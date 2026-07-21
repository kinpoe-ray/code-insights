import { createHash } from 'node:crypto';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { getDb, getDbPath } from '../db/client.js';
import { loadConfig } from '../utils/config.js';
import { ProviderRunner } from '../analysis/provider-runner.js';
import { acquireLlmLock } from '../analysis/llm-lock.js';
import { ANALYSIS_VERSION } from '../analysis/analysis-db.js';
import { isMaintenancePaused } from './maintenance.js';
import {
  cancelHistoryRefreshCampaign,
  claimNextHistoryRefreshItem,
  createHistoryRefreshCampaign,
  getActiveHistoryRefreshCampaign,
  getLatestHistoryRefreshCampaign,
  inspectHistoryRefreshCampaign,
  markHistoryRefreshItemFailed,
  pauseHistoryRefreshCampaign,
  previewHistoryRefresh,
  publishHistoryRefreshSuccess,
  releaseHistoryRefreshClaim,
  resumeHistoryRefreshCampaign,
  retryFailedHistoryRefreshItems,
  stageHistoryRefreshSession,
  type HistoryRefreshCampaign,
  type HistoryRefreshCampaignInspection,
  type HistoryRefreshCampaignItem,
  type HistoryRefreshCampaignSpec,
  type HistoryRefreshPreview,
  type HistoryRefreshScope,
} from '../analysis/history-refresh-db.js';
import {
  freezeSessionAnalysisInput,
  preparePromptQualityPass,
  prepareSessionAnalysisPass,
  publishPreparedTwoPass,
  TWO_PASS_PIPELINE_REVISION,
  type FrozenSessionAnalysisInput,
  type PreparedPromptQualityPass,
  type PreparedSessionPass,
} from '../analysis/two-pass-analysis.js';
import type { AnalysisRunner } from '../analysis/runner-types.js';
import type { ClaudeInsightConfig } from '../types.js';

type CampaignStopReason =
  | 'no_active_campaign'
  | 'global_paused'
  | 'campaign_paused'
  | 'deadline'
  | 'busy'
  | 'batch_limit'
  | 'completed'
  | 'failed_items'
  | 'rate_limited'
  | 'authentication'
  | 'cancelled'
  | 'configuration_mismatch';

export interface ReanalyzeRunResult {
  /** True when this invocation found and operated on a campaign. */
  active: boolean;
  status: 'idle' | HistoryRefreshCampaign['status'];
  /** Sessions atomically published during this invocation. */
  processed: number;
  /** Campaign members not yet succeeded, including failed members. */
  remaining: number;
  failed: number;
  stopReason: CampaignStopReason;
}

interface ReanalyzeStartOptions {
  from?: string;
  to?: string;
  model?: string;
  yes?: boolean;
  expectedCount?: string;
}

interface ReanalyzeRunOptions {
  batchSize?: string;
  deadlineEpoch?: string;
  retryFailed?: boolean;
  json?: boolean;
  quiet?: boolean;
}

interface ReanalyzePreviewOptions {
  dryRun?: boolean;
  from?: string;
  to?: string;
  model?: string;
}

interface ReanalyzeStatusOptions {
  json?: boolean;
}

interface ReanalyzeConfirmedActionOptions {
  yes?: boolean;
}

interface CampaignTarget {
  provider: string;
  model: string;
  analysisVersion: string;
  pipelineRevision: string;
  baseUrlFingerprint: string;
}

export interface ReanalyzeDependencies {
  getDb: () => Database.Database;
  /** Opens the existing database without migrations, WAL changes, or writes. */
  openReadOnlyDb: () => Database.Database;
  loadConfig: () => ClaudeInsightConfig | null;
  preview: (db: Database.Database, scope: HistoryRefreshScope) => HistoryRefreshPreview;
  getActive: (db: Database.Database) => HistoryRefreshCampaign | null;
  /** Return the most recent campaign for status display, if the store supports it. */
  getLatest?: (db: Database.Database) => HistoryRefreshCampaign | null;
  createCampaign: (
    db: Database.Database,
    spec: HistoryRefreshCampaignSpec,
    expectedSelectionFingerprint?: string,
  ) => HistoryRefreshCampaign;
  inspectCampaign: (
    db: Database.Database,
    campaignId: string,
  ) => HistoryRefreshCampaignInspection;
  pauseCampaign: (db: Database.Database, campaignId: string) => HistoryRefreshCampaign;
  resumeCampaign: (db: Database.Database, campaignId: string) => HistoryRefreshCampaign;
  retryFailedItems: typeof retryFailedHistoryRefreshItems;
  cancelCampaign: typeof cancelHistoryRefreshCampaign;
  claimNextItem: (
    db: Database.Database,
    campaignId: string,
    options?: { retryFailed?: boolean },
  ) => HistoryRefreshCampaignItem | null;
  stageSessionPass: typeof stageHistoryRefreshSession;
  releaseClaim: typeof releaseHistoryRefreshClaim;
  markItemFailed: typeof markHistoryRefreshItemFailed;
  publishSuccess: typeof publishHistoryRefreshSuccess;
  freezeInput: (sessionId: string) => FrozenSessionAnalysisInput;
  prepareSessionPass: (
    input: FrozenSessionAnalysisInput,
    runner: AnalysisRunner,
  ) => Promise<PreparedSessionPass>;
  preparePromptQualityPass: (
    input: FrozenSessionAnalysisInput,
    runner: AnalysisRunner,
    sessionStage?: PreparedSessionPass,
  ) => Promise<PreparedPromptQualityPass>;
  publishTwoPass: typeof publishPreparedTwoPass;
  createRunner: () => AnalysisRunner;
  acquireLock: typeof acquireLlmLock;
  isMaintenancePaused: () => boolean;
  /** Wall-clock milliseconds. */
  now: () => number;
  isInteractive: () => boolean;
  confirmStart: (message: string) => Promise<boolean>;
  fingerprintBaseUrl: (baseUrl: string | undefined) => string;
  writeOut: (text: string) => void;
  writeError: (text: string) => void;
}

export function fingerprintBaseUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl ?? '').trim().replace(/\/+$/, '');
  return createHash('sha256').update(normalized).digest('hex');
}

async function defaultConfirmStart(message: string): Promise<boolean> {
  const { default: inquirer } = await import('inquirer');
  const answer = await inquirer.prompt<{ confirmed: boolean }>([{
    type: 'confirm',
    name: 'confirmed',
    message,
    default: false,
  }]);
  return answer.confirmed;
}

const DEFAULT_DEPENDENCIES: ReanalyzeDependencies = {
  getDb,
  openReadOnlyDb: () => new Database(getDbPath(), { readonly: true, fileMustExist: true }),
  loadConfig,
  preview: previewHistoryRefresh,
  getActive: getActiveHistoryRefreshCampaign,
  getLatest: getLatestHistoryRefreshCampaign,
  createCampaign: createHistoryRefreshCampaign,
  inspectCampaign: inspectHistoryRefreshCampaign,
  pauseCampaign: pauseHistoryRefreshCampaign,
  resumeCampaign: resumeHistoryRefreshCampaign,
  retryFailedItems: retryFailedHistoryRefreshItems,
  cancelCampaign: cancelHistoryRefreshCampaign,
  claimNextItem: claimNextHistoryRefreshItem,
  stageSessionPass: stageHistoryRefreshSession,
  releaseClaim: releaseHistoryRefreshClaim,
  markItemFailed: markHistoryRefreshItemFailed,
  publishSuccess: publishHistoryRefreshSuccess,
  freezeInput: freezeSessionAnalysisInput,
  prepareSessionPass: prepareSessionAnalysisPass,
  preparePromptQualityPass,
  publishTwoPass: publishPreparedTwoPass,
  createRunner: () => ProviderRunner.fromConfig(),
  acquireLock: acquireLlmLock,
  isMaintenancePaused,
  now: Date.now,
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirmStart: defaultConfirmStart,
  fingerprintBaseUrl,
  writeOut: text => process.stdout.write(text),
  writeError: text => process.stderr.write(text),
};

function assertCalendarDate(value: string, field: '--from' | '--to'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be a valid calendar date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date in YYYY-MM-DD format.`);
  }
}

function parseScope(from: string | undefined, to: string | undefined): HistoryRefreshScope {
  if ((from === undefined) !== (to === undefined)) {
    throw new Error('--from and --to must be provided together.');
  }
  if (from === undefined || to === undefined) return {};
  assertCalendarDate(from, '--from');
  assertCalendarDate(to, '--to');
  if (from > to) throw new Error('--from must not be after --to.');
  return { from, to };
}

function parsePositiveInteger(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function resolveTarget(
  deps: ReanalyzeDependencies,
  modelOverride?: string,
): CampaignTarget {
  const llm = deps.loadConfig()?.dashboard?.llm;
  if (!llm) {
    throw new Error('LLM is not configured. Run `code-insights config llm` first.');
  }
  const configuredModel = llm.model.trim();
  const requestedModel = modelOverride?.trim();
  if (requestedModel && requestedModel !== configuredModel) {
    throw new Error(
      `The configured model is ${configuredModel}; change Code Insights configuration before `
        + `starting or previewing a ${requestedModel} campaign.`,
    );
  }
  const model = requestedModel || configuredModel;
  if (!model) throw new Error('A model is required for reanalysis.');
  return {
    provider: llm.provider,
    model,
    analysisVersion: ANALYSIS_VERSION,
    pipelineRevision: TWO_PASS_PIPELINE_REVISION,
    baseUrlFingerprint: deps.fingerprintBaseUrl(llm.baseUrl),
  };
}

function targetMatches(campaign: HistoryRefreshCampaign, target: CampaignTarget): boolean {
  return campaign.provider === target.provider
    && campaign.model === target.model
    && campaign.analysisVersion === target.analysisVersion
    && campaign.pipelineRevision === target.pipelineRevision
    && campaign.baseUrlFingerprint === target.baseUrlFingerprint;
}

function progressFromInspection(inspection: HistoryRefreshCampaignInspection): {
  remaining: number;
  failed: number;
} {
  return {
    remaining: inspection.counts.pending
      + inspection.counts.session_staged
      + inspection.counts.failed,
    failed: inspection.counts.failed,
  };
}

function providerRequestEstimate(sessionCount: number): string {
  return `${sessionCount} sessions; minimum ${sessionCount * 2} provider requests `
    + '(two logical passes); long sessions/chunking/facet extraction and bounded retries '
    + 'can increase it; in-flight crash adds uncertainty';
}

function writeHumanPreview(
  deps: ReanalyzeDependencies,
  preview: HistoryRefreshPreview,
  target: CampaignTarget,
): void {
  deps.writeOut(
    `Dry run: ${providerRequestEstimate(preview.count)} with `
      + `${target.provider}/${target.model}. No campaign was created.\n`,
  );
}

async function previewCommand(
  options: ReanalyzePreviewOptions,
  deps: ReanalyzeDependencies,
): Promise<void> {
  if (!options.dryRun) {
    throw new Error('Use --dry-run to preview, or choose a reanalyze subcommand.');
  }
  const scope = parseScope(options.from, options.to);
  const target = resolveTarget(deps, options.model);
  const db = deps.openReadOnlyDb();
  try {
    const preview = deps.preview(db, scope);
    writeHumanPreview(deps, preview, target);
  } finally {
    db.close();
  }
}

async function startCommand(
  options: ReanalyzeStartOptions,
  deps: ReanalyzeDependencies,
): Promise<void> {
  const scope = parseScope(options.from, options.to);
  const expectedCount = options.expectedCount === undefined
    ? undefined
    : parsePositiveInteger(options.expectedCount, '--expected-count', 0);

  if (!options.yes && !deps.isInteractive()) {
    throw new Error('Non-interactive reanalysis requires --yes.');
  }

  const target = resolveTarget(deps, options.model);
  const db = deps.getDb();
  const preview = deps.preview(db, scope);
  if (expectedCount !== undefined && expectedCount !== preview.count) {
    throw new Error(`Expected ${expectedCount} sessions, but found ${preview.count}; preview again.`);
  }
  if (preview.count === 0) {
    deps.writeOut('No eligible sessions were found; no campaign was created.\n');
    return;
  }

  if (!options.yes) {
    const confirmed = await deps.confirmStart(
      `Create a fixed reanalysis campaign: ${providerRequestEstimate(preview.count)} `
        + `with ${target.provider}/${target.model}?`,
    );
    if (!confirmed) {
      deps.writeOut('Cancelled. No campaign was created.\n');
      return;
    }
  }

  const created = deps.createCampaign(db, { ...target, scope }, preview.selectionFingerprint);
  deps.writeOut(
    `Reanalysis campaign ready: ${created.totalItems} sessions with `
      + `${created.provider}/${created.model} (${created.status}).\n`,
  );
}

function currentStopReason(
  deps: ReanalyzeDependencies,
  db: Database.Database,
  campaignId: string,
  deadlineMs: number | undefined,
): CampaignStopReason | null {
  if (deps.isMaintenancePaused()) return 'global_paused';
  const inspection = deps.inspectCampaign(db, campaignId);
  if (inspection.campaign.status === 'paused') return 'campaign_paused';
  if (inspection.campaign.status === 'completed') return 'completed';
  if (inspection.campaign.status === 'cancelled') return 'cancelled';
  if (deadlineMs !== undefined && deps.now() >= deadlineMs) return 'deadline';
  return null;
}

function campaignIsActive(status: HistoryRefreshCampaign['status']): boolean {
  return status === 'active' || status === 'paused';
}

function currentTargetMatches(
  deps: ReanalyzeDependencies,
  campaign: HistoryRefreshCampaign,
): boolean {
  try {
    return targetMatches(campaign, resolveTarget(deps));
  } catch {
    return false;
  }
}

function releaseItemClaim(
  deps: ReanalyzeDependencies,
  db: Database.Database,
  item: HistoryRefreshCampaignItem,
): void {
  deps.releaseClaim(db, {
    campaignId: item.campaignId,
    sessionId: item.sessionId,
    inputRevision: item.inputRevision,
  });
}

function classifyFailure(error: unknown): {
  code: 'RATE_LIMIT' | 'AUTHENTICATION' | 'INPUT_CHANGED' | 'ANALYSIS_FAILED';
  safeMessage: string;
  stopReason: CampaignStopReason | null;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:429|rate[ -]?limit|too many requests)\b/i.test(message)) {
    return {
      code: 'RATE_LIMIT',
      safeMessage: 'Provider rate limit reached; previous results were kept.',
      stopReason: 'rate_limited',
    };
  }
  if (
    /\b(?:401|403|unauthori[sz]ed|forbidden|authentication|invalid api key)\b/i.test(message)
    || /\b(?:requires?|missing|required)\b.{0,24}\b(?:api[ -]?key|credentials?)\b/i.test(message)
  ) {
    return {
      code: 'AUTHENTICATION',
      safeMessage: 'Provider authentication failed; previous results were kept.',
      stopReason: 'authentication',
    };
  }
  if (/\b(?:input revision|source session changed|changed since analysis)\b/i.test(message)) {
    return {
      code: 'INPUT_CHANGED',
      safeMessage: 'Session changed after campaign creation; previous results were kept.',
      stopReason: null,
    };
  }
  return {
    code: 'ANALYSIS_FAILED',
    safeMessage: 'Analysis failed; previous results were kept.',
    stopReason: null,
  };
}

function emitRunResult(
  deps: ReanalyzeDependencies,
  result: ReanalyzeRunResult,
  options: ReanalyzeRunOptions,
): void {
  if (options.quiet) return;
  if (options.json) {
    deps.writeOut(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!result.active) {
    deps.writeOut('No active reanalysis campaign.\n');
    return;
  }
  deps.writeOut(
    `Reanalysis ${result.status}: ${result.processed} session(s) published; `
      + `stopped because ${result.stopReason.replaceAll('_', ' ')}.\n`,
  );
}

async function runCommand(
  options: ReanalyzeRunOptions,
  deps: ReanalyzeDependencies,
): Promise<void> {
  const batchSize = parsePositiveInteger(options.batchSize, '--batch-size', 20);
  const deadlineEpoch = options.deadlineEpoch === undefined
    ? undefined
    : parsePositiveInteger(options.deadlineEpoch, '--deadline-epoch', 0);
  const deadlineMs = deadlineEpoch === undefined ? undefined : deadlineEpoch * 1_000;
  const db = deps.getDb();
  const campaign = deps.getActive(db);
  if (!campaign) {
    emitRunResult(deps, {
      active: false,
      status: 'idle',
      processed: 0,
      remaining: 0,
      failed: 0,
      stopReason: 'no_active_campaign',
    }, options);
    return;
  }

  const target = resolveTarget(deps);
  if (!targetMatches(campaign, target)) {
    throw new Error(
      'Current LLM configuration does not match the reanalysis campaign; no model calls were made.',
    );
  }

  const initialStop = currentStopReason(deps, db, campaign.id, deadlineMs);
  if (initialStop) {
    const inspection = deps.inspectCampaign(db, campaign.id);
    emitRunResult(deps, {
      active: campaignIsActive(inspection.campaign.status),
      status: inspection.campaign.status,
      processed: 0,
      ...progressFromInspection(inspection),
      stopReason: initialStop,
    }, options);
    return;
  }

  const lock = deps.acquireLock();
  if (!lock) {
    const inspection = deps.inspectCampaign(db, campaign.id);
    emitRunResult(deps, {
      active: campaignIsActive(inspection.campaign.status),
      status: inspection.campaign.status,
      processed: 0,
      ...progressFromInspection(inspection),
      stopReason: 'busy',
    }, options);
    return;
  }

  let processed = 0;
  let attempted = 0;
  let stopReason: CampaignStopReason = 'batch_limit';
  let status: HistoryRefreshCampaign['status'] = campaign.status;
  try {
    const runner = deps.createRunner();
    while (attempted < batchSize) {
      const beforeItem = currentStopReason(deps, db, campaign.id, deadlineMs);
      if (beforeItem) {
        stopReason = beforeItem;
        break;
      }
      if (!currentTargetMatches(deps, campaign)) {
        stopReason = 'configuration_mismatch';
        break;
      }

      const claimed = deps.claimNextItem(db, campaign.id, {
        retryFailed: options.retryFailed,
      });
      if (!claimed) {
        const inspection = deps.inspectCampaign(db, campaign.id);
        status = inspection.campaign.status;
        if (status === 'completed') {
          stopReason = 'completed';
        } else if (
          inspection.counts.pending === 0
          && inspection.counts.session_staged === 0
          && inspection.counts.failed > 0
        ) {
          stopReason = 'failed_items';
        } else {
          stopReason = 'batch_limit';
        }
        break;
      }
      attempted++;

      let hasClaim = true;
      try {
        const input = deps.freezeInput(claimed.sessionId);
        if (
          input.inputRevision !== claimed.inputRevision
          || input.session.message_count !== claimed.messageCount
        ) {
          deps.markItemFailed(db, {
            campaignId: campaign.id,
            sessionId: claimed.sessionId,
            inputRevision: claimed.inputRevision,
            error: {
              code: 'INPUT_CHANGED',
              message: 'Session changed after campaign creation; previous results were kept.',
            },
          });
          hasClaim = false;
          continue;
        }

        // Re-check immediately before the paid pass. Another process may have
        // paused the campaign after this item was claimed.
        const beforeFirstPaidPass = currentStopReason(deps, db, campaign.id, deadlineMs);
        if (beforeFirstPaidPass || !currentTargetMatches(deps, campaign)) {
          releaseItemClaim(deps, db, claimed);
          hasClaim = false;
          stopReason = beforeFirstPaidPass ?? 'configuration_mismatch';
          break;
        }

        let sessionStage: PreparedSessionPass;
        if (claimed.sessionStage === null) {
          sessionStage = await deps.prepareSessionPass(input, runner);

          // Cancellation is terminal and wins over an in-flight response.
          // Pause/deadline may still preserve this completed pass-one stage.
          const afterSessionPass = deps.inspectCampaign(db, campaign.id).campaign.status;
          if (afterSessionPass === 'cancelled' || !currentTargetMatches(deps, campaign)) {
            releaseItemClaim(deps, db, claimed);
            hasClaim = false;
            stopReason = afterSessionPass === 'cancelled'
              ? 'cancelled'
              : 'configuration_mismatch';
            break;
          }

          deps.stageSessionPass(db, {
            campaignId: campaign.id,
            sessionId: claimed.sessionId,
            inputRevision: claimed.inputRevision,
            sessionStage,
            sessionUsage: sessionStage.usage,
          });
          hasClaim = false;

          const beforeSecondPass = currentStopReason(deps, db, campaign.id, deadlineMs);
          if (beforeSecondPass) {
            stopReason = beforeSecondPass;
            break;
          }
          if (!currentTargetMatches(deps, campaign)) {
            stopReason = 'configuration_mismatch';
            break;
          }

          // Staging deliberately releases the durable claim. Reclaim it before
          // pass two so a crash never leaves an ambiguous publish owner.
          const stagedClaim = deps.claimNextItem(db, campaign.id, {
            retryFailed: options.retryFailed,
          });
          if (!stagedClaim || stagedClaim.sessionId !== claimed.sessionId) {
            if (stagedClaim) releaseItemClaim(deps, db, stagedClaim);
            stopReason = currentStopReason(deps, db, campaign.id, deadlineMs) ?? 'busy';
            break;
          }
          hasClaim = true;
        } else {
          sessionStage = claimed.sessionStage as PreparedSessionPass;
        }

        // The staged reclaim is another scheduling boundary, so close the
        // pause/deadline race immediately before pass two as well.
        const beforePromptQuality = currentStopReason(deps, db, campaign.id, deadlineMs);
        if (beforePromptQuality || !currentTargetMatches(deps, campaign)) {
          releaseItemClaim(deps, db, claimed);
          hasClaim = false;
          stopReason = beforePromptQuality ?? 'configuration_mismatch';
          break;
        }

        const promptQualityStage = await deps.preparePromptQualityPass(
          input,
          runner,
          sessionStage,
        );

        // Do not publish a response that returned after terminal cancellation
        // or a provider/model/endpoint configuration change.
        const beforePublish = deps.inspectCampaign(db, campaign.id).campaign.status;
        if (beforePublish === 'cancelled' || !currentTargetMatches(deps, campaign)) {
          releaseItemClaim(deps, db, claimed);
          hasClaim = false;
          stopReason = beforePublish === 'cancelled'
            ? 'cancelled'
            : 'configuration_mismatch';
          break;
        }

        // This store transaction snapshots the old visible results first,
        // publishes both prepared passes, then marks the item succeeded.
        const published = deps.publishSuccess(db, {
          campaignId: campaign.id,
          sessionId: claimed.sessionId,
          inputRevision: claimed.inputRevision,
          publish: publishDb => deps.publishTwoPass(
            input,
            sessionStage,
            promptQualityStage,
            undefined,
            publishDb,
          ),
        });
        hasClaim = false;
        processed++;
        status = published.campaign.status;
        if (status === 'completed') {
          stopReason = 'completed';
          break;
        }
      } catch (error) {
        const campaignAfterError = deps.inspectCampaign(db, campaign.id).campaign.status;
        if (campaignAfterError === 'cancelled') {
          if (hasClaim) {
            // cancel already releases leases; releaseClaim is deliberately
            // idempotent so this also closes the final race before publish.
            releaseItemClaim(deps, db, claimed);
            hasClaim = false;
          }
          stopReason = 'cancelled';
          break;
        }
        const failure = classifyFailure(error);
        const failureWasClaimed = hasClaim;
        if (hasClaim) {
          const markResult = deps.markItemFailed(db, {
            campaignId: campaign.id,
            sessionId: claimed.sessionId,
            inputRevision: claimed.inputRevision,
            error: { code: failure.code, message: failure.safeMessage },
          });
          hasClaim = false;
          if (markResult.outcome === 'campaign_terminal') {
            status = markResult.campaignStatus;
            stopReason = markResult.campaignStatus === 'cancelled'
              ? 'cancelled'
              : 'completed';
            break;
          }
        }
        if (failure.stopReason) {
          stopReason = failure.stopReason;
          break;
        }
        if (!failureWasClaimed) {
          // If staging had already released the claim, preserve that durable
          // stage instead of manufacturing a failed item without an owner.
          stopReason = 'failed_items';
          break;
        }
      }
    }
  } finally {
    lock.release();
  }

  const finalInspection = deps.inspectCampaign(db, campaign.id);
  status = finalInspection.campaign.status;
  if (status === 'cancelled') stopReason = 'cancelled';
  if (status === 'completed') stopReason = 'completed';
  emitRunResult(deps, {
    active: campaignIsActive(status),
    status,
    processed,
    ...progressFromInspection(finalInspection),
    stopReason,
  }, options);
}

function statusCommand(options: ReanalyzeStatusOptions, deps: ReanalyzeDependencies): void {
  const db = deps.getDb();
  const campaign = deps.getActive(db) ?? deps.getLatest?.(db) ?? null;
  if (!campaign) {
    const idle = { active: false, status: 'idle', total: 0, counts: null };
    deps.writeOut(options.json ? `${JSON.stringify(idle)}\n` : 'No reanalysis campaign found.\n');
    return;
  }
  const inspection = deps.inspectCampaign(db, campaign.id);
  const result = {
    active: campaign.status === 'active' || campaign.status === 'paused',
    status: campaign.status,
    total: campaign.totalItems,
    counts: inspection.counts,
    provider: campaign.provider,
    model: campaign.model,
  };
  if (options.json) {
    deps.writeOut(`${JSON.stringify(result)}\n`);
    return;
  }
  deps.writeOut(
    `Reanalysis ${result.status}: ${result.counts.succeeded}/${result.total} succeeded, `
      + `${result.counts.failed} failed (${result.provider}/${result.model}).\n`,
  );
}

function pauseCommand(deps: ReanalyzeDependencies): void {
  const db = deps.getDb();
  const campaign = deps.getActive(db);
  if (!campaign) {
    deps.writeOut('No active reanalysis campaign.\n');
    return;
  }
  const paused = deps.pauseCampaign(db, campaign.id);
  deps.writeOut(`Reanalysis campaign ${paused.status}.\n`);
}

function resumeCommand(deps: ReanalyzeDependencies): void {
  const db = deps.getDb();
  const campaign = deps.getActive(db);
  if (!campaign) {
    deps.writeOut('No paused reanalysis campaign.\n');
    return;
  }
  const resumed = deps.resumeCampaign(db, campaign.id);
  deps.writeOut(`Reanalysis campaign ${resumed.status}.\n`);
}

function requireExplicitConfirmation(
  options: ReanalyzeConfirmedActionOptions,
  action: string,
): void {
  if (!options.yes) {
    throw new Error(`${action} requires --yes; no campaign state was changed.`);
  }
}

function retryFailedCommand(
  options: ReanalyzeConfirmedActionOptions,
  deps: ReanalyzeDependencies,
): void {
  requireExplicitConfirmation(options, 'retry-failed');
  const db = deps.getDb();
  const campaign = deps.getActive(db);
  if (!campaign) {
    deps.writeOut('No active reanalysis campaign.\n');
    return;
  }
  const inspection = deps.inspectCampaign(db, campaign.id);
  if (inspection.counts.failed === 0) {
    deps.writeOut('No failed items to reset.\n');
    return;
  }

  const result = deps.retryFailedItems(db, campaign.id);
  deps.writeOut(
    `${result.resetCount} failed item${result.resetCount === 1 ? '' : 's'} reset for a bounded retry.\n`,
  );
}

function cancelCommand(
  options: ReanalyzeConfirmedActionOptions,
  deps: ReanalyzeDependencies,
): void {
  requireExplicitConfirmation(options, 'cancel');
  const db = deps.getDb();
  const campaign = deps.getActive(db);
  if (!campaign) {
    deps.writeOut('No active reanalysis campaign.\n');
    return;
  }

  const cancelled = deps.cancelCampaign(db, campaign.id);
  deps.writeOut(`Reanalysis campaign ${cancelled.status}.\n`);
}

export function buildReanalyzeCommand(
  dependencies: ReanalyzeDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const command = new Command('reanalyze')
    .description('Safely reanalyze a fixed set of historical sessions')
    .option('--dry-run', 'Preview the fixed membership without writing or calling a model')
    .option('--from <YYYY-MM-DD>', 'Inclusive local start date (requires --to)')
    .option('--to <YYYY-MM-DD>', 'Inclusive local end date (requires --from)')
    .option('--model <model>', 'Target model for the preview')
    .action((options: ReanalyzePreviewOptions) => previewCommand(options, dependencies));

  command
    .command('start')
    .description('Create or resume the single durable reanalysis campaign')
    .option('--from <YYYY-MM-DD>', 'Inclusive local start date (requires --to)')
    .option('--to <YYYY-MM-DD>', 'Inclusive local end date (requires --from)')
    .option('--model <model>', 'Target model (defaults to current configuration)')
    .option('--yes', 'Confirm creation for unattended use')
    .option('--expected-count <n>', 'Abort if the previewed member count differs')
    .action((options: ReanalyzeStartOptions, actionCommand: Command) => startCommand({
      ...options,
      model: options.model ?? actionCommand.parent?.opts().model as string | undefined,
    }, dependencies));

  command
    .command('run')
    .description('Run a bounded, resumable batch from the active campaign')
    .option('--batch-size <n>', 'Maximum items to attempt', '20')
    .option('--deadline-epoch <seconds>', 'Do not start another pass at or after this time')
    .option('--retry-failed', 'Include previously failed items')
    .option('--json', 'Write one stable JSON result line')
    .option('-q, --quiet', 'Suppress all output')
    .action((options: ReanalyzeRunOptions) => runCommand(options, dependencies));

  command
    .command('status')
    .description('Show the active or most recent campaign')
    .option('--json', 'Write one JSON status line')
    .action((options: ReanalyzeStatusOptions) => statusCommand(options, dependencies));

  command
    .command('pause')
    .description('Pause the active campaign between model passes')
    .action(() => pauseCommand(dependencies));

  command
    .command('resume')
    .description('Resume the paused campaign')
    .action(() => resumeCommand(dependencies));

  command
    .command('retry-failed')
    .description('Explicitly reset failed campaign items for another bounded retry')
    .option('--yes', 'Confirm resetting the failed-item retry budget')
    .action((options: ReanalyzeConfirmedActionOptions) => retryFailedCommand(options, dependencies));

  command
    .command('cancel')
    .description('Permanently cancel the active reanalysis campaign')
    .option('--yes', 'Confirm permanent cancellation')
    .action((options: ReanalyzeConfirmedActionOptions) => cancelCommand(options, dependencies));

  return command;
}
