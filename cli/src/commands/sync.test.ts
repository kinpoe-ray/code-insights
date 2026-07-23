import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeParsedMessage, makeParsedSession } from '../__fixtures__/db/seed.js';

let syncState: {
  lastSync: string;
  files: Record<string, any>;
  migrations?: {
    codexScopedMessageIds?: boolean;
    copilotScopedMessageIds?: boolean;
  };
  databaseIdentity?: string;
} = { lastSync: '', files: {} };
let currentDbIdentity = '/mock/data.db#database-a';
let currentDbPath = '/mock/data.db';
const advanceDbSyncIdentity = vi.fn(() => currentDbIdentity);
const dbRun = vi.fn();
const getDb = vi.fn(() => ({
  prepare: vi.fn(() => ({ run: dbRun })),
}));
const getDbIdentity = vi.fn(() => currentDbIdentity);
const getMigrationResult = vi.fn(() => ({ v6Applied: false }));
const saveSyncState = vi.fn((state: typeof syncState) => {
  syncState = state;
});

vi.mock('../utils/config.js', () => ({
  loadSyncState: () => syncState,
  saveSyncState,
  getConfigDir: () => os.tmpdir(),
  getClaudeDir: () => path.join(os.tmpdir(), 'claude'),
}));

vi.mock('../db/client.js', () => ({
  getDb,
  getDbIdentity,
  getDbPath: () => currentDbPath,
  advanceDbSyncIdentity,
  getMigrationResult,
}));

const autoDetectOllama = vi.fn();
vi.mock('../utils/ollama-detect.js', () => ({
  autoDetectOllama,
}));

const insertSessionWithProjectAndReturnIsNew = vi.fn();
const insertMessages = vi.fn();
const replaceSessionSnapshot = vi.fn();
const recalculateUsageStats = vi.fn(() => ({ sessionsWithUsage: 0, totalTokens: 0, estimatedCostUsd: 0 }));
vi.mock('../db/write.js', () => ({
  insertSessionWithProjectAndReturnIsNew,
  insertMessages,
  replaceSessionSnapshot,
  recalculateUsageStats,
}));

const sessionExists = vi.fn();
vi.mock('../db/read.js', () => ({
  sessionExists,
}));

const invalidateAnalysisUsage = vi.fn();
vi.mock('../analysis/analysis-usage-db.js', () => ({
  invalidateAnalysisUsage,
}));

const getAllProviders = vi.fn();
vi.mock('../providers/registry.js', () => ({
  getAllProviders,
  getProvider: vi.fn(),
}));

vi.mock('../providers/context.js', () => ({
  setProviderVerbose: () => {},
}));

const identifyUser = vi.fn();
const trackEvent = vi.fn();
vi.mock('../utils/telemetry.js', () => ({
  trackEvent,
  identifyUser,
  captureError: vi.fn(),
  classifyError: vi.fn(() => ({ error_type: 'test', error_message: 'test' })),
}));

const { runSync, syncCommand } = await import('./sync.js');

describe('runSync', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-insights-sync-'));
    currentDbIdentity = '/mock/data.db#database-a';
    currentDbPath = path.join(tempDir, 'data.db');
    getDb.mockClear();
    dbRun.mockClear();
    getDbIdentity.mockClear();
    getMigrationResult.mockClear();
    advanceDbSyncIdentity.mockReset();
    advanceDbSyncIdentity.mockImplementation(() => currentDbIdentity);
    syncState = { lastSync: '', files: {}, databaseIdentity: currentDbIdentity };
    saveSyncState.mockClear();
    insertSessionWithProjectAndReturnIsNew.mockReset();
    insertMessages.mockReset();
    replaceSessionSnapshot.mockReset();
    replaceSessionSnapshot.mockImplementation((session, isForce) => {
      const isNew = insertSessionWithProjectAndReturnIsNew(session, isForce);
      insertMessages(session, true);
      return { isNew, snapshotChanged: false };
    });
    sessionExists.mockReset();
    sessionExists.mockReturnValue(false);
    recalculateUsageStats.mockClear();
    invalidateAnalysisUsage.mockReset();
    getAllProviders.mockReset();
    autoDetectOllama.mockReset();
    identifyUser.mockReset();
    trackEvent.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates existing sessions by default and recalculates usage stats', async () => {
    const filePath = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(filePath, '{}');

    syncState.files[filePath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'session-1',
    };

    const session = makeParsedSession({
      id: 'session-1',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'msg-1', sessionId: 'session-1' }),
        makeParsedMessage({ id: 'msg-2', sessionId: 'session-1', type: 'assistant' }),
        makeParsedMessage({ id: 'msg-3', sessionId: 'session-1' }),
      ],
    });

    getAllProviders.mockReturnValue([
      {
        getProviderName: () => 'mock',
        discover: async () => [filePath],
        parse: async () => session,
      },
    ]);

    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    await runSync({ quiet: true });

    expect(insertSessionWithProjectAndReturnIsNew).toHaveBeenCalledTimes(1);
    expect(insertSessionWithProjectAndReturnIsNew).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      false,
    );
    expect(insertMessages).toHaveBeenCalledTimes(1);
    expect(recalculateUsageStats).toHaveBeenCalledTimes(1);
  });

  it('resurrects only sessions successfully processed by a force sync', async () => {
    const goodPath = path.join(tempDir, 'good.jsonl');
    const badPath = path.join(tempDir, 'bad.jsonl');
    fs.writeFileSync(goodPath, '{}');
    fs.writeFileSync(badPath, '{}');
    const session = makeParsedSession({
      id: 'cursor:good',
      sourceTool: 'cursor',
      messageCount: 3,
      messages: [
        makeParsedMessage({ id: 'good-1', sessionId: 'cursor:good' }),
        makeParsedMessage({ id: 'good-2', sessionId: 'cursor:good', type: 'assistant' }),
        makeParsedMessage({ id: 'good-3', sessionId: 'cursor:good' }),
      ],
    });

    getAllProviders.mockReturnValue([{
      getProviderName: () => 'cursor',
      discover: async () => [goodPath, badPath],
      parse: async (filePath: string) => {
        if (filePath === badPath) throw new Error('simulated parse failure');
        return session;
      },
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    const result = await runSync({ quiet: true, force: true });

    expect(result.errorCount).toBe(1);
    expect(result.updatedExistingCount).toBe(1);
    expect(dbRun).toHaveBeenCalledWith('cursor:good');
    expect(dbRun).not.toHaveBeenCalledWith('cursor:bad');
    expect(dbRun).not.toHaveBeenCalledWith();
  });

  it('keeps a Claude force-sync checkpoint pending when its atomic snapshot replacement fails', async () => {
    const filePath = path.join(tempDir, 'claude-collision.jsonl');
    fs.writeFileSync(filePath, '{}');
    syncState.files[filePath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'claude-collision',
    };
    const session = makeParsedSession({
      id: 'claude-collision',
      sourceTool: 'claude-code',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'claude-user-1', sessionId: 'claude-collision' }),
        makeParsedMessage({
          id: 'message-owned-by-another-session',
          sessionId: 'claude-collision',
          type: 'assistant',
        }),
        makeParsedMessage({ id: 'claude-user-2', sessionId: 'claude-collision' }),
      ],
    });

    getAllProviders.mockReturnValue([{
      getProviderName: () => 'claude-code',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    replaceSessionSnapshot.mockImplementation(() => {
      throw new Error('message ID collision');
    });

    const result = await runSync({ quiet: true, force: true });

    expect(result.errorCount).toBe(1);
    expect(result.syncedCount).toBe(0);
    expect(replaceSessionSnapshot).toHaveBeenCalledWith(session, true);
    expect(insertSessionWithProjectAndReturnIsNew).not.toHaveBeenCalled();
    expect(insertMessages).not.toHaveBeenCalled();
    expect(syncState.files[filePath]).toBeUndefined();
    expect(dbRun).not.toHaveBeenCalledWith('claude-collision');
  });

  it('preserves an existing forced Claude session when parsing returns null', async () => {
    const filePath = path.join(tempDir, 'claude-temporarily-empty.jsonl');
    fs.writeFileSync(filePath, '{}');
    syncState.files[filePath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'claude-existing',
    };
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'claude-code',
      discover: async () => [filePath],
      parse: async () => null,
    }]);
    sessionExists.mockImplementation(sessionId => sessionId === 'claude-existing');

    const result = await runSync({ quiet: true, force: true });

    expect(result.errorCount).toBe(1);
    expect(result.syncedCount).toBe(0);
    expect(sessionExists).toHaveBeenCalledWith('claude-existing');
    expect(replaceSessionSnapshot).not.toHaveBeenCalled();
    expect(insertSessionWithProjectAndReturnIsNew).not.toHaveBeenCalled();
    expect(insertMessages).not.toHaveBeenCalled();
    expect(syncState.files[filePath]).toBeUndefined();
    expect(dbRun).not.toHaveBeenCalledWith('claude-existing');
  });

  it('restores a stored trivial Claude session during a force sync', async () => {
    const filePath = path.join(tempDir, 'trivial.jsonl');
    fs.writeFileSync(filePath, '{}');
    const session = makeParsedSession({
      id: 'claude-trivial',
      sourceTool: 'claude-code',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'trivial-1', sessionId: 'claude-trivial' }),
        makeParsedMessage({
          id: 'trivial-2',
          sessionId: 'claude-trivial',
          type: 'assistant',
        }),
      ],
    });

    getAllProviders.mockReturnValue([{
      getProviderName: () => 'claude-code',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    sessionExists.mockReturnValue(true);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    const result = await runSync({ quiet: true, force: true });

    expect(result.errorCount).toBe(0);
    expect(result.syncedCount).toBe(1);
    expect(result.updatedExistingCount).toBe(1);
    expect(replaceSessionSnapshot).toHaveBeenCalledWith(session, true);
    expect(dbRun).toHaveBeenCalledWith('claude-trivial');
  });

  it('re-syncs virtual paths when the backing DB file changes', async () => {
    const dbPath = path.join(tempDir, 'state.vscdb');
    fs.writeFileSync(dbPath, 'db');
    const virtualPath = `${dbPath}#composer-1`;

    syncState.files[dbPath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'cursor:composer-1',
      syncedSessionIds: ['composer-1'],
    };

    const session = makeParsedSession({
      id: 'cursor:composer-1',
      sourceTool: 'cursor',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'msg-2', sessionId: 'cursor:composer-1' }),
        makeParsedMessage({ id: 'msg-3', sessionId: 'cursor:composer-1', type: 'assistant' }),
        makeParsedMessage({ id: 'msg-4', sessionId: 'cursor:composer-1' }),
      ],
    });

    getAllProviders.mockReturnValue([
      {
        getProviderName: () => 'cursor',
        discover: async () => [virtualPath],
        parse: async () => session,
      },
    ]);

    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    await runSync({ quiet: true });

    expect(insertSessionWithProjectAndReturnIsNew).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cursor:composer-1' }),
      false,
    );
    expect(recalculateUsageStats).toHaveBeenCalledTimes(1);
  });

  it('re-syncs Cursor virtual paths when only the SQLite WAL changes', async () => {
    const dbPath = path.join(tempDir, 'state-wal.vscdb');
    const walPath = `${dbPath}-wal`;
    fs.writeFileSync(dbPath, 'db');
    fs.writeFileSync(walPath, 'wal-1');
    const virtualPath = `${dbPath}#composer-wal`;
    const session = makeParsedSession({
      id: 'cursor:composer-wal',
      sourceTool: 'cursor',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'wal-1', sessionId: 'cursor:composer-wal' }),
        makeParsedMessage({ id: 'wal-2', sessionId: 'cursor:composer-wal', type: 'assistant' }),
        makeParsedMessage({ id: 'wal-3', sessionId: 'cursor:composer-wal' }),
      ],
    });
    const parse = vi.fn(async () => session);
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'cursor',
      discover: async () => [virtualPath],
      parse,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValueOnce(true).mockReturnValue(false);

    await runSync({ quiet: true });
    fs.writeFileSync(walPath, 'wal-2-with-a-different-size');
    await runSync({ quiet: true });

    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('re-syncs only the virtual session whose provider fingerprint changes', async () => {
    const dbPath = path.join(tempDir, 'state-attribution.vscdb');
    fs.writeFileSync(dbPath, 'db');
    const firstPath = `${dbPath}#composer-a`;
    const secondPath = `${dbPath}#composer-b`;
    const globalOnlyPath = `${dbPath}#composer-global-only`;
    const fingerprints = new Map([
      [firstPath, 'workspace-a:/projects/first'],
      [secondPath, 'workspace-b:/projects/second'],
      [globalOnlyPath, null],
    ]);
    const sessions = new Map([
      [firstPath, makeParsedSession({
        id: 'cursor:composer-a',
        sourceTool: 'cursor',
        messageCount: 3,
        messages: [
          makeParsedMessage({ id: 'a-1', sessionId: 'cursor:composer-a' }),
          makeParsedMessage({ id: 'a-2', sessionId: 'cursor:composer-a', type: 'assistant' }),
          makeParsedMessage({ id: 'a-3', sessionId: 'cursor:composer-a' }),
        ],
      })],
      [secondPath, makeParsedSession({
        id: 'cursor:composer-b',
        sourceTool: 'cursor',
        messageCount: 3,
        messages: [
          makeParsedMessage({ id: 'b-1', sessionId: 'cursor:composer-b' }),
          makeParsedMessage({ id: 'b-2', sessionId: 'cursor:composer-b', type: 'assistant' }),
          makeParsedMessage({ id: 'b-3', sessionId: 'cursor:composer-b' }),
        ],
      })],
      [globalOnlyPath, makeParsedSession({
        id: 'cursor:composer-global-only',
        sourceTool: 'cursor',
        messageCount: 3,
        messages: [
          makeParsedMessage({ id: 'g-1', sessionId: 'cursor:composer-global-only' }),
          makeParsedMessage({ id: 'g-2', sessionId: 'cursor:composer-global-only', type: 'assistant' }),
          makeParsedMessage({ id: 'g-3', sessionId: 'cursor:composer-global-only' }),
        ],
      })],
    ]);
    const parse = vi.fn(async (filePath: string) => sessions.get(filePath)!);
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'cursor',
      discover: async () => [firstPath, secondPath, globalOnlyPath],
      getSourceFingerprint: (filePath: string) => fingerprints.get(filePath)!,
      parse,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(true);

    await runSync({ quiet: true });
    parse.mockClear();
    delete syncState.files[dbPath].virtualSourceFingerprints['composer-global-only'];
    fingerprints.set(firstPath, 'workspace-a:/projects/renamed-first');
    await runSync({ quiet: true });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(firstPath);

    parse.mockClear();
    fingerprints.set(secondPath, null);
    await runSync({ quiet: true });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(secondPath);

    parse.mockClear();
    await runSync({ quiet: true });
    expect(parse).not.toHaveBeenCalled();
  });

  it('rebuilds virtual-session checkpoints after a changed DB is only partly processed', async () => {
    const dbPath = path.join(tempDir, 'state-partial.vscdb');
    fs.writeFileSync(dbPath, 'changed-db');
    const firstPath = `${dbPath}#composer-a`;
    const secondPath = `${dbPath}#composer-b`;
    syncState.files[dbPath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'cursor:composer-b',
      syncedSessionIds: ['composer-a', 'composer-b'],
    };
    const first = makeParsedSession({
      id: 'cursor:composer-a',
      sourceTool: 'cursor',
      messages: [
        makeParsedMessage({ id: 'a-1', sessionId: 'cursor:composer-a' }),
        makeParsedMessage({ id: 'a-2', sessionId: 'cursor:composer-a', type: 'assistant' }),
        makeParsedMessage({ id: 'a-3', sessionId: 'cursor:composer-a' }),
      ],
      messageCount: 3,
    });
    const second = makeParsedSession({
      id: 'cursor:composer-b',
      sourceTool: 'cursor',
      messages: [
        makeParsedMessage({ id: 'b-1', sessionId: 'cursor:composer-b' }),
        makeParsedMessage({ id: 'b-2', sessionId: 'cursor:composer-b', type: 'assistant' }),
        makeParsedMessage({ id: 'b-3', sessionId: 'cursor:composer-b' }),
      ],
      messageCount: 3,
    });
    let secondAttempt = 0;
    const parse = vi.fn(async (filePath: string) => {
      if (filePath === firstPath) return first;
      secondAttempt++;
      if (secondAttempt === 1) throw new Error('transient parse failure');
      return second;
    });
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'cursor',
      discover: async () => [firstPath, secondPath],
      parse,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(true);

    const firstRun = await runSync({ quiet: true });
    expect(firstRun.errorCount).toBe(1);
    expect(syncState.files[dbPath].syncedSessionIds).toEqual(['composer-a']);

    const secondRun = await runSync({ quiet: true });
    expect(secondRun.errorCount).toBe(0);
    expect(parse).toHaveBeenCalledWith(secondPath);
    expect(syncState.files[dbPath].syncedSessionIds).toEqual(['composer-a', 'composer-b']);
  });

  it('replaces a complete Cursor message snapshot when the source deletes one of four messages', async () => {
    const dbPath = path.join(tempDir, 'state-updated.vscdb');
    fs.writeFileSync(dbPath, 'db');
    const virtualPath = `${dbPath}#composer-2`;

    syncState.files[dbPath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'cursor:composer-2',
      syncedSessionIds: ['composer-2'],
    };

    const originalMessages = [
      makeParsedMessage({ id: 'cursor:composer-2:user:1', sessionId: 'cursor:composer-2' }),
      makeParsedMessage({
        id: 'cursor:composer-2:assistant:stale',
        sessionId: 'cursor:composer-2',
        type: 'assistant',
      }),
      makeParsedMessage({ id: 'cursor:composer-2:user:2', sessionId: 'cursor:composer-2' }),
      makeParsedMessage({
        id: 'cursor:composer-2:assistant:2',
        sessionId: 'cursor:composer-2',
        type: 'assistant',
      }),
    ];
    const replacementMessages = originalMessages.filter(
      message => message.id !== 'cursor:composer-2:assistant:stale',
    );
    const session = makeParsedSession({
      id: 'cursor:composer-2',
      sourceTool: 'cursor',
      messageCount: replacementMessages.length,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: replacementMessages,
    });

    getAllProviders.mockReturnValue([
      {
        getProviderName: () => 'cursor',
        discover: async () => [virtualPath],
        parse: async () => session,
      },
    ]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    await runSync({ quiet: true });

    expect(insertMessages).toHaveBeenCalledWith(session, true);
  });

  it('replaces and invalidates an existing Cursor snapshot that shrinks to two messages', async () => {
    const dbPath = path.join(tempDir, 'state-shortened.vscdb');
    fs.writeFileSync(dbPath, 'db');
    const virtualPath = `${dbPath}#composer-shortened`;
    const session = makeParsedSession({
      id: 'cursor:composer-shortened',
      sourceTool: 'cursor',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'short-1', sessionId: 'cursor:composer-shortened' }),
        makeParsedMessage({
          id: 'short-2',
          sessionId: 'cursor:composer-shortened',
          type: 'assistant',
        }),
      ],
    });

    getAllProviders.mockReturnValue([{
      getProviderName: () => 'cursor',
      discover: async () => [virtualPath],
      parse: async () => session,
    }]);
    sessionExists.mockReturnValue(true);
    replaceSessionSnapshot.mockReturnValue({ isNew: false, snapshotChanged: true });

    await runSync({ quiet: true });

    expect(replaceSessionSnapshot).toHaveBeenCalledWith(session, false);
    expect(invalidateAnalysisUsage).toHaveBeenCalledWith(session.id);
  });

  it('does not checkpoint a null parse over a previously stored session', async () => {
    const filePath = path.join(tempDir, 'temporarily-empty.jsonl');
    fs.writeFileSync(filePath, '{}');
    const previousModified = new Date(0).toISOString();
    syncState.files[filePath] = {
      lastModified: previousModified,
      lastSyncedLine: 0,
      sessionId: 'session-existing',
    };
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'cursor',
      discover: async () => [filePath],
      parse: async () => null,
    }]);
    sessionExists.mockImplementation(sessionId => sessionId === 'session-existing');

    await runSync({ quiet: true });

    expect(replaceSessionSnapshot).not.toHaveBeenCalled();
    expect(syncState.files[filePath].lastModified).toBe(previousModified);
  });

  it('reconciles usage stats after importing a purely new session', async () => {
    const filePath = path.join(tempDir, 'new-session.jsonl');
    fs.writeFileSync(filePath, '{}');

    const session = makeParsedSession({
      id: 'session-new',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'msg-new-1', sessionId: 'session-new' }),
        makeParsedMessage({ id: 'msg-new-2', sessionId: 'session-new', type: 'assistant' }),
        makeParsedMessage({ id: 'msg-new-3', sessionId: 'session-new' }),
      ],
    });

    getAllProviders.mockReturnValue([
      {
        getProviderName: () => 'mock',
        discover: async () => [filePath],
        parse: async () => session,
      },
    ]);

    insertSessionWithProjectAndReturnIsNew.mockReturnValue(true);

    await runSync({ quiet: true });

    expect(insertSessionWithProjectAndReturnIsNew).toHaveBeenCalledTimes(1);
    expect(recalculateUsageStats).toHaveBeenCalledTimes(1);
  });

  it('reconciles usage stats on an up-to-date run after a prior interrupted sync', async () => {
    const filePath = path.join(tempDir, 'already-synced.jsonl');
    fs.writeFileSync(filePath, '{}');
    const stat = fs.statSync(filePath);
    syncState.files[filePath] = {
      lastModified: stat.mtime.toISOString(),
      fileSize: stat.size,
      lastSyncedLine: 0,
      sessionId: 'session-existing',
    };
    const parse = vi.fn();
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'mock',
      discover: async () => [filePath],
      parse,
    }]);

    const result = await runSync({ quiet: true });

    expect(result.syncedCount).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    expect(recalculateUsageStats).toHaveBeenCalledTimes(1);
  });

  it('skips sessions with 2 or fewer messages', async () => {
    const filePath = path.join(tempDir, 'trivial.jsonl');
    fs.writeFileSync(filePath, '{}');

    const trivialSession = makeParsedSession({
      id: 'session-trivial',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'msg-t1', sessionId: 'session-trivial' }),
        makeParsedMessage({ id: 'msg-t2', sessionId: 'session-trivial', type: 'assistant' }),
      ],
    });

    getAllProviders.mockReturnValue([
      {
        getProviderName: () => 'mock',
        discover: async () => [filePath],
        parse: async () => trivialSession,
      },
    ]);

    const result = await runSync({ quiet: true });

    expect(insertSessionWithProjectAndReturnIsNew).not.toHaveBeenCalled();
    expect(insertMessages).not.toHaveBeenCalled();
    expect(result.syncedCount).toBe(0);
  });

  it('syncs sessions with 3 or more messages', async () => {
    const filePath = path.join(tempDir, 'valid.jsonl');
    fs.writeFileSync(filePath, '{}');

    const validSession = makeParsedSession({
      id: 'session-valid',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'msg-v1', sessionId: 'session-valid' }),
        makeParsedMessage({ id: 'msg-v2', sessionId: 'session-valid', type: 'assistant' }),
        makeParsedMessage({ id: 'msg-v3', sessionId: 'session-valid' }),
      ],
    });

    getAllProviders.mockReturnValue([
      {
        getProviderName: () => 'mock',
        discover: async () => [filePath],
        parse: async () => validSession,
      },
    ]);

    insertSessionWithProjectAndReturnIsNew.mockReturnValue(true);

    const result = await runSync({ quiet: true });

    expect(insertSessionWithProjectAndReturnIsNew).toHaveBeenCalledTimes(1);
    expect(insertMessages).toHaveBeenCalledTimes(1);
    expect(result.syncedCount).toBe(1);
  });

  it('force-resyncs unchanged Codex files once when scoped message IDs have not been migrated', async () => {
    const filePath = path.join(tempDir, 'rollout.jsonl');
    fs.writeFileSync(filePath, '{}');
    const stat = fs.statSync(filePath);
    syncState.files[filePath] = {
      lastModified: stat.mtime.toISOString(),
      lastSyncedLine: 0,
      sessionId: 'codex:legacy-session',
    };

    const session = makeParsedSession({
      id: 'codex:legacy-session',
      sourceTool: 'codex-cli',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'codex:legacy-session:user:0', sessionId: 'codex:legacy-session' }),
        makeParsedMessage({ id: 'codex:legacy-session:assistant:1', sessionId: 'codex:legacy-session', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:legacy-session:user:2', sessionId: 'codex:legacy-session' }),
      ],
    });

    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    const result = await runSync({ quiet: true });

    expect(result.syncedCount).toBe(1);
    expect(insertMessages).toHaveBeenCalledWith(session, true);
    expect(invalidateAnalysisUsage).toHaveBeenCalledWith('codex:legacy-session');
    expect(syncState.migrations?.codexScopedMessageIds).toBe(true);
  });

  it('replaces four legacy Copilot rows with a three-message scoped snapshot', async () => {
    const filePath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(filePath, '{}');
    const stat = fs.statSync(filePath);
    syncState.files[filePath] = {
      lastModified: stat.mtime.toISOString(),
      fileSize: stat.size,
      lastSyncedLine: 0,
      sessionId: 'copilot:legacy-session',
    };
    let storedMessageIds = [
      'shared-user-id',
      'copilot-assistant-1',
      'shared-user-id-copy',
      'stale-duplicate',
    ];
    const session = makeParsedSession({
      id: 'copilot:legacy-session',
      sourceTool: 'copilot-cli',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({
          id: 'copilot:legacy-session:user:source:shared-user-id',
          sessionId: 'copilot:legacy-session',
        }),
        makeParsedMessage({
          id: 'copilot:legacy-session:assistant:generated:1',
          sessionId: 'copilot:legacy-session',
          type: 'assistant',
        }),
        makeParsedMessage({
          id: 'copilot:legacy-session:user:generated:2',
          sessionId: 'copilot:legacy-session',
        }),
      ],
    });
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'copilot-cli',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    replaceSessionSnapshot.mockImplementation(incoming => {
      storedMessageIds = incoming.messages.map(message => message.id);
      return { isNew: false, snapshotChanged: true };
    });

    const result = await runSync({ quiet: true });

    expect(result.errorCount).toBe(0);
    expect(replaceSessionSnapshot).toHaveBeenCalledWith(session, false);
    expect(insertMessages).not.toHaveBeenCalled();
    expect(storedMessageIds).toEqual(session.messages.map(message => message.id));
    expect(storedMessageIds).toHaveLength(3);
    expect(invalidateAnalysisUsage).toHaveBeenCalledWith(session.id);
    expect(syncState.migrations?.copilotScopedMessageIds).toBe(true);
  });

  it('does not complete the Copilot scoped-ID migration when a transcript errors', async () => {
    const filePath = path.join(tempDir, 'broken-events.jsonl');
    fs.writeFileSync(filePath, '{"type":');
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'copilot-cli',
      discover: async () => [filePath],
      parse: async () => { throw new Error('malformed Copilot event'); },
    }]);

    const result = await runSync({ quiet: true });

    expect(result.errorCount).toBe(1);
    expect(replaceSessionSnapshot).not.toHaveBeenCalled();
    expect(syncState.migrations?.copilotScopedMessageIds).not.toBe(true);
  });

  it('keeps the Copilot migration pending after incomplete discovery and completes it on retry', async () => {
    const filePath = path.join(tempDir, 'recovered-events.jsonl');
    fs.writeFileSync(filePath, '{}');
    const session = makeParsedSession({
      id: 'copilot:recovered-session',
      sourceTool: 'copilot-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({
          id: 'copilot:recovered-session:user:generated:0',
          sessionId: 'copilot:recovered-session',
        }),
        makeParsedMessage({
          id: 'copilot:recovered-session:assistant:generated:1',
          sessionId: 'copilot:recovered-session',
          type: 'assistant',
        }),
        makeParsedMessage({
          id: 'copilot:recovered-session:user:generated:2',
          sessionId: 'copilot:recovered-session',
        }),
      ],
    });
    const discover = vi.fn()
      .mockRejectedValueOnce(new Error('incomplete Copilot discovery'))
      .mockResolvedValue([filePath]);
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'copilot-cli',
      discover,
      parse: async () => session,
    }]);
    replaceSessionSnapshot.mockReturnValue({ isNew: false, snapshotChanged: true });

    const failedResult = await runSync({ quiet: true });

    expect(failedResult.errorCount).toBe(1);
    expect(replaceSessionSnapshot).not.toHaveBeenCalled();
    expect(syncState.migrations?.copilotScopedMessageIds).not.toBe(true);

    const recoveredResult = await runSync({ quiet: true });

    expect(recoveredResult.errorCount).toBe(0);
    expect(replaceSessionSnapshot).toHaveBeenCalledWith(session, false);
    expect(syncState.migrations?.copilotScopedMessageIds).toBe(true);
  });

  it('invalidates analysis during the Copilot migration even when the snapshot is unchanged', async () => {
    const filePath = path.join(tempDir, 'unchanged-events.jsonl');
    fs.writeFileSync(filePath, '{}');
    const session = makeParsedSession({
      id: 'copilot:unchanged-session',
      sourceTool: 'copilot-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({
          id: 'copilot:unchanged-session:user:generated:0',
          sessionId: 'copilot:unchanged-session',
        }),
        makeParsedMessage({
          id: 'copilot:unchanged-session:assistant:generated:1',
          sessionId: 'copilot:unchanged-session',
          type: 'assistant',
        }),
        makeParsedMessage({
          id: 'copilot:unchanged-session:user:generated:2',
          sessionId: 'copilot:unchanged-session',
        }),
      ],
    });
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'copilot-cli',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    replaceSessionSnapshot.mockReturnValue({ isNew: false, snapshotChanged: false });

    await runSync({ quiet: true });

    expect(invalidateAnalysisUsage).toHaveBeenCalledWith(session.id);
    expect(syncState.migrations?.copilotScopedMessageIds).toBe(true);
  });

  it('does not complete the global Copilot migration from a project-filtered sync', async () => {
    const filePath = path.join(tempDir, 'project-events.jsonl');
    fs.writeFileSync(filePath, '{}');
    const session = makeParsedSession({
      id: 'copilot:project-session',
      sourceTool: 'copilot-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({
          id: 'copilot:project-session:user:generated:0',
          sessionId: 'copilot:project-session',
        }),
        makeParsedMessage({
          id: 'copilot:project-session:assistant:generated:1',
          sessionId: 'copilot:project-session',
          type: 'assistant',
        }),
        makeParsedMessage({
          id: 'copilot:project-session:user:generated:2',
          sessionId: 'copilot:project-session',
        }),
      ],
    });
    const discover = vi.fn(async () => [filePath]);
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'copilot-cli',
      discover,
      parse: async () => session,
    }]);
    replaceSessionSnapshot.mockReturnValue({ isNew: false, snapshotChanged: true });

    await runSync({ quiet: true, project: 'only-this-project' });

    expect(discover).toHaveBeenCalledWith({ projectFilter: 'only-this-project' });
    expect(replaceSessionSnapshot).toHaveBeenCalledWith(session, false);
    expect(invalidateAnalysisUsage).toHaveBeenCalledWith(session.id);
    expect(syncState.migrations?.copilotScopedMessageIds).not.toBe(true);
  });

  it('does not complete the global Codex migration from a project-filtered sync', async () => {
    const filePath = path.join(tempDir, 'project-rollout.jsonl');
    fs.writeFileSync(filePath, '{}');
    const session = makeParsedSession({
      id: 'codex:project-session',
      sourceTool: 'codex-cli',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'codex:project-session:user:0', sessionId: 'codex:project-session' }),
        makeParsedMessage({ id: 'codex:project-session:assistant:1', sessionId: 'codex:project-session', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:project-session:user:2', sessionId: 'codex:project-session' }),
      ],
    });
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    await runSync({ quiet: true, project: 'only-this-project' });
    expect(syncState.files[filePath]).toMatchObject({
      lastModified: fs.statSync(filePath).mtime.toISOString(),
      fileSize: fs.statSync(filePath).size,
    });
    await runSync({ quiet: true, project: 'only-this-project' });

    expect(invalidateAnalysisUsage).not.toHaveBeenCalled();
    expect(insertMessages).toHaveBeenCalledTimes(1);
    expect(syncState.migrations?.codexScopedMessageIds).not.toBe(true);
  });

  it('replaces the full message snapshot for later incremental Codex updates', async () => {
    const filePath = path.join(tempDir, 'rollout-updated.jsonl');
    fs.writeFileSync(filePath, '{}');
    syncState.migrations = { codexScopedMessageIds: true };
    syncState.files[filePath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'codex:updated-session',
    };
    const session = makeParsedSession({
      id: 'codex:updated-session',
      sourceTool: 'codex-cli',
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      messages: [
        makeParsedMessage({ id: 'codex:updated-session:user:0', sessionId: 'codex:updated-session' }),
        makeParsedMessage({ id: 'codex:updated-session:assistant:1', sessionId: 'codex:updated-session', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:updated-session:user:2', sessionId: 'codex:updated-session' }),
      ],
    });
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    await runSync({ quiet: true });

    expect(insertMessages).toHaveBeenCalledWith(session, true);
    expect(invalidateAnalysisUsage).toHaveBeenCalledWith('codex:updated-session');
  });

  it('does not invalidate analysis for an unchanged Codex file forced through a no-op resync', async () => {
    const filePath = path.join(tempDir, 'rollout-unchanged.jsonl');
    fs.writeFileSync(filePath, '{}');
    const stat = fs.statSync(filePath);
    syncState.migrations = { codexScopedMessageIds: true };
    syncState.files[filePath] = {
      lastModified: stat.mtime.toISOString(),
      fileSize: stat.size,
      lastSyncedLine: 0,
      sessionId: 'codex:unchanged-session',
    };
    const session = makeParsedSession({
      id: 'codex:unchanged-session',
      sourceTool: 'codex-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({ id: 'codex:unchanged-session:user:0', sessionId: 'codex:unchanged-session' }),
        makeParsedMessage({ id: 'codex:unchanged-session:assistant:1', sessionId: 'codex:unchanged-session', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:unchanged-session:user:2', sessionId: 'codex:unchanged-session' }),
      ],
    });
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(false);

    await runSync({ quiet: true, force: true });

    expect(insertMessages).toHaveBeenCalledWith(session, true);
    expect(invalidateAnalysisUsage).not.toHaveBeenCalled();
  });

  it('discards file checkpoints and migration flags when the SQLite identity changes', async () => {
    const filePath = path.join(tempDir, 'rollout-restored-db.jsonl');
    fs.writeFileSync(filePath, 'unchanged transcript');
    const stat = fs.statSync(filePath);
    syncState = {
      lastSync: '2026-01-01T00:00:00.000Z',
      databaseIdentity: '/mock/data.db#database-before-restore',
      files: {
        [filePath]: {
          lastModified: stat.mtime.toISOString(),
          fileSize: stat.size,
          lastSyncedLine: 0,
          sessionId: 'codex:restored-db',
        },
      },
      migrations: { codexScopedMessageIds: true },
    };
    currentDbIdentity = '/mock/data.db#database-after-restore';
    const session = makeParsedSession({
      id: 'codex:restored-db',
      sourceTool: 'codex-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({ id: 'codex:restored-db:user:0', sessionId: 'codex:restored-db' }),
        makeParsedMessage({ id: 'codex:restored-db:assistant:1', sessionId: 'codex:restored-db', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:restored-db:user:2', sessionId: 'codex:restored-db' }),
      ],
    });
    const parse = vi.fn(async () => session);
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(true);

    const result = await runSync({ quiet: true });

    expect(parse).toHaveBeenCalledOnce();
    expect(result.syncedCount).toBe(1);
    expect(syncState.databaseIdentity).toBe(currentDbIdentity);
    expect(syncState.migrations?.codexScopedMessageIds).toBe(true);
  });

  it('checkpoints the SQLite sync generation after a completed run', async () => {
    const nextIdentity = '/mock/data.db#database-a#generation-next';
    advanceDbSyncIdentity.mockReturnValueOnce(nextIdentity);
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [],
      parse: async () => null,
    }]);

    await runSync({ quiet: true });

    expect(advanceDbSyncIdentity).toHaveBeenCalledOnce();
    expect(syncState.databaseIdentity).toBe(nextIdentity);
  });

  it('does not mutate or persist sync state during a forced dry run', async () => {
    const filePath = path.join(tempDir, 'rollout-dry-run.jsonl');
    fs.writeFileSync(filePath, 'unchanged');
    syncState = {
      lastSync: '2026-01-01T00:00:00.000Z',
      databaseIdentity: '/mock/data.db#database-before-switch',
      files: {
        [filePath]: {
          lastModified: fs.statSync(filePath).mtime.toISOString(),
          fileSize: fs.statSync(filePath).size,
          lastSyncedLine: 0,
          sessionId: 'codex:dry-run',
        },
      },
      migrations: { codexScopedMessageIds: true },
    };
    const originalState = structuredClone(syncState);
    currentDbIdentity = '/mock/data.db#database-after-switch';
    const parse = vi.fn();
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse,
    }]);

    await runSync({ quiet: true, dryRun: true, force: true });

    expect(parse).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
    expect(getDbIdentity).not.toHaveBeenCalled();
    expect(getMigrationResult).not.toHaveBeenCalled();
    expect(autoDetectOllama).not.toHaveBeenCalled();
    expect(insertSessionWithProjectAndReturnIsNew).not.toHaveBeenCalled();
    expect(insertMessages).not.toHaveBeenCalled();
    expect(recalculateUsageStats).not.toHaveBeenCalled();
    expect(advanceDbSyncIdentity).not.toHaveBeenCalled();
    expect(saveSyncState).not.toHaveBeenCalled();
    expect(syncState).toEqual(originalState);
  });

  it('plans a dry run without creating a missing database or auto-configuring Ollama', async () => {
    const filePath = path.join(tempDir, 'dry-run-without-db.jsonl');
    fs.writeFileSync(filePath, '{}');
    currentDbPath = path.join(tempDir, 'missing', 'data.db');
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'mock',
      discover: async () => [filePath],
      parse: vi.fn(),
    }]);

    await syncCommand({ dryRun: true });

    expect(fs.existsSync(currentDbPath)).toBe(false);
    expect(getDb).not.toHaveBeenCalled();
    expect(getDbIdentity).not.toHaveBeenCalled();
    expect(getMigrationResult).not.toHaveBeenCalled();
    expect(autoDetectOllama).not.toHaveBeenCalled();
    expect(identifyUser).not.toHaveBeenCalled();
    expect(saveSyncState).not.toHaveBeenCalled();
    expect(advanceDbSyncIdentity).not.toHaveBeenCalled();
  });

  it('retries a Codex transcript that changes while it is being parsed', async () => {
    const filePath = path.join(tempDir, 'rollout-growing.jsonl');
    fs.writeFileSync(filePath, 'initial');
    syncState.migrations = { codexScopedMessageIds: true };

    const firstSnapshot = makeParsedSession({
      id: 'codex:growing-session',
      sourceTool: 'codex-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({ id: 'codex:growing-session:user:0', sessionId: 'codex:growing-session' }),
        makeParsedMessage({ id: 'codex:growing-session:assistant:1', sessionId: 'codex:growing-session', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:growing-session:user:2', sessionId: 'codex:growing-session' }),
      ],
    });
    const stableSnapshot = makeParsedSession({
      ...firstSnapshot,
      messageCount: 4,
      messages: [
        ...firstSnapshot.messages,
        makeParsedMessage({ id: 'codex:growing-session:assistant:3', sessionId: 'codex:growing-session', type: 'assistant' }),
      ],
    });
    let parseAttempts = 0;
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => {
        parseAttempts++;
        if (parseAttempts === 1) {
          fs.appendFileSync(filePath, '-grew-during-parse');
          return firstSnapshot;
        }
        return stableSnapshot;
      },
    }]);
    insertSessionWithProjectAndReturnIsNew.mockReturnValue(true);

    const result = await runSync({ quiet: true });

    expect(parseAttempts).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(insertSessionWithProjectAndReturnIsNew).toHaveBeenCalledOnce();
    expect(insertSessionWithProjectAndReturnIsNew).toHaveBeenCalledWith(stableSnapshot, false);
    expect(syncState.files[filePath].lastModified).toBe(fs.statSync(filePath).mtime.toISOString());
  });

  it('does not write or checkpoint a Codex transcript that keeps changing', async () => {
    const filePath = path.join(tempDir, 'rollout-still-growing.jsonl');
    fs.writeFileSync(filePath, 'initial');
    const session = makeParsedSession({
      id: 'codex:still-growing',
      sourceTool: 'codex-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({ id: 'codex:still-growing:user:0', sessionId: 'codex:still-growing' }),
        makeParsedMessage({ id: 'codex:still-growing:assistant:1', sessionId: 'codex:still-growing', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:still-growing:user:2', sessionId: 'codex:still-growing' }),
      ],
    });
    let parseAttempts = 0;
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => {
        parseAttempts++;
        fs.appendFileSync(filePath, `-${parseAttempts}`);
        return session;
      },
    }]);

    const result = await runSync({ quiet: true });

    expect(parseAttempts).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(insertSessionWithProjectAndReturnIsNew).not.toHaveBeenCalled();
    expect(insertMessages).not.toHaveBeenCalled();
    expect(syncState.files[filePath]).toBeUndefined();
    expect(syncState.migrations?.codexScopedMessageIds).not.toBe(true);
  });

  it('does not write or checkpoint a forced Claude transcript that keeps changing', async () => {
    const filePath = path.join(tempDir, 'claude-still-growing.jsonl');
    fs.writeFileSync(filePath, 'initial');
    const session = makeParsedSession({
      id: 'claude-still-growing',
      sourceTool: 'claude-code',
      messageCount: 3,
      messages: [
        makeParsedMessage({ id: 'claude-growing-user-0', sessionId: 'claude-still-growing' }),
        makeParsedMessage({
          id: 'claude-growing-assistant-1',
          sessionId: 'claude-still-growing',
          type: 'assistant',
        }),
        makeParsedMessage({ id: 'claude-growing-user-2', sessionId: 'claude-still-growing' }),
      ],
    });
    let parseAttempts = 0;
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'claude-code',
      discover: async () => [filePath],
      parse: async () => {
        parseAttempts++;
        fs.appendFileSync(filePath, `-${parseAttempts}`);
        return session;
      },
    }]);

    const result = await runSync({ quiet: true, force: true });

    expect(parseAttempts).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.syncedCount).toBe(0);
    expect(replaceSessionSnapshot).not.toHaveBeenCalled();
    expect(insertSessionWithProjectAndReturnIsNew).not.toHaveBeenCalled();
    expect(insertMessages).not.toHaveBeenCalled();
    expect(syncState.files[filePath]).toBeUndefined();
    expect(dbRun).not.toHaveBeenCalledWith('claude-still-growing');
  });

  it('checkpoints the parsed Codex snapshot rather than a later file mtime', async () => {
    const filePath = path.join(tempDir, 'rollout-after-parse.jsonl');
    fs.writeFileSync(filePath, 'stable-snapshot');
    const snapshotTime = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(filePath, snapshotTime, snapshotTime);
    syncState.migrations = { codexScopedMessageIds: true };
    const parsedMtime = fs.statSync(filePath).mtime.toISOString();
    const session = makeParsedSession({
      id: 'codex:after-parse',
      sourceTool: 'codex-cli',
      messageCount: 3,
      messages: [
        makeParsedMessage({ id: 'codex:after-parse:user:0', sessionId: 'codex:after-parse' }),
        makeParsedMessage({ id: 'codex:after-parse:assistant:1', sessionId: 'codex:after-parse', type: 'assistant' }),
        makeParsedMessage({ id: 'codex:after-parse:user:2', sessionId: 'codex:after-parse' }),
      ],
    });
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => session,
    }]);
    insertSessionWithProjectAndReturnIsNew.mockImplementation(() => {
      fs.appendFileSync(filePath, '-new-tail-after-parse');
      const laterTime = new Date('2026-01-01T00:00:01.000Z');
      fs.utimesSync(filePath, laterTime, laterTime);
      return true;
    });

    await runSync({ quiet: true });

    expect(fs.statSync(filePath).mtime.toISOString()).not.toBe(parsedMtime);
    expect(syncState.files[filePath].lastModified).toBe(parsedMtime);
  });

  it('does not mark the Codex ID migration complete when a transcript fails to parse', async () => {
    const filePath = path.join(tempDir, 'broken-rollout.jsonl');
    fs.writeFileSync(filePath, '{}');
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => { throw new Error('broken transcript'); },
    }]);

    const result = await runSync({ quiet: true });

    expect(result.errorCount).toBe(1);
    expect(syncState.migrations?.codexScopedMessageIds).not.toBe(true);
  });

  it('does not complete the Codex ID migration when a stored transcript parses as null', async () => {
    const filePath = path.join(tempDir, 'rollout-null.jsonl');
    fs.writeFileSync(filePath, '{}');
    syncState.files[filePath] = {
      lastModified: new Date(0).toISOString(),
      lastSyncedLine: 0,
      sessionId: 'codex:stored-null',
    };
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => null,
    }]);
    sessionExists.mockImplementation(sessionId => sessionId === 'codex:stored-null');

    const result = await runSync({ quiet: true });

    expect(result.errorCount).toBe(1);
    expect(syncState.migrations?.codexScopedMessageIds).not.toBe(true);
  });

  it('returns a failing process status when a sync completes with file errors', async () => {
    const filePath = path.join(tempDir, 'broken-for-cli.jsonl');
    fs.writeFileSync(filePath, '{broken}');
    getAllProviders.mockReturnValue([{
      getProviderName: () => 'codex-cli',
      discover: async () => [filePath],
      parse: async () => { throw new Error('broken transcript'); },
    }]);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await syncCommand({ quiet: true });

      expect(process.exitCode).toBe(1);
      expect(trackEvent).toHaveBeenCalledWith(
        'cli_sync',
        expect.objectContaining({ errors: 1, success: false }),
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
