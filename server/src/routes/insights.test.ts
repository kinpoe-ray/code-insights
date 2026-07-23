import Database from 'better-sqlite3';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '@code-insights/cli/db/schema';

// ──────────────────────────────────────────────────────
// Module-scoped mutable DB reference for mocking.
// ──────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('@code-insights/cli/db/client', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock('@code-insights/cli/utils/telemetry', () => ({
  trackEvent: vi.fn(),
}));

const { createApp } = await import('../index.js');

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function initTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedProjectAndSession(projectId: string, sessionId: string) {
  testDb.prepare(`
    INSERT INTO projects (id, name, path, last_activity, session_count)
    VALUES (?, 'test', '/test', datetime('now'), 1)
  `).run(projectId);

  testDb.prepare(`
    INSERT INTO sessions (id, project_id, project_name, project_path,
      started_at, ended_at, message_count, source_tool)
    VALUES (?, ?, 'test', '/test', '2025-06-15T10:00:00Z', '2025-06-15T11:00:00Z', 5, 'claude-code')
  `).run(sessionId, projectId);
}

function seedInsight(
  id: string,
  sessionId: string,
  projectId: string,
  type: string,
) {
  testDb.prepare(`
    INSERT INTO insights (id, session_id, project_id, project_name, type, title, content,
      summary, confidence, source, timestamp, created_at)
    VALUES (?, ?, ?, 'test', ?, 'Test Title', 'Test content', 'Test summary', 80, 'llm',
      datetime('now'), datetime('now'))
  `).run(id, sessionId, projectId, type);
}

function seedMessage(
  id: string,
  sessionId: string,
  type: 'user' | 'assistant' | 'system',
  content: string,
  timestamp = '2025-06-15T10:00:00Z',
) {
  testDb.prepare(`
    INSERT INTO messages (id, session_id, type, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sessionId, type, content, timestamp);
}

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('Insights routes', () => {
  beforeEach(() => {
    testDb = initTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('GET /api/insights', () => {
    it('returns empty array when no insights exist', async () => {
      const app = createApp();
      const res = await app.request('/api/insights');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.insights).toEqual([]);
    });

    it('returns insights filtered by type', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('ins-1', 'sess-1', 'proj-1', 'summary');
      seedInsight('ins-2', 'sess-1', 'proj-1', 'decision');
      seedInsight('ins-3', 'sess-1', 'proj-1', 'learning');

      const app = createApp();
      const res = await app.request('/api/insights?type=decision');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.insights).toHaveLength(1);
      expect(body.insights[0].type).toBe('decision');
    });
  });

  describe('POST /api/insights', () => {
    it('creates an insight and returns 201', async () => {
      seedProjectAndSession('proj-1', 'sess-1');

      const app = createApp();
      const res = await app.request('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          projectId: 'proj-1',
          type: 'summary',
          title: 'Test insight',
          content: 'This is a test insight',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe('string');

      // Verify it was persisted
      const row = testDb
        .prepare('SELECT * FROM insights WHERE id = ?')
        .get(body.id) as { project_name: string };
      expect(row.project_name).toBe('test');
    });

    it('rejects a project that does not own the requested session', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      testDb.prepare(`
        INSERT INTO projects (id, name, path, last_activity)
        VALUES ('proj-2', 'other', '/other', datetime('now'))
      `).run();

      const app = createApp();
      const res = await app.request('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          projectId: 'proj-2',
          type: 'summary',
          title: 'Wrong project',
          content: 'Must not be persisted.',
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'projectId does not match the session project',
      });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM insights').get())
        .toEqual({ count: 0 });
    });

    it('returns 400 for missing required fields', async () => {
      const app = createApp();
      const res = await app.request('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          // missing projectId, type, title, content
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Missing or invalid field');
    });

    it('returns 400 for invalid type', async () => {
      seedProjectAndSession('proj-1', 'sess-1');

      const app = createApp();
      const res = await app.request('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          projectId: 'proj-1',
          type: 'invalid_type',
          title: 'Test',
          content: 'Test content',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('type must be one of');
    });

    it('rejects a decision when none of its evidence references a real message', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedMessage('msg-1', 'sess-1', 'user', 'Use a transaction.');

      const app = createApp();
      const res = await app.request('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          projectId: 'proj-1',
          type: 'decision',
          title: 'Use a transaction',
          content: 'Atomic writes avoid partial state.',
          metadata: {
            evidence: ['User#9: fabricated', 'msg-1'],
          },
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'decision requires at least one valid evidence reference',
      });

      const list = await app.request('/api/insights?sessionId=sess-1&type=decision');
      expect((await list.json()).insights).toEqual([]);
    });

    it('rejects a learning when none of its evidence references a real message', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedMessage('msg-1', 'sess-1', 'assistant', 'The transaction passed.');

      const app = createApp();
      const res = await app.request('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          projectId: 'proj-1',
          type: 'learning',
          title: 'Transactions are atomic',
          content: 'Use a transaction for snapshot replacement.',
          metadata: {
            evidence: ['Assistant#4: fabricated'],
          },
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'learning requires at least one valid evidence reference',
      });

      const list = await app.request('/api/insights?sessionId=sess-1&type=learning');
      expect((await list.json()).insights).toEqual([]);
    });

    it.each(['decision', 'learning'] as const)(
      'normalizes %s evidence and removes invalid siblings before persisting',
      async (type) => {
        seedProjectAndSession('proj-1', 'sess-1');
        seedMessage('msg-1', 'sess-1', 'user', 'Use a transaction.');

        const app = createApp();
        const res = await app.request('/api/insights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'sess-1',
            projectId: 'proj-1',
            type,
            title: type === 'decision' ? 'Use a transaction' : 'Transactions are atomic',
            content: 'Snapshot replacement must be atomic.',
            metadata: {
              evidence: ['User #0: real message', 'User#4: fabricated'],
              source_detail: 'preserved',
            },
          }),
        });

        expect(res.status).toBe(201);
        const list = await app.request(`/api/insights?sessionId=sess-1&type=${type}`);
        const metadata = JSON.parse((await list.json()).insights[0].metadata);
        expect(metadata).toEqual({
          evidence: ['User#0: real message'],
          source_detail: 'preserved',
        });
      },
    );

    it('filters and normalizes prompt-quality references before persisting metadata', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedMessage('msg-1', 'sess-1', 'user', 'First request.', '2025-06-15T10:00:00Z');
      seedMessage('msg-2', 'sess-1', 'user', 'Second request.', '2025-06-15T10:01:00Z');

      const app = createApp();
      const res = await app.request('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          projectId: 'proj-1',
          type: 'prompt_quality',
          title: 'Prompt quality',
          content: 'Prompt quality analysis',
          metadata: {
            efficiency_score: 75,
            message_overhead: 1,
            assessment: 'Mostly clear',
            dimension_scores: {
              context_provision: 70,
              request_specificity: 80,
              scope_management: 75,
              information_timing: 70,
              correction_quality: 80,
            },
            findings: [
              {
                category: 'specificity',
                type: 'strength',
                description: 'Grounded',
                message_ref: 'User #1: second request',
                impact: 'medium',
                confidence: 90,
              },
              {
                category: 'specificity',
                type: 'deficit',
                description: 'Fabricated',
                message_ref: 'User#2',
                impact: 'high',
                confidence: 90,
              },
            ],
            takeaways: [
              {
                type: 'reinforce',
                category: 'specificity',
                label: 'Grounded takeaway',
                message_ref: 'User#0: first request',
              },
              {
                type: 'improve',
                category: 'specificity',
                label: 'Fabricated takeaway',
                message_ref: 'msg-1',
              },
            ],
          },
        }),
      });

      expect(res.status).toBe(201);
      const list = await app.request('/api/insights?sessionId=sess-1&type=prompt_quality');
      const metadata = JSON.parse((await list.json()).insights[0].metadata);
      expect(metadata.findings).toEqual([
        expect.objectContaining({
          description: 'Grounded',
          message_ref: 'User#1',
        }),
      ]);
      expect(metadata.takeaways).toEqual([
        expect.objectContaining({
          label: 'Grounded takeaway',
          message_ref: 'User#0',
        }),
      ]);
    });
  });

  describe('DELETE /api/insights/:id', () => {
    it('deletes an existing insight', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('ins-del', 'sess-1', 'proj-1', 'summary');

      const app = createApp();
      const res = await app.request('/api/insights/ins-del', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify deleted
      const row = testDb
        .prepare('SELECT * FROM insights WHERE id = ?')
        .get('ins-del');
      expect(row).toBeUndefined();
    });

    it('returns 404 for missing insight ID', async () => {
      const app = createApp();
      const res = await app.request('/api/insights/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not found');
    });
  });
});
