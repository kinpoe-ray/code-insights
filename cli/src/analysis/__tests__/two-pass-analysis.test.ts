import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import type { AnalysisResponse, PromptQualityResponse } from '../prompt-types.js';

let mockDb: Database.Database;

vi.mock('../../db/client.js', () => ({
  getDb: () => mockDb,
}));

function seedSession(db: Database.Database = mockDb): void {
  db.exec(`
    INSERT INTO projects (id, name, path, last_activity)
      VALUES ('p1', 'test-project', '/test', datetime('now'));
    INSERT INTO sessions (
      id, project_id, project_name, project_path, summary, started_at,
      ended_at, message_count, generated_title
    ) VALUES (
      'sess1', 'p1', 'test-project', '/test', 'Original session',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', 1,
      'Previous title'
    );
    INSERT INTO messages (
      id, session_id, type, content, thinking, tool_calls, tool_results,
      usage, timestamp, parent_id
    ) VALUES (
      'm1', 'sess1', 'user', 'Original prompt', NULL, '[]', '[]', NULL,
      '2026-01-01T00:01:00.000Z', NULL
    );
    INSERT INTO insights (
      id, session_id, project_id, project_name, type, title, content,
      summary, bullets, confidence, source, metadata, timestamp,
      created_at, scope, analysis_version
    ) VALUES
      ('old-summary', 'sess1', 'p1', 'test-project', 'summary', 'Previous summary',
       'Old summary', 'Old summary', '[]', 0.9, 'llm', NULL,
       '2026-01-01T00:05:00.000Z', '2026-01-01T00:06:00.000Z', 'session', '3.0.0'),
      ('old-pq', 'sess1', 'p1', 'test-project', 'prompt_quality', 'Previous PQ',
       'Old PQ', 'Old PQ', '[]', 0.85, 'llm', NULL,
       '2026-01-01T00:05:00.000Z', '2026-01-01T00:06:00.000Z', 'session', '3.0.0');
    INSERT INTO session_facets (
      session_id, outcome_satisfaction, workflow_pattern,
      had_course_correction, course_correction_reason, iteration_count,
      friction_points, effective_patterns, analysis_version
    ) VALUES ('sess1', 'low', 'old-pattern', 1, 'old', 4, '[]', '[]', '2.0.0');
    INSERT INTO analysis_usage (
      session_id, analysis_type, provider, model, input_tokens, output_tokens,
      estimated_cost_usd, session_message_count, analyzed_at
    ) VALUES
      ('sess1', 'session', 'old-provider', 'old-model', 1, 2, 0.1, 1, '2000-01-01 00:00:00'),
      ('sess1', 'prompt_quality', 'old-provider', 'old-model', 3, 4, 0.2, 1, '2000-01-01 00:00:00');
  `);
}

const sessionResponse: AnalysisResponse = {
  summary: {
    title: 'Fresh title',
    content: 'Fresh summary',
    bullets: ['Fresh bullet'],
    outcome: 'success',
  },
  decisions: [],
  learnings: [],
  facets: {
    outcome_satisfaction: 'high',
    workflow_pattern: 'direct-execution',
    had_course_correction: false,
    course_correction_reason: null,
    iteration_count: 1,
    friction_points: [],
    effective_patterns: [],
  },
};

const pqResponse: PromptQualityResponse = {
  efficiency_score: 91,
  assessment: 'Fresh PQ',
  message_overhead: 0,
  takeaways: [],
  findings: [],
  dimension_scores: {
    context_provision: 90,
    request_specificity: 91,
    scope_management: 92,
    information_timing: 90,
    correction_quality: 92,
  },
};

/** Keep credential-shaped fixtures out of static secret-scanner signatures. */
function runtimeFixture(...parts: string[]): string {
  return parts.join('');
}

beforeEach(() => {
  mockDb = new Database(':memory:');
  runMigrations(mockDb);
  seedSession();
});

afterEach(() => {
  mockDb.close();
});

function databaseSnapshot(db: Database.Database = mockDb): unknown {
  return {
    session: db.prepare(`SELECT generated_title FROM sessions WHERE id = 'sess1'`).get(),
    insights: db.prepare(`SELECT id, type, title FROM insights WHERE session_id = 'sess1' ORDER BY id`).all(),
    facets: db.prepare(`SELECT * FROM session_facets WHERE session_id = 'sess1'`).get(),
    usage: db.prepare(`SELECT * FROM analysis_usage WHERE session_id = 'sess1' ORDER BY analysis_type`).all(),
  };
}

describe('two-pass preparation and publication', () => {
  it('redacts historical session credentials at the shared prompt-to-runner seam', async () => {
    const {
      calculateSessionInputRevision,
      loadFrozenSessionInput,
      preparePromptQualityPass,
      prepareSessionPass,
    } = await import('../two-pass-analysis.js');
    const secrets = [
      runtimeFixture('sk', '-abcdefghijklmnopqrstuvwxyz012345'),
      'bearer-fixture-value-123456',
      'fixture-api-key-value-123456',
      'fixture-authorization-value-123456',
      'fixture-access-token-value-123456',
      'fixture-refresh-token-value-123456',
    ];
    const transcript = [
      `provider_token=${secrets[0]}`,
      `Authorization: Bearer ${secrets[1]}`,
      `api_key=${secrets[2]}`,
      `authorization=${secrets[3]}`,
      `access_token=${secrets[4]}`,
      `refresh_token=${secrets[5]}`,
    ].join('\n');
    mockDb.prepare(`UPDATE messages SET content = ? WHERE id = 'm1'`).run(transcript);

    const frozen = loadFrozenSessionInput('sess1');
    const originalRevision = frozen.inputRevision;
    const runner = {
      name: 'native-test',
      runAnalysis: vi.fn()
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(sessionResponse), durationMs: 10,
          inputTokens: 11, outputTokens: 12, provider: 'native', model: 'model-a',
        })
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(pqResponse), durationMs: 13,
          inputTokens: 14, outputTokens: 15, provider: 'native', model: 'model-a',
        }),
    };

    const sessionStage = await prepareSessionPass(frozen, runner);
    await preparePromptQualityPass(frozen, runner, sessionStage);

    expect(runner.runAnalysis).toHaveBeenCalledTimes(2);
    for (const [request] of runner.runAnalysis.mock.calls) {
      for (const secret of secrets) {
        expect(request.userPrompt).not.toContain(secret);
      }
      expect(request.userPrompt).toContain('[REDACTED:');
    }
    expect(frozen.messages[0].content).toBe(transcript);
    expect(mockDb.prepare(`SELECT content FROM messages WHERE id = 'm1'`).get())
      .toEqual({ content: transcript });
    expect(calculateSessionInputRevision(frozen.session, frozen.messages)).toBe(originalRevision);
  });

  it('does not stage or publish credential-shaped model output', async () => {
    const {
      loadFrozenSessionInput,
      preparePromptQualityPass,
      prepareSessionPass,
      publishPreparedTwoPass,
    } = await import('../two-pass-analysis.js');
    const secret = runtimeFixture('sk', '-model-output-abcdefghijklmnopqrstuvwxyz');
    const credentialResponse: AnalysisResponse = {
      ...sessionResponse,
      summary: {
        ...sessionResponse.summary,
        title: `Credential ${secret}`,
        content: `Authorization: Bearer ${secret}`,
        bullets: [`api_key=${secret}`],
      },
      facets: {
        ...sessionResponse.facets!,
        friction_points: [{
          category: 'stale-assumptions',
          description: `refresh_token=${secret}`,
          severity: 'medium',
          resolution: 'resolved',
        }],
      },
    };
    const credentialPqResponse: PromptQualityResponse = {
      ...pqResponse,
      assessment: `access_token=${secret}`,
    };
    const frozen = loadFrozenSessionInput('sess1');
    const runner = {
      name: 'native-test',
      runAnalysis: vi.fn()
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(credentialResponse), durationMs: 10,
          inputTokens: 11, outputTokens: 12, provider: 'native', model: 'model-a',
        })
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(credentialPqResponse), durationMs: 13,
          inputTokens: 14, outputTokens: 15, provider: 'native', model: 'model-a',
        }),
    };

    const sessionStage = await prepareSessionPass(frozen, runner);
    const promptQualityStage = await preparePromptQualityPass(frozen, runner, sessionStage);
    publishPreparedTwoPass(frozen, sessionStage, promptQualityStage);

    const durableData = {
      stages: [sessionStage, promptQualityStage],
      insights: mockDb.prepare(`SELECT * FROM insights WHERE session_id = 'sess1'`).all(),
      facets: mockDb.prepare(`SELECT * FROM session_facets WHERE session_id = 'sess1'`).all(),
      title: mockDb.prepare(`SELECT generated_title FROM sessions WHERE id = 'sess1'`).get(),
    };
    expect(JSON.stringify(durableData)).not.toContain(secret);
    expect(JSON.stringify(durableData)).toContain('[REDACTED:');
  });

  it('binds the pipeline revision to the visible analysis artifact version', async () => {
    const {
      TWO_PASS_PIPELINE_REVISION,
      pipelineRevisionForAnalysisLanguage,
    } = await import('../two-pass-analysis.js');
    const { ANALYSIS_VERSION } = await import('../analysis-db.js');
    expect(TWO_PASS_PIPELINE_REVISION).toBe(`analysis-${ANALYSIS_VERSION}/two-pass-v4`);
    expect(pipelineRevisionForAnalysisLanguage('auto')).toBe(TWO_PASS_PIPELINE_REVISION);
    expect(pipelineRevisionForAnalysisLanguage('zh-CN'))
      .toBe(`${TWO_PASS_PIPELINE_REVISION}/lang-zh-CN`);
    expect(pipelineRevisionForAnalysisLanguage('en-US'))
      .toBe(`${TWO_PASS_PIPELINE_REVISION}/lang-en-US`);
  });

  it('produces JSON-round-trippable pass stages without retaining a runner or transcript', async () => {
    const {
      loadFrozenSessionInput,
      prepareSessionPass,
      preparePromptQualityPass,
    } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const runner = {
      name: 'native-test',
      runAnalysis: vi.fn()
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(sessionResponse), durationMs: 10,
          inputTokens: 11, outputTokens: 12, provider: 'native', model: 'model-a',
        })
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(pqResponse), durationMs: 13,
          inputTokens: 14, outputTokens: 15, provider: 'native', model: 'model-a',
        }),
    };

    const sessionStage = await prepareSessionPass(frozen, runner, 'zh-CN');
    // Simulate a later process: reload input and deserialize the durable stage.
    const reloadedInput = loadFrozenSessionInput('sess1');
    const reloadedSessionStage = JSON.parse(JSON.stringify(sessionStage));
    const pqStage = await preparePromptQualityPass(
      reloadedInput,
      runner,
      reloadedSessionStage,
      'zh-CN',
    );

    expect(JSON.parse(JSON.stringify(sessionStage))).toEqual(sessionStage);
    expect(JSON.parse(JSON.stringify(pqStage))).toEqual(pqStage);
    expect(sessionStage).toMatchObject({
      kind: 'session', sessionId: 'sess1', sessionMessageCount: 1,
      provider: 'native', model: 'model-a', response: sessionResponse,
      analysisLanguage: 'zh-CN',
      pipelineRevision: 'analysis-3.0.0/two-pass-v4/lang-zh-CN',
    });
    expect(pqStage).toMatchObject({
      kind: 'prompt_quality', sessionId: 'sess1', sessionMessageCount: 1,
      provider: 'native', model: 'model-a', response: pqResponse,
      analysisLanguage: 'zh-CN',
      pipelineRevision: 'analysis-3.0.0/two-pass-v4/lang-zh-CN',
    });
    expect(sessionStage.inputRevision).toBe(pqStage.inputRevision);
    expect(runner.runAnalysis).toHaveBeenCalledTimes(2);
    for (const [request] of runner.runAnalysis.mock.calls) {
      expect(request.userPrompt).toContain('Simplified Chinese (zh-CN)');
    }
    expect(JSON.stringify(sessionStage)).not.toContain('Original prompt');
    expect(sessionStage).not.toHaveProperty('runner');
  });

  it('does not mix languages between the two prepared passes', async () => {
    const {
      loadFrozenSessionInput,
      prepareSessionPass,
      preparePromptQualityPass,
    } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const runner = {
      name: 'native-test',
      runAnalysis: vi.fn()
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(sessionResponse), durationMs: 10,
          inputTokens: 11, outputTokens: 12, provider: 'native', model: 'model-a',
        })
        .mockResolvedValueOnce({
          rawJson: JSON.stringify(pqResponse), durationMs: 13,
          inputTokens: 14, outputTokens: 15, provider: 'native', model: 'model-a',
        }),
    };
    const sessionStage = await prepareSessionPass(frozen, runner, 'zh-CN');

    await expect(preparePromptQualityPass(
      frozen,
      runner,
      sessionStage,
      'en-US',
    )).rejects.toThrow(/analysis language/i);
    expect(runner.runAnalysis).toHaveBeenCalledOnce();
  });

  it('rejects a pre-language-policy staged session before starting pass two', async () => {
    const {
      loadFrozenSessionInput,
      preparePromptQualityPass,
    } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const runner = {
      name: 'native-test',
      runAnalysis: vi.fn().mockResolvedValue({
        rawJson: JSON.stringify(pqResponse), durationMs: 13,
        inputTokens: 14, outputTokens: 15, provider: 'native', model: 'model-a',
      }),
    };
    const legacyStage = {
      schemaVersion: 1 as const,
      kind: 'session' as const,
      sessionId: 'sess1',
      inputRevision: frozen.inputRevision,
      sessionMessageCount: frozen.session.message_count,
      provider: 'native',
      model: 'model-a',
      usage: {
        inputTokens: 11, outputTokens: 12, cacheCreationTokens: 0,
        cacheReadTokens: 0, estimatedCostUsd: 0, durationMs: 10, chunkCount: 1,
      },
      response: sessionResponse,
    };

    await expect(preparePromptQualityPass(
      frozen,
      runner,
      legacyStage,
      'auto',
    )).rejects.toThrow(/language policy pipeline/i);
    expect(runner.runAnalysis).not.toHaveBeenCalled();
  });

  it('rejects a v1 language-aware staged session before starting pass two', async () => {
    const {
      loadFrozenSessionInput,
      prepareSessionPass,
      preparePromptQualityPass,
    } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const runner = {
      name: 'native-test',
      runAnalysis: vi.fn().mockResolvedValue({
        rawJson: JSON.stringify(sessionResponse), durationMs: 10,
        inputTokens: 11, outputTokens: 12, provider: 'native', model: 'model-a',
      }),
    };
    const currentStage = await prepareSessionPass(frozen, runner, 'zh-CN');
    const legacyStage = {
      ...currentStage,
      pipelineRevision: 'analysis-3.0.0/two-pass-v1/lang-zh-CN',
    };

    await expect(preparePromptQualityPass(
      frozen,
      runner,
      legacyStage,
      'zh-CN',
    )).rejects.toThrow(/current language policy pipeline/i);
    expect(runner.runAnalysis).toHaveBeenCalledOnce();
  });

  it('publishes both pass results together and refreshes usage analyzed_at', async () => {
    const { loadFrozenSessionInput, publishPreparedTwoPass } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: 0.03,
      durationMs: 20,
      chunkCount: 1,
    };
    const sessionStage = {
      schemaVersion: 1 as const,
      kind: 'session' as const,
      sessionId: 'sess1',
      inputRevision: frozen.inputRevision,
      sessionMessageCount: frozen.session.message_count,
      provider: 'new-provider',
      model: 'new-model',
      analysisLanguage: 'zh-CN' as const,
      pipelineRevision: 'analysis-3.0.0/two-pass-v4/lang-zh-CN',
      usage,
      response: sessionResponse,
    };
    const pqStage = {
      ...sessionStage,
      kind: 'prompt_quality' as const,
      response: pqResponse,
    };

    const result = publishPreparedTwoPass(frozen, sessionStage, pqStage);

    expect(result).toEqual({ insightCount: 1, promptQualityScore: 91 });
    expect(mockDb.prepare(`SELECT generated_title FROM sessions WHERE id = 'sess1'`).get())
      .toEqual({ generated_title: 'Fresh title' });
    expect(mockDb.prepare(`SELECT type, title FROM insights WHERE session_id = 'sess1' ORDER BY type`).all())
      .toEqual([
        { type: 'prompt_quality', title: 'Prompt Efficiency: 91/100' },
        { type: 'summary', title: 'Fresh title' },
      ]);
    expect(mockDb.prepare(`SELECT outcome_satisfaction FROM session_facets WHERE session_id = 'sess1'`).get())
      .toEqual({ outcome_satisfaction: 'high' });
    expect(mockDb.prepare(`
      SELECT analysis_type, provider, model, input_revision, pipeline_revision, analyzed_at
      FROM analysis_usage WHERE session_id = 'sess1' ORDER BY analysis_type
    `).all()).toEqual([
      {
        analysis_type: 'prompt_quality', provider: 'new-provider',
        model: 'new-model', input_revision: frozen.inputRevision,
        pipeline_revision: 'analysis-3.0.0/two-pass-v4/lang-zh-CN',
        analyzed_at: expect.not.stringContaining('2000-01-01'),
      },
      {
        analysis_type: 'session', provider: 'new-provider',
        model: 'new-model', input_revision: frozen.inputRevision,
        pipeline_revision: 'analysis-3.0.0/two-pass-v4/lang-zh-CN',
        analyzed_at: expect.not.stringContaining('2000-01-01'),
      },
    ]);
  });

  it('publishes only message references that exist in the frozen conversation', async () => {
    const { loadFrozenSessionInput, publishPreparedTwoPass } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: 0.03,
      durationMs: 20,
      chunkCount: 1,
    };
    const response: AnalysisResponse = {
      ...sessionResponse,
      decisions: [{
        title: 'Keep valid evidence only',
        reasoning: 'The decision is grounded in the stored prompt.',
        confidence: 90,
        evidence: [
          'User#0: valid user turn',
          'User#1: out-of-range user turn',
          'Assistant#0: out-of-range assistant turn',
          'msg-1',
        ],
      }],
    };
    const promptQualityResponse: PromptQualityResponse = {
      ...pqResponse,
      findings: [
        {
          category: 'precise-request',
          type: 'strength',
          description: 'Valid finding',
          message_ref: 'User#0',
          impact: 'medium',
          confidence: 90,
        },
        {
          category: 'precise-request',
          type: 'deficit',
          description: 'Out-of-range finding',
          message_ref: 'User#1',
          impact: 'low',
          confidence: 80,
        },
      ],
      takeaways: [
        {
          type: 'reinforce',
          category: 'precise-request',
          label: 'Valid takeaway',
          message_ref: 'User#0',
        },
        {
          type: 'improve',
          category: 'precise-request',
          label: 'Malformed takeaway',
          message_ref: 'msg-1',
        },
      ],
    };
    const sessionStage = {
      schemaVersion: 1 as const,
      kind: 'session' as const,
      sessionId: 'sess1',
      inputRevision: frozen.inputRevision,
      sessionMessageCount: frozen.session.message_count,
      provider: 'new-provider',
      model: 'new-model',
      analysisLanguage: 'zh-CN' as const,
      pipelineRevision: 'analysis-3.0.0/two-pass-v4/lang-zh-CN',
      usage,
      response,
    };
    const pqStage = {
      ...sessionStage,
      kind: 'prompt_quality' as const,
      response: promptQualityResponse,
    };

    publishPreparedTwoPass(frozen, sessionStage, pqStage);

    const decision = mockDb.prepare(
      `SELECT metadata FROM insights WHERE session_id = 'sess1' AND type = 'decision'`,
    ).get() as { metadata: string };
    const promptQuality = mockDb.prepare(
      `SELECT metadata FROM insights WHERE session_id = 'sess1' AND type = 'prompt_quality'`,
    ).get() as { metadata: string };
    expect(JSON.parse(decision.metadata).evidence).toEqual(['User#0: valid user turn']);
    expect(JSON.parse(promptQuality.metadata)).toMatchObject({
      findings: [{ description: 'Valid finding', message_ref: 'User#0' }],
      takeaways: [{ label: 'Valid takeaway', message_ref: 'User#0' }],
    });
  });

  it('rejects publication when prepared passes use different languages', async () => {
    const { loadFrozenSessionInput, publishPreparedTwoPass } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const usage = {
      inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0,
      cacheReadTokens: 0, estimatedCostUsd: 0.03, durationMs: 20, chunkCount: 1,
    };
    const sessionStage = {
      schemaVersion: 1 as const, kind: 'session' as const, sessionId: 'sess1',
      inputRevision: frozen.inputRevision,
      sessionMessageCount: frozen.session.message_count,
      provider: 'new-provider', model: 'new-model', usage, response: sessionResponse,
      analysisLanguage: 'zh-CN' as const,
      pipelineRevision: 'analysis-3.0.0/two-pass-v4/lang-zh-CN',
    };
    const pqStage = {
      ...sessionStage,
      kind: 'prompt_quality' as const,
      response: pqResponse,
      analysisLanguage: 'en-US' as const,
      pipelineRevision: 'analysis-3.0.0/two-pass-v4/lang-en-US',
    };

    expect(() => publishPreparedTwoPass(frozen, sessionStage, pqStage))
      .toThrow(/analysis language/i);
  });

  it('rejects publication of passes prepared under the legacy v1 language policy', async () => {
    const { loadFrozenSessionInput, publishPreparedTwoPass } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const before = databaseSnapshot();
    const usage = {
      inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0,
      cacheReadTokens: 0, estimatedCostUsd: 0.03, durationMs: 20, chunkCount: 1,
    };
    const sessionStage = {
      schemaVersion: 1 as const, kind: 'session' as const, sessionId: 'sess1',
      inputRevision: frozen.inputRevision,
      sessionMessageCount: frozen.session.message_count,
      provider: 'new-provider', model: 'new-model', usage, response: sessionResponse,
      analysisLanguage: 'zh-CN' as const,
      pipelineRevision: 'analysis-3.0.0/two-pass-v1/lang-zh-CN',
    };
    const pqStage = {
      ...sessionStage,
      kind: 'prompt_quality' as const,
      response: pqResponse,
    };

    expect(() => publishPreparedTwoPass(frozen, sessionStage, pqStage))
      .toThrow(/current language policy pipeline/i);
    expect(databaseSnapshot()).toEqual(before);
  });

  it('rolls the whole publication back when any write fails', async () => {
    const { loadFrozenSessionInput, publishPreparedTwoPass } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const before = databaseSnapshot();
    const usage = {
      inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0,
      cacheReadTokens: 0, estimatedCostUsd: 0.03, durationMs: 20, chunkCount: 1,
    };
    const sessionStage = {
      schemaVersion: 1 as const, kind: 'session' as const, sessionId: 'sess1',
      inputRevision: frozen.inputRevision,
      sessionMessageCount: frozen.session.message_count,
      provider: 'new-provider', model: 'new-model', usage, response: sessionResponse,
      analysisLanguage: 'auto' as const,
      pipelineRevision: 'analysis-3.0.0/two-pass-v4',
    };
    const pqStage = {
      ...sessionStage, kind: 'prompt_quality' as const, response: pqResponse,
    };
    mockDb.exec(`
      CREATE TRIGGER reject_new_pq_usage
      BEFORE UPDATE ON analysis_usage
      WHEN NEW.analysis_type = 'prompt_quality' AND NEW.provider = 'new-provider'
      BEGIN
        SELECT RAISE(ABORT, 'injected publication failure');
      END;
    `);

    expect(() => publishPreparedTwoPass(frozen, sessionStage, pqStage))
      .toThrow('injected publication failure');
    expect(databaseSnapshot()).toEqual(before);
  });

  it('uses the explicitly supplied database for every write in the publication transaction', async () => {
    const explicitDb = new Database(':memory:');
    runMigrations(explicitDb);
    seedSession(explicitDb);
    const decoyBefore = databaseSnapshot(mockDb);
    const explicitBefore = databaseSnapshot(explicitDb);

    try {
      const { loadFrozenSessionInput, publishPreparedTwoPass } = await import('../two-pass-analysis.js');
      const frozen = loadFrozenSessionInput('sess1', explicitDb);
      const usage = {
        inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0,
        cacheReadTokens: 0, estimatedCostUsd: 0.03, durationMs: 20, chunkCount: 1,
      };
      const sessionStage = {
        schemaVersion: 1 as const, kind: 'session' as const, sessionId: 'sess1',
        inputRevision: frozen.inputRevision,
        sessionMessageCount: frozen.session.message_count,
        provider: 'new-provider', model: 'new-model', usage, response: sessionResponse,
        analysisLanguage: 'auto' as const,
        pipelineRevision: 'analysis-3.0.0/two-pass-v4',
      };
      const pqStage = {
        ...sessionStage, kind: 'prompt_quality' as const, response: pqResponse,
      };

      publishPreparedTwoPass(frozen, sessionStage, pqStage, undefined, explicitDb);

      expect(databaseSnapshot(mockDb)).toEqual(decoyBefore);
      expect(databaseSnapshot(explicitDb)).not.toEqual(explicitBefore);
      expect(explicitDb.prepare(`SELECT generated_title FROM sessions WHERE id = 'sess1'`).get())
        .toEqual({ generated_title: 'Fresh title' });
      expect(explicitDb.prepare(`SELECT DISTINCT provider, model FROM analysis_usage`).all())
        .toEqual([{ provider: 'new-provider', model: 'new-model' }]);
    } finally {
      explicitDb.close();
    }
  });

  it('rejects publication if the ordered analysis input changed after preparation', async () => {
    const { loadFrozenSessionInput, publishPreparedTwoPass } = await import('../two-pass-analysis.js');
    const frozen = loadFrozenSessionInput('sess1');
    const before = databaseSnapshot();
    const usage = {
      inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0,
      cacheReadTokens: 0, estimatedCostUsd: 0.03, durationMs: 20, chunkCount: 1,
    };
    const sessionStage = {
      schemaVersion: 1 as const, kind: 'session' as const, sessionId: 'sess1',
      inputRevision: frozen.inputRevision,
      sessionMessageCount: frozen.session.message_count,
      provider: 'new-provider', model: 'new-model', usage, response: sessionResponse,
      analysisLanguage: 'auto' as const,
      pipelineRevision: 'analysis-3.0.0/two-pass-v4',
    };
    const pqStage = {
      ...sessionStage, kind: 'prompt_quality' as const, response: pqResponse,
    };
    mockDb.prepare(`UPDATE messages SET content = 'Changed after preparation' WHERE id = 'm1'`).run();

    expect(() => publishPreparedTwoPass(frozen, sessionStage, pqStage))
      .toThrow(/changed since analysis was prepared/i);
    // Exclude the intentionally changed source message; published artifacts stay untouched.
    expect(databaseSnapshot()).toEqual(before);
  });
});
