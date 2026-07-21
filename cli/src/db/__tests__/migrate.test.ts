import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { SCHEMA_SQL } from '../schema.js';

// ──────────────────────────────────────────────────────
// Migration tests focusing on behavior NOT already covered
// by cli/src/db/schema.test.ts.
//
// schema.test.ts covers: applies without error, version = CURRENT,
// table existence, v6Applied/v7Applied return values, V6 column
// defaults, and the "no error on double run" idempotency check.
//
// This file covers the complementary behaviors: the strict
// no-duplicate-row guarantee, analysis_usage (V7) composite PK
// semantics, the upsert contract that callers depend on, and
// V9 analysis_queue table structure.
// ──────────────────────────────────────────────────────

function freshDb(): Database.Database {
  return new Database(':memory:');
}

describe('runMigrations — idempotency', () => {
  // schema.test.ts verifies "no error on second run".
  // This test verifies the STRONGER guarantee: the schema_version
  // table contains exactly one row per version — no duplicates.
  it('double-apply leaves exactly one schema_version row per version', () => {
    const db = freshDb();
    runMigrations(db);
    runMigrations(db); // second run must be a strict no-op

    const rows = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<{ version: number }>;

    // One row per version, no duplicates
    expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    db.close();
  });
});

describe('runMigrations — interrupted historical migrations', () => {
  it('recovers when V5 through V8 DDL was partially applied but version markers were never committed', () => {
    const db = freshDb();
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (1), (2), (3), (4);

      CREATE TABLE session_facets (
        session_id               TEXT PRIMARY KEY REFERENCES sessions(id),
        outcome_satisfaction     TEXT NOT NULL,
        workflow_pattern         TEXT,
        had_course_correction    INTEGER NOT NULL DEFAULT 0,
        course_correction_reason TEXT,
        iteration_count          INTEGER NOT NULL DEFAULT 0,
        friction_points          TEXT,
        effective_patterns       TEXT,
        extracted_at             TEXT NOT NULL DEFAULT (datetime('now')),
        analysis_version         TEXT NOT NULL DEFAULT '1.0.0'
      );
      CREATE INDEX idx_facets_outcome ON session_facets(outcome_satisfaction);
      CREATE INDEX idx_facets_workflow ON session_facets(workflow_pattern);

      CREATE TABLE reflect_snapshots (
        period        TEXT NOT NULL,
        project_id    TEXT NOT NULL DEFAULT '__all__',
        results_json  TEXT NOT NULL,
        generated_at  TEXT NOT NULL,
        window_start  TEXT,
        window_end    TEXT NOT NULL,
        session_count INTEGER NOT NULL,
        facet_count   INTEGER NOT NULL,
        PRIMARY KEY (period, project_id)
      );

      ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
      CREATE INDEX idx_sessions_deleted_at ON sessions(deleted_at);
      ALTER TABLE sessions ADD COLUMN compact_count INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE analysis_usage (
        session_id            TEXT NOT NULL REFERENCES sessions(id),
        analysis_type         TEXT NOT NULL,
        provider              TEXT NOT NULL,
        model                 TEXT NOT NULL,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd    REAL NOT NULL DEFAULT 0,
        duration_ms           INTEGER,
        chunk_count           INTEGER NOT NULL DEFAULT 1,
        analyzed_at           TEXT NOT NULL DEFAULT (datetime('now')),
        session_message_count INTEGER,
        PRIMARY KEY (session_id, analysis_type)
      );
      CREATE INDEX idx_analysis_usage_analyzed_at
        ON analysis_usage(analyzed_at DESC);

      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('half-project', 'half', '/half', '2026-07-18T00:00:00Z');
      INSERT INTO sessions (
        id, project_id, project_name, project_path, started_at, ended_at,
        compact_count
      ) VALUES (
        'half-session', 'half-project', 'half', '/half',
        '2026-07-18T00:00:00Z', '2026-07-18T01:00:00Z',
        2
      );
      INSERT INTO analysis_usage (
        session_id, analysis_type, provider, model, input_tokens,
        session_message_count
      ) VALUES (
        'half-session', 'session', 'anthropic', 'claude', 123, 42
      );
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const sessionColumns = db
      .prepare("SELECT name FROM pragma_table_info('sessions')")
      .pluck()
      .all() as string[];
    const usageColumns = db
      .prepare("SELECT name FROM pragma_table_info('analysis_usage')")
      .pluck()
      .all() as string[];
    const versions = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .pluck()
      .all() as number[];

    expect(sessionColumns.filter((name) => name === 'deleted_at')).toHaveLength(1);
    expect(sessionColumns.filter((name) => name === 'compact_count')).toHaveLength(1);
    expect(sessionColumns.filter((name) => name === 'auto_compact_count')).toHaveLength(1);
    expect(sessionColumns.filter((name) => name === 'slash_commands')).toHaveLength(1);
    expect(usageColumns.filter((name) => name === 'session_message_count')).toHaveLength(1);
    expect(
      db.prepare(`
        SELECT input_tokens, session_message_count
        FROM analysis_usage
        WHERE session_id = 'half-session' AND analysis_type = 'session'
      `).get(),
    ).toEqual({ input_tokens: 123, session_message_count: 42 });
    expect(
      db.prepare(`
        SELECT compact_count, auto_compact_count, slash_commands
        FROM sessions
        WHERE id = 'half-session'
      `).get(),
    ).toEqual({
      compact_count: 2,
      auto_compact_count: 0,
      slash_commands: '[]',
    });
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    db.close();
  });
});

describe('runMigrations — persistent database identity', () => {
  it('creates one stable unique identity per SQLite database', () => {
    const firstDb = freshDb();
    const secondDb = freshDb();

    runMigrations(firstDb);
    const firstIdentity = firstDb
      .prepare("SELECT value FROM code_insights_metadata WHERE key = 'database_id'")
      .pluck()
      .get() as string;
    runMigrations(firstDb);
    const identityAfterSecondMigration = firstDb
      .prepare("SELECT value FROM code_insights_metadata WHERE key = 'database_id'")
      .pluck()
      .get() as string;

    runMigrations(secondDb);
    const secondIdentity = secondDb
      .prepare("SELECT value FROM code_insights_metadata WHERE key = 'database_id'")
      .pluck()
      .get() as string;
    const firstSyncGeneration = firstDb
      .prepare("SELECT value FROM code_insights_metadata WHERE key = 'sync_generation'")
      .pluck()
      .get() as string;

    expect(firstIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(firstSyncGeneration).toMatch(/^[0-9a-f]{32}$/);
    expect(identityAfterSecondMigration).toBe(firstIdentity);
    expect(secondIdentity).not.toBe(firstIdentity);

    firstDb.close();
    secondDb.close();
  });
});

describe('runMigrations — V7 analysis_usage table', () => {
  // analysis_usage has a composite PRIMARY KEY (session_id, analysis_type).
  // Verify two rows with the same session_id but different analysis_type
  // both insert successfully (not rejected as PK conflict).
  it('allows multiple analysis_type rows for the same session_id', () => {
    const db = freshDb();
    runMigrations(db);

    // Seed minimal project + session rows (FK not enforced in SQLite by default,
    // but providing real rows keeps the test meaningful).
    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
        VALUES ('p1', 'test', '/test', datetime('now'));
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s1', 'p1', 'test', '/test', datetime('now'), datetime('now'));
    `);

    db.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model)
        VALUES (?, ?, 'anthropic', 'claude-sonnet-4-5')
    `).run('s1', 'session');

    db.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model)
        VALUES (?, ?, 'anthropic', 'claude-sonnet-4-5')
    `).run('s1', 'prompt_quality');

    const rows = (
      db
        .prepare('SELECT analysis_type FROM analysis_usage WHERE session_id=? ORDER BY analysis_type')
        .all('s1') as Array<{ analysis_type: string }>
    ).map(r => r.analysis_type);

    expect(rows).toEqual(['prompt_quality', 'session']);
    db.close();
  });

  // Callers use ON CONFLICT upsert to re-record analysis costs on re-analysis.
  // Verify the composite PK enables this pattern without inserting duplicates.
  it('upserts on (session_id, analysis_type) conflict — updates, does not duplicate', () => {
    const db = freshDb();
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
        VALUES ('p2', 'test', '/test', datetime('now'));
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s2', 'p2', 'test', '/test', datetime('now'), datetime('now'));
    `);

    const upsert = db.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model, input_tokens)
        VALUES (?, 'session', 'anthropic', 'claude-sonnet-4-5', ?)
        ON CONFLICT (session_id, analysis_type) DO UPDATE SET input_tokens = excluded.input_tokens
    `);

    upsert.run('s2', 100);
    upsert.run('s2', 200); // re-analysis: should update, not insert a second row

    const row = db
      .prepare('SELECT COUNT(*) as n, input_tokens FROM analysis_usage WHERE session_id=?')
      .get('s2') as { n: number; input_tokens: number };

    expect(row.n).toBe(1);
    expect(row.input_tokens).toBe(200);
    db.close();
  });
});

describe('runMigrations — V9 analysis_queue table', () => {
  it('creates analysis_queue table with correct columns and defaults', () => {
    const db = freshDb();
    runMigrations(db);

    const createProject = `INSERT INTO projects (id, name, path, last_activity) VALUES ('p0', 'test', '/test', datetime('now'))`;
    const createSession = `INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at) VALUES ('s0', 'p0', 'test', '/test', datetime('now'), datetime('now'))`;
    db.prepare(createProject).run();
    db.prepare(createSession).run();
    db.prepare(`INSERT INTO analysis_queue (session_id) VALUES (?)`).run('s0');

    const row = db.prepare(`SELECT * FROM analysis_queue WHERE session_id = ?`).get('s0') as {
      session_id: string; status: string; runner_type: string; enqueued_at: string;
      started_at: unknown; completed_at: unknown; error_message: unknown;
      attempt_count: number; max_attempts: number; rerun_requested: number;
      next_attempt_at: string | null;
    };

    expect(row.session_id).toBe('s0');
    expect(row.status).toBe('pending');
    expect(row.runner_type).toBe('native');
    expect(typeof row.enqueued_at).toBe('string');
    expect(row.started_at).toBeNull();
    expect(row.attempt_count).toBe(0);
    expect(row.max_attempts).toBe(3);
    expect(row.rerun_requested).toBe(0);
    expect(row.next_attempt_at).toBeNull();
    db.close();
  });

  it('enforces session_id PRIMARY KEY (no duplicate rows per session)', () => {
    const db = freshDb();
    runMigrations(db);

    const createProject = `INSERT INTO projects (id, name, path, last_activity) VALUES ('p0b', 'test', '/test', datetime('now'))`;
    const createSession = `INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at) VALUES ('s0b', 'p0b', 'test', '/test', datetime('now'), datetime('now'))`;
    db.prepare(createProject).run();
    db.prepare(createSession).run();
    db.prepare(`INSERT INTO analysis_queue (session_id) VALUES (?)`).run('s0b');

    expect(() => {
      db.prepare(`INSERT INTO analysis_queue (session_id) VALUES (?)`).run('s0b');
    }).toThrow();

    db.close();
  });
});

describe('runMigrations — V11 queue durability and reflect source scope', () => {
  it('upgrades V10 queue and snapshots without losing rows', () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (10);
      CREATE TABLE analysis_queue (
        session_id    TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'pending',
        runner_type   TEXT NOT NULL DEFAULT 'native',
        enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
        started_at    TEXT,
        completed_at  TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3
      );
      CREATE TABLE reflect_snapshots (
        period        TEXT NOT NULL,
        project_id    TEXT NOT NULL DEFAULT '__all__',
        results_json  TEXT NOT NULL,
        generated_at  TEXT NOT NULL,
        window_start  TEXT,
        window_end    TEXT NOT NULL,
        session_count INTEGER NOT NULL,
        facet_count   INTEGER NOT NULL,
        PRIMARY KEY (period, project_id)
      );
      INSERT INTO analysis_queue (session_id, status)
      VALUES ('existing-session', 'processing');
      INSERT INTO reflect_snapshots (
        period, project_id, results_json, generated_at, window_start,
        window_end, session_count, facet_count
      ) VALUES (
        '2026-W29', 'existing-project', '{"kept":true}',
        '2026-07-18T00:00:00Z', '2026-07-13T00:00:00Z',
        '2026-07-20T00:00:00Z', 4, 2
      );
    `);

    runMigrations(db);

    const row = db.prepare(
      `SELECT session_id, status, rerun_requested, next_attempt_at
       FROM analysis_queue`,
    ).get() as {
      session_id: string;
      status: string;
      rerun_requested: number;
      next_attempt_at: string | null;
    };
    const indexColumns = db.prepare(
      "SELECT name FROM pragma_index_info('idx_analysis_queue_claimable') ORDER BY seqno",
    ).pluck().all() as string[];

    expect(row).toEqual({
      session_id: 'existing-session',
      status: 'processing',
      rerun_requested: 0,
      next_attempt_at: null,
    });
    expect(
      db.prepare(`
        SELECT period, project_id, source_scope, results_json, generated_at,
               window_start, window_end, session_count, facet_count
        FROM reflect_snapshots
      `).get(),
    ).toEqual({
      period: '2026-W29',
      project_id: 'existing-project',
      source_scope: '__all__',
      results_json: '{"kept":true}',
      generated_at: '2026-07-18T00:00:00Z',
      window_start: '2026-07-13T00:00:00Z',
      window_end: '2026-07-20T00:00:00Z',
      session_count: 4,
      facet_count: 2,
    });
    expect(
      db.prepare(`
        INSERT INTO reflect_snapshots (
          period, project_id, source_scope, results_json, generated_at,
          window_start, window_end, session_count, facet_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '2026-W29',
        'existing-project',
        'codex-cli',
        '{"kept":"separately"}',
        '2026-07-18T01:00:00Z',
        '2026-07-13T00:00:00Z',
        '2026-07-20T00:00:00Z',
        3,
        1,
      ).changes,
    ).toBe(1);
    expect(indexColumns).toEqual([
      'status',
      'next_attempt_at',
      'enqueued_at',
    ]);
    expect(
      db.prepare('SELECT MAX(version) FROM schema_version').pluck().get(),
    ).toBe(12);
    db.close();
  });

  it('rolls back a migration version completely and can recover after the blocker is fixed', () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY CHECK (version < 11),
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (10);
      CREATE TABLE analysis_queue (
        session_id    TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'pending',
        runner_type   TEXT NOT NULL DEFAULT 'native',
        enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
        started_at    TEXT,
        completed_at  TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3
      );
      INSERT INTO analysis_queue (session_id, status, runner_type)
      VALUES ('rollback-session', 'pending', 'provider');
      CREATE TABLE reflect_snapshots (
        period        TEXT NOT NULL,
        project_id    TEXT NOT NULL DEFAULT '__all__',
        results_json  TEXT NOT NULL,
        generated_at  TEXT NOT NULL,
        window_start  TEXT,
        window_end    TEXT NOT NULL,
        session_count INTEGER NOT NULL,
        facet_count   INTEGER NOT NULL,
        PRIMARY KEY (period, project_id)
      );
      INSERT INTO reflect_snapshots (
        period, project_id, results_json, generated_at, window_start,
        window_end, session_count, facet_count
      ) VALUES (
        '2026-W29', 'rollback-project', '{"must_survive":true}',
        '2026-07-18T00:00:00Z', '2026-07-13T00:00:00Z',
        '2026-07-20T00:00:00Z', 6, 3
      );
    `);

    expect(() => runMigrations(db)).toThrow();
    expect(
      db.prepare("SELECT COUNT(*) FROM pragma_table_info('analysis_queue') WHERE name = 'rerun_requested'").pluck().get(),
    ).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) FROM pragma_table_info('analysis_queue') WHERE name = 'next_attempt_at'").pluck().get(),
    ).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_analysis_queue_claimable'").pluck().get(),
    ).toBe(0);
    expect(
      db.prepare('SELECT MAX(version) FROM schema_version').pluck().get(),
    ).toBe(10);
    expect(
      db.prepare("SELECT COUNT(*) FROM pragma_table_info('reflect_snapshots') WHERE name = 'source_scope'").pluck().get(),
    ).toBe(0);
    expect(
      db.prepare(`
        SELECT results_json, session_count, facet_count
        FROM reflect_snapshots
        WHERE period = '2026-W29' AND project_id = 'rollback-project'
      `).get(),
    ).toEqual({
      results_json: '{"must_survive":true}',
      session_count: 6,
      facet_count: 3,
    });

    db.exec(`
      DROP TABLE schema_version;
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (10);
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(
      db.prepare("SELECT COUNT(*) FROM pragma_table_info('analysis_queue') WHERE name = 'rerun_requested'").pluck().get(),
    ).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) FROM pragma_table_info('analysis_queue') WHERE name = 'next_attempt_at'").pluck().get(),
    ).toBe(1);
    expect(
      db.prepare("SELECT next_attempt_at FROM analysis_queue LIMIT 1").pluck().get(),
    ).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) FROM pragma_table_info('reflect_snapshots') WHERE name = 'source_scope'").pluck().get(),
    ).toBe(1);
    expect(
      db.prepare(`
        SELECT source_scope, results_json, session_count, facet_count
        FROM reflect_snapshots
        WHERE period = '2026-W29' AND project_id = 'rollback-project'
      `).get(),
    ).toEqual({
      source_scope: '__all__',
      results_json: '{"must_survive":true}',
      session_count: 6,
      facet_count: 3,
    });
    expect(
      db.prepare('SELECT MAX(version) FROM schema_version').pluck().get(),
    ).toBe(12);
    db.close();
  });
});

describe('runMigrations — V12 history refresh campaigns', () => {
  it('creates durable campaign, item, and pre-publish snapshot tables', () => {
    const db = freshDb();
    runMigrations(db);

    const tableNames = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).pluck().all() as string[];

    expect(tableNames).toEqual(expect.arrayContaining([
      'analysis_campaigns',
      'analysis_campaign_items',
      'analysis_campaign_snapshots',
    ]));

    const campaignColumns = db.prepare(
      "SELECT name FROM pragma_table_info('analysis_campaigns') ORDER BY cid",
    ).pluck().all() as string[];
    const itemColumns = db.prepare(
      "SELECT name FROM pragma_table_info('analysis_campaign_items') ORDER BY cid",
    ).pluck().all() as string[];
    const snapshotColumns = db.prepare(
      "SELECT name FROM pragma_table_info('analysis_campaign_snapshots') ORDER BY cid",
    ).pluck().all() as string[];
    const usageColumns = db.prepare(
      "SELECT name FROM pragma_table_info('analysis_usage') ORDER BY cid",
    ).pluck().all() as string[];

    expect(campaignColumns).toEqual([
      'id', 'intent_fingerprint', 'provider', 'model',
      'analysis_version', 'pipeline_revision',
      'base_url_fingerprint', 'scope_json', 'selection_fingerprint',
      'status', 'total_items', 'created_at', 'updated_at',
      'paused_at', 'resumed_at', 'completed_at',
    ]);
    expect(itemColumns).toEqual([
      'campaign_id', 'session_id', 'ordinal', 'message_count',
      'input_revision', 'status', 'session_stage_json',
      'session_usage_json', 'error_code', 'safe_error', 'attempts',
      'claimed_at', 'staged_at', 'failed_at', 'succeeded_at', 'updated_at',
    ]);
    expect(snapshotColumns).toEqual([
      'campaign_id', 'session_id', 'insights_json', 'facet_json',
      'usage_json', 'generated_title_json', 'created_at',
    ]);
    expect(usageColumns).toEqual(expect.arrayContaining([
      'input_revision', 'pipeline_revision',
    ]));

    expect(campaignColumns.some(name => /key|secret|token/i.test(name))).toBe(false);
    expect(itemColumns.some(name => /key|secret|token/i.test(name))).toBe(false);
    expect(snapshotColumns.some(name => /key|secret|token/i.test(name))).toBe(false);
    expect(db.prepare('SELECT MAX(version) FROM schema_version').pluck().get()).toBe(12);

    db.close();
  });
});
