import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeParsedMessage, makeParsedSession } from '../__fixtures__/db/seed.js';

let syncState: {
  lastSync: string;
  files: Record<string, any>;
  migrations?: { codexScopedMessageIds?: boolean };
  databaseIdentity?: string;
} = { lastSync: '', files: {} };
let currentDbIdentity = '/mock/data.db#database-a';
let currentDbPath = '/mock/data.db';
const advanceDbSyncIdentity = vi.fn(() => currentDbIdentity);
const getDb = vi.fn(() => ({
  prepare: vi.fn(() => ({ run: vi.fn() })),
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
const recalculateUsageStats = vi.fn(() => ({ sessionsWithUsage: 0, totalTokens: 0, estimatedCostUsd: 0 }));
vi.mock('../db/write.js', () => ({
  insertSessionWithProjectAndReturnIsNew,
  insertMessages,
  recalculateUsageStats,
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
    getDbIdentity.mockClear();
    getMigrationResult.mockClear();
    advanceDbSyncIdentity.mockReset();
    advanceDbSyncIdentity.mockImplementation(() => currentDbIdentity);
    syncState = { lastSync: '', files: {}, databaseIdentity: currentDbIdentity };
    saveSyncState.mockClear();
    insertSessionWithProjectAndReturnIsNew.mockReset();
    insertMessages.mockReset();
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

  it('does not recalculate usage stats for purely new sessions', async () => {
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
    expect(recalculateUsageStats).not.toHaveBeenCalled();
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
