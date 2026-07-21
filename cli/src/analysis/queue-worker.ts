/**
 * Queue worker — processes analysis_queue items one at a time.
 *
 * Called as a detached subprocess spawned by `session-end` after enqueue.
 * Holds the cross-process LLM lock for the bounded processing run so concurrent
 * hook workers cannot analyze different sessions at the same time.
 * Hook workers process one item by default; maintenance callers can request a
 * larger explicit bound and delay. A failed item ends the run immediately.
 *
 * Worker spawned with CODE_INSIGHTS_HOOK_ACTIVE=1 in env so that
 * ClaudeNativeRunner does not re-trigger this hook recursively.
 */

import chalk from 'chalk';
import {
  claimNext,
  getNextAttemptAt,
  markCompleted,
  markFailed,
  resetStale,
} from '../db/queue.js';
import { runInsightsCommand } from '../commands/insights.js';
import { isMaintenancePaused } from '../commands/maintenance.js';
import { ClaudeNativeRunner } from './native-runner.js';
import { acquireLlmLock } from './llm-lock.js';

export interface ProcessQueueOptions {
  quiet?: boolean;
  /** Runner type to use — 'native' uses claude -p, anything else uses configured provider */
  runnerType?: string;
  model?: string;
  /** Maximum queue items to attempt in this run. Defaults to one for hook safety. */
  maxItems?: number;
  /** Delay between queue items in milliseconds. */
  delayMs?: number;
  /** Absolute Unix timestamp in seconds after which no new item may be claimed. */
  deadlineEpoch?: number;
}

export type ProcessQueueResult =
  | { status: 'completed'; completedCount: number; rerunPendingCount: number }
  | { status: 'paused'; completedCount: number; rerunPendingCount: number }
  | { status: 'deadline'; completedCount: number; rerunPendingCount: number }
  | { status: 'busy'; completedCount: 0; rerunPendingCount: 0 }
  | {
      status: 'deferred';
      completedCount: number;
      rerunPendingCount: number;
      nextAttemptAt: string;
    }
  | { status: 'failed'; completedCount: number; rerunPendingCount: number };

/**
 * Process a bounded number of pending queue items.
 * Returns an explicit outcome so callers cannot confuse counts with control
 * states such as busy or failed.
 */
export async function processQueue(options: ProcessQueueOptions = {}): Promise<ProcessQueueResult> {
  const { quiet = false } = options;
  const log = quiet ? () => {} : console.log.bind(console);
  const maxItems = Number.isFinite(options.maxItems)
    ? Math.max(1, Math.floor(options.maxItems!))
    : 1;
  const delayMs = Number.isFinite(options.delayMs)
    ? Math.max(0, Math.floor(options.delayMs!))
    : 0;
  const environmentDeadline = Number(process.env.CODE_INSIGHTS_DEADLINE_EPOCH);
  const deadlineEpoch = Number.isFinite(options.deadlineEpoch)
    ? options.deadlineEpoch
    : Number.isFinite(environmentDeadline) && environmentDeadline > 0
      ? environmentDeadline
      : undefined;
  const deadlineReached = (): boolean => deadlineEpoch !== undefined
    && Date.now() >= deadlineEpoch * 1_000;

  if (isMaintenancePaused()) {
    log(chalk.dim('[Code Insights] Automatic analysis is paused; pending items were retained'));
    return { status: 'paused', completedCount: 0, rerunPendingCount: 0 };
  }
  if (deadlineReached()) {
    log(chalk.dim('[Code Insights] Maintenance deadline reached; pending items were retained'));
    return { status: 'deadline', completedCount: 0, rerunPendingCount: 0 };
  }

  const lock = acquireLlmLock();
  if (!lock) {
    log(chalk.dim('[Code Insights] Another LLM analysis process is already running'));
    // Nothing was claimed, so every database row remains pending. A later hook
    // wake-up or the bounded daily maintenance run can durably recover the work.
    return { status: 'busy', completedCount: 0, rerunPendingCount: 0 };
  }

  try {
    // Reset any items stuck in 'processing' from a previous crashed worker
    const staleCount = resetStale();
    if (staleCount > 0) {
      log(chalk.yellow(`[Code Insights] Recovered ${staleCount} stale processing item(s)`));
    }

    let completedCount = 0;
    let rerunPendingCount = 0;
    let attemptedCount = 0;
    let failed = false;

    // Build a native runner once and reuse across items (avoids repeated validate() calls)
    let runner: ClaudeNativeRunner | undefined;
    try {
      ClaudeNativeRunner.validate();
      runner = new ClaudeNativeRunner({ model: options.model });
    } catch {
      // claude CLI not available — fall back to provider runner (runInsightsCommand handles this)
      runner = undefined;
    }

    while (attemptedCount < maxItems) {
      if (isMaintenancePaused()) {
        log(chalk.dim('[Code Insights] Automatic analysis was paused; pending items were retained'));
        return { status: 'paused', completedCount, rerunPendingCount };
      }
      if (deadlineReached()) {
        log(chalk.dim('[Code Insights] Maintenance deadline reached; pending items were retained'));
        return { status: 'deadline', completedCount, rerunPendingCount };
      }

      if (attemptedCount > 0 && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        if (isMaintenancePaused()) {
          log(chalk.dim('[Code Insights] Automatic analysis was paused; pending items were retained'));
          return { status: 'paused', completedCount, rerunPendingCount };
        }
        if (deadlineReached()) {
          log(chalk.dim('[Code Insights] Maintenance deadline reached; pending items were retained'));
          return { status: 'deadline', completedCount, rerunPendingCount };
        }
      }

      const item = claimNext();
      if (!item) break; // Queue empty
      attemptedCount++;

      log(chalk.dim(`[Code Insights] Analyzing session ${item.session_id} (attempt ${item.attempt_count + 1}/${item.max_attempts})...`));

      try {
        await runInsightsCommand({
          sessionId: item.session_id,
          native: item.runner_type === 'native',
          quiet,
          _runner: item.runner_type === 'native' ? runner : undefined,
        });
        const completion = markCompleted(item.session_id);
        if (completion.status === 'not_processing') {
          if (!quiet) {
            console.error(chalk.red(
              `[Code Insights] Analysis finished for ${item.session_id}, but its queue claim was no longer active`,
            ));
          }
          failed = true;
          break;
        }

        completedCount++;
        if (completion.status === 'rerun_pending') {
          rerunPendingCount++;
          log(chalk.yellow(
            `[Code Insights] Session ${item.session_id} changed during analysis and remains queued`,
          ));
        } else {
          log(chalk.green(`[Code Insights] Session ${item.session_id} analyzed successfully`));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failure = markFailed(item.session_id, errorMessage);
        if (!quiet) {
          console.error(chalk.red(`[Code Insights] Analysis failed for ${item.session_id}: ${errorMessage}`));
        }
        if (failure.status === 'deferred') {
          return {
            status: 'deferred',
            completedCount,
            rerunPendingCount,
            nextAttemptAt: failure.nextAttemptAt,
          };
        }
        if (failure.status === 'rerun_pending') {
          return {
            status: 'completed',
            completedCount,
            rerunPendingCount: rerunPendingCount + 1,
          };
        }
        // markFailed may have moved the row back to pending. Stop this run so
        // the same transient failure is never retried in a tight loop.
        failed = true;
        break;
      }
    }

    if (!failed && completedCount === 0 && rerunPendingCount === 0) {
      const nextAttemptAt = getNextAttemptAt();
      if (nextAttemptAt) {
        return {
          status: 'deferred',
          completedCount,
          rerunPendingCount,
          nextAttemptAt,
        };
      }
    }

    return failed
      ? { status: 'failed', completedCount, rerunPendingCount }
      : { status: 'completed', completedCount, rerunPendingCount };
  } finally {
    lock.release();
  }
}
