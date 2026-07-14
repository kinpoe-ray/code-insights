import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../__fixtures__/db/seed.js';

let testDb: Database.Database;

vi.mock('./client.js', () => ({
  getDb: () => testDb,
}));

const { claimNext, enqueue, markCompleted, markFailed } = await import('./queue.js');

describe('analysis queue claiming', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('claims the most recently enqueued pending session first', () => {
    testDb.prepare(
      `INSERT INTO projects (id, name, path, last_activity)
       VALUES ('project-1', 'project', '/project', '2026-07-14 10:00:00')`,
    ).run();
    const insertSession = testDb.prepare(
      `INSERT INTO sessions
         (id, project_id, project_name, project_path, started_at, ended_at)
       VALUES
         (?, 'project-1', 'project', '/project', ?, ?)`,
    );
    insertSession.run('older-session', '2026-07-14 09:00:00', '2026-07-14 09:30:00');
    insertSession.run('newer-session', '2026-07-14 10:00:00', '2026-07-14 10:30:00');

    testDb.prepare(
      `INSERT INTO analysis_queue (session_id, enqueued_at)
       VALUES (?, ?)`,
    ).run('older-session', '2026-07-14 09:00:00');
    testDb.prepare(
      `INSERT INTO analysis_queue (session_id, enqueued_at)
       VALUES (?, ?)`,
    ).run('newer-session', '2026-07-14 10:00:00');

    const claimed = claimNext();

    expect(claimed?.session_id).toBe('newer-session');
  });

  it('uses insertion order as the newest-first tie-break within the same second', () => {
    testDb.prepare(
      `INSERT INTO projects (id, name, path, last_activity)
       VALUES ('project-1', 'project', '/project', '2026-07-14 10:00:00')`,
    ).run();
    const insertSession = testDb.prepare(
      `INSERT INTO sessions
         (id, project_id, project_name, project_path, started_at, ended_at)
       VALUES
         (?, 'project-1', 'project', '/project', ?, ?)`,
    );
    insertSession.run('first-session', '2026-07-14 10:00:00', '2026-07-14 10:10:00');
    insertSession.run('second-session', '2026-07-14 10:00:00', '2026-07-14 10:10:00');

    const enqueueAt = '2026-07-14 10:30:00';
    testDb.prepare(
      `INSERT INTO analysis_queue (session_id, enqueued_at)
       VALUES (?, ?)`,
    ).run('first-session', enqueueAt);
    testDb.prepare(
      `INSERT INTO analysis_queue (session_id, enqueued_at)
       VALUES (?, ?)`,
    ).run('second-session', enqueueAt);

    const claimed = claimNext();

    expect(claimed?.session_id).toBe('second-session');
  });

  it('does not let an old worker complete a newer enqueue of the same session', () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('project-race', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('session-race', 'project-race', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00');
    `);
    enqueue('session-race');
    expect(claimNext()?.status).toBe('processing');

    enqueue('session-race');
    markCompleted('session-race');

    const row = testDb.prepare(
      'SELECT status, attempt_count, error_message FROM analysis_queue WHERE session_id = ?',
    ).get('session-race') as { status: string; attempt_count: number; error_message: string | null };
    expect(row).toEqual({ status: 'pending', attempt_count: 0, error_message: null });
  });

  it('does not let an old worker fail a newer enqueue of the same session', () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('project-fail-race', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('session-fail-race', 'project-fail-race', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00');
    `);
    enqueue('session-fail-race');
    expect(claimNext()?.status).toBe('processing');

    enqueue('session-fail-race');
    markFailed('session-fail-race', 'stale worker error');

    const row = testDb.prepare(
      'SELECT status, attempt_count, error_message FROM analysis_queue WHERE session_id = ?',
    ).get('session-fail-race') as { status: string; attempt_count: number; error_message: string | null };
    expect(row).toEqual({ status: 'pending', attempt_count: 0, error_message: null });
  });
});
