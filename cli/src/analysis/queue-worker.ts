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
import { claimNext, markCompleted, markFailed, resetStale } from '../db/queue.js';
import { runInsightsCommand } from '../commands/insights.js';
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
}

/** Numeric sentinel kept compatible with the existing success-count return type. */
export const PROCESS_QUEUE_BUSY = -1;
/** At least one claimed queue item failed during this bounded run. */
export const PROCESS_QUEUE_FAILED = -2;

/**
 * Process a bounded number of pending queue items.
 * Returns the number completed successfully, PROCESS_QUEUE_BUSY when the
 * shared LLM lock is held by another process, or PROCESS_QUEUE_FAILED when a
 * claimed item could not be analyzed.
 */
export async function processQueue(options: ProcessQueueOptions = {}): Promise<number> {
  const { quiet = false } = options;
  const log = quiet ? () => {} : console.log.bind(console);
  const maxItems = Number.isFinite(options.maxItems)
    ? Math.max(1, Math.floor(options.maxItems!))
    : 1;
  const delayMs = Number.isFinite(options.delayMs)
    ? Math.max(0, Math.floor(options.delayMs!))
    : 0;

  const lock = acquireLlmLock();
  if (!lock) {
    log(chalk.dim('[Code Insights] Another LLM analysis process is already running'));
    // Nothing was claimed, so every database row remains pending. A later hook
    // wake-up or the bounded daily maintenance run can durably recover the work.
    return PROCESS_QUEUE_BUSY;
  }

  try {
    // Reset any items stuck in 'processing' from a previous crashed worker
    const staleCount = resetStale();
    if (staleCount > 0) {
      log(chalk.yellow(`[Code Insights] Reset ${staleCount} stale processing item(s) to pending`));
    }

    let successCount = 0;
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
      const item = claimNext();
      if (!item) break; // Queue empty

      if (attemptedCount > 0 && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      attemptedCount++;

      log(chalk.dim(`[Code Insights] Analyzing session ${item.session_id} (attempt ${item.attempt_count + 1}/${item.max_attempts})...`));

      try {
        await runInsightsCommand({
          sessionId: item.session_id,
          native: item.runner_type === 'native',
          quiet,
          _runner: item.runner_type === 'native' ? runner : undefined,
        });
        markCompleted(item.session_id);
        successCount++;
        log(chalk.green(`[Code Insights] Session ${item.session_id} analyzed successfully`));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        markFailed(item.session_id, errorMessage);
        if (!quiet) {
          console.error(chalk.red(`[Code Insights] Analysis failed for ${item.session_id}: ${errorMessage}`));
        }
        // markFailed may have moved the row back to pending. Stop this run so
        // the same transient failure is never retried in a tight loop.
        failed = true;
        break;
      }
    }

    return failed ? PROCESS_QUEUE_FAILED : successCount;
  } finally {
    lock.release();
  }
}
