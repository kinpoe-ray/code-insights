/**
 * insights command — analyze a session using configured LLM or native claude -p.
 *
 * Two modes:
 *   --native   Use claude -p (user's Claude subscription, zero config)
 *   (default)  Use configured LLM provider (OpenAI, Anthropic, Gemini, Ollama)
 *
 * Resume detection is fail-closed: both passes must match the exact input,
 * pipeline revision, provider, and model. Bypassed with --force.
 */

import type Database from 'better-sqlite3';
import chalk from 'chalk';
import { getDb } from '../db/client.js';
import { ClaudeNativeRunner } from '../analysis/native-runner.js';
import { ProviderRunner } from '../analysis/provider-runner.js';
import {
  freezeSessionAnalysisInput,
  isAnalysisLLMClient,
  preparePromptQualityPass,
  prepareSessionAnalysisPass,
  publishPreparedTwoPass,
  pipelineRevisionForAnalysisLanguage,
  type FrozenSessionAnalysisInput,
} from '../analysis/two-pass-analysis.js';
import type { AnalysisRunner } from '../analysis/runner-types.js';
import type { AnalysisLanguage } from '../types.js';
import { acquireLlmLock } from '../analysis/llm-lock.js';
import { configuredAnalysisLanguage } from '../analysis/analysis-language.js';
import { loadConfig } from '../utils/config.js';

// ── Resume detection ──────────────────────────────────────────────────────────

function isAlreadyAnalyzed(
  input: FrozenSessionAnalysisInput,
  runner: AnalysisRunner,
  analysisLanguage: AnalysisLanguage,
  db: Database.Database,
): boolean {
  if (typeof runner.provider !== 'string' || typeof runner.model !== 'string') {
    return false;
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS completed_passes
    FROM analysis_usage
    WHERE session_id = ?
      AND analysis_type IN ('session', 'prompt_quality')
      AND session_message_count = ?
      AND provider = ?
      AND model = ?
      AND input_revision = ?
      AND pipeline_revision = ?
  `).get(
    input.session.id,
    input.session.message_count,
    runner.provider,
    runner.model,
    input.inputRevision,
    pipelineRevisionForAnalysisLanguage(analysisLanguage),
  ) as { completed_passes: number };

  return row.completed_passes === 2;
}

function isAlreadyAnalyzedInAnyLanguage(
  input: FrozenSessionAnalysisInput,
  runner: AnalysisRunner,
  db: Database.Database,
): boolean {
  if (typeof runner.provider !== 'string' || typeof runner.model !== 'string') {
    return false;
  }
  const supportedRevisions = (['auto', 'zh-CN', 'en-US'] as const)
    .map(pipelineRevisionForAnalysisLanguage);
  const revisionPlaceholders = supportedRevisions.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT COALESCE(MAX(completed_passes), 0) AS completed_passes
    FROM (
      SELECT pipeline_revision, COUNT(DISTINCT analysis_type) AS completed_passes
      FROM analysis_usage
      WHERE session_id = ?
        AND analysis_type IN ('session', 'prompt_quality')
        AND session_message_count = ?
        AND provider = ?
        AND model = ?
        AND input_revision = ?
        AND pipeline_revision IN (${revisionPlaceholders})
      GROUP BY pipeline_revision
    )
  `).get(
    input.session.id,
    input.session.message_count,
    runner.provider,
    runner.model,
    input.inputRevision,
    ...supportedRevisions,
  ) as { completed_passes: number };

  return row.completed_passes === 2;
}

// ── Command options ───────────────────────────────────────────────────────────

export interface InsightsCommandOptions {
  sessionId: string;
  native: boolean;
  force?: boolean;
  quiet?: boolean;
  source?: string;
  model?: string;
  /** Pre-built runner to reuse across batch calls. Skips runner construction and validate(). */
  _runner?: AnalysisRunner;
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Run analysis on a session. Called by the CLI command and tests.
 *
 * @throws if session not found or LLM is not configured / not available
 */
export async function runInsightsCommand(options: InsightsCommandOptions): Promise<void> {
  const log = options.quiet ? () => {} : console.log.bind(console);
  const db = getDb();

  // 1. Build the runner (or reuse a pre-built one from batch callers)
  let runner: AnalysisRunner;
  if (options._runner) {
    runner = options._runner;
    if (!options.native && !isAnalysisLLMClient(runner)) {
      throw new Error('Configured provider runner does not implement the LLMClient interface.');
    }
  } else if (options.native) {
    ClaudeNativeRunner.validate();
    runner = new ClaudeNativeRunner({ model: options.model });
  } else {
    runner = ProviderRunner.fromConfig();
  }

  // 2. Freeze one revision for both remote passes.
  const input = freezeSessionAnalysisInput(options.sessionId, db);
  const analysisLanguage = configuredAnalysisLanguage(loadConfig());

  // 3. Resume detection (skipped when --force)
  if (!options.force) {
    if (isAlreadyAnalyzed(input, runner, analysisLanguage, db)) {
      return;
    }
  }

  // 4. Prepare both remote passes. Neither call can mutate visible results.
  const sessionStage = await prepareSessionAnalysisPass(input, runner, analysisLanguage);
  const promptQualityStage = await preparePromptQualityPass(
    input,
    runner,
    sessionStage,
    analysisLanguage,
  );

  // 5. Publish only after both passes succeeded, in one SQLite transaction.
  const published = publishPreparedTwoPass(input, sessionStage, promptQualityStage, undefined, db);
  log(chalk.green(
    `[Code Insights] Session analyzed: ${published.insightCount} insights, PQ ${published.promptQualityScore}/100`,
  ));
}

// ── CLI command entry point ───────────────────────────────────────────────────

function acquireCommandLlmLock(quiet: boolean): ReturnType<typeof acquireLlmLock> {
  const lock = acquireLlmLock();
  if (!lock) {
    if (!quiet) {
      console.error(chalk.yellow(
        '[Code Insights] Another LLM analysis process is already running; try again later.'
      ));
    }
    process.exitCode = 75;
  }
  return lock;
}

export async function insightsCommand(
  sessionId: string | undefined,
  opts: {
    native?: boolean;
    hook?: boolean;
    source?: string;
    force?: boolean;
    quiet?: boolean;
    model?: string;
  }
): Promise<void> {
  const quiet = opts.quiet ?? false;
  let lock: ReturnType<typeof acquireLlmLock> = null;

  try {
    if (opts.hook) {
      // --hook was removed in v4.9. Show a clear error so users know what to do.
      console.error(chalk.red(
        'The --hook flag has been removed. Run `code-insights install-hook` to install the updated hook.'
      ));
      process.exitCode = 1;
      return;
    }

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    lock = acquireCommandLlmLock(quiet);
    if (!lock) return;

    await runInsightsCommand({
      sessionId,
      native: opts.native ?? false,
      force: opts.force ?? false,
      quiet,
      source: opts.source,
      model: opts.model,
    });
  } catch (error) {
    if (!quiet) {
      console.error(chalk.red(`[Code Insights] ${error instanceof Error ? error.message : 'Analysis failed'}`));
    }
    process.exitCode = 1;
  } finally {
    lock?.release();
  }
}

// ── Subcommand: insights check ────────────────────────────────────────────────

// Seconds per session estimate (15-30s each; use 22s as mid-range)
const SECONDS_PER_SESSION = 22;

export async function insightsCheckCommand(opts: {
  days?: number;
  quiet?: boolean;
  analyze?: boolean;
}): Promise<void> {
  const days = opts.days ?? 7;
  const quiet = opts.quiet ?? false;
  const analyze = opts.analyze ?? false;
  const log = quiet ? () => {} : console.log.bind(console);

  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const recentRows = db.prepare(`
      SELECT s.id, s.generated_title, s.custom_title, s.started_at, s.message_count
      FROM sessions s
      WHERE s.started_at >= ?
        AND s.deleted_at IS NULL
      ORDER BY s.started_at DESC
    `).all(cutoff) as Array<{ id: string; generated_title: string | null; custom_title: string | null; started_at: string; message_count: number }>;

    if (recentRows.length === 0) return;
    const runner = ProviderRunner.fromConfig();
    const rows = recentRows.filter(row => {
      const input = freezeSessionAnalysisInput(row.id, db);
      return !isAlreadyAnalyzedInAnyLanguage(input, runner, db);
    });

    const count = rows.length;

    if (count === 0) {
      // Silent — all sessions analyzed
      return;
    }

    if (quiet) {
      process.stdout.write(String(count) + '\n');
      return;
    }

    // --analyze: process all found sessions with progress output
    if (analyze) {
      const lock = acquireCommandLlmLock(quiet);
      if (!lock) return;
      try {
        let successCount = 0;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const label = row.custom_title ?? row.generated_title ?? row.id;
          const position = `[${i + 1}/${count}]`;
          process.stdout.write(`${position} ${label} ... `);
          const start = Date.now();
          try {
            await runInsightsCommand({ sessionId: row.id, native: false, quiet: true, _runner: runner });
            const elapsed = Math.round((Date.now() - start) / 1000);
            process.stdout.write(`done (${elapsed}s)\n`);
            successCount++;
          } catch (err) {
            process.stdout.write('failed\n');
            console.error(chalk.red(`  [Code Insights] ${err instanceof Error ? err.message : 'Analysis failed'}`));
          }
        }

        log(chalk.green(`Analyzed ${successCount} session${successCount !== 1 ? 's' : ''}.`));
      } finally {
        lock.release();
      }
      return;
    }

    // Auto-analyze silently when 1-2 unanalyzed sessions
    if (count <= 2) {
      const lock = acquireCommandLlmLock(quiet);
      if (!lock) return;
      try {
        for (const row of rows) {
          try {
            await runInsightsCommand({ sessionId: row.id, native: false, quiet: true, _runner: runner });
          } catch {
            // Silently ignore auto-analyze errors for 1-2 sessions
          }
        }
      } finally {
        lock.release();
      }
      return;
    }

    // 3-10: print count + suggestion
    if (count <= 10) {
      log(chalk.yellow(`[Code Insights] ${count} unanalyzed session${count > 1 ? 's' : ''} in the last ${days} days.`));
      log(chalk.dim(`  Run: code-insights insights check --analyze to process them`));
      return;
    }

    // 11+: print count + time estimate
    const estimateSecs = count * SECONDS_PER_SESSION;
    const estimateMins = Math.round(estimateSecs / 60);
    const timeLabel = estimateMins < 2 ? `~${estimateSecs}s` : `~${estimateMins} min`;
    log(chalk.yellow(`[Code Insights] ${count} unanalyzed session${count > 1 ? 's' : ''} in the last ${days} days.`));
    log(chalk.dim(`  Estimated time: ${timeLabel} (~${SECONDS_PER_SESSION}s each)`));
    log(chalk.dim(`  Run: code-insights insights check --analyze to process them`));
  } catch (error) {
    if (!quiet) {
      console.error(chalk.red(`[Code Insights] ${error instanceof Error ? error.message : 'Check failed'}`));
    }
    process.exit(1);
  }
}
