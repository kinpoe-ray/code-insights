import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '@code-insights/cli/db/schema';

// ──────────────────────────────────────────────────────
// Module-scoped mutable DB reference for mocking.
// ──────────────────────────────────────────────────────

let testDb: Database.Database;
let lockTestDir: string;

function occupyLlmLock(): void {
  const lockPath = process.env.CODE_INSIGHTS_LLM_LOCK_DIR!;
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, 'pid'), `${process.pid}\n`);
}

vi.mock('@code-insights/cli/db/client', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock('@code-insights/cli/utils/telemetry', () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
  isTelemetryEnabled: () => false,
  getStableMachineId: () => 'test-id',
}));

const mockLoadConfiguredAnalysisLanguage = vi.hoisted(() => vi.fn(
  (): 'auto' | 'zh-CN' | 'en-US' => 'zh-CN',
));

vi.mock('@code-insights/cli/analysis/analysis-language', async (importOriginal) => ({
  ...await importOriginal<typeof import('@code-insights/cli/analysis/analysis-language')>(),
  loadConfiguredAnalysisLanguage: mockLoadConfiguredAnalysisLanguage,
}));

const mockIsLLMConfigured = vi.fn(() => false);
const mockChat = vi.fn();

vi.mock('../llm/client.js', () => ({
  isLLMConfigured: () => mockIsLLMConfigured(),
  createLLMClient: () => ({ chat: mockChat, provider: 'test', model: 'test-model', estimateTokens: (t: string) => Math.ceil(t.length / 4) }),
  loadLLMConfig: () => null,
}));

const { createApp } = await import('../index.js');
const { formatIsoWeek } = await import('./shared-aggregation.js');

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function initTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedSessionWithFacets(
  id: string,
  overrides: Partial<{
    projectId: string;
    projectName: string;
    startedAt: string;
    sourceTool: string;
    sessionCharacter: string;
    outcomeSatisfaction: string;
    workflowPattern: string | null;
    frictionPoints: unknown[];
    effectivePatterns: unknown[];
  }> = {},
) {
  const defaults = {
    projectId: 'proj-test',
    projectName: 'test-project',
    startedAt: '2025-06-15T10:00:00Z',
    sourceTool: 'claude-code',
    sessionCharacter: 'feature_build',
    outcomeSatisfaction: 'high',
    workflowPattern: 'plan-then-implement',
    frictionPoints: [],
    effectivePatterns: [],
  };
  const d = { ...defaults, ...overrides };

  // Ensure project exists
  testDb.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, last_activity, session_count)
    VALUES (?, ?, ?, datetime('now'), 1)
  `).run(d.projectId, d.projectName, `/projects/${d.projectName}`);

  // Insert session
  testDb.prepare(`
    INSERT OR IGNORE INTO sessions (
      id, project_id, project_name, project_path, started_at, ended_at,
      message_count, user_message_count, assistant_message_count, tool_call_count,
      source_tool, session_character
    ) VALUES (?, ?, ?, ?, ?, ?, 10, 5, 5, 2, ?, ?)
  `).run(
    id, d.projectId, d.projectName, `/projects/${d.projectName}`,
    d.startedAt, '2025-06-15T11:00:00Z', d.sourceTool, d.sessionCharacter,
  );

  // Insert facets
  testDb.prepare(`
    INSERT OR IGNORE INTO session_facets (
      session_id, outcome_satisfaction, workflow_pattern,
      had_course_correction, iteration_count,
      friction_points, effective_patterns
    ) VALUES (?, ?, ?, 0, 0, ?, ?)
  `).run(
    id, d.outcomeSatisfaction, d.workflowPattern,
    JSON.stringify(d.frictionPoints), JSON.stringify(d.effectivePatterns),
  );
}

// ──────────────────────────────────────────────────────
// SSE parsing helper
// ──────────────────────────────────────────────────────

function parseSSEEvents(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = text.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (event && data) events.push({ event, data });
  }
  return events;
}

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('Reflect routes', () => {
  beforeEach(() => {
    lockTestDir = mkdtempSync(join(tmpdir(), 'code-insights-server-lock-'));
    process.env.CODE_INSIGHTS_LLM_LOCK_DIR = join(lockTestDir, 'llm.lock');
    testDb = initTestDb();
    mockIsLLMConfigured.mockReturnValue(false);
    mockChat.mockReset();
    mockLoadConfiguredAnalysisLanguage.mockReset();
    mockLoadConfiguredAnalysisLanguage.mockReturnValue('zh-CN');
  });

  afterEach(() => {
    testDb.close();
    delete process.env.CODE_INSIGHTS_LLM_LOCK_DIR;
    rmSync(lockTestDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/reflect/results
  // ──────────────────────────────────────────────────────

  describe('GET /api/reflect/results', () => {
    it('returns aggregated data with zero sessions when no data exists', async () => {
      const app = createApp();
      const res = await app.request('/api/reflect/results');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSessions).toBe(0);
      expect(body.frictionCategories).toEqual([]);
      expect(body.effectivePatterns).toEqual([]);
    });

    it('returns aggregated friction and patterns when facets exist', async () => {
      seedSessionWithFacets('sess-1', {
        frictionPoints: [
          { category: 'wrong-approach', description: 'Used wrong pattern', severity: 'high', attribution: 'user-actionable', resolution: 'resolved' },
        ],
        effectivePatterns: [
          { category: 'verification-workflow', description: 'Ran tests before commit', confidence: 90, driver: 'user-driven' },
        ],
      });

      const app = createApp();
      const res = await app.request('/api/reflect/results?period=all');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSessions).toBe(1);

      const wrongApproach = body.frictionCategories.find(
        (fc: { category: string }) => fc.category === 'wrong-approach',
      );
      expect(wrongApproach).toBeDefined();
      expect(wrongApproach.count).toBe(1);

      const verificationWorkflow = body.effectivePatterns.find(
        (ep: { category: string }) => ep.category === 'verification-workflow',
      );
      expect(verificationWorkflow).toBeDefined();
      expect(verificationWorkflow.frequency).toBe(1);
    });

    it('filters by project query param', async () => {
      seedSessionWithFacets('sess-alpha', {
        projectId: 'proj-alpha',
        projectName: 'alpha',
        frictionPoints: [
          { category: 'knowledge-gap', description: 'Missing TS knowledge', severity: 'medium', attribution: 'user-actionable', resolution: 'resolved' },
        ],
      });
      seedSessionWithFacets('sess-beta', {
        projectId: 'proj-beta',
        projectName: 'beta',
        frictionPoints: [
          { category: 'scope-creep', description: 'Scope grew mid-session', severity: 'low', attribution: 'user-actionable', resolution: 'workaround' },
        ],
      });

      const app = createApp();
      const res = await app.request('/api/reflect/results?period=all&project=proj-alpha');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSessions).toBe(1);

      const knowledgeGap = body.frictionCategories.find(
        (fc: { category: string }) => fc.category === 'knowledge-gap',
      );
      expect(knowledgeGap).toBeDefined();

      const scopeCreep = body.frictionCategories.find(
        (fc: { category: string }) => fc.category === 'scope-creep',
      );
      expect(scopeCreep).toBeUndefined();
    });

    it('filters aggregate counts by source query param', async () => {
      seedSessionWithFacets('sess-claude-source', {
        sourceTool: 'claude-code',
      });
      seedSessionWithFacets('sess-codex-source-1', {
        sourceTool: 'codex-cli',
      });
      seedSessionWithFacets('sess-codex-source-2', {
        sourceTool: 'codex-cli',
      });

      const app = createApp();
      const res = await app.request(
        '/api/reflect/results?period=all&source=codex-cli',
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.totalSessions).toBe(2);
      expect(body.totalAllSessions).toBe(2);
      expect(body.sourceTools).toEqual(['codex-cli']);
    });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/reflect/snapshot
  // ──────────────────────────────────────────────────────

  describe('GET /api/reflect/snapshot', () => {
    it('returns null when no snapshot exists', async () => {
      const app = createApp();
      const res = await app.request('/api/reflect/snapshot?period=30d');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot).toBeNull();
    });

    it('returns saved snapshot after manual DB insert', async () => {
      const snapshotResults = {
        'friction-wins': { section: 'friction-wins', insights: [] },
      };
      testDb.prepare(`
        INSERT INTO reflect_snapshots (period, project_id, results_json, generated_at, window_start, window_end, session_count, facet_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '2026-W10',
        '__all__',
        JSON.stringify(snapshotResults),
        '2026-03-10T12:00:00Z',
        '2026-03-02T00:00:00Z',
        '2026-03-09T00:00:00Z',
        5,
        12,
      );

      const app = createApp();
      const res = await app.request('/api/reflect/snapshot?period=2026-W10');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot).not.toBeNull();
      expect(body.snapshot.period).toBe('2026-W10');
      expect(body.snapshot.projectId).toBe('__all__');
      expect(body.snapshot.sessionCount).toBe(5);
      expect(body.snapshot.facetCount).toBe(12);
      expect(body.snapshot.generatedAt).toBe('2026-03-10T12:00:00Z');
      expect(body.snapshot.results).toEqual(snapshotResults);
    });

    it('keeps snapshots for different source scopes independent', async () => {
      const insertSnapshot = testDb.prepare(`
        INSERT INTO reflect_snapshots (
          period, project_id, source_scope, results_json, generated_at,
          window_start, window_end, session_count, facet_count
        ) VALUES (?, '__all__', ?, ?, ?, NULL, ?, ?, ?)
      `);
      insertSnapshot.run(
        '2026-W10',
        'claude-code',
        JSON.stringify({ marker: 'claude' }),
        '2026-03-10T12:00:00Z',
        '2026-03-09T00:00:00Z',
        4,
        2,
      );
      insertSnapshot.run(
        '2026-W10',
        'codex-cli',
        JSON.stringify({ marker: 'codex' }),
        '2026-03-10T13:00:00Z',
        '2026-03-09T00:00:00Z',
        7,
        3,
      );

      const app = createApp();
      const claudeRes = await app.request(
        '/api/reflect/snapshot?period=2026-W10&source=claude-code',
      );
      const codexRes = await app.request(
        '/api/reflect/snapshot?period=2026-W10&source=codex-cli',
      );
      const unscopedRes = await app.request('/api/reflect/snapshot?period=2026-W10');

      expect((await claudeRes.json()).snapshot).toMatchObject({
        sourceScope: 'claude-code',
        results: { marker: 'claude' },
        sessionCount: 4,
      });
      expect((await codexRes.json()).snapshot).toMatchObject({
        sourceScope: 'codex-cli',
        results: { marker: 'codex' },
        sessionCount: 7,
      });
      expect((await unscopedRes.json()).snapshot).toBeNull();
    });

    it('returns null for corrupted snapshot JSON', async () => {
      testDb.prepare(`
        INSERT INTO reflect_snapshots (period, project_id, results_json, generated_at, window_start, window_end, session_count, facet_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '2026-W09',
        '__all__',
        'NOT_VALID_JSON{{{',
        '2026-03-03T12:00:00Z',
        '2026-02-23T00:00:00Z',
        '2026-03-02T00:00:00Z',
        3,
        7,
      );

      const app = createApp();
      const res = await app.request('/api/reflect/snapshot?period=2026-W09');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/reflect/weeks
  // ──────────────────────────────────────────────────────

  describe('GET /api/reflect/weeks', () => {
    it('returns weeks array spanning from earliest session through current week', async () => {
      // Seed a session so the endpoint has a range to generate
      const now = new Date();
      const nowDay = now.getUTCDay();
      const daysToMonday = nowDay === 0 ? 6 : nowDay - 1;
      const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysToMonday * 86400000);
      const sessionStart = new Date(thisMonday.getTime() + 3600000).toISOString(); // Monday + 1 hour
      seedSessionWithFacets('sess-shape-1', { startedAt: sessionStart });

      const app = createApp();
      const res = await app.request('/api/reflect/weeks');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.weeks)).toBe(true);
      // Data-driven: at minimum contains the current week (where the seeded session lives)
      expect(body.weeks.length).toBeGreaterThanOrEqual(1);
      // Most recent week is first
      expect(body.weeks[0].week).toMatch(/^\d{4}-W\d{2}$/);
    });

    it('each week entry has ISO week format and required fields', async () => {
      const app = createApp();
      const res = await app.request('/api/reflect/weeks');
      const body = await res.json();

      for (const entry of body.weeks) {
        // ISO week format: YYYY-WNN
        expect(entry.week).toMatch(/^\d{4}-W\d{2}$/);
        expect(typeof entry.sessionCount).toBe('number');
        expect(typeof entry.hasSnapshot).toBe('boolean');
        // generatedAt is either null or a string
        expect(entry.generatedAt === null || typeof entry.generatedAt === 'string').toBe(true);
      }
    });

    it('reflects hasSnapshot true and generatedAt when a snapshot exists for a week', async () => {
      // Find the current ISO week to insert a matching snapshot
      const now = new Date();
      const nowDay = now.getUTCDay();
      const daysToMonday = nowDay === 0 ? 6 : nowDay - 1;
      const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysToMonday * 86400000);
      const year = thisMonday.getUTCFullYear();
      // Compute ISO week number
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4Day = jan4.getUTCDay() || 7;
      const weekNum = Math.ceil(((thisMonday.getTime() - jan4.getTime()) / 86400000 + jan4Day) / 7);
      const currentWeek = `${year}-W${String(weekNum).padStart(2, '0')}`;

      // Seed a session in the current week so the endpoint generates a week range
      const sessionStart = new Date(thisMonday.getTime() + 3600000).toISOString(); // Monday + 1 hour
      seedSessionWithFacets('sess-snapshot-1', { startedAt: sessionStart });

      testDb.prepare(`
        INSERT INTO reflect_snapshots (period, project_id, results_json, generated_at, window_start, window_end, session_count, facet_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        currentWeek,
        '__all__',
        JSON.stringify({ 'friction-wins': {} }),
        '2026-03-13T10:00:00Z',
        thisMonday.toISOString(),
        now.toISOString(),
        3,
        6,
      );

      const app = createApp();
      const res = await app.request('/api/reflect/weeks');
      const body = await res.json();

      const weekEntry = body.weeks.find((w: { week: string }) => w.week === currentWeek);
      expect(weekEntry).toBeDefined();
      expect(weekEntry.hasSnapshot).toBe(true);
      expect(weekEntry.generatedAt).toBe('2026-03-13T10:00:00Z');
    });

    it('sessionCount reflects seeded sessions in the correct week', async () => {
      // Seed a session with startedAt in the current ISO week
      const now = new Date();
      const nowDay = now.getUTCDay();
      const daysToMonday = nowDay === 0 ? 6 : nowDay - 1;
      const thisMonday = new Date(now.getTime() - daysToMonday * 86400000);
      // Use Monday itself as the session start time
      const sessionStart = new Date(thisMonday.getTime() + 3600000).toISOString(); // Monday + 1 hour

      seedSessionWithFacets('sess-week-1', { startedAt: sessionStart });
      seedSessionWithFacets('sess-week-2', { startedAt: sessionStart });

      const app = createApp();
      const res = await app.request('/api/reflect/weeks');
      const body = await res.json();

      // The first entry in weeks is the most recent week (current)
      const currentWeekEntry = body.weeks[0];
      expect(currentWeekEntry.sessionCount).toBeGreaterThanOrEqual(2);
    });

    it('counts a Sunday session in the previous ISO week', async () => {
      const now = new Date();
      const nowDay = now.getUTCDay();
      const daysToMonday = nowDay === 0 ? 6 : nowDay - 1;
      const thisMondayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        - daysToMonday * 86400000;
      const thisMonday = new Date(thisMondayMs);
      const previousMonday = new Date(thisMondayMs - 7 * 86400000);
      const previousSundayNoon = new Date(thisMondayMs - 12 * 3600000);

      seedSessionWithFacets('sess-previous-sunday', { startedAt: previousSundayNoon.toISOString() });

      const app = createApp();
      const res = await app.request('/api/reflect/weeks');
      const body = await res.json();
      const currentWeek = body.weeks.find((w: { week: string }) => w.week === formatIsoWeek(thisMonday));
      const previousWeek = body.weeks.find((w: { week: string }) => w.week === formatIsoWeek(previousMonday));

      expect(previousWeek.sessionCount).toBe(1);
      expect(currentWeek.sessionCount).toBe(0);
    });

    it('filters week range, session counts, and snapshot status by source', async () => {
      const now = new Date();
      const nowDay = now.getUTCDay();
      const daysToMonday = nowDay === 0 ? 6 : nowDay - 1;
      const thisMondayMs = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
      ) - daysToMonday * 86400000;
      const thisMonday = new Date(thisMondayMs);
      const currentWeek = formatIsoWeek(thisMonday);

      seedSessionWithFacets('sess-codex-current', {
        sourceTool: 'codex-cli',
        startedAt: new Date(thisMondayMs + 3600000).toISOString(),
      });
      seedSessionWithFacets('sess-claude-current', {
        sourceTool: 'claude-code',
        startedAt: new Date(thisMondayMs + 7200000).toISOString(),
      });
      seedSessionWithFacets('sess-claude-old', {
        sourceTool: 'claude-code',
        startedAt: new Date(thisMondayMs - 21 * 86400000).toISOString(),
      });

      testDb.prepare(`
        INSERT INTO reflect_snapshots (
          period, project_id, source_scope, results_json, generated_at,
          window_start, window_end, session_count, facet_count
        ) VALUES (?, '__all__', 'claude-code', '{}', ?, ?, ?, 2, 0)
      `).run(
        currentWeek,
        '2026-07-18T00:00:00Z',
        thisMonday.toISOString(),
        new Date(thisMondayMs + 7 * 86400000).toISOString(),
      );

      const app = createApp();
      const response = await app.request('/api/reflect/weeks?source=codex-cli');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.weeks).toHaveLength(1);
      expect(body.weeks[0]).toMatchObject({
        week: currentWeek,
        sessionCount: 1,
        hasSnapshot: false,
        generatedAt: null,
      });
    });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/reflect/weeks — with project filter
  // ──────────────────────────────────────────────────────

  describe('GET /api/reflect/weeks — project filter', () => {
    it('filters sessionCount to only the specified project', async () => {
      const now = new Date();
      const nowDay = now.getUTCDay();
      const daysToMonday = nowDay === 0 ? 6 : nowDay - 1;
      const thisMonday = new Date(now.getTime() - daysToMonday * 86400000);
      const sessionStart = new Date(thisMonday.getTime() + 3600000).toISOString(); // Monday + 1 hour

      // Seed one session for the filter project and one for another project
      seedSessionWithFacets('sess-proj-filter', { projectId: 'proj-filter', projectName: 'filter-proj', startedAt: sessionStart });
      seedSessionWithFacets('sess-other-project', { projectId: 'proj-other', projectName: 'other-proj', startedAt: sessionStart });

      const app = createApp();
      const res = await app.request('/api/reflect/weeks?project=proj-filter');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(Array.isArray(body.weeks)).toBe(true);
      const currentWeekEntry = body.weeks[0];
      // Only sessions from proj-filter should be counted
      expect(currentWeekEntry.sessionCount).toBeGreaterThanOrEqual(1);

      // The total across all weeks should be less than 2 (the other project's session excluded)
      const totalSessionCount = body.weeks.reduce((sum: number, w: { sessionCount: number }) => sum + w.sessionCount, 0);
      expect(totalSessionCount).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────
  // POST /api/reflect/generate
  // ──────────────────────────────────────────────────────

  describe('POST /api/reflect/generate', () => {
    // Helper: seed N sessions with varied friction + patterns for generate tests
    function seedMultipleSessions(count: number) {
      for (let i = 0; i < count; i++) {
        seedSessionWithFacets(`sess-gen-${i}`, {
          frictionPoints: i % 3 === 0 ? [
            { category: 'wrong-approach', description: `friction ${i}`, severity: 'medium', attribution: 'user-actionable' },
          ] : [],
          effectivePatterns: i % 2 === 0 ? [
            { category: 'structured-planning', description: `pattern ${i}`, confidence: 80, driver: 'user-driven' },
          ] : [],
          outcomeSatisfaction: i % 2 === 0 ? 'high' : 'moderate',
          workflowPattern: i % 2 === 0 ? 'plan-then-implement' : 'iterative',
          sessionCharacter: i % 3 === 0 ? 'feature_build' : i % 3 === 1 ? 'bug_hunt' : 'exploration',
        });
      }
    }

    it('returns 400 when LLM not configured', async () => {
      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: '30d' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('LLM not configured');
    });

    it('streams SSE error when no sessions with facets found', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all' }),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeDefined();
      const errorData = JSON.parse(errorEvent!.data);
      expect(errorData.error).toContain('No sessions with facets found');
    });

    it('streams SSE error with INSUFFICIENT_FACETS code when below threshold', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      // Seed only 3 sessions (below MIN_FACETS_FOR_REFLECT = 8)
      for (let i = 0; i < 3; i++) {
        seedSessionWithFacets(`sess-few-${i}`, {});
      }

      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all' }),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeDefined();
      const errorData = JSON.parse(errorEvent!.data);
      expect(errorData.code).toBe('INSUFFICIENT_FACETS');
      expect(errorData.current).toBe(3);
      expect(errorData.required).toBe(8);
    });

    it('sends a recognizable busy error without calling the LLM', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '<json>{}</json>' });
      seedMultipleSessions(8);
      occupyLlmLock();

      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all', sections: ['friction-wins'] }),
      });
      const text = await res.text();

      expect(text).toContain('event: error');
      expect(text).toContain('LLM_BUSY');
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('streams progress and complete events for friction-wins section', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '<json>{"narrative":"test","topFriction":[],"topWins":[]}</json>' });

      seedMultipleSessions(10);

      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all', sections: ['friction-wins'] }),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const progressEvents = events.filter(e => e.event === 'progress');
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);

      const completeEvent = events.find(e => e.event === 'complete');
      expect(completeEvent).toBeDefined();
      const completeData = JSON.parse(completeEvent!.data);
      expect(completeData.results).toHaveProperty('friction-wins');
      expect(completeData.results['friction-wins'].section).toBe('friction-wins');
      expect(JSON.stringify(mockChat.mock.calls[0][0]))
        .toContain('Simplified Chinese (zh-CN)');
    });

    it('ignores stored system artifacts when Reflect resolves auto language', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockLoadConfiguredAnalysisLanguage.mockReturnValue('auto');
      mockChat.mockResolvedValue({ content: '<json>{"narrative":"test","topFriction":[],"topWins":[]}</json>' });
      seedMultipleSessions(8);
      const insertMessage = testDb.prepare(`
        INSERT INTO messages (id, session_id, type, content, timestamp)
        VALUES (?, 'sess-gen-0', 'user', ?, ?)
      `);
      [
        'Please analyze these sessions.',
        'Keep the result concise.',
        '<task-notification>大量中文任务通知</task-notification>',
        'Base directory for this skill: /大量/中文/路径',
        '<local-command-caveat>大量中文提示</local-command-caveat>',
        '<local-command-stdout>大量中文输出</local-command-stdout>',
        '<command-name>/plan 大量中文参数</command-name>',
      ].forEach((content, index) => {
        insertMessage.run(
          `reflect-language-${index}`,
          content,
          `2025-06-15T10:${String(index).padStart(2, '0')}:00Z`,
        );
      });

      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all', sections: ['friction-wins'] }),
      });
      await res.text();

      expect(JSON.stringify(mockChat.mock.calls[0][0])).toContain('English (en-US)');
    });

    it('streams complete event for working-style section', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '<json>{"tagline":"The Builder","narrative":"You build things."}</json>' });

      seedMultipleSessions(10);

      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all', sections: ['working-style'] }),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const completeEvent = events.find(e => e.event === 'complete');
      expect(completeEvent).toBeDefined();
      const completeData = JSON.parse(completeEvent!.data);
      expect(completeData.results).toHaveProperty('working-style');
      expect(completeData.results['working-style'].section).toBe('working-style');
      // tagline should be sanitized to ≤40 chars string
      expect(typeof completeData.results['working-style'].tagline).toBe('string');
    });

    it('streams complete event for rules-skills section', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '<json>{"claudeMdRules":[],"hookConfigs":[]}</json>' });

      // Seed 10 sessions with 3+ friction in same category to satisfy rules threshold
      for (let i = 0; i < 10; i++) {
        seedSessionWithFacets(`sess-rules-${i}`, {
          frictionPoints: [
            { category: 'wrong-approach', description: `friction ${i}`, severity: 'medium', attribution: 'user-actionable' },
          ],
          effectivePatterns: i % 2 === 0 ? [
            { category: 'structured-planning', description: `pattern ${i}`, confidence: 80, driver: 'user-driven' },
          ] : [],
        });
      }

      const app = createApp();
      const res = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all', sections: ['rules-skills'] }),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const completeEvent = events.find(e => e.event === 'complete');
      expect(completeEvent).toBeDefined();
      const completeData = JSON.parse(completeEvent!.data);
      expect(completeData.results).toHaveProperty('rules-skills');
      expect(completeData.results['rules-skills'].section).toBe('rules-skills');
    });

    it('saves snapshot after successful generation', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '<json>{"narrative":"test","topFriction":[],"topWins":[]}</json>' });

      seedMultipleSessions(10);

      const app = createApp();

      // Trigger generation
      const generateRes = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all', sections: ['friction-wins'] }),
      });

      const generateText = await generateRes.text();
      const generateEvents = parseSSEEvents(generateText);
      const completeEvent = generateEvents.find(e => e.event === 'complete');
      expect(completeEvent).toBeDefined();

      // Fetch snapshot for the same period
      const snapshotRes = await app.request('/api/reflect/snapshot?period=all');
      expect(snapshotRes.status).toBe(200);
      const snapshotBody = await snapshotRes.json();
      expect(snapshotBody.snapshot).not.toBeNull();
      expect(snapshotBody.snapshot.period).toBe('all');
      expect(snapshotBody.snapshot.results).toHaveProperty('friction-wins');
    });

    it('stores generated snapshots independently for each source scope', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat
        .mockResolvedValueOnce({ content: '<json>{"narrative":"claude result"}</json>' })
        .mockResolvedValueOnce({ content: '<json>{"narrative":"codex result"}</json>' });

      for (let i = 0; i < 8; i++) {
        seedSessionWithFacets(`sess-claude-scope-${i}`, {
          sourceTool: 'claude-code',
        });
        seedSessionWithFacets(`sess-codex-scope-${i}`, {
          sourceTool: 'codex-cli',
        });
      }

      const app = createApp();
      for (const source of ['claude-code', 'codex-cli']) {
        const response = await app.request('/api/reflect/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            period: 'all',
            source,
            sections: ['friction-wins'],
          }),
        });
        const events = parseSSEEvents(await response.text());
        expect(events.some(event => event.event === 'complete')).toBe(true);
      }

      const claudeSnapshot = await (
        await app.request('/api/reflect/snapshot?period=all&source=claude-code')
      ).json();
      const codexSnapshot = await (
        await app.request('/api/reflect/snapshot?period=all&source=codex-cli')
      ).json();

      expect(claudeSnapshot.snapshot).toMatchObject({
        sourceScope: 'claude-code',
        sessionCount: 8,
        results: {
          'friction-wins': { narrative: 'claude result' },
        },
      });
      expect(codexSnapshot.snapshot).toMatchObject({
        sourceScope: 'codex-cli',
        sessionCount: 8,
        results: {
          'friction-wins': { narrative: 'codex result' },
        },
      });
    });

    it('targets the requested source tool when generating rules', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({
        content: '<json>{"claudeMdRules":[],"hookConfigs":[]}</json>',
      });

      for (let i = 0; i < 10; i++) {
        seedSessionWithFacets(`sess-global-majority-${i}`, {
          sourceTool: 'claude-code',
        });
      }
      for (let i = 0; i < 8; i++) {
        seedSessionWithFacets(`sess-filtered-source-${i}`, {
          sourceTool: 'codex-cli',
        });
      }

      const app = createApp();
      const response = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: 'all',
          source: 'codex-cli',
          sections: ['rules-skills'],
        }),
      });
      const events = parseSSEEvents(await response.text());
      const complete = events.find(event => event.event === 'complete');

      expect(complete).toBeDefined();
      expect(JSON.parse(complete!.data).results['rules-skills'].targetTool).toBe(
        'codex-cli',
      );
    });

    it('detects the target tool inside the selected project scope', async () => {
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({
        content: '<json>{"claudeMdRules":[],"hookConfigs":[]}</json>',
      });

      for (let i = 0; i < 10; i++) {
        seedSessionWithFacets(`sess-other-project-${i}`, {
          projectId: 'proj-other',
          projectName: 'other',
          sourceTool: 'claude-code',
        });
      }
      for (let i = 0; i < 8; i++) {
        seedSessionWithFacets(`sess-selected-project-${i}`, {
          projectId: 'proj-selected',
          projectName: 'selected',
          sourceTool: 'codex-cli',
        });
      }

      const app = createApp();
      const response = await app.request('/api/reflect/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: 'all',
          project: 'proj-selected',
          sections: ['rules-skills'],
        }),
      });
      const events = parseSSEEvents(await response.text());
      const complete = events.find(event => event.event === 'complete');

      expect(complete).toBeDefined();
      expect(JSON.parse(complete!.data).results['rules-skills'].targetTool).toBe(
        'codex-cli',
      );
    });
  });
});
