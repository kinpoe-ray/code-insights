import { describe, expect, it } from 'vitest';
import { createAnalysisEngine } from '../analysis-engine.js';
import {
  estimateRequestTokens,
  type LLMClient,
  type LLMMessage,
} from '../llm-client.js';
import type { SQLiteMessageRow } from '../prompt-types.js';
import type { SessionData } from '../analysis-db.js';

const session: SessionData = {
  id: 'session-1',
  project_id: 'project-1',
  project_name: 'code-insights',
  project_path: '/tmp/code-insights',
  summary: 'Unify analysis execution',
  ended_at: '2026-07-18T10:00:00.000Z',
};

function message(id: string, content: string): SQLiteMessageRow {
  return {
    id,
    session_id: session.id,
    type: 'user',
    content,
    thinking: null,
    tool_calls: '[]',
    tool_results: '[]',
    usage: null,
    timestamp: '2026-07-18T09:00:00.000Z',
    parent_id: null,
  };
}

const validResponse = JSON.stringify({
  summary: { title: 'Unified engine', content: 'One execution path.', bullets: [] },
  decisions: [],
  learnings: [],
  facets: {
    outcome_satisfaction: 'high',
    workflow_pattern: 'plan-then-implement',
    had_course_correction: false,
    course_correction_reason: null,
    iteration_count: 1,
    friction_points: [],
    effective_patterns: [],
  },
});

function client(overrides: Partial<LLMClient> = {}): LLMClient {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    capabilities: {
      contextWindowTokens: 100_000,
      reservedOutputTokens: 8_192,
      safetyMarginTokens: 11_808,
      supportsContentBlocks: false,
      requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
    },
    estimateTokens: (text) => Math.ceil(text.length / 4),
    prepareMessages: (messages) => messages,
    chat: async (_messages: LLMMessage[]) => ({
      content: validResponse,
      usage: { inputTokens: 1_000, outputTokens: 100 },
    }),
    ...overrides,
  };
}

describe('AnalysisEngine contract', () => {
  it('returns a complete single-chunk result with provider usage and cost', async () => {
    const engine = createAnalysisEngine({ client: client(), now: () => 25 });

    const result = await engine.analyzeSession({
      session,
      messages: [message('message-1', 'Please unify the analysis path.')],
    });

    expect(result).toEqual({
      ok: true,
      completeness: 'complete',
      response: JSON.parse(validResponse),
      stats: {
        chunkCount: 1,
        successfulChunks: 1,
        failedChunks: 0,
        callCount: 1,
        facetCallCount: 0,
      },
      warnings: [],
      usage: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: 1_000,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCostUsd: 0.00021,
        durationMs: 0,
        chunkCount: 1,
        callCount: 1,
      },
    });
  });

  it('budgets the complete request, preserves content blocks, and aggregates chunk plus facet calls', async () => {
    const requests: LLMMessage[][] = [];
    const chunkResponse = (title: string) => JSON.stringify({
      summary: { title, content: `${title} content`, bullets: [] },
      decisions: [{ title, reasoning: 'Observed in this chunk', confidence: 90 }],
      learnings: [],
    });
    const facetResponse = JSON.stringify({
      outcome_satisfaction: 'high',
      workflow_pattern: 'iterative',
      had_course_correction: false,
      course_correction_reason: null,
      iteration_count: 2,
      friction_points: [],
      effective_patterns: [],
    });
    const responses = [chunkResponse('Chunk A'), chunkResponse('Chunk B'), facetResponse];
    let now = 100;
    const engineClient = client({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      capabilities: {
        contextWindowTokens: 30_000,
        reservedOutputTokens: 100,
        safetyMarginTokens: 100,
        supportsContentBlocks: true,
        requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
      },
      estimateTokens: (text) => text.length,
      chat: async (messages) => {
        requests.push(messages);
        return {
          content: responses[requests.length - 1],
          usage: {
            inputTokens: 100 * requests.length,
            outputTokens: 10 * requests.length,
            cacheCreationTokens: requests.length,
            cacheReadTokens: requests.length * 2,
          },
        };
      },
    });
    const engine = createAnalysisEngine({ client: engineClient, now: () => now++ });

    const result = await engine.analyzeSession({
      session,
      messages: [
        message('message-a', 'A'.repeat(6_000)),
        message('message-b', 'B'.repeat(6_000)),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected complete analysis');
    expect(result.stats).toEqual({
      chunkCount: 2,
      successfulChunks: 2,
      failedChunks: 0,
      callCount: 3,
      facetCallCount: 1,
    });
    expect(result.response.decisions.map((decision) => decision.title)).toEqual(['Chunk A', 'Chunk B']);
    expect(result.response.facets?.workflow_pattern).toBe('iterative');
    expect(result.usage).toMatchObject({
      inputTokens: 600,
      outputTokens: 60,
      cacheCreationTokens: 6,
      cacheReadTokens: 12,
      chunkCount: 2,
      callCount: 3,
    });

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const requestTokens = request.reduce(
        (total, item) => total + (
          typeof item.content === 'string'
            ? item.content.length
            : item.content.reduce((sum, block) => sum + block.text.length, 0)
        ),
        0,
      );
      expect(requestTokens).toBeLessThanOrEqual(29_800);
      const user = request.find((item) => item.role === 'user');
      expect(Array.isArray(user?.content)).toBe(true);
      if (Array.isArray(user?.content)) {
        expect(user.content[0].cache_control).toEqual({ type: 'ephemeral' });
      }
    }
  });

  it('fails closed with typed partial_failure when any required chunk cannot be parsed', async () => {
    let callCount = 0;
    const engine = createAnalysisEngine({
      client: client({
        capabilities: {
          contextWindowTokens: 30_000,
          reservedOutputTokens: 100,
          safetyMarginTokens: 100,
          supportsContentBlocks: false,
          requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
        },
        estimateTokens: (text) => text.length,
        chat: async () => {
          callCount++;
          return {
            content: callCount === 1 ? validResponse : 'not-json',
            usage: { inputTokens: callCount * 100, outputTokens: callCount * 10 },
          };
        },
      }),
      now: () => 50,
    });

    const result = await engine.analyzeSession({
      session,
      messages: [
        message('message-a', 'A'.repeat(6_000)),
        message('message-b', 'B'.repeat(6_000)),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a partial failure');
    expect(result.completeness).toBe('partial');
    expect(result.error).toMatchObject({
      kind: 'partial_failure',
      code: 'PARTIAL_RESPONSE',
      message: 'One or more analysis chunks failed.',
      failedChunks: [2],
    });
    expect(result.stats).toEqual({
      chunkCount: 2,
      successfulChunks: 1,
      failedChunks: 1,
      callCount: 2,
      facetCallCount: 0,
    });
    expect(result.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      chunkCount: 2,
      callCount: 2,
    });
    expect(callCount).toBe(2);
  });

  it('checks abort before every chunk and returns without merging or making a facet call', async () => {
    const controller = new AbortController();
    let callCount = 0;
    const engine = createAnalysisEngine({
      client: client({
        capabilities: {
          contextWindowTokens: 30_000,
          reservedOutputTokens: 100,
          safetyMarginTokens: 100,
          supportsContentBlocks: false,
          requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
        },
        estimateTokens: (text) => text.length,
        chat: async () => {
          callCount++;
          controller.abort();
          return {
            content: validResponse,
            usage: { inputTokens: 120, outputTokens: 12 },
          };
        },
      }),
      now: () => 75,
    });

    const result = await engine.analyzeSession({
      session,
      messages: [
        message('message-a', 'A'.repeat(6_000)),
        message('message-b', 'B'.repeat(6_000)),
      ],
    }, { signal: controller.signal });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected abort');
    expect(result.error.kind).toBe('aborted');
    expect(result.error.code).toBe('ANALYSIS_ABORTED');
    expect(result.completeness).toBe('none');
    expect(result.stats).toEqual({
      chunkCount: 2,
      successfulChunks: 0,
      failedChunks: 0,
      callCount: 1,
      facetCallCount: 0,
    });
    expect(result.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 12,
      callCount: 1,
    });
    expect(callCount).toBe(1);
  });

  it('does not merge a final response when cancellation arrives during the provider call', async () => {
    const controller = new AbortController();
    const engine = createAnalysisEngine({
      client: client({
        chat: async () => {
          controller.abort();
          return {
            content: validResponse,
            usage: { inputTokens: 120, outputTokens: 12 },
          };
        },
      }),
      now: () => 80,
    });

    const result = await engine.analyzeSession({
      session,
      messages: [message('message-a', 'Analyze this session.')],
    }, { signal: controller.signal });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected abort');
    expect(result.error.kind).toBe('aborted');
    expect(result.stats).toMatchObject({
      successfulChunks: 0,
      callCount: 1,
      facetCallCount: 0,
    });
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 12 });
  });

  it('rejects an empty session before calling the provider', async () => {
    let callCount = 0;
    const engine = createAnalysisEngine({
      client: client({
        chat: async () => {
          callCount++;
          return { content: validResponse };
        },
      }),
      now: () => 90,
    });

    const result = await engine.analyzeSession({ session, messages: [] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected empty failure');
    expect(result.error.kind).toBe('empty');
    expect(result.error.code).toBe('EMPTY_SESSION');
    expect(result.stats.chunkCount).toBe(0);
    expect(result.usage.callCount).toBe(0);
    expect(callCount).toBe(0);
  });

  it.each([
    { errorName: 'AbortError', kind: 'aborted' as const },
    { errorName: 'Error', kind: 'provider' as const },
  ])('normalizes a thrown $errorName without producing a response', async ({ errorName, kind }) => {
    const secret = 'endpoint-secret-that-must-not-be-exposed';
    const failure = new Error(errorName === 'AbortError' ? 'cancelled' : `rate limited: ${secret}`);
    failure.name = errorName;
    const engine = createAnalysisEngine({
      client: client({
        chat: async () => {
          throw failure;
        },
      }),
      now: () => 100,
    });

    const result = await engine.analyzeSession({
      session,
      messages: [message('message-1', 'Analyze this session.')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected provider failure');
    expect(result.error.kind).toBe(kind);
    expect(result.error.code).toBe(
      kind === 'aborted' ? 'ANALYSIS_ABORTED' : 'PROVIDER_REQUEST_FAILED',
    );
    expect(result.error.message).toBe(
      kind === 'aborted' ? 'Analysis cancelled.' : 'The analysis provider request failed.',
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.stats.callCount).toBe(1);
    expect(result.stats.successfulChunks).toBe(0);
    expect(result.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      callCount: 1,
    });
  });

  it('reports only a safe response length when provider output cannot be parsed', async () => {
    const secret = 'raw-provider-response-secret';
    const result = await createAnalysisEngine({
      client: client({
        chat: async () => ({ content: `not-json ${secret}` }),
      }),
    }).analyzeSession({
      session,
      messages: [message('message-1', 'Analyze this session.')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse failure');
    expect(result.error).toMatchObject({
      kind: 'parse',
      code: 'INVALID_RESPONSE',
      message: 'The analysis provider returned an invalid response.',
      responseLength: `not-json ${secret}`.length,
    });
    expect(result.error).not.toHaveProperty('responsePreview');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('accounts for provider-declared message and content-block envelopes when chunking', async () => {
    const requests: LLMMessage[][] = [];
    const overheadClient = client({
      capabilities: {
        contextWindowTokens: 40_000,
        reservedOutputTokens: 100,
        safetyMarginTokens: 100,
        supportsContentBlocks: false,
        requestOverhead: {
          baseTokens: 10,
          perMessageTokens: 100,
          perContentBlockTokens: 5_000,
        },
      },
      estimateTokens: (text) => text.length,
      chat: async (messages) => {
        requests.push(messages);
        if (requests.length === 3) {
          return {
            content: JSON.stringify({
              outcome_satisfaction: 'high',
              workflow_pattern: 'iterative',
              had_course_correction: false,
              course_correction_reason: null,
              iteration_count: 1,
              friction_points: [],
              effective_patterns: [],
            }),
          };
        }
        return { content: validResponse };
      },
    });

    const oneMessage = [{ role: 'user' as const, content: 'same text' }];
    const splitMessages = [
      { role: 'user' as const, content: 'same ' },
      { role: 'assistant' as const, content: 'text' },
    ];
    const splitBlocks = [{
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'same ' },
        { type: 'text' as const, text: 'text' },
      ],
    }];
    expect(estimateRequestTokens(overheadClient, splitMessages))
      .toBeGreaterThan(estimateRequestTokens(overheadClient, oneMessage));
    expect(estimateRequestTokens(overheadClient, splitBlocks))
      .toBeGreaterThan(estimateRequestTokens(overheadClient, oneMessage));

    const result = await createAnalysisEngine({ client: overheadClient }).analyzeSession({
      session,
      messages: [
        message('message-a', 'A'.repeat(6_000)),
        message('message-b', 'B'.repeat(6_000)),
      ],
    });

    expect(result.stats.chunkCount).toBe(2);
    expect(requests).toHaveLength(3);
  });

  it('prepares the complete outbound prompt before a known secret can cross chunk boundaries', async () => {
    const secret = 'known-secret-that-must-never-cross-a-chunk-boundary';
    const preparedInputs: LLMMessage[][] = [];
    const sentRequests: LLMMessage[][] = [];
    const secureClient = client({
      capabilities: {
        contextWindowTokens: 30_000,
        reservedOutputTokens: 100,
        safetyMarginTokens: 100,
        supportsContentBlocks: false,
        requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
      },
      estimateTokens: (text) => text.length,
      prepareMessages: (messages) => {
        preparedInputs.push(messages);
        return messages.map((outbound) => ({
          ...outbound,
          content: typeof outbound.content === 'string'
            ? outbound.content.replaceAll(secret, '[REDACTED:known-secret]')
            : outbound.content.map((block) => ({
                ...block,
                text: block.text.replaceAll(secret, '[REDACTED:known-secret]'),
              })),
        }));
      },
      chat: async (messages) => {
        sentRequests.push(messages);
        return { content: validResponse };
      },
    });

    const result = await createAnalysisEngine({ client: secureClient }).analyzeSession({
      session,
      messages: [
        message('message-a', `${'A'.repeat(18_000)}${secret}${'B'.repeat(18_000)}`),
      ],
    });

    expect(result.stats.chunkCount).toBeGreaterThan(1);
    expect(preparedInputs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(preparedInputs[0])).toContain(secret);
    expect(JSON.stringify(sentRequests)).not.toContain(secret);
    expect(JSON.stringify(sentRequests)).toContain('[REDACTED:known-secret]');
  });

  it('plans chunks from expanded redaction replacements so every final request stays in budget', async () => {
    const sentRequests: LLMMessage[][] = [];
    const expandingClient = client({
      capabilities: {
        contextWindowTokens: 30_000,
        reservedOutputTokens: 100,
        safetyMarginTokens: 100,
        supportsContentBlocks: false,
        requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
      },
      estimateTokens: (text) => text.length,
      prepareMessages: (messages) => messages.map((outbound) => ({
        ...outbound,
        content: typeof outbound.content === 'string'
          ? outbound.content.replaceAll('EXPAND_ME', '[REDACTED:known-secret]')
          : outbound.content.map((block) => ({
              ...block,
              text: block.text.replaceAll('EXPAND_ME', '[REDACTED:known-secret]'),
            })),
      })),
      chat: async (messages) => {
        sentRequests.push(messages);
        return { content: validResponse };
      },
    });

    const result = await createAnalysisEngine({ client: expandingClient }).analyzeSession({
      session,
      messages: [message('message-a', 'EXPAND_ME'.repeat(1_000))],
    });

    expect(result.stats.chunkCount).toBeGreaterThan(1);
    for (const request of sentRequests) {
      expect(estimateRequestTokens(expandingClient, request)).toBeLessThanOrEqual(29_800);
    }
  });

  it.each([
    { facetFailure: 'provider' as const, warning: /provider/i },
    { facetFailure: 'parse' as const, warning: /could not be parsed/i },
  ])('keeps complete chunk insights when facet fallback has a $facetFailure failure', async ({
    facetFailure,
    warning,
  }) => {
    let callCount = 0;
    const fallbackClient = client({
      capabilities: {
        contextWindowTokens: 30_000,
        reservedOutputTokens: 100,
        safetyMarginTokens: 100,
        supportsContentBlocks: false,
        requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
      },
      estimateTokens: (text) => text.length,
      chat: async () => {
        callCount++;
        if (callCount === 3) {
          if (facetFailure === 'provider') throw new Error('facet provider unavailable');
          return {
            content: 'not-json',
            usage: { inputTokens: 300, outputTokens: 30 },
          };
        }
        return {
          content: JSON.stringify({
            summary: { title: `Chunk ${callCount}`, content: 'Complete chunk.', bullets: [] },
            decisions: [],
            learnings: [],
          }),
          usage: { inputTokens: callCount * 100, outputTokens: callCount * 10 },
        };
      },
    });

    const result = await createAnalysisEngine({ client: fallbackClient }).analyzeSession({
      session,
      messages: [
        message('message-a', 'A'.repeat(6_000)),
        message('message-b', 'B'.repeat(6_000)),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected complete chunk result');
    expect(result.completeness).toBe('complete');
    expect(result.warnings.some((entry) => warning.test(entry))).toBe(true);
    expect(result.stats).toMatchObject({ chunkCount: 2, callCount: 3, facetCallCount: 1 });
    expect(result.usage.inputTokens).toBe(facetFailure === 'parse' ? 600 : 300);
  });

  it.each([
    ['array', '[]'],
    ['empty object', '{}'],
    ['wrong field types', JSON.stringify({
      outcome_satisfaction: 'high',
      workflow_pattern: 'iterative',
      had_course_correction: 'false',
      course_correction_reason: null,
      iteration_count: 2,
      friction_points: [],
      effective_patterns: [],
    })],
  ])('keeps chunk insights but rejects an invalid facet-only %s response', async (
    _label,
    facetContent,
  ) => {
    let callCount = 0;
    const result = await createAnalysisEngine({
      client: client({
        capabilities: {
          contextWindowTokens: 30_000,
          reservedOutputTokens: 100,
          safetyMarginTokens: 100,
          supportsContentBlocks: false,
          requestOverhead: { baseTokens: 0, perMessageTokens: 0, perContentBlockTokens: 0 },
        },
        estimateTokens: (text) => text.length,
        chat: async () => {
          callCount++;
          if (callCount === 3) return { content: facetContent };
          return {
            content: JSON.stringify({
              summary: { title: `Chunk ${callCount}`, content: 'Complete chunk.', bullets: [] },
              decisions: [],
              learnings: [],
            }),
          };
        },
      }),
    }).analyzeSession({
      session,
      messages: [
        message('message-a', 'A'.repeat(6_000)),
        message('message-b', 'B'.repeat(6_000)),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected non-fatal facet validation failure');
    expect(result.response.facets).toBeUndefined();
    expect(result.warnings).toContain('Facet extraction response could not be parsed.');
    expect(result.stats).toMatchObject({ callCount: 3, facetCallCount: 1 });
  });
});
