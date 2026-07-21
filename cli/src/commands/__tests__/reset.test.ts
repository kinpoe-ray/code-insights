import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../../__fixtures__/db/seed.js';

let testDb: Database.Database;

const spinner = vi.hoisted(() => ({
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
  info: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
spinner.start.mockReturnValue(spinner);

vi.mock('ora', () => ({
  default: () => spinner,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    unlinkSync: fsMocks.unlinkSync,
  };
});

vi.mock('../../db/client.js', () => ({
  getDb: () => testDb,
  getDbPath: () => ':memory:',
}));

vi.mock('../../utils/config.js', () => ({
  getSyncStatePath: () => '/tmp/code-insights-reset-test-sync-state.json',
}));

vi.mock('../../utils/telemetry.js', () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
  classifyError: vi.fn(() => ({ error_type: 'unknown', error_message: 'unknown' })),
}));

const { resetCommand } = await import('../reset.js');

function readDatabaseIdentityState(db: Database.Database): {
  databaseId: string;
  syncGeneration: string;
  identity: string;
} {
  const rows = db
    .prepare(`
      SELECT key, value
      FROM code_insights_metadata
      WHERE key IN ('database_id', 'sync_generation')
    `)
    .all() as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const databaseId = values.get('database_id');
  const syncGeneration = values.get('sync_generation');

  if (!databaseId || !syncGeneration) {
    throw new Error('Expected database identity metadata');
  }

  return {
    databaseId,
    syncGeneration,
    identity: `${databaseId}#${syncGeneration}`,
  };
}

describe('reset command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinner.start.mockReturnValue(spinner);
    fsMocks.existsSync.mockReturnValue(false);
    testDb = createTestDb();
    testDb.pragma('foreign_keys = ON');
    process.exitCode = undefined;
  });

  afterEach(() => {
    testDb.close();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('clears session data even when usage and queue rows enforce foreign keys', async () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('reset-project', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('reset-session', 'reset-project', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00');
      INSERT INTO messages (id, session_id, type, timestamp)
      VALUES ('reset-message', 'reset-session', 'user', '2026-07-14 10:05:00');
      INSERT INTO insights
        (id, session_id, project_id, project_name, type, title, content, summary, confidence, timestamp)
      VALUES
        ('reset-insight', 'reset-session', 'reset-project', 'project', 'learning', 'title', 'content', 'summary', 0.9, '2026-07-14 10:30:00');
      INSERT INTO session_facets (session_id, outcome_satisfaction)
      VALUES ('reset-session', 'high');
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model)
      VALUES ('reset-session', 'session', 'anthropic', 'claude');
      INSERT INTO analysis_queue (session_id)
      VALUES ('reset-session');
      INSERT INTO analysis_campaigns (
        id, intent_fingerprint, provider, model, analysis_version,
        pipeline_revision, base_url_fingerprint,
        scope_json, selection_fingerprint, total_items
      ) VALUES (
        'reset-campaign', 'intent', 'anthropic', 'glm-5.2', '3.0.0',
        'analysis-3.0.0/two-pass-v1', 'endpoint',
        '{}', 'selection', 1
      );
      INSERT INTO analysis_campaign_items (
        campaign_id, session_id, ordinal, message_count, input_revision
      ) VALUES ('reset-campaign', 'reset-session', 0, 3, 'revision');
      INSERT INTO analysis_campaign_snapshots (
        campaign_id, session_id, insights_json, usage_json, generated_title_json
      ) VALUES ('reset-campaign', 'reset-session', '[]', '[]', 'null');
      INSERT INTO reflect_snapshots
        (period, project_id, results_json, generated_at, window_end, session_count, facet_count)
      VALUES ('30d', 'reset-project', '{}', '2026-07-14 10:30:00', '2026-07-14 10:30:00', 1, 1);
      INSERT INTO usage_stats (id) VALUES (1);
    `);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await resetCommand.parseAsync(['node', 'code-insights', '--confirm']);

    const dataTables = [
      'analysis_campaign_snapshots',
      'analysis_campaign_items',
      'analysis_campaigns',
      'analysis_queue',
      'analysis_usage',
      'insights',
      'session_facets',
      'reflect_snapshots',
      'messages',
      'sessions',
      'projects',
      'usage_stats',
    ];
    const counts = dataTables.map((table) =>
      testDb.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
    );
    expect(counts).toEqual(dataTables.map(() => 0));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('fails clearly after an unlink error while leaving an empty database with a new sync identity', async () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('reset-project', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('reset-session', 'reset-project', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00');
      INSERT INTO messages (id, session_id, type, timestamp)
      VALUES ('reset-message', 'reset-session', 'user', '2026-07-14 10:05:00');
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model)
      VALUES ('reset-session', 'session', 'anthropic', 'claude');
      INSERT INTO analysis_queue (session_id)
      VALUES ('reset-session');
    `);
    const identityBeforeReset = readDatabaseIdentityState(testDb);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.unlinkSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await resetCommand.parseAsync(['node', 'code-insights', '--confirm']);

    const identityAfterReset = readDatabaseIdentityState(testDb);
    expect(
      ['analysis_queue', 'analysis_usage', 'messages', 'sessions', 'projects'].map((table) =>
        testDb.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
      ),
    ).toEqual([0, 0, 0, 0, 0]);
    expect(identityAfterReset.databaseId).toBe(identityBeforeReset.databaseId);
    expect(identityAfterReset.syncGeneration).not.toBe(identityBeforeReset.syncGeneration);
    expect(identityAfterReset.identity).not.toBe(identityBeforeReset.identity);
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(
      '/tmp/code-insights-reset-test-sync-state.json',
    );
    expect(spinner.fail).toHaveBeenCalledWith(
      expect.stringContaining('EACCES: permission denied'),
    );
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
  });
});
