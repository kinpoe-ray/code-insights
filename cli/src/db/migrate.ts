import type Database from 'better-sqlite3';
import { SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from './schema.js';

export interface MigrationResult {
  v6Applied: boolean;
  v7Applied: boolean;
  v8Applied: boolean;
  v9Applied: boolean;
  v10Applied: boolean;
  v11Applied: boolean;
  v12Applied: boolean;
}

/**
 * Apply schema migrations to the database.
 * Called once on startup before any reads or writes.
 *
 * Version 1: Initial schema (projects, sessions, messages, insights, usage_stats)
 * Version 2: Add compound index on insights(confidence DESC, timestamp DESC) for depth-ordered export queries
 * Version 3: Add session_facets table for cross-session analysis
 * Version 4: Add reflect_snapshots table for caching LLM-generated synthesis results
 * Version 5: Add deleted_at column to sessions for soft-delete (user-initiated hide)
 * Version 6: Add compact_count, auto_compact_count, slash_commands columns to sessions
 * Version 7: Add analysis_usage table for tracking LLM analysis costs per session
 * Version 8: Add session_message_count to analysis_usage for resume detection
 * Version 9: Add analysis_queue table for async hook-triggered analysis
 * Version 10: Add persistent per-database identity metadata
 * Version 11: Make queue reruns durable and scope reflection snapshots by source
 * Version 12: Add durable, resumable full-history analysis campaigns
 */
export function runMigrations(db: Database.Database): MigrationResult {
  // Create schema_version table first if it doesn't exist.
  // This table is created inline (not via SCHEMA_SQL) so migrations can check it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = getCurrentVersion(db);

  if (currentVersion < 1) {
    applyMigration(db, () => applyV1(db));
  }

  if (currentVersion < 2) {
    applyMigration(db, () => applyV2(db));
  }

  if (currentVersion < 3) {
    applyMigration(db, () => applyV3(db));
  }

  if (currentVersion < 4) {
    applyMigration(db, () => applyV4(db));
  }

  if (currentVersion < 5) {
    applyMigration(db, () => applyV5(db));
  }

  let v6Applied = false;
  if (currentVersion < 6) {
    applyMigration(db, () => applyV6(db));
    v6Applied = true;
  }

  let v7Applied = false;
  if (currentVersion < 7) {
    applyMigration(db, () => applyV7(db));
    v7Applied = true;
  }

  let v8Applied = false;
  if (currentVersion < 8) {
    applyMigration(db, () => applyV8(db));
    v8Applied = true;
  }

  let v9Applied = false;
  if (currentVersion < 9) {
    applyMigration(db, () => applyV9(db));
    v9Applied = true;
  }

  let v10Applied = false;
  if (currentVersion < 10) {
    applyMigration(db, () => applyV10(db));
    v10Applied = true;
  }

  let v11Applied = false;
  if (currentVersion < 11) {
    applyMigration(db, () => applyV11(db));
    v11Applied = true;
  }

  let v12Applied = false;
  if (currentVersion < 12) {
    applyMigration(db, () => applyV12(db));
    v12Applied = true;
  }

  return { v6Applied, v7Applied, v8Applied, v9Applied, v10Applied, v11Applied, v12Applied };
}

function getCurrentVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * Keep each version's schema changes and version marker atomic. SQLite rolls
 * transactional DDL back, so a failed upgrade can be retried safely.
 */
function applyMigration(db: Database.Database, apply: () => void): void {
  db.transaction(apply)();
}

function hasColumn(
  db: Database.Database,
  table: 'sessions' | 'analysis_usage',
  column: string,
): boolean {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function applyV1(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
}

function applyV2(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_insights_confidence_timestamp ON insights(confidence DESC, timestamp DESC)`);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
}

function applyV3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_facets (
      session_id              TEXT PRIMARY KEY REFERENCES sessions(id),
      outcome_satisfaction    TEXT NOT NULL,
      workflow_pattern        TEXT,
      had_course_correction   INTEGER NOT NULL DEFAULT 0,
      course_correction_reason TEXT,
      iteration_count         INTEGER NOT NULL DEFAULT 0,
      friction_points         TEXT,
      effective_patterns      TEXT,
      extracted_at            TEXT NOT NULL DEFAULT (datetime('now')),
      analysis_version        TEXT NOT NULL DEFAULT '1.0.0'
    );

    CREATE INDEX IF NOT EXISTS idx_facets_outcome ON session_facets(outcome_satisfaction);
    CREATE INDEX IF NOT EXISTS idx_facets_workflow ON session_facets(workflow_pattern);
  `);

  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
}

function applyV4(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflect_snapshots (
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
  `);

  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4);
}

function applyV5(db: Database.Database): void {
  if (!hasColumn(db, 'sessions', 'deleted_at')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN deleted_at TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at)`);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(5);
}

function applyV6(db: Database.Database): void {
  if (!hasColumn(db, 'sessions', 'compact_count')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN compact_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'sessions', 'auto_compact_count')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN auto_compact_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'sessions', 'slash_commands')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN slash_commands TEXT NOT NULL DEFAULT '[]'`);
  }
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
}


function applyV7(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_usage (
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
      PRIMARY KEY (session_id, analysis_type)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_analysis_usage_analyzed_at
      ON analysis_usage(analyzed_at DESC)
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7);
}
function applyV8(db: Database.Database): void {
  if (!hasColumn(db, 'analysis_usage', 'session_message_count')) {
    db.exec(`ALTER TABLE analysis_usage ADD COLUMN session_message_count INTEGER`);
  }
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(8);
}

function applyV9(db: Database.Database): void {
  // analysis_queue: tracks async hook-triggered analysis jobs
  // One row per session (session_id is PK) — retries increment attempt_count in-place
  db.exec(
    `CREATE TABLE IF NOT EXISTS analysis_queue (
      session_id    TEXT PRIMARY KEY REFERENCES sessions(id),
      status        TEXT NOT NULL DEFAULT 'pending',
      runner_type   TEXT NOT NULL DEFAULT 'native',
      enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT,
      completed_at  TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3
    )`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_analysis_queue_status ON analysis_queue(status)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_analysis_queue_enqueued_at ON analysis_queue(enqueued_at ASC)`
  );
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(9);
}

function applyV10(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_insights_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.prepare(`
    INSERT OR IGNORE INTO code_insights_metadata (key, value)
    VALUES ('database_id', lower(hex(randomblob(16))))
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO code_insights_metadata (key, value)
    VALUES ('sync_generation', lower(hex(randomblob(16))))
  `).run();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(10);
}

/**
 * Keep all V11 schema work in this function. Additional V11 DDL must be added
 * before the version marker so applyMigration() commits or rolls back the whole
 * version as one unit.
 */
function applyV11(db: Database.Database): void {
  db.exec(`
    ALTER TABLE analysis_queue
      ADD COLUMN rerun_requested INTEGER NOT NULL DEFAULT 0
  `);
  db.exec(`
    ALTER TABLE analysis_queue
      ADD COLUMN next_attempt_at TEXT
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_analysis_queue_claimable
      ON analysis_queue(status, next_attempt_at, enqueued_at ASC)
  `);
  db.exec(`
    ALTER TABLE reflect_snapshots RENAME TO reflect_snapshots_v10;

    CREATE TABLE reflect_snapshots (
      period        TEXT NOT NULL,
      project_id    TEXT NOT NULL DEFAULT '__all__',
      source_scope  TEXT NOT NULL DEFAULT '__all__',
      results_json  TEXT NOT NULL,
      generated_at  TEXT NOT NULL,
      window_start  TEXT,
      window_end    TEXT NOT NULL,
      session_count INTEGER NOT NULL,
      facet_count   INTEGER NOT NULL,
      PRIMARY KEY (period, project_id, source_scope)
    );

    INSERT INTO reflect_snapshots (
      period, project_id, source_scope, results_json, generated_at,
      window_start, window_end, session_count, facet_count
    )
    SELECT
      period, project_id, '__all__', results_json, generated_at,
      window_start, window_end, session_count, facet_count
    FROM reflect_snapshots_v10;

    DROP TABLE reflect_snapshots_v10;
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(11);
}

function applyV12(db: Database.Database): void {
  if (hasTable(db, 'analysis_usage') && !hasColumn(db, 'analysis_usage', 'input_revision')) {
    db.exec('ALTER TABLE analysis_usage ADD COLUMN input_revision TEXT');
  }
  if (hasTable(db, 'analysis_usage') && !hasColumn(db, 'analysis_usage', 'pipeline_revision')) {
    db.exec('ALTER TABLE analysis_usage ADD COLUMN pipeline_revision TEXT');
  }

  db.exec(`
    CREATE TABLE analysis_campaigns (
      id                       TEXT PRIMARY KEY,
      intent_fingerprint       TEXT NOT NULL,
      provider                 TEXT NOT NULL,
      model                    TEXT NOT NULL,
      analysis_version         TEXT NOT NULL,
      pipeline_revision        TEXT NOT NULL,
      base_url_fingerprint     TEXT NOT NULL,
      scope_json               TEXT NOT NULL,
      selection_fingerprint    TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
      total_items              INTEGER NOT NULL CHECK (total_items >= 0),
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
      paused_at                TEXT,
      resumed_at               TEXT,
      completed_at             TEXT
    );

    CREATE UNIQUE INDEX idx_analysis_campaigns_one_active
      ON analysis_campaigns((1))
      WHERE status IN ('active', 'paused');

    CREATE INDEX idx_analysis_campaigns_created_at
      ON analysis_campaigns(created_at DESC);

    CREATE TABLE analysis_campaign_items (
      campaign_id              TEXT NOT NULL REFERENCES analysis_campaigns(id) ON DELETE CASCADE,
      session_id               TEXT NOT NULL REFERENCES sessions(id),
      ordinal                  INTEGER NOT NULL CHECK (ordinal >= 0),
      message_count            INTEGER NOT NULL CHECK (message_count >= 0),
      input_revision           TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'session_staged', 'failed', 'succeeded')),
      session_stage_json       TEXT,
      session_usage_json       TEXT,
      error_code               TEXT,
      safe_error               TEXT,
      attempts                 INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claimed_at               TEXT,
      staged_at                TEXT,
      failed_at                TEXT,
      succeeded_at             TEXT,
      updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (campaign_id, session_id),
      UNIQUE (campaign_id, ordinal)
    );

    CREATE INDEX idx_analysis_campaign_items_claimable
      ON analysis_campaign_items(campaign_id, status, ordinal);

    CREATE TABLE analysis_campaign_snapshots (
      campaign_id              TEXT NOT NULL REFERENCES analysis_campaigns(id) ON DELETE CASCADE,
      session_id               TEXT NOT NULL REFERENCES sessions(id),
      insights_json            TEXT NOT NULL,
      facet_json               TEXT,
      usage_json               TEXT NOT NULL,
      generated_title_json     TEXT NOT NULL,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (campaign_id, session_id)
    );
  `);

  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(12);
}
