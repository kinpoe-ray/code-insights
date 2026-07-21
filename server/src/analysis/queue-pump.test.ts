import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisQueuePump } from './queue-pump.js';

const empty = {
  status: 'completed' as const,
  completedCount: 0,
  rerunPendingCount: 0,
};
const completedOne = {
  status: 'completed' as const,
  completedCount: 1,
  rerunPendingCount: 0,
};

describe('analysis queue pump', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T13:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes one item per yielded cycle until the durable queue is empty', async () => {
    const processQueue = vi.fn()
      .mockResolvedValueOnce(completedOne)
      .mockResolvedValueOnce(completedOne)
      .mockResolvedValueOnce(empty);
    const pump = createAnalysisQueuePump({ processQueue });

    pump.wake();
    await vi.runAllTimersAsync();

    expect(processQueue).toHaveBeenCalledTimes(3);
    for (const call of processQueue.mock.calls) {
      expect(call[0]).toEqual({ quiet: true, maxItems: 1 });
    }
  });

  it(
    'backs off after a busy outcome before retrying',
    async () => {
      const processQueue = vi.fn()
        .mockResolvedValueOnce({
          status: 'busy' as const,
          completedCount: 0,
          rerunPendingCount: 0,
        })
        .mockResolvedValueOnce(empty);
      const pump = createAnalysisQueuePump({
        processQueue,
        retryBackoffMs: 250,
      });

      pump.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(processQueue).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(249);
      expect(processQueue).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      expect(processQueue).toHaveBeenCalledTimes(2);

      await vi.runAllTimersAsync();
      expect(processQueue).toHaveBeenCalledTimes(2);
    },
  );

  it('waits until the durable next-attempt time before retrying', async () => {
    const processQueue = vi.fn()
      .mockResolvedValueOnce({
        status: 'deferred' as const,
        completedCount: 0,
        rerunPendingCount: 0,
        nextAttemptAt: '2026-07-18 13:00:30',
      })
      .mockResolvedValueOnce(empty);
    const pump = createAnalysisQueuePump({ processQueue });

    pump.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(processQueue).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(processQueue).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(processQueue).toHaveBeenCalledTimes(2);
  });

  it('preempts a durable retry timer when newly eligible work wakes the pump', async () => {
    const processQueue = vi.fn()
      .mockResolvedValueOnce({
        status: 'deferred' as const,
        completedCount: 0,
        rerunPendingCount: 0,
        nextAttemptAt: '2026-07-18 13:00:30',
      })
      .mockResolvedValueOnce(empty);
    const pump = createAnalysisQueuePump({ processQueue });

    pump.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(processQueue).toHaveBeenCalledOnce();

    pump.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect(processQueue).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs one terminal follow-up cycle and then stops when the queue is empty', async () => {
    const processQueue = vi.fn()
      .mockResolvedValueOnce({
        status: 'failed' as const,
        completedCount: 0,
        rerunPendingCount: 0,
      })
      .mockResolvedValueOnce(empty);
    const pump = createAnalysisQueuePump({ processQueue });

    pump.wake();
    await vi.runAllTimersAsync();

    expect(processQueue).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses bounded exponential backoff while another process owns the lock', async () => {
    const busy = {
      status: 'busy' as const,
      completedCount: 0 as const,
      rerunPendingCount: 0 as const,
    };
    const processQueue = vi.fn()
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(empty);
    const pump = createAnalysisQueuePump({
      processQueue,
      retryBackoffMs: 100,
      maxRetryBackoffMs: 400,
    });

    pump.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(processQueue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(processQueue).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(processQueue).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(processQueue).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(400);
    expect(processQueue).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(400);
    expect(processQueue).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces wakes while one cycle is running and never runs concurrently', async () => {
    let resolveFirst!: (value: typeof empty) => void;
    const firstCycle = new Promise<typeof empty>((resolve) => {
      resolveFirst = resolve;
    });
    const processQueue = vi.fn()
      .mockReturnValueOnce(firstCycle)
      .mockResolvedValueOnce(empty);
    const pump = createAnalysisQueuePump({ processQueue });

    pump.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(processQueue).toHaveBeenCalledOnce();

    pump.wake();
    pump.wake();
    pump.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(processQueue).toHaveBeenCalledOnce();

    resolveFirst(empty);
    await vi.runAllTimersAsync();
    expect(processQueue).toHaveBeenCalledTimes(2);
  });
});
