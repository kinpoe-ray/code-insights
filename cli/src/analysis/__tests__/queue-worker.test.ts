import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testState = vi.hoisted(() => ({ home: '' }));
const queueMocks = vi.hoisted(() => ({
  claimNext: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  getNextAttemptAt: vi.fn(),
  resetStale: vi.fn(() => 0),
}));
const runInsightsCommand = vi.hoisted(() => vi.fn());
const validateNativeRunner = vi.hoisted(() => vi.fn());
const maintenanceState = vi.hoisted(() => ({ paused: false }));

function queueItem(sessionId: string) {
  return {
    session_id: sessionId,
    status: 'pending' as const,
    runner_type: 'provider',
    enqueued_at: '2026-07-14T00:00:00Z',
    started_at: null,
    completed_at: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    rerun_requested: 0 as const,
    next_attempt_at: null,
  };
}

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => testState.home };
});

vi.mock('../../db/queue.js', () => queueMocks);

vi.mock('../../commands/insights.js', () => ({ runInsightsCommand }));
vi.mock('../../commands/maintenance.js', () => ({
  isMaintenancePaused: () => maintenanceState.paused,
}));

vi.mock('../native-runner.js', () => ({
  ClaudeNativeRunner: class MockNativeRunner {
    static validate = validateNativeRunner;
  },
}));

import { processQueue } from '../queue-worker.js';

describe('processQueue LLM lock', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    testState.home = mkdtempSync(join(tmpdir(), 'code-insights-queue-worker-'));
    queueMocks.resetStale.mockReturnValue(0);
    queueMocks.getNextAttemptAt.mockReturnValue(null);
    queueMocks.markCompleted.mockReturnValue({ status: 'completed' });
    queueMocks.markFailed.mockReturnValue({
      status: 'failed',
      attemptCount: 3,
      nextAttemptAt: null,
    });
    queueMocks.claimNext
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(null);
    runInsightsCommand.mockResolvedValue(undefined);
    maintenanceState.paused = false;
    delete process.env.CODE_INSIGHTS_LOCK_HELD;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testState.home, { recursive: true, force: true });
    delete process.env.CODE_INSIGHTS_LOCK_HELD;
  });

  it('returns a busy status without claiming, leaving pending work durable for a later wake-up', async () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), String(process.pid));

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'busy',
      completedCount: 0,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).not.toHaveBeenCalled();
    expect(runInsightsCommand).not.toHaveBeenCalled();
  });

  it('returns paused without claiming pending work when automatic maintenance is paused', async () => {
    maintenanceState.paused = true;

    const result = await processQueue({ quiet: true, maxItems: 5 });

    expect(result).toEqual({
      status: 'paused',
      completedCount: 0,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).not.toHaveBeenCalled();
    expect(runInsightsCommand).not.toHaveBeenCalled();
  });

  it('holds the LLM lock while analyzing and releases it after the bounded run', async () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    let lockWasHeldDuringAnalysis = false;
    runInsightsCommand.mockImplementationOnce(async () => {
      lockWasHeldDuringAnalysis = existsSync(lockPath);
    });

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'completed',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    expect(lockWasHeldDuringAnalysis).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('processes at most one item by default for hook-triggered workers', async () => {
    queueMocks.claimNext
      .mockReset()
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(queueItem('session-2'));

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'completed',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).toHaveBeenCalledTimes(1);
    expect(runInsightsCommand).toHaveBeenCalledTimes(1);
    expect(queueMocks.markCompleted).toHaveBeenCalledWith('session-1');
  });

  it('honors an explicit bounded item limit', async () => {
    queueMocks.claimNext
      .mockReset()
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(queueItem('session-2'))
      .mockReturnValueOnce(queueItem('session-3'));

    const result = await processQueue({ quiet: true, maxItems: 2 });

    expect(result).toEqual({
      status: 'completed',
      completedCount: 2,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).toHaveBeenCalledTimes(2);
    expect(runInsightsCommand).toHaveBeenCalledTimes(2);
  });

  it('stops before claiming the next item when pause is requested during a bounded run', async () => {
    queueMocks.claimNext
      .mockReset()
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(queueItem('session-2'));
    runInsightsCommand.mockImplementationOnce(async () => {
      maintenanceState.paused = true;
    });

    const result = await processQueue({ quiet: true, maxItems: 2 });

    expect(result).toEqual({
      status: 'paused',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).toHaveBeenCalledTimes(1);
    expect(runInsightsCommand).toHaveBeenCalledTimes(1);
    expect(queueMocks.markCompleted).toHaveBeenCalledWith('session-1');
  });

  it('stops before claiming the next item when the maintenance deadline is reached', async () => {
    queueMocks.claimNext
      .mockReset()
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(queueItem('session-2'));
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    runInsightsCommand.mockImplementationOnce(async () => {
      now = 3_000;
    });

    const result = await processQueue({ quiet: true, maxItems: 2, deadlineEpoch: 2 });

    expect(result).toEqual({
      status: 'deadline',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).toHaveBeenCalledTimes(1);
    expect(runInsightsCommand).toHaveBeenCalledTimes(1);
  });

  it('waits for the configured delay between bounded items', async () => {
    queueMocks.claimNext
      .mockReset()
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(queueItem('session-2'));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await processQueue({ quiet: true, maxItems: 2, delayMs: 5 });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5);
  });

  it('stops after a failure so a re-queued item is not retried in the same run', async () => {
    queueMocks.claimNext
      .mockReset()
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(queueItem('session-1'));
    runInsightsCommand.mockRejectedValue(new Error('provider unavailable'));

    const result = await processQueue({ quiet: true, maxItems: 2 });

    expect(result).toEqual({
      status: 'failed',
      completedCount: 0,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).toHaveBeenCalledTimes(1);
    expect(queueMocks.markFailed).toHaveBeenCalledTimes(1);
  });

  it('returns the durable retry time after a transient analysis failure', async () => {
    queueMocks.markFailed.mockReturnValueOnce({
      status: 'deferred',
      attemptCount: 1,
      nextAttemptAt: '2026-07-18 13:00:30',
    });
    runInsightsCommand.mockRejectedValueOnce(
      new Error('temporary provider failure'),
    );

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'deferred',
      completedCount: 0,
      rerunPendingCount: 0,
      nextAttemptAt: '2026-07-18 13:00:30',
    });
  });

  it('reports fresh rerun work when the active analysis fails after an enqueue', async () => {
    queueMocks.markFailed.mockReturnValueOnce({
      status: 'rerun_pending',
      attemptCount: 0,
      nextAttemptAt: null,
    });
    runInsightsCommand.mockRejectedValueOnce(
      new Error('older snapshot failed'),
    );

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'completed',
      completedCount: 0,
      rerunPendingCount: 1,
    });
    expect(queueMocks.claimNext).toHaveBeenCalledOnce();
  });

  it('defers to the processing lease deadline after the worker restarts', async () => {
    queueMocks.claimNext.mockReset().mockReturnValue(null);
    queueMocks.getNextAttemptAt.mockReturnValue(
      '2026-07-18 13:10:00',
    );

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'deferred',
      completedCount: 0,
      rerunPendingCount: 0,
      nextAttemptAt: '2026-07-18 13:10:00',
    });
    expect(runInsightsCommand).not.toHaveBeenCalled();
  });

  it('returns successes completed before a later failure and leaves newer work unclaimed', async () => {
    queueMocks.claimNext
      .mockReset()
      .mockReturnValueOnce(queueItem('session-1'))
      .mockReturnValueOnce(queueItem('session-2'))
      .mockReturnValueOnce(queueItem('session-3'));
    runInsightsCommand
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rate limited'));

    const result = await processQueue({ quiet: true, maxItems: 3 });

    expect(result).toEqual({
      status: 'failed',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    expect(queueMocks.claimNext).toHaveBeenCalledTimes(2);
    expect(queueMocks.markCompleted).toHaveBeenCalledWith('session-1');
    expect(queueMocks.markFailed).toHaveBeenCalledWith('session-2', 'rate limited');
  });

  it('reports a durable rerun requested while the analysis was active', async () => {
    queueMocks.markCompleted.mockReturnValueOnce({ status: 'rerun_pending' });

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'completed',
      completedCount: 1,
      rerunPendingCount: 1,
    });
  });

  it('fails the run when completion loses its processing compare-and-set', async () => {
    queueMocks.markCompleted.mockReturnValueOnce({ status: 'not_processing' });

    const result = await processQueue({ quiet: true });

    expect(result).toEqual({
      status: 'failed',
      completedCount: 0,
      rerunPendingCount: 0,
    });
  });
});
