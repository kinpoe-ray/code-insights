/**
 * analysis_queue CRUD operations.
 *
 * Queue semantics: one row per session (session_id is PRIMARY KEY).
 * Retries increment attempt_count in-place — no duplicate rows.
 *
 * Status lifecycle:
 *   pending -> processing -> completed
 *                        -> pending  (new session data arrived while processing)
 *                        -> pending  (retry if attempt_count < max_attempts)
 *                        -> failed   (permanent failure after max_attempts)
 *
 * All write operations are synchronous (better-sqlite3 is sync-only).
 */

import { getDb } from './client.js';

export type QueueRunnerType = 'native' | 'provider';

export interface QueueItem {
  session_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  runner_type: QueueRunnerType;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  attempt_count: number;
  max_attempts: number;
  rerun_requested: 0 | 1;
  next_attempt_at: string | null;
}

export interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  nextAttemptAt: string | null;
  items: QueueItem[];
}

/**
 * Return the earliest time the queue needs another worker wake-up.
 *
 * Pending rows contribute their durable retry time. Processing rows contribute
 * the end of their 10-minute lease so a restarted scheduler cannot forget work
 * that has not become stale yet. A legacy processing row without started_at is
 * already recoverable and therefore contributes the current time.
 */
export function getNextAttemptAt(): string | null {
  const row = getDb().prepare(
    `SELECT MIN(wake_at) AS value
     FROM (
       SELECT next_attempt_at AS wake_at
       FROM analysis_queue
       WHERE status = 'pending'
         AND next_attempt_at > datetime('now')

       UNION ALL

       SELECT CASE
                WHEN started_at IS NULL THEN datetime('now')
                ELSE datetime(started_at, '+10 minutes')
              END AS wake_at
       FROM analysis_queue
       WHERE status = 'processing'
     )`
  ).get() as { value: string | null };
  return row.value;
}

export interface EnqueueBatchResult {
  sessionIds: string[];
  queued: number;
  alreadyActive: number;
  enqueuedAt: string;
}

export class QueueBatchValidationError extends Error {
  readonly invalidSessionIds: string[];

  constructor(message: string, invalidSessionIds: string[] = []) {
    super(message);
    this.name = 'QueueBatchValidationError';
    this.invalidSessionIds = invalidSessionIds;
  }
}

/**
 * Add a session to the analysis queue.
 * Re-enqueuing pending/completed/failed work resets it to a fresh pending item.
 * Re-enqueuing processing work only records a durable rerun request so the
 * active worker cannot lose the newer session contents.
 */
export function enqueue(
  sessionId: string,
  runnerType: QueueRunnerType = 'native',
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO analysis_queue
       (session_id, status, runner_type, enqueued_at, started_at, completed_at, error_message, attempt_count, max_attempts, rerun_requested)
     VALUES
       (?, 'pending', ?, datetime('now'), NULL, NULL, NULL, 0, 3, 0)
     ON CONFLICT(session_id) DO UPDATE SET
       status = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.status
         ELSE 'pending'
       END,
       runner_type = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.runner_type
         ELSE excluded.runner_type
       END,
       enqueued_at = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.enqueued_at
         ELSE excluded.enqueued_at
       END,
       started_at = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.started_at
         ELSE NULL
       END,
       completed_at = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.completed_at
         ELSE NULL
       END,
       error_message = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.error_message
         ELSE NULL
       END,
       attempt_count = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.attempt_count
         ELSE 0
       END,
       max_attempts = CASE
         WHEN analysis_queue.status = 'processing' THEN analysis_queue.max_attempts
         ELSE excluded.max_attempts
       END,
       rerun_requested = CASE
         WHEN analysis_queue.status = 'processing' THEN 1
         ELSE 0
       END,
       next_attempt_at = CASE
         WHEN analysis_queue.status = 'processing'
           THEN analysis_queue.next_attempt_at
         ELSE NULL
       END`
  ).run(sessionId, runnerType);
}

/**
 * Durably enqueue one dashboard batch.
 *
 * The whole batch is validated before any row is changed. Existing pending and
 * processing rows are deliberately left untouched: a batch request is not a
 * signal to rerun work that is already active. Terminal rows are reset to a
 * fresh pending attempt.
 */
export function enqueueBatch(
  sessionIds: string[],
  runnerType: QueueRunnerType,
): EnqueueBatchResult {
  if (
    !Array.isArray(sessionIds)
    || sessionIds.length < 1
    || sessionIds.length > 500
    || sessionIds.some((sessionId) => (
      typeof sessionId !== 'string' || sessionId.trim().length === 0
    ))
  ) {
    throw new QueueBatchValidationError(
      'A queue batch must contain between 1 and 500 non-empty session ids',
    );
  }

  const deduplicatedSessionIds = [...new Set(sessionIds)];
  const db = getDb();

  return db.transaction(() => {
    const placeholders = deduplicatedSessionIds.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT sessions.id, analysis_queue.status
       FROM sessions
       LEFT JOIN analysis_queue
         ON analysis_queue.session_id = sessions.id
       WHERE sessions.id IN (${placeholders})
         AND sessions.deleted_at IS NULL`,
    ).all(...deduplicatedSessionIds) as Array<{
      id: string;
      status: QueueItem['status'] | null;
    }>;

    const statusBySessionId = new Map(
      rows.map((row) => [row.id, row.status] as const),
    );
    const invalidSessionIds = deduplicatedSessionIds.filter(
      (sessionId) => !statusBySessionId.has(sessionId),
    );
    if (invalidSessionIds.length > 0) {
      throw new QueueBatchValidationError(
        `Sessions are missing or deleted: ${invalidSessionIds.join(', ')}`,
        invalidSessionIds,
      );
    }

    const queuedSessionIds = deduplicatedSessionIds.filter((sessionId) => {
      const status = statusBySessionId.get(sessionId);
      return status !== 'pending' && status !== 'processing';
    });
    const enqueuedAt = (
      db.prepare(`SELECT datetime('now') AS value`).get() as { value: string }
    ).value;
    const enqueueStatement = db.prepare(
      `INSERT INTO analysis_queue
         (session_id, status, runner_type, enqueued_at, started_at,
          completed_at, error_message, attempt_count, max_attempts,
          rerun_requested)
       VALUES
         (?, 'pending', ?, ?, NULL, NULL, NULL, 0, 3, 0)
       ON CONFLICT(session_id) DO UPDATE SET
         status = 'pending',
         runner_type = excluded.runner_type,
         enqueued_at = excluded.enqueued_at,
         started_at = NULL,
         completed_at = NULL,
         error_message = NULL,
         attempt_count = 0,
         max_attempts = excluded.max_attempts,
         rerun_requested = 0,
         next_attempt_at = NULL`,
    );

    for (const sessionId of queuedSessionIds) {
      enqueueStatement.run(sessionId, runnerType, enqueuedAt);
    }

    return {
      sessionIds: deduplicatedSessionIds,
      queued: queuedSessionIds.length,
      alreadyActive: deduplicatedSessionIds.length - queuedSessionIds.length,
      enqueuedAt,
    };
  })();
}

/**
 * Atomically claim the next pending item by moving it to 'processing'.
 * Uses UPDATE ... WHERE session_id = (subquery) to avoid a SELECT-then-UPDATE
 * race. Returns the claimed item, or null if the queue is empty.
 *
 * SQLite's single-writer model prevents concurrent claims, but the atomic
 * pattern is still correct and future-safe.
 */
export function claimNext(): QueueItem | null {
  const db = getDb();
  // RETURNING * makes the claim and fetch a single atomic operation,
  // eliminating the UPDATE + SELECT timing window.
  return (db.prepare(
    `UPDATE analysis_queue
     SET status = 'processing',
         started_at = datetime('now'),
         rerun_requested = 0,
         next_attempt_at = NULL
     WHERE session_id = (
       SELECT candidate.session_id FROM analysis_queue AS candidate
       WHERE candidate.status = 'pending'
         AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= datetime('now'))
         AND NOT EXISTS (
           SELECT 1
           FROM analysis_campaigns AS campaign
           JOIN analysis_campaign_items AS campaign_item
             ON campaign_item.campaign_id = campaign.id
           WHERE campaign.status IN ('active', 'paused')
             AND campaign_item.session_id = candidate.session_id
             AND campaign_item.status <> 'succeeded'
         )
       ORDER BY candidate.enqueued_at ASC, candidate.rowid ASC
       LIMIT 1
     )
     RETURNING *`
  ).get() as QueueItem | undefined) ?? null;
}

export type MarkCompletedResult =
  | { status: 'completed' }
  | { status: 'rerun_pending' }
  | { status: 'not_processing' };

/**
 * Complete a processing item with compare-and-set semantics.
 * If new session data arrived during analysis, atomically preserve it as a
 * fresh pending item instead of allowing the active worker to overwrite it.
 */
export function markCompleted(sessionId: string): MarkCompletedResult {
  const db = getDb();
  const row = db.prepare(
    `UPDATE analysis_queue
     SET status = CASE
           WHEN rerun_requested = 1 THEN 'pending'
           ELSE 'completed'
         END,
         enqueued_at = CASE
           WHEN rerun_requested = 1 THEN datetime('now')
           ELSE enqueued_at
         END,
         started_at = CASE
           WHEN rerun_requested = 1 THEN NULL
           ELSE started_at
         END,
         completed_at = CASE
           WHEN rerun_requested = 1 THEN NULL
           ELSE datetime('now')
         END,
         error_message = NULL,
         attempt_count = CASE
           WHEN rerun_requested = 1 THEN 0
           ELSE attempt_count
         END,
         rerun_requested = 0,
         next_attempt_at = NULL
     WHERE session_id = ? AND status = 'processing'
     RETURNING status`
  ).get(sessionId) as { status: 'pending' | 'completed' } | undefined;

  if (!row) return { status: 'not_processing' };
  if (row.status === 'pending') return { status: 'rerun_pending' };
  return { status: 'completed' };
}

/**
 * Mark an item as failed (or re-queue for retry).
 * If attempt_count < max_attempts, resets to 'pending' for retry.
 * Otherwise sets status to 'failed' permanently.
 */
export type MarkFailedResult =
  | { status: 'deferred'; attemptCount: number; nextAttemptAt: string }
  | { status: 'failed'; attemptCount: number; nextAttemptAt: null }
  | { status: 'rerun_pending'; attemptCount: 0; nextAttemptAt: null }
  | { status: 'not_processing'; attemptCount: 0; nextAttemptAt: null };

export function markFailed(
  sessionId: string,
  errorMessage: string,
): MarkFailedResult {
  const db = getDb();
  // A rerun represents newer session data, so it starts with a fresh retry
  // budget rather than inheriting the failed older analysis.
  const row = db.prepare(
    `UPDATE analysis_queue
     SET attempt_count = CASE
           WHEN rerun_requested = 1 THEN 0
           ELSE attempt_count + 1
         END,
         error_message = CASE
           WHEN rerun_requested = 1 THEN NULL
           ELSE ?
         END,
         status = CASE
           WHEN rerun_requested = 1 THEN 'pending'
           WHEN attempt_count + 1 >= max_attempts THEN 'failed'
           ELSE 'pending'
         END,
         enqueued_at = CASE
           WHEN rerun_requested = 1 THEN datetime('now')
           ELSE enqueued_at
         END,
         next_attempt_at = CASE
           WHEN rerun_requested = 1 THEN NULL
           WHEN attempt_count + 1 >= max_attempts THEN NULL
           ELSE datetime(
             'now',
             CASE
               WHEN attempt_count <= 0 THEN '+30 seconds'
               WHEN attempt_count = 1 THEN '+60 seconds'
               WHEN attempt_count = 2 THEN '+120 seconds'
               WHEN attempt_count = 3 THEN '+240 seconds'
               ELSE '+480 seconds'
             END
           )
         END,
         started_at = NULL,
         completed_at = NULL,
         rerun_requested = 0
     WHERE session_id = ? AND status = 'processing'
     RETURNING status, attempt_count, next_attempt_at`
  ).get(errorMessage, sessionId) as {
    status: 'pending' | 'failed';
    attempt_count: number;
    next_attempt_at: string | null;
  } | undefined;

  if (!row) {
    return {
      status: 'not_processing',
      attemptCount: 0,
      nextAttemptAt: null,
    };
  }
  if (row.status === 'failed') {
    return {
      status: 'failed',
      attemptCount: row.attempt_count,
      nextAttemptAt: null,
    };
  }
  if (row.attempt_count === 0) {
    return {
      status: 'rerun_pending',
      attemptCount: 0,
      nextAttemptAt: null,
    };
  }
  if (!row.next_attempt_at) {
    throw new Error('Deferred queue item is missing its next attempt time');
  }
  return {
    status: 'deferred',
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
  };
}

/**
 * Recover stale 'processing' items.
 * Items whose 10-minute lease has expired consume an attempt. Legacy rows
 * without a lease start are treated as expired immediately. Recoverable rows
 * return to pending with durable backoff; exhausted rows become failed.
 */
export function resetStale(now = 'now'): number {
  const db = getDb();
  const result = db.prepare(
    `UPDATE analysis_queue
     SET attempt_count = CASE
           WHEN rerun_requested = 1 THEN 0
           ELSE attempt_count + 1
         END,
         status = CASE
           WHEN rerun_requested = 1 THEN 'pending'
           WHEN attempt_count + 1 >= max_attempts THEN 'failed'
           ELSE 'pending'
         END,
         error_message = CASE
           WHEN rerun_requested = 1 THEN NULL
           ELSE 'Worker stopped before analysis completed'
         END,
         enqueued_at = CASE
           WHEN rerun_requested = 1 THEN datetime(@now)
           ELSE enqueued_at
         END,
         next_attempt_at = CASE
           WHEN rerun_requested = 1 THEN NULL
           WHEN attempt_count + 1 >= max_attempts THEN NULL
           ELSE datetime(
             @now,
             CASE
               WHEN attempt_count <= 0 THEN '+30 seconds'
               WHEN attempt_count = 1 THEN '+60 seconds'
               WHEN attempt_count = 2 THEN '+120 seconds'
               WHEN attempt_count = 3 THEN '+240 seconds'
               ELSE '+480 seconds'
             END
           )
         END,
         started_at = NULL,
         completed_at = NULL,
         rerun_requested = 0
     WHERE status = 'processing'
       AND (
         started_at IS NULL
         OR started_at <= datetime(@now, '-10 minutes')
       )`
  ).run({ now });
  return result.changes;
}

/**
 * Reset failed items back to pending (manual retry).
 * Pass a sessionId to retry one item, or omit to retry all failed items.
 */
export function resetFailed(sessionId?: string): number {
  const db = getDb();
  if (sessionId) {
    const result = db.prepare(
      `UPDATE analysis_queue
       SET status = 'pending', attempt_count = 0, error_message = NULL,
           started_at = NULL, completed_at = NULL, rerun_requested = 0,
           next_attempt_at = NULL
       WHERE session_id = ? AND status = 'failed'`
    ).run(sessionId);
    return result.changes;
  }
  const result = db.prepare(
    `UPDATE analysis_queue
     SET status = 'pending', attempt_count = 0, error_message = NULL,
         started_at = NULL, completed_at = NULL, rerun_requested = 0,
         next_attempt_at = NULL
     WHERE status = 'failed'`
  ).run();
  return result.changes;
}

/**
 * Return queue status counts and active/pending item details.
 * Completed items are excluded from the items list (only pending/processing/failed).
 */
export function getQueueStatus(): QueueStatus {
  const db = getDb();

  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM analysis_queue`
  ).get() as { pending: number | null; processing: number | null; completed: number | null; failed: number | null };

  const items = db.prepare(
    `SELECT * FROM analysis_queue
     WHERE status IN ('pending', 'processing', 'failed')
     ORDER BY enqueued_at ASC`
  ).all() as QueueItem[];

  return {
    pending: counts.pending ?? 0,
    processing: counts.processing ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    nextAttemptAt: getNextAttemptAt(),
    items,
  };
}

/**
 * Remove completed and failed items older than the specified number of days.
 * Returns the number of rows deleted.
 */
export function pruneCompleted(olderThanDays = 7): number {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM analysis_queue
     WHERE status IN ('completed', 'failed')
       AND enqueued_at < datetime('now', ? || ' days')`
  ).run(`-${olderThanDays}`);
  return result.changes;
}
