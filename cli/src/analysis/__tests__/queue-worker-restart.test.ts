import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../__fixtures__/db/seed.js';

let testDb: Database.Database;

const runInsightsCommand = vi.hoisted(() => vi.fn());
const releaseLock = vi.hoisted(() => vi.fn());

vi.mock('../../db/client.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../commands/insights.js', () => ({
  runInsightsCommand,
}));

// Restart recovery must not depend on the operator's real
// ~/.code-insights/maintenance.paused marker.
vi.mock('../../commands/maintenance.js', () => ({
  isMaintenancePaused: () => false,
}));

vi.mock('../native-runner.js', () => ({
  ClaudeNativeRunner: class MockNativeRunner {
    static validate(): never {
      throw new Error('native runner unavailable in this test');
    }
  },
}));

vi.mock('../llm-lock.js', () => ({
  acquireLlmLock: () => ({ release: releaseLock }),
}));

const { processQueue } = await import('../queue-worker.js');
const {
  claimNext,
  enqueue,
  getQueueStatus,
} = await import('../../db/queue.js');

describe('processQueue restart recovery', () => {
  beforeEach(() => {
    testDb = createTestDb();
    runInsightsCommand.mockReset();
    runInsightsCommand.mockResolvedValue(undefined);
    releaseLock.mockReset();

    testDb.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('restart-project', 'project', '/project', datetime('now'));
      INSERT INTO sessions (
        id, project_id, project_name, project_path, started_at, ended_at
      ) VALUES (
        'restart-session', 'restart-project', 'project', '/project',
        datetime('now', '-1 hour'), datetime('now')
      );
    `);
  });

  afterEach(() => {
    testDb.close();
  });

  it('wakes at the processing lease, recovers the row, and later completes it', async () => {
    enqueue('restart-session', 'provider');
    const abandonedClaim = claimNext();

    const afterRestart = await processQueue({ quiet: true });

    expect(afterRestart).toMatchObject({
      status: 'deferred',
      completedCount: 0,
      rerunPendingCount: 0,
      nextAttemptAt: expect.any(String),
    });
    expect(
      Date.parse(
        `${afterRestart.status === 'deferred'
          ? afterRestart.nextAttemptAt.replace(' ', 'T')
          : ''}Z`,
      )
      - Date.parse(`${abandonedClaim!.started_at!.replace(' ', 'T')}Z`),
    ).toBe(10 * 60 * 1000);
    expect(runInsightsCommand).not.toHaveBeenCalled();

    testDb.prepare(
      `UPDATE analysis_queue
       SET started_at = datetime('now', '-10 minutes')
       WHERE session_id = 'restart-session'`,
    ).run();

    const atLeaseDeadline = await processQueue({ quiet: true });

    expect(atLeaseDeadline).toMatchObject({
      status: 'deferred',
      completedCount: 0,
      rerunPendingCount: 0,
      nextAttemptAt: expect.any(String),
    });
    expect(getQueueStatus().items[0]).toMatchObject({
      session_id: 'restart-session',
      status: 'pending',
      attempt_count: 1,
      error_message: 'Worker stopped before analysis completed',
      next_attempt_at: expect.any(String),
    });

    testDb.prepare(
      `UPDATE analysis_queue
       SET next_attempt_at = datetime('now', '-1 second')
       WHERE session_id = 'restart-session'`,
    ).run();

    await expect(processQueue({ quiet: true })).resolves.toEqual({
      status: 'completed',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    expect(runInsightsCommand).toHaveBeenCalledOnce();
    expect(getQueueStatus()).toMatchObject({
      pending: 0,
      processing: 0,
      completed: 1,
      failed: 0,
      nextAttemptAt: null,
      items: [],
    });
  });
});
