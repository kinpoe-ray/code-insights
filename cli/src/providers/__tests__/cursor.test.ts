import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { CursorProvider } from '../cursor.js';

// ---------------------------------------------------------------------------
// Helpers — build a minimal Cursor-style SQLite database in a temp dir.
//
// CursorProvider.parse() accepts a virtual path: `<dbPath>#<composerId>`.
// We create a real SQLite file with the `cursorDiskKV` table that Cursor uses
// and store JSON composer data blobs exactly as Cursor would.
// ---------------------------------------------------------------------------

const COMPOSER_ID = 'test-composer-abc123';

function makeCursorDb(dir: string, composerData: Record<string, unknown>): string {
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);');
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    `composerData:${COMPOSER_ID}`,
    JSON.stringify(composerData),
  );
  db.close();
  return dbPath;
}

function virtualPath(dbPath: string): string {
  return `${dbPath}#${COMPOSER_ID}`;
}

function makeWorkspaceDb(
  cursorDataDir: string,
  workspaceHash: string,
  projectPath: string,
  composerIds: string[],
): string {
  const workspaceDir = path.join(cursorDataDir, 'workspaceStorage', workspaceHash);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'workspace.json'),
    JSON.stringify({ folder: `file://${projectPath}` }),
  );

  const dbPath = path.join(workspaceDir, 'state.vscdb');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerData',
    JSON.stringify({
      allComposers: composerIds.map(composerId => ({ composerId, name: `Session ${composerId}` })),
    }),
  );
  db.close();
  return dbPath;
}

function userBubble(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { bubbleId: 'bubble-user-1', type: 1, text: 'How do I fix the login bug?', ...overrides };
}

function assistantBubble(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { bubbleId: 'bubble-assistant-1', type: 2, text: 'Here is how to fix the login bug.', ...overrides };
}

describe('CursorProvider — parsing accuracy fixes', () => {
  let tempDir: string;
  const provider = new CursorProvider();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Discovery / canonical source ─────────────────────────────────────────

  it('discovers one canonical global source when workspace and global storage contain the same composer', async () => {
    const cursorDataDir = path.join(tempDir, 'Cursor', 'User');
    const projectPath = path.join(tempDir, 'projects', 'real-workspace');
    makeWorkspaceDb(cursorDataDir, 'workspace-hash', projectPath, [COMPOSER_ID]);
    fs.mkdirSync(path.join(cursorDataDir, 'globalStorage'), { recursive: true });
    const globalDbPath = makeCursorDb(
      path.join(cursorDataDir, 'globalStorage'),
      {
        conversation: [
          userBubble({ createdAt: '2026-07-20T06:12:25.123Z' }),
          assistantBubble({ createdAt: '2026-07-20T06:12:26.456Z' }),
        ],
      },
    );
    const isolatedProvider = new CursorProvider(cursorDataDir);

    const discovered = await isolatedProvider.discover();

    expect(discovered).toEqual([virtualPath(globalDbPath)]);
  });

  it('keeps the real workspace project path when parsing a canonical global source', async () => {
    const cursorDataDir = path.join(tempDir, 'Cursor', 'User');
    const projectPath = path.join(tempDir, 'projects', 'real-workspace');
    makeWorkspaceDb(cursorDataDir, 'workspace-hash', projectPath, [COMPOSER_ID]);
    fs.mkdirSync(path.join(cursorDataDir, 'globalStorage'), { recursive: true });
    makeCursorDb(
      path.join(cursorDataDir, 'globalStorage'),
      {
        conversation: [
          userBubble({ createdAt: '2026-07-20T06:12:25.123Z' }),
          assistantBubble({ createdAt: '2026-07-20T06:12:26.456Z' }),
        ],
      },
    );
    const isolatedProvider = new CursorProvider(cursorDataDir);
    const [canonicalSource] = await isolatedProvider.discover();

    const session = await isolatedProvider.parse(canonicalSource);

    expect(session).not.toBeNull();
    expect(session!.projectPath).toBe(projectPath);
    expect(session!.projectName).toBe('real-workspace');
  });

  it('does not reintroduce unrelated global composers after applying a project filter', async () => {
    const cursorDataDir = path.join(tempDir, 'Cursor', 'User');
    const matchingProject = path.join(tempDir, 'projects', 'real-workspace');
    const unrelatedProject = path.join(tempDir, 'projects', 'unrelated-workspace');
    const unrelatedComposerId = 'unrelated-composer';
    makeWorkspaceDb(cursorDataDir, 'matching-hash', matchingProject, [COMPOSER_ID]);
    makeWorkspaceDb(cursorDataDir, 'unrelated-hash', unrelatedProject, [unrelatedComposerId]);
    fs.mkdirSync(path.join(cursorDataDir, 'globalStorage'), { recursive: true });
    const globalDbPath = makeCursorDb(
      path.join(cursorDataDir, 'globalStorage'),
      { conversation: [userBubble(), assistantBubble()] },
    );
    const globalDb = new Database(globalDbPath);
    globalDb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      `composerData:${unrelatedComposerId}`,
      JSON.stringify({ conversation: [userBubble(), assistantBubble()] }),
    );
    globalDb.close();
    const isolatedProvider = new CursorProvider(cursorDataDir);

    const discovered = await isolatedProvider.discover({ projectFilter: 'real-workspace' });

    expect(discovered).toEqual([virtualPath(globalDbPath)]);
  });

  it('changes only the affected composer fingerprint when workspace attribution changes', async () => {
    const cursorDataDir = path.join(tempDir, 'Cursor', 'User');
    const firstWorkspaceHash = 'first-workspace-hash';
    const firstProject = path.join(tempDir, 'projects', 'first-project');
    const renamedFirstProject = path.join(tempDir, 'projects', 'renamed-first-project');
    const secondProject = path.join(tempDir, 'projects', 'second-project');
    const secondComposerId = 'second-composer';
    const globalOnlyComposerId = 'global-only-composer';
    makeWorkspaceDb(cursorDataDir, firstWorkspaceHash, firstProject, [COMPOSER_ID]);
    makeWorkspaceDb(cursorDataDir, 'second-workspace-hash', secondProject, [secondComposerId]);
    fs.mkdirSync(path.join(cursorDataDir, 'globalStorage'), { recursive: true });
    const globalDbPath = makeCursorDb(
      path.join(cursorDataDir, 'globalStorage'),
      { conversation: [userBubble(), assistantBubble()] },
    );
    const globalDb = new Database(globalDbPath);
    globalDb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      `composerData:${secondComposerId}`,
      JSON.stringify({ conversation: [userBubble(), assistantBubble()] }),
    );
    globalDb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      `composerData:${globalOnlyComposerId}`,
      JSON.stringify({ conversation: [userBubble(), assistantBubble()] }),
    );
    globalDb.close();
    const isolatedProvider = new CursorProvider(cursorDataDir);
    const initialSources = await isolatedProvider.discover();
    const firstSource = initialSources.find(source => source.endsWith(`#${COMPOSER_ID}`))!;
    const secondSource = initialSources.find(source => source.endsWith(`#${secondComposerId}`))!;
    const globalOnlySource = initialSources.find(source => source.endsWith(`#${globalOnlyComposerId}`))!;
    const initialFirstFingerprint = isolatedProvider.getSourceFingerprint(firstSource);
    const initialSecondFingerprint = isolatedProvider.getSourceFingerprint(secondSource);

    expect(isolatedProvider.getSourceFingerprint(globalOnlySource)).toBeNull();

    fs.writeFileSync(
      path.join(cursorDataDir, 'workspaceStorage', firstWorkspaceHash, 'workspace.json'),
      JSON.stringify({ folder: `file://${renamedFirstProject}` }),
    );
    await isolatedProvider.discover();

    expect(isolatedProvider.getSourceFingerprint(firstSource)).not.toBe(initialFirstFingerprint);
    expect(isolatedProvider.getSourceFingerprint(secondSource)).toBe(initialSecondFingerprint);
    expect(isolatedProvider.getSourceFingerprint(globalOnlySource)).toBeNull();
  });

  // ── Timestamps ────────────────────────────────────────────────────────────

  it('uses the bubble createdAt timestamp exposed by current Cursor storage', async () => {
    const userCreatedAt = '2026-07-20T06:12:25.123Z';
    const assistantCreatedAt = '2026-07-20T06:12:26.456Z';
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ createdAt: userCreatedAt }),
        assistantBubble({ createdAt: assistantCreatedAt }),
      ],
    });

    const session = await provider.parse(virtualPath(dbPath));

    expect(session).not.toBeNull();
    expect(session!.messages.map(message => message.timestamp.toISOString())).toEqual([
      userCreatedAt,
      assistantCreatedAt,
    ]);
  });

  it('does not move endedAt behind the latest message when metadata is stale', async () => {
    const firstMessageAt = '2026-07-20T06:12:25.123Z';
    const staleMetadataAt = Date.parse('2026-07-20T06:15:00.000Z');
    const latestMessageAt = '2026-07-20T06:20:26.456Z';
    const dbPath = makeCursorDb(tempDir, {
      lastUpdatedAt: staleMetadataAt,
      conversation: [
        userBubble({ createdAt: firstMessageAt }),
        assistantBubble({ createdAt: latestMessageAt }),
      ],
    });

    const session = await provider.parse(virtualPath(dbPath));

    expect(session).not.toBeNull();
    expect(session!.endedAt.toISOString()).toBe(latestMessageAt);
    expect(Math.max(...session!.messages.map(message => message.timestamp.getTime())))
      .toBeLessThanOrEqual(session!.endedAt.getTime());
  });

  it('keeps endedAt at the latest message even when metadata is later', async () => {
    const firstMessageAt = '2026-07-20T06:12:25.123Z';
    const latestMessageAt = '2026-07-20T06:20:26.456Z';
    const metadataAt = '2026-07-20T06:25:00.000Z';
    const dbPath = makeCursorDb(tempDir, {
      lastUpdatedAt: Date.parse(metadataAt),
      conversation: [
        userBubble({ createdAt: firstMessageAt }),
        assistantBubble({ createdAt: latestMessageAt }),
      ],
    });

    const session = await provider.parse(virtualPath(dbPath));

    expect(session).not.toBeNull();
    expect(session!.endedAt.toISOString()).toBe(latestMessageAt);
  });

  it('uses composer metadata for both bounds when messages have no wall-clock timestamps', async () => {
    const createdAt = '2026-07-20T06:12:25.123Z';
    const lastUpdatedAt = '2026-07-20T06:25:00.000Z';
    const dbPath = makeCursorDb(tempDir, {
      createdAt: Date.parse(createdAt),
      lastUpdatedAt: Date.parse(lastUpdatedAt),
      conversation: [userBubble(), assistantBubble()],
    });

    const session = await provider.parse(virtualPath(dbPath));

    expect(session).not.toBeNull();
    expect(session!.startedAt.toISOString()).toBe(createdAt);
    expect(session!.endedAt.toISOString()).toBe(lastUpdatedAt);
  });

  it('uses timingInfo.clientRpcSendTime as the timestamp for assistant bubbles', async () => {
    const rpcTime = 1748076005959;
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble(),
        assistantBubble({ timingInfo: { clientRpcSendTime: rpcTime, clientStartTime: 926228.7 } }),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    const assistantMsg = session!.messages.find(m => m.type === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.timestamp.getTime()).toBe(rpcTime);
  });

  it('falls back to epoch when timingInfo is absent on an assistant bubble', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [userBubble(), assistantBubble()],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    const assistantMsg = session!.messages.find(m => m.type === 'assistant');
    expect(assistantMsg!.timestamp.getTime()).toBe(0);
  });

  it('ignores clientStartTime (performance offset < 1e12) and falls back to epoch', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble(),
        assistantBubble({ timingInfo: { clientStartTime: 926228.7 } }),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    const assistantMsg = session!.messages.find(m => m.type === 'assistant');
    expect(assistantMsg!.timestamp.getTime()).toBe(0);
  });

  it('falls back to epoch for user bubbles (no timestamp available)', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble(),
        assistantBubble({ timingInfo: { clientRpcSendTime: 1748076005959 } }),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    const userMsg = session!.messages.find(m => m.type === 'user');
    expect(userMsg!.timestamp.getTime()).toBe(0);
  });

  it('emits an exact replayed bubble once without double-counting its usage', async () => {
    const replayedAssistant = assistantBubble({
      bubbleId: 'replayed-assistant',
      createdAt: '2026-07-20T06:12:26.456Z',
      tokenCount: { inputTokens: 100, outputTokens: 50 },
    });
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ createdAt: '2026-07-20T06:12:25.123Z' }),
        replayedAssistant,
        { ...replayedAssistant },
      ],
    });

    const session = await provider.parse(virtualPath(dbPath));

    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);
    expect(session!.assistantMessageCount).toBe(1);
    expect(session!.usage).toMatchObject({
      totalInputTokens: 100,
      totalOutputTokens: 50,
    });
  });

  it('rejects conflicting payloads that reuse one bubble ID', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ bubbleId: 'conflict', text: 'First payload' }),
        userBubble({ bubbleId: 'conflict', text: 'Different payload' }),
        assistantBubble(),
      ],
    });

    await expect(provider.parse(virtualPath(dbPath))).rejects.toThrow(
      /conflicting Cursor bubble ID/i,
    );
  });

  it('rejects an incomplete headers-only snapshot instead of deleting the missing turn', async () => {
    const dbPath = makeCursorDb(tempDir, {
      fullConversationHeadersOnly: [{ bubbleId: 'broken-bubble', type: 1 }],
    });
    const db = new Database(dbPath);
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      `bubbleId:${COMPOSER_ID}:broken-bubble`,
      '{not-json}',
    );
    db.close();

    await expect(provider.parse(virtualPath(dbPath))).rejects.toThrow(
      /Cursor bubble/i,
    );
  });

  // ── Cost (usageData) ───────────────────────────────────────────────────────

  it('converts usageData.default.costInCents to estimatedCostUsd', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [userBubble(), assistantBubble()],
      usageData: { default: { costInCents: 44 } },
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.usage).toBeDefined();
    expect(session!.usage!.estimatedCostUsd).toBeCloseTo(0.44);
  });

  it('leaves usage undefined when usageData is absent and no token counts', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [userBubble(), assistantBubble()],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.usage).toBeUndefined();
  });

  it('leaves usage undefined when usageData.default is absent', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [userBubble(), assistantBubble()],
      usageData: {},
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.usage).toBeUndefined();
  });

  // ── Token counts ──────────────────────────────────────────────────────────

  it('aggregates tokenCount from multiple assistant bubbles', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ bubbleId: 'u1', text: 'First question' }),
        assistantBubble({ bubbleId: 'a1', text: 'First answer', tokenCount: { inputTokens: 100, outputTokens: 50 } }),
        userBubble({ bubbleId: 'u2', text: 'Second question' }),
        assistantBubble({ bubbleId: 'a2', text: 'Second answer', tokenCount: { inputTokens: 200, outputTokens: 75 } }),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.usage).toBeDefined();
    expect(session!.usage!.totalInputTokens).toBe(300);
    expect(session!.usage!.totalOutputTokens).toBe(125);
  });

  it('skips tokenCount on user bubbles (always 0/0)', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ tokenCount: { inputTokens: 0, outputTokens: 0 } }),
        assistantBubble({ tokenCount: { inputTokens: 150, outputTokens: 60 } }),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.usage!.totalInputTokens).toBe(150);
    expect(session!.usage!.totalOutputTokens).toBe(60);
  });

  // ── gitBranch ─────────────────────────────────────────────────────────────

  it('extracts gitBranch from gitStatusRaw on the first user bubble', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ gitStatusRaw: "On branch main\nYour branch is up to date.\n\nnothing to commit" }),
        assistantBubble(),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.gitBranch).toBe('main');
  });

  it('returns null gitBranch when gitStatusRaw shows detached HEAD', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ gitStatusRaw: 'HEAD detached at abc1234\nnothing to commit' }),
        assistantBubble(),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.gitBranch).toBeNull();
  });

  it('returns null gitBranch when git reports "(no branch)"', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ gitStatusRaw: 'On branch (no branch)\nInteractive rebase in progress' }),
        assistantBubble(),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.gitBranch).toBeNull();
  });

  it('returns null gitBranch when no gitStatusRaw is present', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [userBubble(), assistantBubble()],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.gitBranch).toBeNull();
  });

  // ── Lexical JSON in text field ────────────────────────────────────────────

  it('extracts plain text from Lexical JSON stored in the text field', async () => {
    const lexicalJson = JSON.stringify({
      root: {
        children: [
          {
            type: 'paragraph',
            children: [{ text: 'Go through the codebase and understand the project.' }],
          },
        ],
      },
    });
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ text: lexicalJson }),
        assistantBubble(),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    const userMsg = session!.messages.find(m => m.type === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('Go through the codebase and understand the project.');
    expect(userMsg!.content).not.toContain('{"root"');
  });

  it('leaves non-Lexical text field unchanged', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ text: 'How do I fix this bug?' }),
        assistantBubble(),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    const userMsg = session!.messages.find(m => m.type === 'user');
    expect(userMsg!.content).toBe('How do I fix this bug?');
  });

  // ── messageCount consistency ──────────────────────────────────────────────

  it('messageCount equals userMessageCount + assistantMessageCount', async () => {
    const dbPath = makeCursorDb(tempDir, {
      conversation: [
        userBubble({ bubbleId: 'u1' }),
        assistantBubble({ bubbleId: 'a1' }),
        userBubble({ bubbleId: 'u2', text: 'follow-up question' }),
        assistantBubble({ bubbleId: 'a2', text: 'follow-up answer' }),
      ],
    });
    const session = await provider.parse(virtualPath(dbPath));
    expect(session).not.toBeNull();
    expect(session!.messageCount).toBe(session!.userMessageCount + session!.assistantMessageCount);
    expect(session!.userMessageCount).toBe(2);
    expect(session!.assistantMessageCount).toBe(2);
    expect(session!.messageCount).toBe(4);
  });
});
