import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ANALYSIS_VERSION } from './analysis-db.js';
import type { SQLiteMessageRow } from './prompt-types.js';
import {
  calculateSessionInputRevision,
  TWO_PASS_PIPELINE_REVISION,
  type PreparedPassUsage,
  type PreparedSessionPass,
  type SessionAnalysisRow,
} from './two-pass-analysis.js';

export interface HistoryRefreshScope {
  /** Inclusive local calendar date (YYYY-MM-DD). */
  from?: string;
  /** Inclusive local calendar date (YYYY-MM-DD). */
  to?: string;
}

export interface HistoryRefreshPreviewItem {
  sessionId: string;
  ordinal: number;
  messageCount: number;
  startedAt: string;
  inputRevision: string;
}

export interface HistoryRefreshPreview {
  scope: HistoryRefreshScope;
  scopeJson: string;
  count: number;
  selectionFingerprint: string;
  items: HistoryRefreshPreviewItem[];
}

export type HistoryRefreshCampaignStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type HistoryRefreshItemStatus = 'pending' | 'session_staged' | 'failed' | 'succeeded';

export interface HistoryRefreshCampaignSpec {
  provider: string;
  model: string;
  analysisVersion?: string;
  pipelineRevision?: string;
  /** SHA-256 (or equivalent opaque digest) of the endpoint; never the endpoint or API key. */
  baseUrlFingerprint: string;
  scope: HistoryRefreshScope;
}

export interface HistoryRefreshCampaign {
  id: string;
  intentFingerprint: string;
  provider: string;
  model: string;
  analysisVersion: string;
  pipelineRevision: string;
  baseUrlFingerprint: string;
  scope: HistoryRefreshScope;
  selectionFingerprint: string;
  status: HistoryRefreshCampaignStatus;
  totalItems: number;
  createdAt: string;
  updatedAt: string;
  pausedAt: string | null;
  resumedAt: string | null;
  completedAt: string | null;
}

export interface HistoryRefreshCampaignItem {
  campaignId: string;
  sessionId: string;
  ordinal: number;
  messageCount: number;
  inputRevision: string;
  status: HistoryRefreshItemStatus;
  sessionStage: PreparedSessionPass | null;
  sessionUsage: PreparedPassUsage | null;
  errorCode: string | null;
  safeError: string | null;
  attempts: number;
  claimedAt: string | null;
  stagedAt: string | null;
  failedAt: string | null;
  succeededAt: string | null;
  updatedAt: string;
}

export interface HistoryRefreshCampaignInspection {
  campaign: HistoryRefreshCampaign;
  counts: Record<HistoryRefreshItemStatus, number>;
  items: HistoryRefreshCampaignItem[];
}

export interface RetryFailedHistoryRefreshResult {
  campaign: HistoryRefreshCampaign;
  resetCount: number;
}

export interface ClaimHistoryRefreshOptions {
  retryFailed?: boolean;
  /** ISO timestamp injection for deterministic scheduling/tests. */
  now?: string;
  /** A crashed claim may be reclaimed after this lease duration. */
  claimLeaseMs?: number;
  /** Maximum complete attempts for one session. Continuing pass two is not a new attempt. */
  maxAttempts?: number;
}

export interface StageHistoryRefreshSessionInput {
  campaignId: string;
  sessionId: string;
  inputRevision: string;
  sessionStage: PreparedSessionPass;
  sessionUsage: PreparedPassUsage;
  now?: string;
}

export interface ReleaseHistoryRefreshClaimInput {
  campaignId: string;
  sessionId: string;
  inputRevision: string;
  now?: string;
}

export interface MarkHistoryRefreshItemFailedInput {
  campaignId: string;
  sessionId: string;
  inputRevision: string;
  error: {
    code: string;
    message: string;
  };
  now?: string;
}

export interface MarkHistoryRefreshItemFailedResult {
  outcome: 'failed' | 'campaign_terminal';
  campaignStatus: HistoryRefreshCampaignStatus;
  item: HistoryRefreshCampaignItem;
}

export interface PublishHistoryRefreshSuccessInput {
  campaignId: string;
  sessionId: string;
  inputRevision: string;
  /** Must be synchronous. It runs inside the snapshot/success transaction. */
  publish: (db: Database.Database) => void;
  now?: string;
}

export interface PublishHistoryRefreshSuccessResult {
  campaign: HistoryRefreshCampaign;
  item: HistoryRefreshCampaignItem;
}

export interface HistoryRefreshSnapshot {
  campaignId: string;
  sessionId: string;
  insights: Array<Record<string, unknown>>;
  facet: Record<string, unknown> | null;
  usage: Array<Record<string, unknown>>;
  generatedTitle: string | null;
  createdAt: string;
}

interface SelectedSessionRow extends SessionAnalysisRow {
  started_at: string;
  compact_count: number;
  auto_compact_count: number;
  slash_commands: string;
}

interface CampaignRow {
  id: string;
  intent_fingerprint: string;
  provider: string;
  model: string;
  analysis_version: string;
  pipeline_revision: string;
  base_url_fingerprint: string;
  scope_json: string;
  selection_fingerprint: string;
  status: HistoryRefreshCampaignStatus;
  total_items: number;
  created_at: string;
  updated_at: string;
  paused_at: string | null;
  resumed_at: string | null;
  completed_at: string | null;
}

interface CampaignItemRow {
  campaign_id: string;
  session_id: string;
  ordinal: number;
  message_count: number;
  input_revision: string;
  status: HistoryRefreshItemStatus;
  session_stage_json: string | null;
  session_usage_json: string | null;
  error_code: string | null;
  safe_error: string | null;
  attempts: number;
  claimed_at: string | null;
  staged_at: string | null;
  failed_at: string | null;
  succeeded_at: string | null;
  updated_at: string;
}

interface CampaignSnapshotRow {
  campaign_id: string;
  session_id: string;
  insights_json: string;
  facet_json: string | null;
  usage_json: string;
  generated_title_json: string;
  created_at: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseStoredJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value) as unknown;
}

function jsonWithoutSecrets(
  value: unknown,
  label: string,
  scanCredentialValues = false,
): string {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate === 'string' && scanCredentialValues) {
      if (
        /\bBearer\s+[^\s,;]+/i.test(candidate)
        || /\bsk-[A-Za-z0-9._-]{6,}/.test(candidate)
        || /\b(?:x[-_]?api[-_]?key|api[-_]?key|authorization|access[-_]?token|refresh[-_]?token)\s*[:=]\s*[^\s,;]+/i.test(candidate)
      ) {
        throw new Error(`${label} contains a credential value at ${path}`);
      }
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    if (seen.has(candidate)) throw new Error(`${label} must be acyclic JSON`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      const compactKey = key.replace(/[-_]/g, '').toLowerCase();
      const safeUsageCounter = /^(?:input|output|cachecreation|cacheread)tokens$/.test(compactKey);
      if (
        !safeUsageCounter
        && /(?:apikey|authorization|token|secret|password|credential|auth)/.test(compactKey)
      ) {
        throw new Error(`${label} contains a credential field at ${path}.${key}`);
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(value, label);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} must be JSON serializable`);
  return encoded;
}

function normalizeErrorCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').slice(0, 64);
  return normalized || 'ANALYSIS_FAILED';
}

function sanitizeErrorMessage(value: string): string {
  return value
    .replace(/(\bBearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\bapi[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, 1_000);
}

function mapCampaign(row: CampaignRow): HistoryRefreshCampaign {
  return {
    id: row.id,
    intentFingerprint: row.intent_fingerprint,
    provider: row.provider,
    model: row.model,
    analysisVersion: row.analysis_version,
    pipelineRevision: row.pipeline_revision,
    baseUrlFingerprint: row.base_url_fingerprint,
    scope: JSON.parse(row.scope_json) as HistoryRefreshScope,
    selectionFingerprint: row.selection_fingerprint,
    status: row.status,
    totalItems: row.total_items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pausedAt: row.paused_at,
    resumedAt: row.resumed_at,
    completedAt: row.completed_at,
  };
}

function mapCampaignItem(row: CampaignItemRow): HistoryRefreshCampaignItem {
  return {
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    messageCount: row.message_count,
    inputRevision: row.input_revision,
    status: row.status,
    sessionStage: parseStoredJson(row.session_stage_json) as PreparedSessionPass | null,
    sessionUsage: parseStoredJson(row.session_usage_json) as PreparedPassUsage | null,
    errorCode: row.error_code,
    safeError: row.safe_error,
    attempts: row.attempts,
    claimedAt: row.claimed_at,
    stagedAt: row.staged_at,
    failedAt: row.failed_at,
    succeededAt: row.succeeded_at,
    updatedAt: row.updated_at,
  };
}

function assertCalendarDate(value: string, field: 'from' | 'to'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`History refresh ${field} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`History refresh ${field} is not a valid calendar date`);
  }
}

function normalizeScope(scope: HistoryRefreshScope): HistoryRefreshScope {
  if (scope.from !== undefined) assertCalendarDate(scope.from, 'from');
  if (scope.to !== undefined) assertCalendarDate(scope.to, 'to');
  if (scope.from !== undefined && scope.to !== undefined && scope.from > scope.to) {
    throw new Error('History refresh from date must not be after to date');
  }
  return {
    ...(scope.from === undefined ? {} : { from: scope.from }),
    ...(scope.to === undefined ? {} : { to: scope.to }),
  };
}

function calculateInputRevision(
  db: Database.Database,
  session: SelectedSessionRow,
): string {
  const messages = db.prepare(`
    SELECT id, session_id, type, content, thinking, tool_calls, tool_results,
           usage, timestamp, parent_id
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(session.id) as SQLiteMessageRow[];

  return calculateSessionInputRevision(session, messages);
}

function getSelectedSessionRow(
  db: Database.Database,
  sessionId: string,
): SelectedSessionRow | undefined {
  return db.prepare(`
    SELECT
      s.id, s.project_id, s.project_name, s.project_path, s.summary,
      s.started_at, s.ended_at, s.message_count, s.compact_count,
      s.auto_compact_count, s.slash_commands
    FROM sessions s
    WHERE s.id = ? AND s.deleted_at IS NULL
  `).get(sessionId) as SelectedSessionRow | undefined;
}

/**
 * Read the exact campaign membership without creating or mutating campaign
 * rows. Calendar bounds intentionally use SQLite's localtime modifier so the
 * CLI and the operator see the same local dates.
 */
export function previewHistoryRefresh(
  db: Database.Database,
  requestedScope: HistoryRefreshScope,
): HistoryRefreshPreview {
  const scope = normalizeScope(requestedScope);
  const conditions = [
    's.deleted_at IS NULL',
    's.message_count >= 3',
    'EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)',
  ];
  const params: string[] = [];

  if (scope.from !== undefined) {
    conditions.push("date(s.started_at, 'localtime') >= date(?)");
    params.push(scope.from);
  }
  if (scope.to !== undefined) {
    conditions.push("date(s.started_at, 'localtime') <= date(?)");
    params.push(scope.to);
  }

  const sessions = db.prepare(`
    SELECT
      s.id, s.project_id, s.project_name, s.project_path, s.summary,
      s.started_at, s.ended_at, s.message_count, s.compact_count,
      s.auto_compact_count, s.slash_commands
    FROM sessions s
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.started_at ASC, s.id ASC
  `).all(...params) as SelectedSessionRow[];

  const items = sessions.map((session, ordinal): HistoryRefreshPreviewItem => ({
    sessionId: session.id,
    ordinal,
    messageCount: session.message_count,
    startedAt: session.started_at,
    inputRevision: calculateInputRevision(db, session),
  }));
  const scopeJson = JSON.stringify(scope);
  const selectionFingerprint = sha256(JSON.stringify(
    items.map(({ sessionId, ordinal, messageCount, inputRevision }) => ({
      sessionId,
      ordinal,
      messageCount,
      inputRevision,
    })),
  ));

  return {
    scope,
    scopeJson,
    count: items.length,
    selectionFingerprint,
    items,
  };
}

function assertCampaignSpec(spec: HistoryRefreshCampaignSpec): void {
  for (const [name, value] of [
    ['provider', spec.provider],
    ['model', spec.model],
    ['baseUrlFingerprint', spec.baseUrlFingerprint],
    ...(spec.analysisVersion === undefined
      ? []
      : [['analysisVersion', spec.analysisVersion] as const]),
    ...(spec.pipelineRevision === undefined
      ? []
      : [['pipelineRevision', spec.pipelineRevision] as const]),
  ] as const) {
    if (value.trim() === '') {
      throw new Error(`History refresh ${name} is required`);
    }
  }
}

function getCampaignRow(db: Database.Database, id: string): CampaignRow | undefined {
  return db.prepare(`
    SELECT id, intent_fingerprint, provider, model, analysis_version,
           pipeline_revision, base_url_fingerprint,
           scope_json, selection_fingerprint, status, total_items,
           created_at, updated_at, paused_at, resumed_at, completed_at
    FROM analysis_campaigns
    WHERE id = ?
  `).get(id) as CampaignRow | undefined;
}

function getCampaignItemRow(
  db: Database.Database,
  campaignId: string,
  sessionId: string,
): CampaignItemRow | undefined {
  return db.prepare(`
    SELECT campaign_id, session_id, ordinal, message_count, input_revision,
           status, session_stage_json, session_usage_json, error_code,
           safe_error, attempts, claimed_at, staged_at, failed_at,
           succeeded_at, updated_at
    FROM analysis_campaign_items
    WHERE campaign_id = ? AND session_id = ?
  `).get(campaignId, sessionId) as CampaignItemRow | undefined;
}

export function getActiveHistoryRefreshCampaign(
  db: Database.Database,
): HistoryRefreshCampaign | null {
  const row = db.prepare(`
    SELECT id, intent_fingerprint, provider, model, analysis_version,
           pipeline_revision, base_url_fingerprint,
           scope_json, selection_fingerprint, status, total_items,
           created_at, updated_at, paused_at, resumed_at, completed_at
    FROM analysis_campaigns
    WHERE status IN ('active', 'paused')
    LIMIT 1
  `).get() as CampaignRow | undefined;
  return row ? mapCampaign(row) : null;
}

export function getLatestHistoryRefreshCampaign(
  db: Database.Database,
): HistoryRefreshCampaign | null {
  const row = db.prepare(`
    SELECT id, intent_fingerprint, provider, model, analysis_version,
           pipeline_revision, base_url_fingerprint,
           scope_json, selection_fingerprint, status, total_items,
           created_at, updated_at, paused_at, resumed_at, completed_at
    FROM analysis_campaigns
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get() as CampaignRow | undefined;
  return row ? mapCampaign(row) : null;
}

export function createHistoryRefreshCampaign(
  db: Database.Database,
  spec: HistoryRefreshCampaignSpec,
  expectedSelectionFingerprint?: string,
): HistoryRefreshCampaign {
  assertCampaignSpec(spec);
  const scope = normalizeScope(spec.scope);
  const analysisVersion = spec.analysisVersion ?? ANALYSIS_VERSION;
  const pipelineRevision = spec.pipelineRevision ?? TWO_PASS_PIPELINE_REVISION;
  const intentFingerprint = sha256(JSON.stringify({
    provider: spec.provider,
    model: spec.model,
    analysisVersion,
    pipelineRevision,
    baseUrlFingerprint: spec.baseUrlFingerprint,
    scope,
  }));

  return db.transaction(() => {
    const active = db.prepare(`
      SELECT id, intent_fingerprint, provider, model, analysis_version,
             pipeline_revision, base_url_fingerprint,
             scope_json, selection_fingerprint, status, total_items,
             created_at, updated_at, paused_at, resumed_at, completed_at
      FROM analysis_campaigns
      WHERE status IN ('active', 'paused')
      LIMIT 1
    `).get() as CampaignRow | undefined;
    if (active) {
      if (active.intent_fingerprint === intentFingerprint) return mapCampaign(active);
      throw new Error(`Another history refresh campaign is already active (${active.id})`);
    }

    const preview = previewHistoryRefresh(db, scope);
    if (
      expectedSelectionFingerprint !== undefined
      && preview.selectionFingerprint !== expectedSelectionFingerprint
    ) {
      throw new Error('History refresh selection changed after preview; preview again before creating');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const initialStatus: HistoryRefreshCampaignStatus = preview.count === 0
      ? 'completed'
      : 'active';
    db.prepare(`
      INSERT INTO analysis_campaigns (
        id, intent_fingerprint, provider, model, analysis_version,
        pipeline_revision, base_url_fingerprint,
        scope_json, selection_fingerprint, status, total_items,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      intentFingerprint,
      spec.provider,
      spec.model,
      analysisVersion,
      pipelineRevision,
      spec.baseUrlFingerprint,
      preview.scopeJson,
      preview.selectionFingerprint,
      initialStatus,
      preview.count,
      now,
      now,
      initialStatus === 'completed' ? now : null,
    );

    const insertItem = db.prepare(`
      INSERT INTO analysis_campaign_items (
        campaign_id, session_id, ordinal, message_count, input_revision,
        status, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `);
    for (const item of preview.items) {
      insertItem.run(
        id,
        item.sessionId,
        item.ordinal,
        item.messageCount,
        item.inputRevision,
        now,
      );
    }

    return mapCampaign(getCampaignRow(db, id)!);
  }).immediate();
}

export function inspectHistoryRefreshCampaign(
  db: Database.Database,
  campaignId: string,
): HistoryRefreshCampaignInspection {
  const campaignRow = getCampaignRow(db, campaignId);
  if (!campaignRow) throw new Error(`History refresh campaign not found: ${campaignId}`);

  const items = (db.prepare(`
    SELECT campaign_id, session_id, ordinal, message_count, input_revision,
           status, session_stage_json, session_usage_json, error_code,
           safe_error, attempts, claimed_at, staged_at, failed_at,
           succeeded_at, updated_at
    FROM analysis_campaign_items
    WHERE campaign_id = ?
    ORDER BY ordinal ASC
  `).all(campaignId) as CampaignItemRow[]).map(mapCampaignItem);
  const counts: Record<HistoryRefreshItemStatus, number> = {
    pending: 0,
    session_staged: 0,
    failed: 0,
    succeeded: 0,
  };
  for (const item of items) counts[item.status]++;

  return { campaign: mapCampaign(campaignRow), counts, items };
}

export function pauseHistoryRefreshCampaign(
  db: Database.Database,
  campaignId: string,
): HistoryRefreshCampaign {
  const campaign = getCampaignRow(db, campaignId);
  if (!campaign) throw new Error(`History refresh campaign not found: ${campaignId}`);
  if (campaign.status === 'paused') return mapCampaign(campaign);
  if (campaign.status !== 'active') {
    throw new Error(`Cannot pause history refresh campaign in ${campaign.status} state`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE analysis_campaigns
    SET status = 'paused', paused_at = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(now, now, campaignId);
  return mapCampaign(getCampaignRow(db, campaignId)!);
}

export function resumeHistoryRefreshCampaign(
  db: Database.Database,
  campaignId: string,
): HistoryRefreshCampaign {
  const campaign = getCampaignRow(db, campaignId);
  if (!campaign) throw new Error(`History refresh campaign not found: ${campaignId}`);
  if (campaign.status === 'active') return mapCampaign(campaign);
  if (campaign.status !== 'paused') {
    throw new Error(`Cannot resume history refresh campaign in ${campaign.status} state`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE analysis_campaigns
    SET status = 'active', resumed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'paused'
  `).run(now, now, campaignId);
  return mapCampaign(getCampaignRow(db, campaignId)!);
}

/**
 * Explicitly grant a fresh bounded retry budget to failed members. Existing
 * pass-one stages are preserved, so a prompt-quality failure does not repay
 * for pass one. A no-op leaves every timestamp untouched.
 */
export function retryFailedHistoryRefreshItems(
  db: Database.Database,
  campaignId: string,
  now = new Date().toISOString(),
): RetryFailedHistoryRefreshResult {
  return db.transaction(() => {
    const campaign = getCampaignRow(db, campaignId);
    if (!campaign) throw new Error(`History refresh campaign not found: ${campaignId}`);
    if (campaign.status !== 'active' && campaign.status !== 'paused') {
      throw new Error(`Cannot retry failed items in a ${campaign.status} campaign`);
    }

    const result = db.prepare(`
      UPDATE analysis_campaign_items
      SET status = CASE
            WHEN session_stage_json IS NULL THEN 'pending'
            ELSE 'session_staged'
          END,
          attempts = 0,
          claimed_at = NULL,
          error_code = NULL,
          safe_error = NULL,
          failed_at = NULL,
          updated_at = ?
      WHERE campaign_id = ? AND status = 'failed'
    `).run(now, campaignId);

    if (result.changes > 0) {
      db.prepare(`
        UPDATE analysis_campaigns SET updated_at = ? WHERE id = ?
      `).run(now, campaignId);
    }

    return {
      campaign: mapCampaign(getCampaignRow(db, campaignId)!),
      resetCount: result.changes,
    };
  }).immediate();
}

/** Terminally stop an active or paused campaign and release its leases. */
export function cancelHistoryRefreshCampaign(
  db: Database.Database,
  campaignId: string,
  now = new Date().toISOString(),
): HistoryRefreshCampaign {
  return db.transaction(() => {
    const campaign = getCampaignRow(db, campaignId);
    if (!campaign) throw new Error(`History refresh campaign not found: ${campaignId}`);
    if (campaign.status === 'cancelled') return mapCampaign(campaign);
    if (campaign.status !== 'active' && campaign.status !== 'paused') {
      throw new Error(`Cannot cancel a history refresh campaign in ${campaign.status} state`);
    }

    db.prepare(`
      UPDATE analysis_campaigns
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status IN ('active', 'paused')
    `).run(now, campaignId);
    db.prepare(`
      UPDATE analysis_campaign_items
      SET claimed_at = NULL, updated_at = ?
      WHERE campaign_id = ? AND claimed_at IS NOT NULL
    `).run(now, campaignId);
    return mapCampaign(getCampaignRow(db, campaignId)!);
  }).immediate();
}

export function claimNextHistoryRefreshItem(
  db: Database.Database,
  campaignId: string,
  options: ClaimHistoryRefreshOptions = {},
): HistoryRefreshCampaignItem | null {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('History refresh claim time must be ISO-8601');
  const claimLeaseMs = options.claimLeaseMs ?? 30 * 60 * 1000;
  if (!Number.isFinite(claimLeaseMs) || claimLeaseMs < 0) {
    throw new Error('History refresh claim lease must be non-negative');
  }
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('History refresh max attempts must be a positive integer');
  }
  const staleBefore = new Date(nowMs - claimLeaseMs).toISOString();
  const statuses = options.retryFailed
    ? "('pending', 'session_staged', 'failed')"
    : "('pending', 'session_staged')";

  return db.transaction(() => {
    const campaign = getCampaignRow(db, campaignId);
    if (!campaign) throw new Error(`History refresh campaign not found: ${campaignId}`);
    if (campaign.status !== 'active') return null;

    const candidate = db.prepare(`
      SELECT campaign_id, session_id, ordinal, message_count, input_revision,
             status, session_stage_json, session_usage_json, error_code,
             safe_error, attempts, claimed_at, staged_at, failed_at,
             succeeded_at, updated_at
      FROM analysis_campaign_items
      WHERE campaign_id = ?
        AND status IN ${statuses}
        AND attempts < ?
        AND (claimed_at IS NULL OR claimed_at <= ?)
      ORDER BY CASE WHEN status = 'failed' THEN 1 ELSE 0 END, ordinal ASC
      LIMIT 1
    `).get(campaignId, maxAttempts, staleBefore) as CampaignItemRow | undefined;
    if (!candidate) return null;

    const retryStatus = candidate.status === 'failed'
      ? (candidate.session_stage_json === null ? 'pending' : 'session_staged')
      : candidate.status;
    const attemptIncrement = candidate.status === 'session_staged' ? 0 : 1;
    db.prepare(`
      UPDATE analysis_campaign_items
      SET status = ?, claimed_at = ?, attempts = attempts + ?,
          error_code = NULL, safe_error = NULL, failed_at = NULL,
          updated_at = ?
      WHERE campaign_id = ? AND session_id = ?
    `).run(retryStatus, now, attemptIncrement, now, campaignId, candidate.session_id);

    return mapCampaignItem(getCampaignItemRow(db, campaignId, candidate.session_id)!);
  }).immediate();
}

export function stageHistoryRefreshSession(
  db: Database.Database,
  input: StageHistoryRefreshSessionInput,
): HistoryRefreshCampaignItem {
  const sessionStageJson = jsonWithoutSecrets(input.sessionStage, 'sessionStage', true);
  const sessionUsageJson = jsonWithoutSecrets(input.sessionUsage, 'sessionUsage', true);
  const now = input.now ?? new Date().toISOString();

  return db.transaction(() => {
    const item = getCampaignItemRow(db, input.campaignId, input.sessionId);
    if (!item) {
      throw new Error(`History refresh item not found: ${input.campaignId}/${input.sessionId}`);
    }
    if (item.status !== 'pending' || item.claimed_at === null) {
      throw new Error(`History refresh item is not a claimed pending item (${item.status})`);
    }
    if (item.input_revision !== input.inputRevision) {
      throw new Error('History refresh input revision does not match the campaign item');
    }
    const session = getSelectedSessionRow(db, input.sessionId);
    if (!session || calculateInputRevision(db, session) !== item.input_revision) {
      throw new Error('History refresh source session changed after campaign creation');
    }

    db.prepare(`
      UPDATE analysis_campaign_items
      SET status = 'session_staged', session_stage_json = ?,
          session_usage_json = ?, claimed_at = NULL, staged_at = ?,
          error_code = NULL, safe_error = NULL, failed_at = NULL,
          updated_at = ?
      WHERE campaign_id = ? AND session_id = ?
    `).run(
      sessionStageJson,
      sessionUsageJson,
      now,
      now,
      input.campaignId,
      input.sessionId,
    );
    return mapCampaignItem(getCampaignItemRow(db, input.campaignId, input.sessionId)!);
  }).immediate();
}

export function releaseHistoryRefreshClaim(
  db: Database.Database,
  input: ReleaseHistoryRefreshClaimInput,
): HistoryRefreshCampaignItem {
  const now = input.now ?? new Date().toISOString();

  return db.transaction(() => {
    const item = getCampaignItemRow(db, input.campaignId, input.sessionId);
    if (!item) {
      throw new Error(`History refresh item not found: ${input.campaignId}/${input.sessionId}`);
    }
    if (item.input_revision !== input.inputRevision) {
      throw new Error('History refresh input revision does not match the campaign item');
    }
    if (item.status !== 'pending' && item.status !== 'session_staged') {
      throw new Error(`Cannot release a history refresh item in ${item.status} state`);
    }
    if (item.claimed_at === null) return mapCampaignItem(item);

    db.prepare(`
      UPDATE analysis_campaign_items
      SET claimed_at = NULL,
          attempts = CASE
            WHEN status = 'pending' AND attempts > 0 THEN attempts - 1
            ELSE attempts
          END,
          updated_at = ?
      WHERE campaign_id = ? AND session_id = ?
    `).run(now, input.campaignId, input.sessionId);
    return mapCampaignItem(getCampaignItemRow(db, input.campaignId, input.sessionId)!);
  }).immediate();
}

export function markHistoryRefreshItemFailed(
  db: Database.Database,
  input: MarkHistoryRefreshItemFailedInput,
): MarkHistoryRefreshItemFailedResult {
  const now = input.now ?? new Date().toISOString();
  const errorCode = normalizeErrorCode(input.error.code);
  const safeError = sanitizeErrorMessage(input.error.message);

  return db.transaction((): MarkHistoryRefreshItemFailedResult => {
    const campaign = getCampaignRow(db, input.campaignId);
    if (!campaign) {
      throw new Error(`History refresh campaign not found: ${input.campaignId}`);
    }
    const item = getCampaignItemRow(db, input.campaignId, input.sessionId);
    if (!item) {
      throw new Error(`History refresh item not found: ${input.campaignId}/${input.sessionId}`);
    }
    if (campaign.status === 'cancelled' || campaign.status === 'completed') {
      return {
        outcome: 'campaign_terminal',
        campaignStatus: campaign.status,
        item: mapCampaignItem(item),
      };
    }
    if (item.status === 'succeeded') {
      throw new Error('A succeeded history refresh item cannot be marked failed');
    }
    if (item.claimed_at === null) {
      throw new Error('History refresh item must be claimed before recording a failure');
    }
    if (item.input_revision !== input.inputRevision) {
      throw new Error('History refresh input revision does not match the campaign item');
    }

    db.prepare(`
      UPDATE analysis_campaign_items
      SET status = 'failed', error_code = ?, safe_error = ?,
          claimed_at = NULL, failed_at = ?, updated_at = ?
      WHERE campaign_id = ? AND session_id = ?
    `).run(
      errorCode,
      safeError,
      now,
      now,
      input.campaignId,
      input.sessionId,
    );
    return {
      outcome: 'failed',
      campaignStatus: campaign.status,
      item: mapCampaignItem(getCampaignItemRow(db, input.campaignId, input.sessionId)!),
    };
  }).immediate();
}

function mapSnapshot(row: CampaignSnapshotRow): HistoryRefreshSnapshot {
  return {
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    insights: JSON.parse(row.insights_json) as Array<Record<string, unknown>>,
    facet: row.facet_json === null
      ? null
      : JSON.parse(row.facet_json) as Record<string, unknown>,
    usage: JSON.parse(row.usage_json) as Array<Record<string, unknown>>,
    generatedTitle: JSON.parse(row.generated_title_json) as string | null,
    createdAt: row.created_at,
  };
}

export function getHistoryRefreshSnapshot(
  db: Database.Database,
  campaignId: string,
  sessionId: string,
): HistoryRefreshSnapshot | null {
  const row = db.prepare(`
    SELECT campaign_id, session_id, insights_json, facet_json, usage_json,
           generated_title_json, created_at
    FROM analysis_campaign_snapshots
    WHERE campaign_id = ? AND session_id = ?
  `).get(campaignId, sessionId) as CampaignSnapshotRow | undefined;
  return row ? mapSnapshot(row) : null;
}

export function publishHistoryRefreshSuccess(
  db: Database.Database,
  input: PublishHistoryRefreshSuccessInput,
): PublishHistoryRefreshSuccessResult {
  const now = input.now ?? new Date().toISOString();

  return db.transaction(() => {
    const campaign = getCampaignRow(db, input.campaignId);
    if (!campaign) throw new Error(`History refresh campaign not found: ${input.campaignId}`);
    if (campaign.status !== 'active' && campaign.status !== 'paused') {
      throw new Error(`Cannot publish a history refresh campaign in ${campaign.status} state`);
    }

    const item = getCampaignItemRow(db, input.campaignId, input.sessionId);
    if (!item) {
      throw new Error(`History refresh item not found: ${input.campaignId}/${input.sessionId}`);
    }
    if (item.status !== 'session_staged' || item.claimed_at === null) {
      throw new Error(`History refresh item is not a claimed staged item (${item.status})`);
    }
    if (item.input_revision !== input.inputRevision) {
      throw new Error('History refresh input revision does not match the campaign item');
    }
    const session = getSelectedSessionRow(db, input.sessionId);
    if (!session || calculateInputRevision(db, session) !== item.input_revision) {
      throw new Error('History refresh source session changed after campaign creation');
    }

    const oldInsights = db.prepare(`
      SELECT * FROM insights WHERE session_id = ? ORDER BY id ASC
    `).all(input.sessionId) as Array<Record<string, unknown>>;
    const oldFacet = db.prepare(`
      SELECT * FROM session_facets WHERE session_id = ?
    `).get(input.sessionId) as Record<string, unknown> | undefined;
    const oldUsage = db.prepare(`
      SELECT * FROM analysis_usage WHERE session_id = ? ORDER BY analysis_type ASC
    `).all(input.sessionId) as Array<Record<string, unknown>>;
    const generatedTitle = db.prepare(`
      SELECT generated_title FROM sessions WHERE id = ?
    `).pluck().get(input.sessionId) as string | null | undefined;
    if (generatedTitle === undefined) {
      throw new Error(`History refresh source session not found: ${input.sessionId}`);
    }

    db.prepare(`
      INSERT INTO analysis_campaign_snapshots (
        campaign_id, session_id, insights_json, facet_json, usage_json,
        generated_title_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.campaignId,
      input.sessionId,
      jsonWithoutSecrets(oldInsights, 'snapshot.insights'),
      oldFacet === undefined ? null : jsonWithoutSecrets(oldFacet, 'snapshot.facet'),
      jsonWithoutSecrets(oldUsage, 'snapshot.usage'),
      jsonWithoutSecrets(generatedTitle, 'snapshot.generatedTitle'),
      now,
    );

    const publishResult = input.publish(db) as unknown;
    if (
      publishResult !== null
      && (typeof publishResult === 'object' || typeof publishResult === 'function')
      && typeof (publishResult as { then?: unknown }).then === 'function'
    ) {
      throw new Error('History refresh publish callback must be synchronous');
    }

    db.prepare(`
      UPDATE analysis_campaign_items
      SET status = 'succeeded', claimed_at = NULL, error_code = NULL,
          safe_error = NULL, failed_at = NULL, succeeded_at = ?, updated_at = ?
      WHERE campaign_id = ? AND session_id = ?
    `).run(now, now, input.campaignId, input.sessionId);

    const remaining = db.prepare(`
      SELECT COUNT(*)
      FROM analysis_campaign_items
      WHERE campaign_id = ? AND status <> 'succeeded'
    `).pluck().get(input.campaignId) as number;
    if (remaining === 0) {
      db.prepare(`
        UPDATE analysis_campaigns
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, input.campaignId);
    } else {
      db.prepare(`
        UPDATE analysis_campaigns SET updated_at = ? WHERE id = ?
      `).run(now, input.campaignId);
    }

    return {
      campaign: mapCampaign(getCampaignRow(db, input.campaignId)!),
      item: mapCampaignItem(getCampaignItemRow(db, input.campaignId, input.sessionId)!),
    };
  }).immediate();
}
