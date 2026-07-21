import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeInsightConfig } from '../../types.js';
import {
  buildReanalyzeCommand,
  type ReanalyzeDependencies,
  type ReanalyzeRunResult,
} from '../reanalyze.js';

type CampaignStatus = 'active' | 'paused' | 'completed' | 'cancelled';
type ItemStatus = 'pending' | 'session_staged' | 'failed' | 'succeeded';

interface TestCampaign {
  id: string;
  provider: string;
  model: string;
  analysisVersion: string;
  pipelineRevision: string;
  baseUrlFingerprint: string;
  scope: { from?: string; to?: string };
  status: CampaignStatus;
  totalItems: number;
}

interface TestItem {
  campaignId: string;
  sessionId: string;
  ordinal: number;
  messageCount: number;
  inputRevision: string;
  status: ItemStatus;
  sessionStage: unknown | null;
}

const config: ClaudeInsightConfig = {
  sync: { claudeDir: '/tmp/claude', excludeProjects: [] },
  dashboard: {
    llm: {
      provider: 'anthropic',
      model: 'glm-5.2',
      apiKey: 'secret-api-key',
      baseUrl: 'https://example.invalid/anthropic',
    },
  },
};

function campaign(overrides: Partial<TestCampaign> = {}): TestCampaign {
  return {
    id: 'campaign-1',
    provider: 'anthropic',
    model: 'glm-5.2',
    analysisVersion: '3.0.0',
    pipelineRevision: 'analysis-3.0.0/two-pass-v1',
    baseUrlFingerprint: 'endpoint-fingerprint',
    scope: {},
    status: 'active',
    totalItems: 3,
    ...overrides,
  };
}

function item(ordinal: number, overrides: Partial<TestItem> = {}): TestItem {
  return {
    campaignId: 'campaign-1',
    sessionId: `session-${ordinal + 1}`,
    ordinal,
    messageCount: 10,
    inputRevision: `revision-${ordinal + 1}`,
    status: 'pending',
    sessionStage: null,
    ...overrides,
  };
}

function makeDependencies(overrides: Partial<ReanalyzeDependencies> = {}) {
  const output: string[] = [];
  const items = [item(0), item(1), item(2)];
  let stagedForReclaim: TestItem | null = null;
  const active = campaign();
  const previewDb = { close: vi.fn() };
  const deps: ReanalyzeDependencies = {
    getDb: vi.fn(() => ({}) as never),
    openReadOnlyDb: vi.fn(() => previewDb as never),
    loadConfig: vi.fn(() => config),
    preview: vi.fn(() => ({
      scope: {},
      scopeJson: '{}',
      count: items.length,
      selectionFingerprint: 'selection-fingerprint',
      items: [],
    })),
    getActive: vi.fn(() => active as never),
    createCampaign: vi.fn(() => active as never),
    inspectCampaign: vi.fn(() => ({
      campaign: active,
      counts: { pending: 3, session_staged: 0, failed: 0, succeeded: 0 },
      items,
    }) as never),
    pauseCampaign: vi.fn(() => ({ ...active, status: 'paused' }) as never),
    resumeCampaign: vi.fn(() => active as never),
    retryFailedItems: vi.fn(() => ({ campaign: active, resetCount: 1 })) as never,
    cancelCampaign: vi.fn(() => ({ ...active, status: 'cancelled' }) as never),
    claimNextItem: vi.fn(() => {
      if (stagedForReclaim) {
        const staged = stagedForReclaim;
        stagedForReclaim = null;
        return staged;
      }
      return items.shift() ?? null;
    }) as never,
    stageSessionPass: vi.fn((_db, input) => {
      const original = [...items, item(0), item(1), item(2)]
        .find(candidate => candidate.sessionId === input.sessionId)!;
      stagedForReclaim = {
        ...original,
        campaignId: input.campaignId,
        inputRevision: input.inputRevision,
        status: 'session_staged',
        sessionStage: input.sessionStage,
      };
      return stagedForReclaim;
    }) as never,
    releaseClaim: vi.fn((_db, input) => item(0, {
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      inputRevision: input.inputRevision,
    })) as never,
    markItemFailed: vi.fn((_db, input) => ({
      outcome: 'failed',
      campaignStatus: 'active',
      item: item(0, {
        campaignId: input.campaignId,
        sessionId: input.sessionId,
        inputRevision: input.inputRevision,
        status: 'failed',
      }),
    })) as never,
    publishSuccess: vi.fn((db, input) => {
      input.publish(db);
      return {
        item: item(0, {
          campaignId: input.campaignId,
          sessionId: input.sessionId,
          inputRevision: input.inputRevision,
          status: 'succeeded',
        }),
        campaign: active,
      };
    }) as never,
    freezeInput: vi.fn((sessionId: string) => ({
      session: { id: sessionId, message_count: 10 },
      messages: [],
      inputRevision: `revision-${Number(sessionId.split('-')[1])}`,
    })) as never,
    prepareSessionPass: vi.fn(async (input: { session: { id: string }; inputRevision: string }) => ({
      schemaVersion: 1,
      kind: 'session',
      sessionId: input.session.id,
      inputRevision: input.inputRevision,
      sessionMessageCount: 10,
      provider: 'anthropic',
      model: 'glm-5.2',
      usage: {},
      response: {},
    })) as never,
    preparePromptQualityPass: vi.fn(async (input: { session: { id: string }; inputRevision: string }) => ({
      schemaVersion: 1,
      kind: 'prompt_quality',
      sessionId: input.session.id,
      inputRevision: input.inputRevision,
      sessionMessageCount: 10,
      provider: 'anthropic',
      model: 'glm-5.2',
      usage: {},
      response: { efficiency_score: 80 },
    })) as never,
    publishTwoPass: vi.fn((_input, _session, _pq, callback) => {
      callback?.({ insightCount: 1, promptQualityScore: 80 });
      return { insightCount: 1, promptQualityScore: 80 };
    }) as never,
    createRunner: vi.fn(() => ({ provider: 'anthropic', model: 'glm-5.2' }) as never),
    acquireLock: vi.fn(() => ({ token: 'lock', release: vi.fn() })),
    isMaintenancePaused: vi.fn(() => false),
    now: vi.fn(() => 1_000_000),
    isInteractive: vi.fn(() => false),
    confirmStart: vi.fn(async () => true),
    fingerprintBaseUrl: vi.fn(() => 'endpoint-fingerprint'),
    writeOut: vi.fn((text: string) => output.push(text)),
    writeError: vi.fn(),
    ...overrides,
  };
  return { deps, output, items, active, previewDb };
}

async function parse(deps: ReanalyzeDependencies, args: string[]): Promise<void> {
  await buildReanalyzeCommand(deps).parseAsync(args, { from: 'user' });
}

function lastJson<T>(output: string[]): T {
  return JSON.parse(output.at(-1)!.trim()) as T;
}

describe('reanalyze command', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  it('exposes explicit confirmed recovery and cancellation commands', () => {
    const { deps } = makeDependencies();
    const names = buildReanalyzeCommand(deps).commands.map(command => command.name());

    expect(names).toEqual(expect.arrayContaining(['retry-failed', 'cancel']));
  });

  it('previews a fixed selection and minimum provider request count without writes or a runner', async () => {
    const { deps, output, previewDb } = makeDependencies();

    await parse(deps, [
      '--dry-run',
      '--from', '2026-02-10',
      '--to', '2026-07-17',
      '--model', 'glm-5.2',
    ]);

    expect(deps.preview).toHaveBeenCalledWith(expect.anything(), {
      from: '2026-02-10',
      to: '2026-07-17',
    });
    expect(output.join('')).toContain('3 sessions');
    expect(output.join('')).toContain('minimum 6 provider requests');
    expect(output.join('')).toContain('long sessions/chunking/facet extraction and bounded retries can increase it');
    expect(output.join('')).toContain('in-flight crash adds uncertainty');
    expect(output.join('')).not.toMatch(/ceiling/i);
    expect(deps.createCampaign).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
    expect(deps.acquireLock).not.toHaveBeenCalled();
    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.openReadOnlyDb).toHaveBeenCalledOnce();
    expect(previewDb.close).toHaveBeenCalledOnce();
  });

  it('closes the read-only preview database when selection fails', async () => {
    const { deps, previewDb } = makeDependencies({
      preview: vi.fn(() => { throw new Error('broken read'); }),
    });

    await expect(parse(deps, ['--dry-run'])).rejects.toThrow('broken read');

    expect(deps.getDb).not.toHaveBeenCalled();
    expect(previewDb.close).toHaveBeenCalledOnce();
  });

  it.each([
    [['--dry-run', '--from', '2026-07-01'], /together/i],
    [['--dry-run', '--from', '2026-07-32', '--to', '2026-08-01'], /valid/i],
    [['--dry-run', '--from', '2026-08-01', '--to', '2026-07-01'], /after/i],
  ] as const)('rejects an invalid date range before opening the database', async (args, error) => {
    const { deps } = makeDependencies();

    await expect(parse(deps, [...args])).rejects.toThrow(error);

    expect(deps.getDb).not.toHaveBeenCalled();
  });

  it('requires --yes when start is non-interactive', async () => {
    const { deps } = makeDependencies();

    await expect(parse(deps, ['start'])).rejects.toThrow(/--yes/);

    expect(deps.confirmStart).not.toHaveBeenCalled();
    expect(deps.createCampaign).not.toHaveBeenCalled();
  });

  it('can confirm interactively and makes repeated starts idempotent', async () => {
    const active = campaign();
    const { deps } = makeDependencies({
      isInteractive: vi.fn(() => true),
      createCampaign: vi.fn(() => active as never),
    });

    await parse(deps, ['start']);
    await parse(deps, ['start', '--yes']);

    expect(deps.confirmStart).toHaveBeenCalledOnce();
    expect(deps.confirmStart).toHaveBeenCalledWith(expect.stringMatching(
      /minimum 6 provider requests.*long sessions\/chunking\/facet extraction and bounded retries can increase it.*in-flight crash adds uncertainty/i,
    ));
    expect(deps.createCampaign).toHaveBeenCalledTimes(2);
    expect(deps.createCampaign).toHaveReturnedWith(active);
  });

  it('guards unattended start with the previewed expected member count', async () => {
    const { deps } = makeDependencies();

    await expect(parse(deps, ['start', '--yes', '--expected-count', '4']))
      .rejects.toThrow(/expected 4.*found 3/i);

    expect(deps.createCampaign).not.toHaveBeenCalled();
  });

  it.each([
    ['start', ['start', '--yes', '--model', 'glm-4.7']],
    ['dry run', ['--dry-run', '--model', 'glm-4.7']],
  ] as const)('rejects a %s model override that differs from the configured runner', async (_name, args) => {
    const { deps } = makeDependencies();

    await expect(parse(deps, [...args])).rejects.toThrow(/configured model.*glm-5\.2/i);

    expect(deps.createCampaign).not.toHaveBeenCalled();
    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.openReadOnlyDb).not.toHaveBeenCalled();
  });

  it('runs a bounded three-item batch through snapshot-before-publish success transactions', async () => {
    const { deps, output } = makeDependencies();

    await parse(deps, ['run', '--batch-size', '3', '--json']);

    expect(deps.prepareSessionPass).toHaveBeenCalledTimes(3);
    expect(deps.preparePromptQualityPass).toHaveBeenCalledTimes(3);
    expect(deps.publishTwoPass).toHaveBeenCalledTimes(3);
    expect(deps.publishSuccess).toHaveBeenCalledTimes(3);
    for (const successCall of vi.mocked(deps.publishSuccess).mock.calls) {
      expect(typeof successCall[1].publish).toBe('function');
    }
    const runDb = vi.mocked(deps.getDb).mock.results[0]?.value;
    expect(vi.mocked(deps.publishTwoPass).mock.calls.every(call => call[4] === runDb)).toBe(true);
    expect(vi.mocked(deps.acquireLock).mock.results[0]?.value?.release).toHaveBeenCalledOnce();
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({
      active: true,
      processed: 3,
      stopReason: 'batch_limit',
    });
  });

  it('reports a campaign completed by this batch as no longer active', async () => {
    let completed = false;
    const running = campaign({ totalItems: 1 });
    const done = campaign({ totalItems: 1, status: 'completed' });
    const only = item(0);
    const { deps, output } = makeDependencies({
      getActive: vi.fn(() => running as never),
      claimNextItem: vi.fn()
        .mockReturnValueOnce(only)
        .mockReturnValueOnce(item(0, {
          status: 'session_staged',
          sessionStage: { kind: 'session' },
        })) as never,
      inspectCampaign: vi.fn(() => completed
        ? {
            campaign: done,
            counts: { pending: 0, session_staged: 0, failed: 0, succeeded: 1 },
            items: [{ ...only, status: 'succeeded' }],
          }
        : {
            campaign: running,
            counts: { pending: 1, session_staged: 0, failed: 0, succeeded: 0 },
            items: [only],
          }) as never,
      publishSuccess: vi.fn((db, input) => {
        input.publish(db);
        completed = true;
        return { campaign: done, item: { ...only, status: 'succeeded' } };
      }) as never,
    });

    await parse(deps, ['run', '--batch-size', '1', '--json']);

    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({
      active: false,
      status: 'completed',
      stopReason: 'completed',
    });
  });

  it('reports a concurrent cancellation explicitly before the first paid pass', async () => {
    let cancelled = false;
    const running = campaign({ totalItems: 1 });
    const stopped = campaign({ totalItems: 1, status: 'cancelled' });
    const only = item(0);
    const { deps, output } = makeDependencies({
      getActive: vi.fn(() => running as never),
      claimNextItem: vi.fn().mockReturnValueOnce(only) as never,
      freezeInput: vi.fn(() => {
        cancelled = true;
        return {
          session: { id: only.sessionId, message_count: only.messageCount },
          messages: [],
          inputRevision: only.inputRevision,
        };
      }) as never,
      inspectCampaign: vi.fn(() => ({
        campaign: cancelled ? stopped : running,
        counts: { pending: 1, session_staged: 0, failed: 0, succeeded: 0 },
        items: [only],
      })) as never,
    });

    await parse(deps, ['run', '--json']);

    expect(deps.releaseClaim).toHaveBeenCalledOnce();
    expect(deps.prepareSessionPass).not.toHaveBeenCalled();
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({
      active: false,
      status: 'cancelled',
      stopReason: 'cancelled',
    });
  });

  it('does not publish or mark failure when cancellation wins during pass two', async () => {
    let cancelled = false;
    const running = campaign({ totalItems: 1 });
    const stopped = campaign({ totalItems: 1, status: 'cancelled' });
    const only = item(0);
    const { deps, output } = makeDependencies({
      getActive: vi.fn(() => running as never),
      claimNextItem: vi.fn()
        .mockReturnValueOnce(only)
        .mockReturnValueOnce(item(0, {
          status: 'session_staged',
          sessionStage: { kind: 'session' },
        })) as never,
      inspectCampaign: vi.fn(() => ({
        campaign: cancelled ? stopped : running,
        counts: { pending: 0, session_staged: 1, failed: 0, succeeded: 0 },
        items: [only],
      })) as never,
      preparePromptQualityPass: vi.fn(async () => {
        cancelled = true;
        return {
          schemaVersion: 1,
          kind: 'prompt_quality',
          sessionId: only.sessionId,
          inputRevision: only.inputRevision,
          sessionMessageCount: only.messageCount,
          provider: 'anthropic',
          model: 'glm-5.2',
          usage: {},
          response: { efficiency_score: 80 },
        };
      }) as never,
    });

    await parse(deps, ['run', '--json']);

    expect(deps.publishSuccess).not.toHaveBeenCalled();
    expect(deps.markItemFailed).not.toHaveBeenCalled();
    expect(deps.releaseClaim).toHaveBeenCalledOnce();
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({
      active: false,
      status: 'cancelled',
      stopReason: 'cancelled',
    });
  });

  it('stops directly when cancellation wins between error inspection and failure recording', async () => {
    let providerFailed = false;
    let cancellationWon = false;
    const running = campaign({ totalItems: 1 });
    const stopped = campaign({ totalItems: 1, status: 'cancelled' });
    const only = item(0);
    const inspectCampaign = vi.fn(() => {
      if (providerFailed && !cancellationWon) {
        // Return the pre-cancel snapshot, then simulate cancellation before
        // markItemFailed starts its own transaction.
        cancellationWon = true;
        return {
          campaign: running,
          counts: { pending: 1, session_staged: 0, failed: 0, succeeded: 0 },
          items: [only],
        };
      }
      return {
        campaign: cancellationWon ? stopped : running,
        counts: { pending: 1, session_staged: 0, failed: 0, succeeded: 0 },
        items: [only],
      };
    });
    const markItemFailed = vi.fn(() => ({
      outcome: 'campaign_terminal',
      campaignStatus: 'cancelled',
      item: { ...only, claimedAt: null },
    }));
    const { deps, output } = makeDependencies({
      getActive: vi.fn(() => running as never),
      claimNextItem: vi.fn().mockReturnValueOnce(only) as never,
      inspectCampaign: inspectCampaign as never,
      prepareSessionPass: vi.fn(async () => {
        providerFailed = true;
        throw new Error('provider failed');
      }) as never,
      markItemFailed: markItemFailed as never,
    });

    await parse(deps, ['run', '--json']);

    expect(markItemFailed).toHaveBeenCalledOnce();
    expect(inspectCampaign).toHaveBeenCalledTimes(5);
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({
      active: false,
      status: 'cancelled',
      stopReason: 'cancelled',
    });
  });

  it('lets terminal cancellation override an earlier stop reason at final emission', async () => {
    const running = campaign({ totalItems: 1 });
    const stopped = campaign({ totalItems: 1, status: 'cancelled' });
    const only = item(0);
    let inspectionCount = 0;
    const { deps, output } = makeDependencies({
      getActive: vi.fn(() => running as never),
      claimNextItem: vi.fn().mockReturnValueOnce(only) as never,
      inspectCampaign: vi.fn(() => {
        inspectionCount++;
        return {
          campaign: inspectionCount >= 5 ? stopped : running,
          counts: { pending: 0, session_staged: 0, failed: 1, succeeded: 0 },
          items: [{ ...only, status: 'failed' }],
        };
      }) as never,
      prepareSessionPass: vi.fn(async () => {
        throw new Error('HTTP 429 too many requests');
      }) as never,
    });

    await parse(deps, ['run', '--json']);

    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({
      active: false,
      status: 'cancelled',
      stopReason: 'cancelled',
    });
  });

  it('resumes a staged item by running only prompt quality', async () => {
    const staged = item(0, {
      status: 'session_staged',
      sessionStage: {
        schemaVersion: 1,
        kind: 'session',
        sessionId: 'session-1',
        inputRevision: 'revision-1',
        sessionMessageCount: 10,
        provider: 'anthropic',
        model: 'glm-5.2',
        usage: {},
        response: {},
      },
    });
    const claimNextItem = vi.fn()
      .mockReturnValueOnce(staged)
      .mockReturnValueOnce(null);
    const { deps } = makeDependencies({ claimNextItem: claimNextItem as never });

    await parse(deps, ['run', '--batch-size', '1', '--quiet']);

    expect(deps.prepareSessionPass).not.toHaveBeenCalled();
    expect(deps.preparePromptQualityPass).toHaveBeenCalledOnce();
    expect(deps.stageSessionPass).not.toHaveBeenCalled();
    expect(deps.publishTwoPass).toHaveBeenCalledOnce();
  });

  it('passes --retry-failed through every durable claim', async () => {
    const { deps } = makeDependencies();

    await parse(deps, ['run', '--batch-size', '1', '--retry-failed', '--quiet']);

    expect(deps.claimNextItem).toHaveBeenCalled();
    expect(vi.mocked(deps.claimNextItem).mock.calls.every(
      call => call[2]?.retryFailed === true,
    )).toBe(true);
  });

  it.each([
    ['global pause', { isMaintenancePaused: vi.fn(() => true) }, 'global_paused'],
    ['campaign pause', { inspectCampaign: vi.fn(() => ({
      campaign: campaign({ status: 'paused' }),
      counts: { pending: 3, session_staged: 0, failed: 0, succeeded: 0 },
      items: [],
    })) }, 'campaign_paused'],
    ['deadline', { now: vi.fn(() => 2_000_000) }, 'deadline'],
  ] as const)('does not claim work after %s', async (_name, overrides, stopReason) => {
    const { deps, output } = makeDependencies(overrides as Partial<ReanalyzeDependencies>);

    await parse(deps, ['run', '--deadline-epoch', '1500', '--json']);

    expect(deps.claimNextItem).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({ processed: 0, stopReason });
  });

  it('releases a pending claim when pause begins immediately before pass one', async () => {
    let paused = false;
    const only = item(0);
    const { deps, output } = makeDependencies({
      isMaintenancePaused: vi.fn(() => paused),
      claimNextItem: vi.fn().mockReturnValueOnce(only) as never,
      freezeInput: vi.fn(() => {
        paused = true;
        return {
          session: { id: only.sessionId, message_count: only.messageCount },
          messages: [],
          inputRevision: only.inputRevision,
        };
      }) as never,
    });

    await parse(deps, ['run', '--json']);

    expect(deps.releaseClaim).toHaveBeenCalledWith(expect.anything(), {
      campaignId: only.campaignId,
      sessionId: only.sessionId,
      inputRevision: only.inputRevision,
    });
    expect(deps.prepareSessionPass).not.toHaveBeenCalled();
    expect(deps.preparePromptQualityPass).not.toHaveBeenCalled();
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({ stopReason: 'global_paused' });
  });

  it('releases a staged claim when pause begins immediately before prompt quality', async () => {
    let paused = false;
    const staged = item(0, {
      status: 'session_staged',
      sessionStage: {
        schemaVersion: 1,
        kind: 'session',
        sessionId: 'session-1',
        inputRevision: 'revision-1',
        sessionMessageCount: 10,
        provider: 'anthropic',
        model: 'glm-5.2',
        usage: {},
        response: {},
      },
    });
    const { deps, output } = makeDependencies({
      isMaintenancePaused: vi.fn(() => paused),
      claimNextItem: vi.fn().mockReturnValueOnce(staged) as never,
      freezeInput: vi.fn(() => {
        paused = true;
        return {
          session: { id: staged.sessionId, message_count: staged.messageCount },
          messages: [],
          inputRevision: staged.inputRevision,
        };
      }) as never,
    });

    await parse(deps, ['run', '--json']);

    expect(deps.releaseClaim).toHaveBeenCalledOnce();
    expect(deps.preparePromptQualityPass).not.toHaveBeenCalled();
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({ stopReason: 'global_paused' });
  });

  it.each([
    ['pause', 'global_paused'],
    ['deadline', 'deadline'],
  ] as const)('keeps pass one staged when %s begins before pass two', async (kind, reason) => {
    let paused = false;
    let now = 1_000_000;
    const only = item(0);
    const { deps, output } = makeDependencies({
      isMaintenancePaused: vi.fn(() => paused),
      now: vi.fn(() => now),
      claimNextItem: vi.fn().mockReturnValueOnce(only) as never,
      stageSessionPass: vi.fn((_db, input) => {
        if (kind === 'pause') paused = true;
        else now = 2_000_000;
        return item(0, {
          campaignId: input.campaignId,
          sessionId: input.sessionId,
          inputRevision: input.inputRevision,
          status: 'session_staged',
          sessionStage: input.sessionStage,
        });
      }) as never,
    });

    await parse(deps, ['run', '--deadline-epoch', '1500', '--json']);

    expect(deps.prepareSessionPass).toHaveBeenCalledOnce();
    expect(deps.stageSessionPass).toHaveBeenCalledOnce();
    expect(deps.preparePromptQualityPass).not.toHaveBeenCalled();
    expect(deps.publishSuccess).not.toHaveBeenCalled();
    expect(deps.releaseClaim).not.toHaveBeenCalled();
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({
      processed: 0,
      stopReason: reason,
    });
  });

  it('refuses a changed provider target before claiming or calling the model', async () => {
    const { deps } = makeDependencies({
      loadConfig: vi.fn(() => ({
        ...config,
        dashboard: { llm: { ...config.dashboard!.llm!, model: 'glm-4.7' } },
      })),
    });

    await expect(parse(deps, ['run'])).rejects.toThrow(/configuration.*campaign/i);

    expect(deps.claimNextItem).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
    expect(deps.acquireLock).not.toHaveBeenCalled();
  });

  it('refuses a campaign created by a different analysis pipeline before any paid call', async () => {
    const { deps } = makeDependencies({
      getActive: vi.fn(() => campaign({ pipelineRevision: 'two-pass-v0' }) as never),
    });

    await expect(parse(deps, ['run'])).rejects.toThrow(/configuration.*campaign/i);

    expect(deps.claimNextItem).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
    expect(deps.acquireLock).not.toHaveBeenCalled();
  });

  it('fails a changed input revision before any paid pass', async () => {
    const only = item(0);
    const { deps } = makeDependencies({
      claimNextItem: vi.fn().mockReturnValueOnce(only).mockReturnValueOnce(null) as never,
      freezeInput: vi.fn(() => ({
        session: { id: only.sessionId, message_count: only.messageCount },
        messages: [],
        inputRevision: 'a-new-revision',
      })) as never,
    });

    await parse(deps, ['run', '--batch-size', '1', '--quiet']);

    expect(deps.markItemFailed).toHaveBeenCalledWith(expect.anything(), {
      campaignId: only.campaignId,
      sessionId: only.sessionId,
      inputRevision: only.inputRevision,
      error: {
        code: 'INPUT_CHANGED',
        message: expect.stringMatching(/changed/i),
      },
    });
    expect(deps.prepareSessionPass).not.toHaveBeenCalled();
    expect(deps.preparePromptQualityPass).not.toHaveBeenCalled();
  });

  it('stages pass one immediately and leaves published results untouched when pass two fails', async () => {
    const only = item(0);
    const { deps } = makeDependencies({
      preparePromptQualityPass: vi.fn(async () => {
        throw new Error('request failed at https://example.invalid/private?api_key=secret-api-key');
      }) as never,
    });

    await parse(deps, ['run', '--batch-size', '1', '--quiet']);

    expect(deps.stageSessionPass).toHaveBeenCalledOnce();
    expect(deps.publishTwoPass).not.toHaveBeenCalled();
    expect(deps.markItemFailed).toHaveBeenCalledWith(expect.anything(), {
      campaignId: only.campaignId,
      sessionId: only.sessionId,
      inputRevision: only.inputRevision,
      error: {
        code: 'ANALYSIS_FAILED',
        message: 'Analysis failed; previous results were kept.',
      },
    });
    expect(JSON.stringify(vi.mocked(deps.markItemFailed).mock.calls)).not.toContain('secret-api-key');
    expect(JSON.stringify(vi.mocked(deps.markItemFailed).mock.calls)).not.toContain('example.invalid');
  });

  it.each([
    ['HTTP 429 too many requests', 'RATE_LIMIT', 'rate_limited'],
    ['HTTP 401 invalid API key', 'AUTHENTICATION', 'authentication'],
    ['Provider requires an API key', 'AUTHENTICATION', 'authentication'],
  ] as const)('stops the batch after a provider safety error: %s', async (message, code, reason) => {
    const { deps, output } = makeDependencies({
      prepareSessionPass: vi.fn(async () => { throw new Error(message); }) as never,
    });

    await parse(deps, ['run', '--batch-size', '3', '--json']);

    expect(deps.claimNextItem).toHaveBeenCalledOnce();
    expect(deps.markItemFailed).toHaveBeenCalledWith(expect.anything(), {
      campaignId: 'campaign-1',
      sessionId: 'session-1',
      inputRevision: 'revision-1',
      error: {
        code,
        message: expect.not.stringContaining(message),
      },
    });
    expect(lastJson<ReanalyzeRunResult>(output)).toMatchObject({ stopReason: reason });
  });

  it('returns stable one-line JSON and exit zero when there is no active campaign', async () => {
    const { deps, output } = makeDependencies({ getActive: vi.fn(() => null) });

    await parse(deps, ['run', '--json']);

    expect(output).toHaveLength(1);
    expect(output[0].endsWith('\n')).toBe(true);
    expect(lastJson<ReanalyzeRunResult>(output)).toEqual({
      active: false,
      status: 'idle',
      processed: 0,
      remaining: 0,
      failed: 0,
      stopReason: 'no_active_campaign',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('suppresses all run output with --quiet', async () => {
    const { deps, output } = makeDependencies({ getActive: vi.fn(() => null) });

    await parse(deps, ['run', '--quiet']);

    expect(output).toEqual([]);
  });

  it('shows status as JSON and controls the unique active campaign', async () => {
    const { deps, output } = makeDependencies();

    await parse(deps, ['status', '--json']);
    const status = lastJson<{ active: boolean; status: string; total: number }>(output);
    await parse(deps, ['pause']);
    await parse(deps, ['resume']);

    expect(status).toMatchObject({
      active: true,
      status: 'active',
      total: 3,
    });
    expect(deps.pauseCampaign).toHaveBeenCalledWith(expect.anything(), 'campaign-1');
    expect(deps.resumeCampaign).toHaveBeenCalledWith(expect.anything(), 'campaign-1');
  });

  it.each(['retry-failed', 'cancel'])('%s requires explicit --yes before opening the database', async action => {
    const { deps } = makeDependencies();

    await expect(parse(deps, [action])).rejects.toThrow(/--yes/);

    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.retryFailedItems).not.toHaveBeenCalled();
    expect(deps.cancelCampaign).not.toHaveBeenCalled();
  });

  it('resets failed items only after confirmation', async () => {
    const failed = item(0, { status: 'failed' });
    const { deps, output } = makeDependencies({
      inspectCampaign: vi.fn(() => ({
        campaign: campaign(),
        counts: { pending: 0, session_staged: 0, failed: 1, succeeded: 2 },
        items: [failed],
      })) as never,
    });

    await parse(deps, ['retry-failed', '--yes']);

    expect(deps.retryFailedItems).toHaveBeenCalledWith(expect.anything(), 'campaign-1');
    expect(output.join('')).toMatch(/1 failed item.*reset/i);
  });

  it('does not mutate when retry-failed finds no failed items', async () => {
    const { deps, output } = makeDependencies();

    await parse(deps, ['retry-failed', '--yes']);

    expect(deps.retryFailedItems).not.toHaveBeenCalled();
    expect(output.join('')).toMatch(/no failed items/i);
  });

  it.each(['retry-failed', 'cancel'])('%s does not mutate when no campaign is active', async action => {
    const { deps, output } = makeDependencies({ getActive: vi.fn(() => null) });

    await parse(deps, [action, '--yes']);

    expect(deps.retryFailedItems).not.toHaveBeenCalled();
    expect(deps.cancelCampaign).not.toHaveBeenCalled();
    expect(output.join('')).toMatch(/no active reanalysis campaign/i);
  });

  it('cancels the current campaign only after confirmation', async () => {
    const { deps, output } = makeDependencies();

    await parse(deps, ['cancel', '--yes']);

    expect(deps.cancelCampaign).toHaveBeenCalledWith(expect.anything(), 'campaign-1');
    expect(output.join('')).toMatch(/cancelled/i);
  });
});
