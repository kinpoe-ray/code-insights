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

function insertProject(id: string, name = id) {
  testDb.prepare(`
    INSERT INTO projects (id, name, path, last_activity)
    VALUES (?, ?, ?, ?)
  `).run(id, name, `/workspace/${id}`, new Date().toISOString());
}

function insertSession(options: {
  id: string;
  projectId: string;
  projectName?: string;
  startedAt: string;
  sourceTool?: string;
  usage?: boolean;
  model?: string;
}) {
  const endedAt = new Date(new Date(options.startedAt).getTime() + 30 * 60_000).toISOString();
  testDb.prepare(`
    INSERT INTO sessions (
      id, project_id, project_name, project_path, started_at, ended_at,
      source_tool, message_count, tool_call_count, synced_at,
      total_input_tokens, total_output_tokens, estimated_cost_usd,
      usage_source, primary_model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 10, 4, ?, ?, ?, ?, ?, ?)
  `).run(
    options.id,
    options.projectId,
    options.projectName ?? options.projectId,
    `/workspace/${options.projectId}`,
    options.startedAt,
    endedAt,
    options.sourceTool ?? 'codex-cli',
    endedAt,
    options.usage ? 1_000 : null,
    options.usage ? 500 : null,
    options.usage ? 0.25 : null,
    options.usage ? 'jsonl' : null,
    options.model ?? null,
  );
}

function insertInsight(options: {
  id: string;
  sessionId: string;
  projectId: string;
  type: string;
  createdAt: string;
}) {
  testDb.prepare(`
    INSERT INTO insights (
      id, session_id, project_id, project_name, type, title, content,
      summary, confidence, timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 90, ?, ?)
  `).run(
    options.id,
    options.sessionId,
    options.projectId,
    options.projectId,
    options.type,
    `Insight ${options.id}`,
    'Test content',
    options.createdAt,
    options.createdAt,
  );
}

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('Analytics routes', () => {
  beforeEach(() => {
    testDb = initTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('GET /api/analytics/dashboard', () => {
    it('returns stats shape with default range', async () => {
      const app = createApp();
      const res = await app.request('/api/analytics/dashboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.range).toBe('7d');
      expect(body.stats).toBeDefined();
      expect(body.stats.session_count).toBe(0);
    });

    it('accepts valid range parameter', async () => {
      const app = createApp();
      const res = await app.request('/api/analytics/dashboard?range=30d');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.range).toBe('30d');
    });

    it('returns 400 for invalid range', async () => {
      const app = createApp();
      const res = await app.request('/api/analytics/dashboard?range=invalid');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid range');
    });
  });

  describe('GET /api/analytics/usage', () => {
    it('returns null stats when no usage data exists', async () => {
      const app = createApp();
      const res = await app.request('/api/analytics/usage');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stats).toBeNull();
    });

    it('returns usage stats when data exists', async () => {
      testDb.prepare(`
        INSERT INTO usage_stats (
          id, total_input_tokens, total_output_tokens,
          estimated_cost_usd, sessions_with_usage
        ) VALUES (1, 10000, 20000, 1.50, 5)
      `).run();

      const app = createApp();
      const res = await app.request('/api/analytics/usage');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stats).not.toBeNull();
      expect(body.stats.total_input_tokens).toBe(10000);
      expect(body.stats.total_output_tokens).toBe(20000);
      expect(body.stats.estimated_cost_usd).toBe(1.5);
    });
  });

  describe('GET /api/analytics/overview', () => {
    it('returns a complete seven-day series and explicit zero coverage for an empty database', async () => {
      const app = createApp();
      const res = await app.request('/api/analytics/overview?range=7d&timezoneOffset=0');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.daily).toHaveLength(7);
      expect(body.summary).toMatchObject({
        session_count: 0,
        insight_count: 0,
        estimated_cost_usd: 0,
      });
      expect(body.coverage).toMatchObject({
        analyzed_sessions: 0,
        usage_covered_sessions: 0,
        model_covered_sessions: 0,
      });
      expect(body.unanalyzed_session_ids).toEqual([]);
    });

    it('attributes insights to the session day and reports analysis and usage coverage separately', async () => {
      insertProject('project-a', 'Shared name');
      insertProject('project-b', 'Shared name');

      const sessionDate = new Date(Date.now() - 2 * 86_400_000);
      sessionDate.setUTCHours(8, 0, 0, 0);
      const oldDate = new Date(Date.now() - 12 * 86_400_000).toISOString();
      const analysisDate = new Date().toISOString();

      insertSession({
        id: 'session-a',
        projectId: 'project-a',
        projectName: 'Shared name',
        startedAt: sessionDate.toISOString(),
        usage: true,
        model: 'test-model',
      });
      insertSession({
        id: 'session-b',
        projectId: 'project-b',
        projectName: 'Shared name',
        startedAt: sessionDate.toISOString(),
      });
      insertSession({
        id: 'old-session',
        projectId: 'project-a',
        projectName: 'Shared name',
        startedAt: oldDate,
        usage: true,
        model: 'old-model',
      });

      insertInsight({ id: 'summary-a', sessionId: 'session-a', projectId: 'project-a', type: 'summary', createdAt: analysisDate });
      insertInsight({ id: 'decision-a', sessionId: 'session-a', projectId: 'project-a', type: 'decision', createdAt: analysisDate });
      insertInsight({ id: 'pq-b', sessionId: 'session-b', projectId: 'project-b', type: 'prompt_quality', createdAt: analysisDate });

      const app = createApp();
      const res = await app.request('/api/analytics/overview?range=7d&timezoneOffset=0');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary).toMatchObject({
        session_count: 2,
        insight_count: 3,
        active_projects: 2,
        estimated_cost_usd: 0.25,
      });
      expect(body.coverage).toMatchObject({
        analyzed_sessions: 1,
        usage_covered_sessions: 1,
        model_covered_sessions: 1,
      });
      expect(body.insight_types).toEqual({
        summary: 1,
        decision: 1,
        learning: 0,
        prompt_quality: 1,
      });
      expect(body.models).toEqual([{ model: 'test-model', session_count: 1 }]);
      expect(body.projects).toHaveLength(2);
      expect(body.unanalyzed_session_ids).toEqual(['session-b']);

      const sessionDay = sessionDate.toISOString().slice(0, 10);
      expect(body.daily.find((day: { date: string }) => day.date === sessionDay)).toMatchObject({
        session_count: 2,
        insight_count: 3,
      });
      const analysisDay = analysisDate.slice(0, 10);
      if (analysisDay !== sessionDay) {
        expect(body.daily.find((day: { date: string }) => day.date === analysisDay)).toMatchObject({
          session_count: 0,
          insight_count: 0,
        });
      }
    });

    it('applies source filters before computing every metric', async () => {
      insertProject('project-a');
      const startedAt = new Date().toISOString();
      insertSession({ id: 'codex', projectId: 'project-a', startedAt, sourceTool: 'codex-cli' });
      insertSession({ id: 'claude', projectId: 'project-a', startedAt, sourceTool: 'claude-code' });

      const app = createApp();
      const res = await app.request('/api/analytics/overview?range=7d&source=codex-cli');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.summary.session_count).toBe(1);
      expect(body.source).toBe('codex-cli');
      expect(body.unanalyzed_session_ids).toEqual(['codex']);
    });

    it('reports the actual first session as the all-time window start', async () => {
      insertProject('project-a');
      insertSession({
        id: 'first',
        projectId: 'project-a',
        startedAt: '2024-02-03T04:05:06.000Z',
      });
      insertSession({
        id: 'later',
        projectId: 'project-a',
        startedAt: '2025-03-04T05:06:07.000Z',
      });

      const app = createApp();
      const res = await app.request('/api/analytics/overview?range=all');
      const body = await res.json();

      expect(body.window_start).toBe('2024-02-03T04:05:06.000Z');
      expect(body.activity_grain).toBe('month');
      expect(body.daily[0]).toMatchObject({ date: '2024-02-01', session_count: 1 });
      expect(body.daily.some((point: { date: string; session_count: number }) => (
        point.date === '2025-03-01' && point.session_count === 1
      ))).toBe(true);
      expect(body.daily.some((point: { session_count: number }) => point.session_count === 0)).toBe(true);
    });

    it('rejects invalid timezone offsets', async () => {
      const app = createApp();
      const res = await app.request('/api/analytics/overview?timezoneOffset=not-a-number');
      expect(res.status).toBe(400);
    });
  });
});
