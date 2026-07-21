export interface QueueProcessResult {
  status: 'completed' | 'busy' | 'failed' | 'deferred';
  completedCount: number;
  rerunPendingCount: number;
  nextAttemptAt?: string;
}

export interface QueueProcessorOptions {
  quiet: boolean;
  maxItems: number;
}

export interface AnalysisQueuePumpOptions {
  processQueue: (
    options: QueueProcessorOptions,
  ) => Promise<QueueProcessResult>;
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  now?: () => number;
}

export interface AnalysisQueuePump {
  wake: () => void;
  stop: () => void;
}

/**
 * Create one in-process scheduler for the durable SQLite queue.
 *
 * Every turn asks the worker to process at most one item. The worker releases
 * the cross-process LLM lock before resolving; only then does the pump yield to
 * a timer before starting another turn or applying a short retry backoff.
 */
export function createAnalysisQueuePump({
  processQueue,
  retryBackoffMs = 250,
  maxRetryBackoffMs = 5_000,
  now = Date.now,
}: AnalysisQueuePumpOptions): AnalysisQueuePump {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let wakeRequested = false;
  let stopped = false;
  let busyBackoffMs = retryBackoffMs;

  const schedule = (delayMs: number): void => {
    if (stopped || running || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void runCycle();
    }, delayMs);
    timer.unref?.();
  };

  const runCycle = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    wakeRequested = false;

    let result: QueueProcessResult;
    try {
      result = await processQueue({ quiet: true, maxItems: 1 });
    } catch {
      result = {
        // Infrastructure failures did not produce a durable terminal queue
        // transition. Treat them like temporary lock contention so retries are
        // bounded rather than spinning at zero delay.
        status: 'busy',
        completedCount: 0,
        rerunPendingCount: 0,
      };
    } finally {
      running = false;
    }

    if (stopped) return;

    if (wakeRequested) {
      schedule(0);
      return;
    }

    if (result.status === 'busy') {
      schedule(busyBackoffMs);
      busyBackoffMs = Math.min(
        maxRetryBackoffMs,
        Math.max(retryBackoffMs, busyBackoffMs * 2),
      );
      return;
    }

    busyBackoffMs = retryBackoffMs;

    if (result.status === 'deferred') {
      const rawNextAttemptAt = result.nextAttemptAt;
      const normalizedNextAttemptAt = rawNextAttemptAt
        && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawNextAttemptAt)
        ? `${rawNextAttemptAt.replace(' ', 'T')}Z`
        : rawNextAttemptAt;
      const nextAttemptMs = normalizedNextAttemptAt
        ? Date.parse(normalizedNextAttemptAt)
        : Number.NaN;
      const delayMs = Number.isFinite(nextAttemptMs)
        ? Math.max(0, nextAttemptMs - now())
        : retryBackoffMs;
      schedule(delayMs);
      return;
    }

    if (result.status === 'failed') {
      // A terminal row may not be the only queued work. Yield once, then let
      // the durable worker either claim the next row or report an empty queue.
      schedule(0);
      return;
    }

    if (
      result.completedCount > 0
      || result.rerunPendingCount > 0
      || wakeRequested
    ) {
      schedule(0);
    }
  };

  return {
    wake: () => {
      if (stopped) return;
      if (running) {
        wakeRequested = true;
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedule(0);
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
