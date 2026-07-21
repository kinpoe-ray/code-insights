import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../__fixtures__/db/seed.js';

let testDb: Database.Database;

vi.mock('./client.js', () => ({
  getDb: () => testDb,
}));

const {
  claimNext,
  enqueue,
  enqueueBatch,
  getNextAttemptAt,
  getQueueStatus,
  markCompleted,
  markFailed,
  resetStale,
} = await import('./queue.js');

function seedQueueSessions(sessionIds: string[]): void {
  testDb.prepare(
    `INSERT INTO projects (id, name, path, last_activity)
     VALUES ('batch-project', 'project', '/project', '2026-07-14 10:00:00')`,
  ).run();
  const insertSession = testDb.prepare(
    `INSERT INTO sessions
       (id, project_id, project_name, project_path, started_at, ended_at)
     VALUES
       (?, 'batch-project', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00')`,
  );
  for (const sessionId of sessionIds) {
    insertSession.run(sessionId);
  }
}

function seedCampaignItem(
  sessionId: string,
  campaignStatus: 'active' | 'paused' | 'completed' | 'cancelled',
  itemStatus: 'pending' | 'session_staged' | 'failed' | 'succeeded' = 'pending',
): void {
  const campaignId = `campaign-${campaignStatus}-${sessionId}`;
  testDb.prepare(
    `INSERT INTO analysis_campaigns
       (id, intent_fingerprint, provider, model, analysis_version,
        pipeline_revision, base_url_fingerprint, scope_json,
        selection_fingerprint, status, total_items)
     VALUES
       (?, ?, 'anthropic', 'glm-5.2', '3.0.0', 'pipeline-v1',
        'endpoint-fingerprint', '{}', ?, ?, 1)`,
  ).run(campaignId, `intent-${campaignId}`, `selection-${campaignId}`, campaignStatus);
  testDb.prepare(
    `INSERT INTO analysis_campaign_items
       (campaign_id, session_id, ordinal, message_count, input_revision, status)
     VALUES (?, ?, 0, 10, ?, ?)`,
  ).run(campaignId, sessionId, `revision-${sessionId}`, itemStatus);
}

describe('analysis queue batch enqueue', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('deduplicates the batch, preserves active rows, and resets terminal rows', () => {
    seedQueueSessions(['new', 'pending', 'processing', 'completed', 'failed']);
    testDb.exec(`
      INSERT INTO analysis_queue
        (session_id, status, runner_type, enqueued_at, started_at, completed_at,
         error_message, attempt_count, max_attempts, rerun_requested)
      VALUES
        ('pending', 'pending', 'native', '2026-07-14 09:00:00', NULL, NULL,
         'pending metadata', 1, 5, 0),
        ('processing', 'processing', 'native', '2026-07-14 09:01:00',
         '2026-07-14 09:02:00', NULL, 'processing metadata', 2, 5, 0),
        ('completed', 'completed', 'native', '2026-07-14 09:03:00',
         '2026-07-14 09:04:00', '2026-07-14 09:05:00', NULL, 2, 5, 0),
        ('failed', 'failed', 'native', '2026-07-14 09:06:00',
         NULL, NULL, 'permanent failure', 3, 5, 0);
    `);
    const activeBefore = testDb.prepare(
      `SELECT * FROM analysis_queue
       WHERE session_id IN ('pending', 'processing')
       ORDER BY session_id`,
    ).all();

    const result = enqueueBatch(
      ['new', 'pending', 'processing', 'completed', 'failed', 'new'],
      'provider',
    );

    expect(result).toEqual({
      sessionIds: ['new', 'pending', 'processing', 'completed', 'failed'],
      queued: 3,
      alreadyActive: 2,
      enqueuedAt: expect.any(String),
    });
    expect(testDb.prepare(
      `SELECT * FROM analysis_queue
       WHERE session_id IN ('pending', 'processing')
       ORDER BY session_id`,
    ).all()).toEqual(activeBefore);
    expect(testDb.prepare(
      `SELECT session_id, status, runner_type, enqueued_at, started_at,
              completed_at, error_message, attempt_count, max_attempts,
              rerun_requested
       FROM analysis_queue
       WHERE session_id IN ('new', 'completed', 'failed')
       ORDER BY session_id`,
    ).all()).toEqual([
      {
        session_id: 'completed',
        status: 'pending',
        runner_type: 'provider',
        enqueued_at: result.enqueuedAt,
        started_at: null,
        completed_at: null,
        error_message: null,
        attempt_count: 0,
        max_attempts: 3,
        rerun_requested: 0,
      },
      {
        session_id: 'failed',
        status: 'pending',
        runner_type: 'provider',
        enqueued_at: result.enqueuedAt,
        started_at: null,
        completed_at: null,
        error_message: null,
        attempt_count: 0,
        max_attempts: 3,
        rerun_requested: 0,
      },
      {
        session_id: 'new',
        status: 'pending',
        runner_type: 'provider',
        enqueued_at: result.enqueuedAt,
        started_at: null,
        completed_at: null,
        error_message: null,
        attempt_count: 0,
        max_attempts: 3,
        rerun_requested: 0,
      },
    ]);
  });

  it('rejects the whole batch when any session is missing or deleted', () => {
    seedQueueSessions(['valid', 'deleted', 'existing-completed']);
    testDb.prepare(
      `UPDATE sessions SET deleted_at = datetime('now') WHERE id = 'deleted'`,
    ).run();
    testDb.prepare(
      `INSERT INTO analysis_queue
         (session_id, status, runner_type, enqueued_at, completed_at)
       VALUES
         ('existing-completed', 'completed', 'native',
          '2026-07-14 09:00:00', '2026-07-14 09:30:00')`,
    ).run();
    const queueBefore = testDb.prepare(
      'SELECT * FROM analysis_queue ORDER BY session_id',
    ).all();

    expect(() => enqueueBatch(
      ['valid', 'missing', 'deleted', 'existing-completed'],
      'provider',
    )).toThrow(/missing.*deleted|deleted.*missing/i);

    expect(testDb.prepare(
      'SELECT * FROM analysis_queue ORDER BY session_id',
    ).all()).toEqual(queueBefore);
  });

  it('requires between 1 and 500 session ids', () => {
    expect(() => enqueueBatch([], 'provider')).toThrow(/1.*500/);
    expect(() => enqueueBatch(['   '], 'provider')).toThrow(/non-empty/);
    expect(() => enqueueBatch(
      Array.from({ length: 501 }, (_, index) => `session-${index}`),
      'provider',
    )).toThrow(/1.*500/);
  });
});

describe('analysis queue claiming', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('claims the oldest enqueued pending session first', () => {
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

    expect(claimed?.session_id).toBe('older-session');
  });

  it('skips unfinished active-campaign work without blocking a newer queue session', () => {
    seedQueueSessions(['campaign-member', 'new-session']);
    enqueue('campaign-member', 'provider');
    enqueue('new-session', 'provider');
    seedCampaignItem('campaign-member', 'active');

    expect(claimNext()?.session_id).toBe('new-session');
  });

  it('does not claim unfinished work owned by a paused campaign', () => {
    seedQueueSessions(['paused-campaign-member']);
    enqueue('paused-campaign-member', 'provider');
    seedCampaignItem('paused-campaign-member', 'paused');

    expect(claimNext()).toBeNull();
  });

  it.each(['session_staged', 'failed'] as const)(
    'does not claim active-campaign work in %s state',
    (itemStatus) => {
      const sessionId = `active-${itemStatus}`;
      seedQueueSessions([sessionId]);
      enqueue(sessionId, 'provider');
      seedCampaignItem(sessionId, 'active', itemStatus);

      expect(claimNext()).toBeNull();
    },
  );

  it('claims an old queue row after its active-campaign item succeeds', () => {
    seedQueueSessions(['succeeded-campaign-member']);
    enqueue('succeeded-campaign-member', 'provider');
    seedCampaignItem('succeeded-campaign-member', 'active', 'succeeded');

    expect(claimNext()?.session_id).toBe('succeeded-campaign-member');
  });

  it.each(['completed', 'cancelled'] as const)(
    'claims unfinished work from a %s campaign',
    (campaignStatus) => {
      const sessionId = `${campaignStatus}-campaign-member`;
      seedQueueSessions([sessionId]);
      enqueue(sessionId, 'provider');
      seedCampaignItem(sessionId, campaignStatus);

      expect(claimNext()?.session_id).toBe(sessionId);
    },
  );

  it('uses insertion order as the FIFO tie-break within the same second', () => {
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

    expect(claimed?.session_id).toBe('first-session');
  });

  it('skips deferred rows while preserving FIFO order among eligible work', () => {
    seedQueueSessions(['deferred-oldest', 'eligible-first', 'eligible-second']);
    const insertQueueItem = testDb.prepare(
      `INSERT INTO analysis_queue
         (session_id, enqueued_at, next_attempt_at)
       VALUES (?, ?, ?)`,
    );
    insertQueueItem.run(
      'deferred-oldest',
      '2026-07-14 09:00:00',
      '2999-01-01 00:00:00',
    );
    insertQueueItem.run(
      'eligible-first',
      '2026-07-14 10:00:00',
      null,
    );
    insertQueueItem.run(
      'eligible-second',
      '2026-07-14 11:00:00',
      null,
    );

    expect(claimNext()?.session_id).toBe('eligible-first');
    expect(claimNext()?.session_id).toBe('eligible-second');
    expect(claimNext()).toBeNull();
  });

  it('exposes the lease deadline for recently claimed work after a restart', () => {
    seedQueueSessions(['processing-after-restart']);
    enqueue('processing-after-restart', 'provider');
    const claimed = claimNext();

    expect(claimed?.started_at).toBeTruthy();
    const leaseDeadline = getNextAttemptAt();
    expect(leaseDeadline).toBeTruthy();
    expect(
      Date.parse(`${leaseDeadline!.replace(' ', 'T')}Z`)
      - Date.parse(`${claimed!.started_at!.replace(' ', 'T')}Z`),
    ).toBe(10 * 60 * 1000);
  });

  it('recovers restarted processing work exactly when its lease expires', () => {
    seedQueueSessions(['processing-at-lease-deadline']);
    enqueue('processing-at-lease-deadline', 'provider');
    const claimed = claimNext();
    const leaseDeadline = getNextAttemptAt();

    expect(claimed?.session_id).toBe('processing-at-lease-deadline');
    expect(claimNext()).toBeNull();
    expect(leaseDeadline).toBeTruthy();

    expect(resetStale(leaseDeadline!)).toBe(1);

    const recovered = getQueueStatus().items[0];
    expect(recovered).toMatchObject({
      session_id: 'processing-at-lease-deadline',
      status: 'pending',
      started_at: null,
      attempt_count: 1,
      error_message: 'Worker stopped before analysis completed',
      next_attempt_at: expect.any(String),
    });
    expect(
      Date.parse(`${recovered!.next_attempt_at!.replace(' ', 'T')}Z`)
      - Date.parse(`${leaseDeadline!.replace(' ', 'T')}Z`),
    ).toBe(30 * 1000);
    expect(getNextAttemptAt()).toBe(recovered?.next_attempt_at);
  });

  it('uses the earliest pending retry or processing lease deadline', () => {
    seedQueueSessions(['pending-retry', 'processing-lease']);
    testDb.prepare(
      `INSERT INTO analysis_queue
         (session_id, status, enqueued_at, next_attempt_at)
       VALUES
         ('pending-retry', 'pending', '2099-01-01 00:00:00',
          '2099-01-01 00:05:00')`,
    ).run();
    testDb.prepare(
      `INSERT INTO analysis_queue
         (session_id, status, enqueued_at, started_at)
       VALUES
         ('processing-lease', 'processing', '2099-01-01 00:00:00',
          '2099-01-01 00:00:00')`,
    ).run();

    expect(getNextAttemptAt()).toBe('2099-01-01 00:05:00');

    testDb.prepare(
      `UPDATE analysis_queue
       SET next_attempt_at = '2099-01-01 00:20:00'
       WHERE session_id = 'pending-retry'`,
    ).run();

    expect(getNextAttemptAt()).toBe('2099-01-01 00:10:00');
  });

  it('immediately recovers a legacy processing row without a lease start', () => {
    seedQueueSessions(['processing-without-start']);
    testDb.prepare(
      `INSERT INTO analysis_queue
         (session_id, status, runner_type, enqueued_at, started_at)
       VALUES
         ('processing-without-start', 'processing', 'provider',
          '2099-01-01 00:00:00', NULL)`,
    ).run();

    expect(resetStale('2099-01-01 01:00:00')).toBe(1);
    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'processing-without-start',
      status: 'pending',
      started_at: null,
      attempt_count: 1,
      next_attempt_at: '2099-01-01 01:00:30',
    });
  });

  it('records a rerun request without replacing a processing item', () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('project-race', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('session-race', 'project-race', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00');
    `);
    testDb.prepare(
      `INSERT INTO analysis_queue
         (session_id, runner_type, enqueued_at, attempt_count, error_message)
       VALUES
         ('session-race', 'native', '2026-07-14 10:00:00', 2, 'previous error')`,
    ).run();
    const claimed = claimNext();
    expect(claimed?.status).toBe('processing');

    enqueue('session-race', 'provider');

    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'session-race',
      status: 'processing',
      runner_type: 'native',
      enqueued_at: '2026-07-14 10:00:00',
      started_at: claimed?.started_at,
      attempt_count: 2,
      error_message: 'previous error',
      rerun_requested: 1,
    });
  });

  it('re-enqueues completed work as a fresh pending item', () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('project-requeue', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('session-requeue', 'project-requeue', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00');
    `);
    enqueue('session-requeue');
    expect(claimNext()?.status).toBe('processing');
    expect(markCompleted('session-requeue')).toEqual({ status: 'completed' });

    enqueue('session-requeue', 'provider');

    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'session-requeue',
      status: 'pending',
      runner_type: 'provider',
      started_at: null,
      completed_at: null,
      attempt_count: 0,
      error_message: null,
      rerun_requested: 0,
    });
  });

  it('atomically leaves a rerun pending when processing completes after a new enqueue', () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('project-rerun', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('session-rerun', 'project-rerun', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00');
    `);
    enqueue('session-rerun');
    expect(claimNext()?.status).toBe('processing');
    enqueue('session-rerun');

    expect(markCompleted('session-rerun')).toEqual({ status: 'rerun_pending' });
    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'session-rerun',
      status: 'pending',
      started_at: null,
      completed_at: null,
      attempt_count: 0,
      rerun_requested: 0,
    });
  });

  it('reports when completion loses the processing compare-and-set', () => {
    expect(markCompleted('missing-session')).toEqual({ status: 'not_processing' });
  });

  it('preserves a rerun requested while the current analysis fails', () => {
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

    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'session-fail-race',
      status: 'pending',
      attempt_count: 0,
      error_message: null,
      rerun_requested: 0,
    });
  });

  it('durably defers a transient failure until its next eligible attempt', () => {
    seedQueueSessions(['session-deferred']);
    enqueue('session-deferred', 'provider');
    expect(claimNext()?.session_id).toBe('session-deferred');

    const failure = markFailed('session-deferred', 'temporary provider error');
    const status = getQueueStatus();

    expect(failure).toEqual({
      status: 'deferred',
      attemptCount: 1,
      nextAttemptAt: expect.any(String),
    });
    expect(status.nextAttemptAt).toBe(failure.nextAttemptAt);
    expect(status.items[0]).toMatchObject({
      session_id: 'session-deferred',
      status: 'pending',
      attempt_count: 1,
      error_message: 'temporary provider error',
      next_attempt_at: failure.nextAttemptAt,
    });
    expect(claimNext()).toBeNull();
  });

  it('treats newly enqueued session data as a fresh attempt during backoff', () => {
    seedQueueSessions(['session-updated-during-backoff']);
    enqueue('session-updated-during-backoff', 'provider');
    expect(claimNext()?.session_id).toBe('session-updated-during-backoff');
    expect(
      markFailed('session-updated-during-backoff', 'temporary provider error'),
    ).toMatchObject({ status: 'deferred' });

    enqueue('session-updated-during-backoff', 'provider');

    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'session-updated-during-backoff',
      status: 'pending',
      attempt_count: 0,
      error_message: null,
      next_attempt_at: null,
    });
    expect(claimNext()?.session_id).toBe('session-updated-during-backoff');
  });

  it('counts stale processing as an attempt and fails it at the retry limit', () => {
    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('project-stale', 'project', '/project', '2026-07-14 10:00:00');
      INSERT INTO sessions
        (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES
        ('stale-retry', 'project-stale', 'project', '/project', '2026-07-14 10:00:00', '2026-07-14 10:30:00'),
        ('stale-failed', 'project-stale', 'project', '/project', '2026-07-14 11:00:00', '2026-07-14 11:30:00');
      INSERT INTO analysis_queue
        (session_id, status, started_at, attempt_count, max_attempts)
      VALUES
        ('stale-retry', 'processing', datetime('now', '-11 minutes'), 1, 3),
        ('stale-failed', 'processing', datetime('now', '-11 minutes'), 2, 3);
    `);

    expect(resetStale()).toBe(2);

    expect(getQueueStatus().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session_id: 'stale-retry',
        status: 'pending',
        attempt_count: 2,
        next_attempt_at: expect.any(String),
      }),
      expect.objectContaining({
        session_id: 'stale-failed',
        status: 'failed',
        attempt_count: 3,
        next_attempt_at: null,
      }),
    ]));
    expect(claimNext()).toBeNull();
  });

  it('recovers a stale rerun request as fresh pending work', () => {
    seedQueueSessions(['stale-rerun']);
    testDb.prepare(
      `INSERT INTO analysis_queue
         (session_id, status, runner_type, enqueued_at, started_at,
          error_message, attempt_count, max_attempts, rerun_requested)
       VALUES
         ('stale-rerun', 'processing', 'provider', '2026-07-14 09:00:00',
          datetime('now', '-11 minutes'), 'old attempt failed', 2, 3, 1)`,
    ).run();

    expect(resetStale()).toBe(1);

    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'stale-rerun',
      status: 'pending',
      runner_type: 'provider',
      started_at: null,
      completed_at: null,
      error_message: null,
      attempt_count: 0,
      max_attempts: 3,
      rerun_requested: 0,
    });
    expect(getQueueStatus().items[0]?.enqueued_at).not.toBe(
      '2026-07-14 09:00:00',
    );
  });
});
