import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { freezeSessionAnalysisInput } from '../two-pass-analysis.js';
import {
  cancelHistoryRefreshCampaign,
  claimNextHistoryRefreshItem,
  createHistoryRefreshCampaign,
  getActiveHistoryRefreshCampaign,
  getHistoryRefreshSnapshot,
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
} from '../history-refresh-db.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO projects (id, name, path, last_activity)
    VALUES ('project-1', 'Code Insights', '/code-insights', '2026-07-21T00:00:00Z')
  `).run();
  return db;
}

function insertSession(
  db: Database.Database,
  id: string,
  startedAt: string,
  messageCount: number,
  deletedAt: string | null = null,
  withMessage = true,
): void {
  db.prepare(`
    INSERT INTO sessions (
      id, project_id, project_name, project_path, started_at, ended_at,
      message_count, deleted_at
    ) VALUES (?, 'project-1', 'Code Insights', '/code-insights', ?, ?, ?, ?)
  `).run(id, startedAt, startedAt, messageCount, deletedAt);
  if (withMessage) {
    db.prepare(`
      INSERT INTO messages (
        id, session_id, type, content, tool_calls, tool_results, timestamp
      ) VALUES (?, ?, 'user', 'Campaign input', '[]', '[]', ?)
    `).run(`${id}-message`, id, startedAt);
  }
}

function insertOldAnalysis(db: Database.Database, sessionId: string): void {
  db.prepare(`UPDATE sessions SET generated_title = 'Old title' WHERE id = ?`).run(sessionId);
  db.prepare(`
    INSERT INTO insights (
      id, session_id, project_id, project_name, type, title, content,
      summary, confidence, timestamp
    ) VALUES (
      'old-insight', ?, 'project-1', 'Code Insights', 'summary',
      'Old title', 'Old content', 'Old summary', 0.9, '2026-07-21T08:00:00Z'
    )
  `).run(sessionId);
  db.prepare(`
    INSERT INTO session_facets (
      session_id, outcome_satisfaction, workflow_pattern,
      friction_points, effective_patterns
    ) VALUES (?, 'satisfied', 'old-workflow', '[]', '[]')
  `).run(sessionId);
  db.prepare(`
    INSERT INTO analysis_usage (
      session_id, analysis_type, provider, model, input_tokens, output_tokens
    ) VALUES (?, 'session', 'anthropic', 'old-model', 100, 10)
  `).run(sessionId);
}

describe('history refresh campaign store', () => {
  it('finishes an empty campaign immediately and exposes it as the latest run', () => {
    const db = freshDb();
    expect(getLatestHistoryRefreshCampaign(db)).toBeNull();

    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });

    expect(campaign).toMatchObject({ status: 'completed', totalItems: 0 });
    expect(campaign.completedAt).not.toBeNull();
    expect(getActiveHistoryRefreshCampaign(db)).toBeNull();
    expect(getLatestHistoryRefreshCampaign(db)?.id).toBe(campaign.id);

    db.close();
  });

  it('previews a stable eligible selection without writing campaign state', () => {
    const db = freshDb();
    insertSession(db, 'newer', '2026-07-21T08:00:00Z', 4);
    insertSession(db, 'older', '2026-07-20T08:00:00Z', 3);
    insertSession(db, 'too-short', '2026-07-19T08:00:00Z', 2);
    insertSession(db, 'deleted', '2026-07-18T08:00:00Z', 9, '2026-07-21T00:00:00Z');
    insertSession(db, 'metadata-only', '2026-07-17T08:00:00Z', 4, null, false);
    db.prepare(`
      INSERT INTO messages (
        id, session_id, type, content, thinking, tool_calls, tool_results,
        usage, timestamp, parent_id
      ) VALUES (
        'message-1', 'older', 'user', 'Analyze this exact input', NULL,
        '[]', '[]', '{"input_tokens":12}', '2026-07-20T08:00:00Z', NULL
      )
    `).run();

    const preview = previewHistoryRefresh(db, {});

    expect(preview.items).toMatchObject([
      { sessionId: 'older', ordinal: 0, messageCount: 3 },
      { sessionId: 'newer', ordinal: 1, messageCount: 4 },
    ]);
    expect(preview.selectionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.items.every(item => /^sha256:[0-9a-f]{64}$/.test(item.inputRevision))).toBe(true);
    expect(preview.items[0].inputRevision).toBe(
      freezeSessionAnalysisInput('older', db).inputRevision,
    );
    expect(db.prepare('SELECT COUNT(*) FROM analysis_campaigns').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM analysis_campaign_items').pluck().get()).toBe(0);

    db.close();
  });

  it('selects inclusive calendar dates in the local timezone', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    const db = freshDb();
    try {
      expect(db.prepare("SELECT date('2026-07-20T16:00:00Z', 'localtime')").pluck().get())
        .toBe('2026-07-21');
      insertSession(db, 'before', '2026-07-20T15:59:59Z', 3);
      insertSession(db, 'local-start', '2026-07-20T16:00:00Z', 3);
      insertSession(db, 'local-end', '2026-07-21T15:59:59Z', 3);
      insertSession(db, 'after', '2026-07-21T16:00:00Z', 3);

      const preview = previewHistoryRefresh(db, {
        from: '2026-07-21',
        to: '2026-07-21',
      });

      expect(preview.items.map(item => item.sessionId)).toEqual(['local-start', 'local-end']);
    } finally {
      db.close();
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('creates an immutable membership from the previewed selection', () => {
    const db = freshDb();
    insertSession(db, 'first', '2026-07-19T08:00:00Z', 3);
    insertSession(db, 'second', '2026-07-20T08:00:00Z', 4);
    const preview = previewHistoryRefresh(db, {});

    const created = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      analysisVersion: '3.0.0',
      pipelineRevision: 'analysis-3.0.0/two-pass-v2/lang-zh-CN',
      baseUrlFingerprint: 'base-url-sha256',
      scope: {},
    }, preview.selectionFingerprint);

    insertSession(db, 'arrived-later', '2026-07-21T08:00:00Z', 5);
    const inspection = inspectHistoryRefreshCampaign(db, created.id);

    expect(inspection.campaign).toMatchObject({
      id: created.id,
      provider: 'anthropic',
      model: 'glm-5.2',
      pipelineRevision: 'analysis-3.0.0/two-pass-v2/lang-zh-CN',
      baseUrlFingerprint: 'base-url-sha256',
      selectionFingerprint: preview.selectionFingerprint,
      status: 'active',
      totalItems: 2,
    });
    expect(inspection.items.map(item => ({
      sessionId: item.sessionId,
      ordinal: item.ordinal,
      status: item.status,
    }))).toEqual([
      { sessionId: 'first', ordinal: 0, status: 'pending' },
      { sessionId: 'second', ordinal: 1, status: 'pending' },
    ]);
    expect(previewHistoryRefresh(db, {}).count).toBe(3);

    db.close();
  });

  it('returns the active campaign for the same intent and rejects a competing intent', () => {
    const db = freshDb();
    insertSession(db, 'original', '2026-07-20T08:00:00Z', 3);
    const spec = {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'same-endpoint',
      scope: {},
    };
    const first = createHistoryRefreshCampaign(db, spec);

    // A repeated start means "resume the same operation", even if new source
    // sessions have appeared since its immutable membership was captured.
    insertSession(db, 'new-source-data', '2026-07-21T08:00:00Z', 4);
    const repeated = createHistoryRefreshCampaign(db, spec);

    expect(repeated.id).toBe(first.id);
    expect(inspectHistoryRefreshCampaign(db, repeated.id).campaign.totalItems).toBe(1);
    expect(() => createHistoryRefreshCampaign(db, {
      ...spec,
      model: 'a-different-model',
    })).toThrow(/already active/);

    db.close();
  });

  it('persists pause and resume state across reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'code-insights-campaign-'));
    const path = join(directory, 'data.db');
    try {
      const firstConnection = new Database(path);
      firstConnection.pragma('foreign_keys = ON');
      runMigrations(firstConnection);
      firstConnection.prepare(`
        INSERT INTO projects (id, name, path, last_activity)
        VALUES ('project-1', 'Code Insights', '/code-insights', '2026-07-21T00:00:00Z')
      `).run();
      insertSession(firstConnection, 'session-1', '2026-07-21T08:00:00Z', 3);
      const created = createHistoryRefreshCampaign(firstConnection, {
        provider: 'anthropic',
        model: 'glm-5.2',
        baseUrlFingerprint: 'endpoint-fingerprint',
        scope: {},
      });

      const paused = pauseHistoryRefreshCampaign(firstConnection, created.id);
      expect(paused.status).toBe('paused');
      expect(paused.pausedAt).not.toBeNull();
      firstConnection.close();

      const reopened = new Database(path);
      reopened.pragma('foreign_keys = ON');
      runMigrations(reopened);
      expect(getActiveHistoryRefreshCampaign(reopened)).toMatchObject({
        id: created.id,
        status: 'paused',
      });

      const resumed = resumeHistoryRefreshCampaign(reopened, created.id);
      expect(resumed.status).toBe('active');
      expect(resumed.resumedAt).not.toBeNull();
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('claims work in ordinal order and resumes a staged session before moving on', () => {
    const db = freshDb();
    insertSession(db, 'first', '2026-07-19T08:00:00Z', 3);
    insertSession(db, 'second', '2026-07-20T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });

    const firstClaim = claimNextHistoryRefreshItem(db, campaign.id, {
      now: '2026-07-21T01:00:00.000Z',
    });
    expect(firstClaim).toMatchObject({
      sessionId: 'first',
      status: 'pending',
      attempts: 1,
      claimedAt: '2026-07-21T01:00:00.000Z',
    });

    stageHistoryRefreshSession(db, {
      campaignId: campaign.id,
      sessionId: 'first',
      inputRevision: firstClaim!.inputRevision,
      sessionStage: { summary: { title: 'Prepared, not yet visible' } },
      sessionUsage: { inputTokens: 120, outputTokens: 30 },
      now: '2026-07-21T01:01:00.000Z',
    });

    const stagedClaim = claimNextHistoryRefreshItem(db, campaign.id, {
      now: '2026-07-21T01:02:00.000Z',
    });
    expect(stagedClaim).toMatchObject({
      sessionId: 'first',
      status: 'session_staged',
      sessionStage: { summary: { title: 'Prepared, not yet visible' } },
      sessionUsage: { inputTokens: 120, outputTokens: 30 },
      attempts: 1,
    });

    pauseHistoryRefreshCampaign(db, campaign.id);
    expect(claimNextHistoryRefreshItem(db, campaign.id)).toBeNull();

    db.close();
  });

  it('releases a claimed pass without discarding its stage or changing its attempt count', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const pending = claimNextHistoryRefreshItem(db, campaign.id)!;
    stageHistoryRefreshSession(db, {
      campaignId: campaign.id,
      sessionId: pending.sessionId,
      inputRevision: pending.inputRevision,
      sessionStage: { summary: { title: 'Keep this stage' } },
      sessionUsage: { inputTokens: 12 },
    });
    const staged = claimNextHistoryRefreshItem(db, campaign.id)!;

    const released = releaseHistoryRefreshClaim(db, {
      campaignId: campaign.id,
      sessionId: staged.sessionId,
      inputRevision: staged.inputRevision,
      now: '2026-07-21T03:00:00.000Z',
    });

    expect(released).toMatchObject({
      status: 'session_staged',
      claimedAt: null,
      attempts: staged.attempts,
      sessionStage: { summary: { title: 'Keep this stage' } },
    });

    db.close();
  });

  it('does not consume an attempt when a pending claim is released before its first model pass', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const claimed = claimNextHistoryRefreshItem(db, campaign.id)!;
    expect(claimed.attempts).toBe(1);

    const released = releaseHistoryRefreshClaim(db, {
      campaignId: campaign.id,
      sessionId: claimed.sessionId,
      inputRevision: claimed.inputRevision,
    });

    expect(released).toMatchObject({ status: 'pending', claimedAt: null, attempts: 0 });
    expect(claimNextHistoryRefreshItem(db, campaign.id)).toMatchObject({ attempts: 1 });
    db.close();
  });

  it('rejects credential-shaped fields before durable staging', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const claimed = claimNextHistoryRefreshItem(db, campaign.id)!;

    expect(() => stageHistoryRefreshSession(db, {
      campaignId: campaign.id,
      sessionId: claimed.sessionId,
      inputRevision: claimed.inputRevision,
      sessionStage: { apiKey: 'must-never-be-stored' },
      sessionUsage: { inputTokens: 1 },
    })).toThrow(/credential field/);
    expect(() => stageHistoryRefreshSession(db, {
      campaignId: campaign.id,
      sessionId: claimed.sessionId,
      inputRevision: claimed.inputRevision,
      sessionStage: { 'x-api-key': 'alternate-secret' },
      sessionUsage: { inputTokens: 1 },
    })).toThrow(/credential field/);
    expect(() => stageHistoryRefreshSession(db, {
      campaignId: campaign.id,
      sessionId: claimed.sessionId,
      inputRevision: claimed.inputRevision,
      sessionStage: { summary: { title: 'Bearer embedded-secret' } },
      sessionUsage: { inputTokens: 1 },
    })).toThrow(/credential value/);
    expect(JSON.stringify(inspectHistoryRefreshCampaign(db, campaign.id)))
      .not.toMatch(/must-never-be-stored|alternate-secret|embedded-secret/);

    db.close();
  });

  it('stores only a safe failure summary and retries from the staged pass explicitly', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const firstPass = claimNextHistoryRefreshItem(db, campaign.id)!;
    stageHistoryRefreshSession(db, {
      campaignId: campaign.id,
      sessionId: firstPass.sessionId,
      inputRevision: firstPass.inputRevision,
      sessionStage: { summary: { title: 'Staged title' } },
      sessionUsage: { inputTokens: 10 },
    });
    const secondPass = claimNextHistoryRefreshItem(db, campaign.id)!;

    markHistoryRefreshItemFailed(db, {
      campaignId: campaign.id,
      sessionId: secondPass.sessionId,
      inputRevision: secondPass.inputRevision,
      error: {
        code: 'provider_error',
        message: 'Authorization: Bearer top-secret api_key=also-secret upstream rejected request',
      },
    });

    const failed = inspectHistoryRefreshCampaign(db, campaign.id).items[0];
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
    expect(failed.safeError).toContain('[REDACTED]');
    expect(failed.safeError).not.toMatch(/top-secret|also-secret/);
    expect(claimNextHistoryRefreshItem(db, campaign.id)).toBeNull();
    expect(claimNextHistoryRefreshItem(db, campaign.id, { retryFailed: true })).toMatchObject({
      sessionId: 'session-1',
      status: 'session_staged',
      attempts: 2,
    });

    db.close();
  });

  it('processes fresh work before bounded retries and stops after three claims', () => {
    const db = freshDb();
    insertSession(db, 'first', '2026-07-19T08:00:00Z', 3);
    insertSession(db, 'second', '2026-07-20T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const fail = (item: NonNullable<ReturnType<typeof claimNextHistoryRefreshItem>>) => {
      markHistoryRefreshItemFailed(db, {
        campaignId: campaign.id,
        sessionId: item.sessionId,
        inputRevision: item.inputRevision,
        error: { code: 'temporary', message: 'temporary provider failure' },
      });
    };

    const firstAttempt = claimNextHistoryRefreshItem(db, campaign.id)!;
    fail(firstAttempt);

    const freshWork = claimNextHistoryRefreshItem(db, campaign.id, { retryFailed: true });
    expect(freshWork?.sessionId).toBe('second');

    const retryTwo = claimNextHistoryRefreshItem(db, campaign.id, { retryFailed: true })!;
    expect(retryTwo).toMatchObject({ sessionId: 'first', attempts: 2 });
    fail(retryTwo);
    const retryThree = claimNextHistoryRefreshItem(db, campaign.id, { retryFailed: true })!;
    expect(retryThree).toMatchObject({ sessionId: 'first', attempts: 3 });
    fail(retryThree);
    expect(claimNextHistoryRefreshItem(db, campaign.id, { retryFailed: true })).toBeNull();

    const reset = retryFailedHistoryRefreshItems(
      db,
      campaign.id,
      '2026-07-21T04:00:00.000Z',
    );
    expect(reset.resetCount).toBe(1);
    expect(inspectHistoryRefreshCampaign(db, campaign.id).items[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      errorCode: null,
      safeError: null,
      failedAt: null,
    });
    expect(claimNextHistoryRefreshItem(db, campaign.id)).toMatchObject({
      sessionId: 'first',
      attempts: 1,
    });

    db.close();
  });

  it('does not mutate a campaign when there are no failed items to reset', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const before = inspectHistoryRefreshCampaign(db, campaign.id);

    const result = retryFailedHistoryRefreshItems(
      db,
      campaign.id,
      '2030-01-01T00:00:00.000Z',
    );

    expect(result.resetCount).toBe(0);
    expect(inspectHistoryRefreshCampaign(db, campaign.id)).toEqual(before);
    db.close();
  });

  it('cancels the current campaign and releases any durable claims', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    claimNextHistoryRefreshItem(db, campaign.id);

    const cancelled = cancelHistoryRefreshCampaign(
      db,
      campaign.id,
      '2026-07-21T05:00:00.000Z',
    );

    expect(cancelled.status).toBe('cancelled');
    expect(getActiveHistoryRefreshCampaign(db)).toBeNull();
    expect(inspectHistoryRefreshCampaign(db, campaign.id).items[0].claimedAt).toBeNull();
    expect(claimNextHistoryRefreshItem(db, campaign.id, { retryFailed: true })).toBeNull();
    db.close();
  });

  it('treats failure recording as a terminal no-op when cancellation already released the claim', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const claimed = claimNextHistoryRefreshItem(db, campaign.id)!;
    cancelHistoryRefreshCampaign(db, campaign.id, '2026-07-21T09:00:00.000Z');
    const before = inspectHistoryRefreshCampaign(db, campaign.id).items[0];

    const result = markHistoryRefreshItemFailed(db, {
      campaignId: campaign.id,
      sessionId: claimed.sessionId,
      inputRevision: claimed.inputRevision,
      error: { code: 'provider_error', message: 'late provider failure' },
      now: '2026-07-21T09:01:00.000Z',
    });

    expect(result).toMatchObject({
      outcome: 'campaign_terminal',
      campaignStatus: 'cancelled',
      item: before,
    });
    expect(inspectHistoryRefreshCampaign(db, campaign.id).items[0]).toEqual(before);
    db.close();
  });

  it('atomically snapshots old analysis, publishes new data, and never reclaims success', () => {
    const db = freshDb();
    insertSession(db, 'session-1', '2026-07-21T08:00:00Z', 3);
    insertOldAnalysis(db, 'session-1');
    const campaign = createHistoryRefreshCampaign(db, {
      provider: 'anthropic',
      model: 'glm-5.2',
      baseUrlFingerprint: 'endpoint-fingerprint',
      scope: {},
    });
    const firstPass = claimNextHistoryRefreshItem(db, campaign.id)!;
    stageHistoryRefreshSession(db, {
      campaignId: campaign.id,
      sessionId: firstPass.sessionId,
      inputRevision: firstPass.inputRevision,
      sessionStage: { summary: { title: 'New title' } },
      sessionUsage: { inputTokens: 25, outputTokens: 5 },
    });
    const secondPass = claimNextHistoryRefreshItem(db, campaign.id)!;

    expect(() => publishHistoryRefreshSuccess(db, {
      campaignId: campaign.id,
      sessionId: secondPass.sessionId,
      inputRevision: secondPass.inputRevision,
      publish: (transactionDb) => {
        transactionDb.prepare("DELETE FROM insights WHERE session_id = 'session-1'").run();
        throw new Error('simulated publish failure');
      },
    })).toThrow('simulated publish failure');
    expect(db.prepare("SELECT title FROM insights WHERE id = 'old-insight'").pluck().get()).toBe('Old title');
    expect(getHistoryRefreshSnapshot(db, campaign.id, 'session-1')).toBeNull();

    const result = publishHistoryRefreshSuccess(db, {
      campaignId: campaign.id,
      sessionId: secondPass.sessionId,
      inputRevision: secondPass.inputRevision,
      now: '2026-07-21T02:00:00.000Z',
      publish: (transactionDb) => {
        transactionDb.prepare("DELETE FROM insights WHERE session_id = 'session-1'").run();
        transactionDb.prepare(`
          INSERT INTO insights (
            id, session_id, project_id, project_name, type, title, content,
            summary, confidence, timestamp
          ) VALUES (
            'new-insight', 'session-1', 'project-1', 'Code Insights',
            'summary', 'New title', 'New content', 'New summary', 0.9,
            '2026-07-21T08:00:00Z'
          )
        `).run();
        transactionDb.prepare(`
          UPDATE sessions SET generated_title = 'New title' WHERE id = 'session-1'
        `).run();
      },
    });

    expect(result.item.status).toBe('succeeded');
    expect(result.campaign.status).toBe('completed');
    expect(claimNextHistoryRefreshItem(db, campaign.id, { retryFailed: true })).toBeNull();
    expect(getHistoryRefreshSnapshot(db, campaign.id, 'session-1')).toMatchObject({
      generatedTitle: 'Old title',
      insights: [{ id: 'old-insight', title: 'Old title' }],
      facet: { session_id: 'session-1', workflow_pattern: 'old-workflow' },
      usage: [{ session_id: 'session-1', model: 'old-model' }],
    });
    expect(db.prepare("SELECT title FROM insights WHERE id = 'new-insight'").pluck().get()).toBe('New title');

    db.close();
  });
});
