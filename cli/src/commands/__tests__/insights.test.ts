import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import {
  estimateRequestTokens,
  flattenContent,
  getRequestTokenBudget,
  type LLMMessage,
} from '../../analysis/llm-client.js';
import {
  freezeSessionAnalysisInput,
  TWO_PASS_PIPELINE_REVISION,
} from '../../analysis/two-pass-analysis.js';

// ── Shared mocks ──────────────────────────────────────────────────────────────

let mockDb: Database.Database;

vi.mock('../../db/client.js', () => ({
  getDb: () => mockDb,
}));

vi.mock('../../utils/telemetry.js', () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
  classifyError: vi.fn(() => ({ error_type: 'unknown', error_message: 'unknown' })),
}));

vi.mock('../../utils/config.js', () => ({
  loadSyncState: () => ({ lastSync: '', files: {} }),
  saveSyncState: vi.fn(),
  getConfigDir: () => '/tmp',
  loadConfig: vi.fn(() => null),
}));

const mockInsertSession = vi.fn(() => true);
const mockInsertMessages = vi.fn();
vi.mock('../../db/write.js', () => ({
  insertSessionWithProjectAndReturnIsNew: mockInsertSession,
  insertMessages: mockInsertMessages,
  recalculateUsageStats: vi.fn(() => ({ sessionsWithUsage: 0 })),
}));

const mockValidate = vi.fn();
const mockRunAnalysis = vi.fn();
vi.mock('../../analysis/native-runner.js', () => {
  // Must use a real class (not vi.fn()) so `new ClaudeNativeRunner()` works
  class MockNativeRunner {
    readonly name = 'claude-code-native';
    readonly provider = 'claude-code-native';
    readonly model: string;
    constructor(options?: { model?: string }) {
      this.model = options?.model ?? 'sonnet';
    }
    runAnalysis = mockRunAnalysis;
    static validate = mockValidate;
  }
  return { ClaudeNativeRunner: MockNativeRunner };
});

const mockFromConfig = vi.fn();
const mockProviderRunAnalysis = vi.fn();
const mockProviderChat = vi.fn(async () => {
  const result = await mockProviderRunAnalysis();
  return {
    content: result.rawJson,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      cacheReadTokens: result.cacheReadTokens,
    },
  };
});
vi.mock('../../analysis/provider-runner.js', () => ({
  ProviderRunner: {
    fromConfig: () => {
      mockFromConfig();
      return {
        name: 'openai',
        provider: 'openai',
        model: 'gpt-4o',
        capabilities: {
          contextWindowTokens: 100_000,
          reservedOutputTokens: 8_192,
          safetyMarginTokens: 11_808,
          supportsContentBlocks: false,
          requestOverhead: {
            baseTokens: 3,
            perMessageTokens: 4,
            perContentBlockTokens: 2,
          },
        },
        estimateTokens: (text: string) => Math.ceil(text.length / 4),
        prepareMessages: (messages: unknown[]) => messages,
        chat: mockProviderChat,
        runAnalysis: mockProviderRunAnalysis,
      };
    },
  },
}));

const mockReleaseLlmLock = vi.fn();
const mockAcquireLlmLock = vi.fn((): { release(): void } | null => ({
  release: mockReleaseLlmLock,
}));
vi.mock('../../analysis/llm-lock.js', () => ({
  acquireLlmLock: mockAcquireLlmLock,
}));

const mockProvider = {
  parse: vi.fn(),
  getProviderName: vi.fn(() => 'claude-code'),
};
vi.mock('../../providers/registry.js', () => ({
  getProvider: vi.fn(() => mockProvider),
  getAllProviders: vi.fn(() => [mockProvider]),
}));

beforeEach(() => {
  mockReleaseLlmLock.mockReset();
  mockAcquireLlmLock.mockReset();
  mockAcquireLlmLock.mockReturnValue({ release: mockReleaseLlmLock });
  mockProviderChat.mockClear();
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedSession(db: Database.Database, id = 'sess1', messageCount = 10): void {
  db.exec(`
    INSERT OR IGNORE INTO projects (id, name, path, last_activity)
      VALUES ('p1', 'test-project', '/test', datetime('now'));
    INSERT OR IGNORE INTO sessions
      (id, project_id, project_name, project_path, started_at, ended_at, message_count)
      VALUES ('${id}', 'p1', 'test-project', '/test', datetime('now'), datetime('now'), ${messageCount});
    INSERT OR IGNORE INTO messages
      (id, session_id, type, content, timestamp)
      VALUES ('${id}-message', '${id}', 'user', 'Analyze this session.', datetime('now'));
  `);
}

function markSessionCurrent(
  db: Database.Database,
  id: string,
  provider = 'openai',
  model = 'gpt-4o',
): void {
  const input = freezeSessionAnalysisInput(id, db);
  db.prepare(`
    INSERT OR REPLACE INTO analysis_usage (
      session_id, analysis_type, provider, model, session_message_count,
      input_revision, pipeline_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'session', provider, model, input.session.message_count,
    input.inputRevision, TWO_PASS_PIPELINE_REVISION);
  db.prepare(`
    INSERT OR REPLACE INTO analysis_usage (
      session_id, analysis_type, provider, model, session_message_count,
      input_revision, pipeline_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'prompt_quality', provider, model, input.session.message_count,
    input.inputRevision, TWO_PASS_PIPELINE_REVISION);
}

function makeAnalysisResponse(): string {
  return JSON.stringify({
    summary: { title: 'Test session', content: 'Did things', bullets: [] },
    decisions: [],
    learnings: [],
    facets: {
      outcome_satisfaction: 'high',
      workflow_pattern: 'direct-execution',
      had_course_correction: false,
      course_correction_reason: null,
      iteration_count: 0,
      friction_points: [],
      effective_patterns: [],
    },
  });
}

function makePQResponse(): string {
  return JSON.stringify({
    efficiency_score: 75,
    assessment: 'Good prompting overall.',
    message_overhead: 0,
    takeaways: [],
    findings: [],
    dimension_scores: {
      context_provision: 80,
      request_specificity: 70,
      scope_management: 75,
      information_timing: 80,
      correction_quality: 75,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('V8 migration — session_message_count column', () => {
  it('adds session_message_count column to analysis_usage', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
        VALUES ('p1', 'test', '/test', datetime('now'));
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s1', 'p1', 'test', '/test', datetime('now'), datetime('now'));
    `);
    db.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model, session_message_count)
        VALUES ('s1', 'session', 'claude-code-native', 'claude-native', 10)
    `).run();

    const row = db.prepare(
      'SELECT session_message_count FROM analysis_usage WHERE session_id = ?'
    ).get('s1') as { session_message_count: number };

    expect(row.session_message_count).toBe(10);
    db.close();
  });

  it('double-apply leaves exactly one schema_version row per version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    runMigrations(db);

    const rows = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<{ version: number }>;

    expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    db.close();
  });

  it('session_message_count defaults to NULL when not provided', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
        VALUES ('p2', 'test', '/test', datetime('now'));
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s2', 'p2', 'test', '/test', datetime('now'), datetime('now'));
    `);
    db.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model)
        VALUES ('s2', 'session', 'anthropic', 'claude-sonnet-4-5')
    `).run();

    const row = db.prepare(
      'SELECT session_message_count FROM analysis_usage WHERE session_id = ?'
    ).get('s2') as { session_message_count: number | null };

    expect(row.session_message_count).toBeNull();
    db.close();
  });
});

describe('runInsightsCommand — provider mode (no --native)', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockRunAnalysis.mockReset();
    mockProviderRunAnalysis.mockReset();
    mockFromConfig.mockReset();
    mockValidate.mockReset();
    mockInsertSession.mockReset();
    mockInsertMessages.mockReset();
    mockProvider.parse.mockReset();
  });

  it('calls ProviderRunner.fromConfig() when --native is false', async () => {
    seedSession(mockDb);
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    expect(mockFromConfig).toHaveBeenCalledTimes(1);
    expect(mockValidate).not.toHaveBeenCalled();
  }, 15_000);

  it('rejects a reused provider runner that lacks the LLMClient contract', async () => {
    seedSession(mockDb);
    const legacyOnlyRunner = {
      name: 'legacy-only',
      runAnalysis: vi.fn()
        .mockResolvedValueOnce({
          rawJson: makeAnalysisResponse(), durationMs: 1, inputTokens: 1,
          outputTokens: 1, provider: 'legacy', model: 'legacy-model',
        })
        .mockResolvedValueOnce({
          rawJson: makePQResponse(), durationMs: 1, inputTokens: 1,
          outputTokens: 1, provider: 'legacy', model: 'legacy-model',
        }),
    };

    const { runInsightsCommand } = await import('../insights.js');
    await expect(runInsightsCommand({
      sessionId: 'sess1', native: false, quiet: true, _runner: legacyOnlyRunner,
    })).rejects.toThrow('Configured provider runner does not implement the LLMClient interface.');
    expect(legacyOnlyRunner.runAnalysis).not.toHaveBeenCalled();
  });

  it('saves insights to the database', async () => {
    seedSession(mockDb);
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    const insights = mockDb.prepare('SELECT * FROM insights WHERE session_id = ?').all('sess1');
    // summary + prompt_quality
    expect(insights.length).toBeGreaterThanOrEqual(2);
  });

  it('records analysis_usage for session and prompt_quality', async () => {
    seedSession(mockDb);
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    const usageRows = mockDb
      .prepare('SELECT analysis_type FROM analysis_usage WHERE session_id = ? ORDER BY analysis_type')
      .all('sess1') as Array<{ analysis_type: string }>;

    expect(usageRows.map(r => r.analysis_type)).toEqual(['prompt_quality', 'session']);
  });

  it('leaves every previously published artifact unchanged when prompt-quality fails', async () => {
    seedSession(mockDb);
    mockDb.exec(`
      UPDATE sessions SET generated_title = 'Previous title' WHERE id = 'sess1';
      INSERT INTO insights (
        id, session_id, project_id, project_name, type, title, content,
        summary, bullets, confidence, source, metadata, timestamp,
        created_at, scope, analysis_version
      ) VALUES
        ('old-summary', 'sess1', 'p1', 'test-project', 'summary',
         'Previous summary', 'Old content', 'Old content', '[]', 0.9,
         'llm', NULL, datetime('now'), datetime('now'), 'session', '3.0.0'),
        ('old-pq', 'sess1', 'p1', 'test-project', 'prompt_quality',
         'Previous PQ', 'Old PQ content', 'Old PQ content', '[]', 0.85,
         'llm', NULL, datetime('now'), datetime('now'), 'session', '3.0.0');
      INSERT INTO session_facets (
        session_id, outcome_satisfaction, workflow_pattern,
        had_course_correction, course_correction_reason, iteration_count,
        friction_points, effective_patterns, analysis_version
      ) VALUES ('sess1', 'low', 'old-pattern', 1, 'old reason', 9, '[]', '[]', '2.0.0');
      INSERT INTO analysis_usage (
        session_id, analysis_type, provider, model, input_tokens,
        output_tokens, estimated_cost_usd, session_message_count, analyzed_at
      ) VALUES
        ('sess1', 'session', 'old-provider', 'old-model', 1, 2, 0.1, 3, '2000-01-01 00:00:00'),
        ('sess1', 'prompt_quality', 'old-provider', 'old-model', 3, 4, 0.2, 3, '2000-01-01 00:00:00');
    `);
    const before = {
      title: mockDb.prepare(`SELECT generated_title FROM sessions WHERE id = 'sess1'`).get(),
      insights: mockDb.prepare(`SELECT id, type, title FROM insights WHERE session_id = 'sess1' ORDER BY id`).all(),
      facets: mockDb.prepare(`SELECT * FROM session_facets WHERE session_id = 'sess1'`).get(),
      usage: mockDb.prepare(`SELECT * FROM analysis_usage WHERE session_id = 'sess1' ORDER BY analysis_type`).all(),
    };
    mockProviderRunAnalysis
      .mockResolvedValueOnce({
        rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50,
        outputTokens: 50, model: 'gpt-4o', provider: 'openai',
      })
      .mockResolvedValueOnce({
        rawJson: '{not valid prompt quality json', durationMs: 80,
        inputTokens: 30, outputTokens: 30, model: 'gpt-4o', provider: 'openai',
      });

    const { runInsightsCommand } = await import('../insights.js');
    await expect(runInsightsCommand({
      sessionId: 'sess1', native: false, force: true, quiet: true,
    })).rejects.toThrow(/Prompt quality analysis failed/);

    expect({
      title: mockDb.prepare(`SELECT generated_title FROM sessions WHERE id = 'sess1'`).get(),
      insights: mockDb.prepare(`SELECT id, type, title FROM insights WHERE session_id = 'sess1' ORDER BY id`).all(),
      facets: mockDb.prepare(`SELECT * FROM session_facets WHERE session_id = 'sess1'`).get(),
      usage: mockDb.prepare(`SELECT * FROM analysis_usage WHERE session_id = 'sess1' ORDER BY analysis_type`).all(),
    }).toEqual(before);
  });

  it('uses the shared LLMClient for both passes with content blocks and real provider cost', async () => {
    seedSession(mockDb);
    mockProviderRunAnalysis
      .mockResolvedValueOnce({
        rawJson: makeAnalysisResponse(),
        durationMs: 100,
        inputTokens: 50,
        outputTokens: 50,
        model: 'gpt-4o',
        provider: 'openai',
      })
      .mockResolvedValueOnce({
        rawJson: makePQResponse(),
        durationMs: 80,
        inputTokens: 30,
        outputTokens: 30,
        cacheReadTokens: 20,
        model: 'gpt-4o',
        provider: 'openai',
      });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    expect(mockProviderChat).toHaveBeenCalledTimes(2);
    const sessionMessages = mockProviderChat.mock.calls[0][0];
    const promptQualityMessages = mockProviderChat.mock.calls[1][0];
    expect(Array.isArray(sessionMessages[1].content)).toBe(true);
    expect(Array.isArray(promptQualityMessages[1].content)).toBe(true);
    const usage = mockDb.prepare(`
      SELECT provider, model, estimated_cost_usd, chunk_count
      FROM analysis_usage
      WHERE session_id = 'sess1' AND analysis_type = 'session'
    `).get() as {
      provider: string;
      model: string;
      estimated_cost_usd: number;
      chunk_count: number;
    };
    expect(usage).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      estimated_cost_usd: 0.000625,
      chunk_count: 1,
    });
    const promptQualityUsage = mockDb.prepare(`
      SELECT provider, model, estimated_cost_usd, cache_read_tokens
      FROM analysis_usage
      WHERE session_id = 'sess1' AND analysis_type = 'prompt_quality'
    `).get();
    expect(promptQualityUsage).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      estimated_cost_usd: 0.0004,
      cache_read_tokens: 20,
    });
  });

  it('bounds the final prepared prompt-quality request after credential replacement expands it', async () => {
    seedSession(mockDb);
    mockDb.prepare(`
      INSERT INTO messages (id, session_id, type, content, timestamp)
      VALUES ('expanded-secret', 'sess1', 'user', 'EXPAND_ME', datetime('now'))
    `).run();

    const capabilities = {
      contextWindowTokens: 8_200,
      reservedOutputTokens: 1_000,
      safetyMarginTokens: 1_000,
      supportsContentBlocks: true,
      requestOverhead: {
        baseTokens: 3,
        perMessageTokens: 4,
        perContentBlockTokens: 2,
      },
    };
    const prepareMessages = vi.fn((messages: LLMMessage[]): LLMMessage[] => (
      messages.map(message => ({
        ...message,
        content: typeof message.content === 'string'
          ? message.content.replaceAll('EXPAND_ME', `[credential removed]${'R'.repeat(16_000)}`)
          : message.content.map(block => ({
              ...block,
              text: block.text.replaceAll(
                'EXPAND_ME',
                `[credential removed]${'R'.repeat(16_000)}`,
              ),
            })),
      }))
    ));
    const chat = vi.fn(async (messages: LLMMessage[]) => {
      const requestText = messages.map(message => flattenContent(message.content)).join('\n');
      return {
        content: requestText.includes('"efficiency_score"')
          ? makePQResponse()
          : makeAnalysisResponse(),
        usage: {
          inputTokens: 31,
          outputTokens: 7,
          cacheCreationTokens: 5,
          cacheReadTokens: 3,
        },
      };
    });
    const legacyRunAnalysis = vi.fn(async () => ({
      rawJson: makePQResponse(),
      durationMs: 80,
      inputTokens: 99,
      outputTokens: 88,
      model: 'small-model',
      provider: 'small-provider',
    }));
    const runner = {
      name: 'small-provider',
      provider: 'small-provider',
      model: 'small-model',
      capabilities,
      estimateTokens: (text: string) => Math.ceil(text.length / 4),
      prepareMessages,
      chat,
      runAnalysis: legacyRunAnalysis,
    };

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({
      sessionId: 'sess1',
      native: false,
      quiet: true,
      _runner: runner,
    });

    const pqCall = chat.mock.calls.find(([messages]) => (
      messages.some(message => flattenContent(message.content).includes('"efficiency_score"'))
    ));
    expect(pqCall).toBeDefined();
    expect(legacyRunAnalysis).not.toHaveBeenCalled();

    const pqMessages = pqCall?.[0] ?? [];
    const userMessage = pqMessages.find(message => message.role === 'user');
    expect(Array.isArray(userMessage?.content)).toBe(true);
    if (!userMessage || !Array.isArray(userMessage.content)) {
      throw new Error('Expected the prompt-quality request to use content blocks.');
    }
    expect(userMessage.content).toHaveLength(2);
    expect(userMessage.content[0].text).toContain('conversation truncated for analysis');
    expect(userMessage.content[0].text).not.toContain('EXPAND_ME');
    expect(userMessage.content[1].text).toContain('"efficiency_score"');
    expect(estimateRequestTokens(runner, pqMessages))
      .toBeLessThanOrEqual(getRequestTokenBudget(runner));

    const usage = mockDb.prepare(`
      SELECT provider, model, input_tokens, output_tokens,
             cache_creation_tokens, cache_read_tokens
      FROM analysis_usage
      WHERE session_id = 'sess1' AND analysis_type = 'prompt_quality'
    `).get();
    expect(usage).toEqual({
      provider: 'small-provider',
      model: 'small-model',
      input_tokens: 31,
      output_tokens: 7,
      cache_creation_tokens: 5,
      cache_read_tokens: 3,
    });
  });

  it('fails with a stable context error when prompt-quality fixed overhead cannot fit', async () => {
    seedSession(mockDb);
    const capabilities = {
      contextWindowTokens: 100_000,
      reservedOutputTokens: 8_192,
      safetyMarginTokens: 11_808,
      supportsContentBlocks: true,
      requestOverhead: {
        baseTokens: 3,
        perMessageTokens: 4,
        perContentBlockTokens: 2,
      },
    };
    const chat = vi.fn(async () => {
      capabilities.contextWindowTokens = 1;
      capabilities.reservedOutputTokens = 0;
      capabilities.safetyMarginTokens = 0;
      return {
        content: makeAnalysisResponse(),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const legacyRunAnalysis = vi.fn(async () => ({
      rawJson: makePQResponse(),
      durationMs: 80,
      inputTokens: 30,
      outputTokens: 30,
      model: 'small-model',
      provider: 'small-provider',
    }));
    const runner = {
      name: 'small-provider',
      provider: 'small-provider',
      model: 'small-model',
      capabilities,
      estimateTokens: (text: string) => Math.ceil(text.length / 4),
      prepareMessages: (messages: LLMMessage[]) => messages,
      chat,
      runAnalysis: legacyRunAnalysis,
    };

    const { runInsightsCommand } = await import('../insights.js');
    await expect(runInsightsCommand({
      sessionId: 'sess1',
      native: false,
      quiet: true,
      _runner: runner,
    })).rejects.toThrow('Prompt quality request exceeds the provider context window.');

    expect(chat).toHaveBeenCalledOnce();
    expect(legacyRunAnalysis).not.toHaveBeenCalled();
    const usageTypes = mockDb.prepare(`
      SELECT analysis_type
      FROM analysis_usage
      WHERE session_id = 'sess1'
      ORDER BY analysis_type
    `).all() as Array<{ analysis_type: string }>;
    expect(usageTypes).toEqual([]);
  });

  it('does not overwrite a previous complete insight when a required provider chunk fails', async () => {
    seedSession(mockDb);
    mockDb.prepare(`
      INSERT INTO insights (
        id, session_id, project_id, project_name, type, title, content,
        summary, bullets, confidence, source, metadata, timestamp,
        created_at, scope, analysis_version
      ) VALUES (
        'old-summary', 'sess1', 'p1', 'test-project', 'summary',
        'Previous complete analysis', 'Old content', 'Old content', '[]',
        0.9, 'llm', NULL, datetime('now'), datetime('now'), 'session', '3.0.0'
      )
    `).run();
    const insertMessage = mockDb.prepare(`
      INSERT INTO messages (id, session_id, type, content, timestamp)
      VALUES (?, 'sess1', 'user', ?, datetime('now'))
    `);
    insertMessage.run('large-a', 'A'.repeat(200_000));
    insertMessage.run('large-b', 'B'.repeat(200_000));
    mockProviderRunAnalysis
      .mockResolvedValueOnce({
        rawJson: makeAnalysisResponse(),
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 20,
        model: 'gpt-4o',
        provider: 'openai',
      })
      .mockResolvedValueOnce({
        rawJson: 'not-json',
        durationMs: 100,
        inputTokens: 200,
        outputTokens: 40,
        model: 'gpt-4o',
        provider: 'openai',
      });

    const { runInsightsCommand } = await import('../insights.js');
    await expect(
      runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true }),
    ).rejects.toThrow(/chunk/i);

    expect(mockDb.prepare(
      `SELECT id, title FROM insights WHERE session_id = 'sess1' ORDER BY id`,
    ).all()).toEqual([
      { id: 'old-summary', title: 'Previous complete analysis' },
    ]);
  });

  it('records session_message_count in analysis_usage (V8)', async () => {
    seedSession(mockDb, 'sess1', 12);
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    const row = mockDb.prepare(
      `SELECT session_message_count FROM analysis_usage WHERE session_id = ? AND analysis_type = 'session'`
    ).get('sess1') as { session_message_count: number };

    expect(row.session_message_count).toBe(12);
  });

  it('throws if session not found in DB', async () => {
    const { runInsightsCommand } = await import('../insights.js');
    await expect(
      runInsightsCommand({ sessionId: 'nonexistent', native: false, quiet: true })
    ).rejects.toThrow(/not found/i);
  });
});

describe('insightsCommand — shared LLM lock', () => {
  const originalExitCode = process.exitCode;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockProviderRunAnalysis.mockReset();
    mockFromConfig.mockReset();
    process.exitCode = undefined;
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    consoleErrSpy.mockRestore();
    mockDb.close();
  });

  it('leaves work untouched and returns temporary-failure status when the lock is busy', async () => {
    seedSession(mockDb, 'busy-session');
    mockAcquireLlmLock.mockReturnValueOnce(null);

    const { insightsCommand } = await import('../insights.js');
    await insightsCommand('busy-session', { quiet: false });

    expect(mockProviderRunAnalysis).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(75);
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringMatching(/already running/i));
  });

  it('releases the lock after a successful direct analysis', async () => {
    seedSession(mockDb, 'locked-session');
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 0, outputTokens: 0, model: 'test', provider: 'test' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 100, inputTokens: 0, outputTokens: 0, model: 'test', provider: 'test' });

    const { insightsCommand } = await import('../insights.js');
    await insightsCommand('locked-session', { quiet: true });

    expect(mockAcquireLlmLock).toHaveBeenCalledOnce();
    expect(mockReleaseLlmLock).toHaveBeenCalledOnce();
  });
});

describe('runInsightsCommand — native mode (--native)', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockRunAnalysis.mockReset();
    mockValidate.mockReset();
    mockFromConfig.mockReset();
    mockProviderRunAnalysis.mockReset();
    mockInsertSession.mockReset();
    mockInsertMessages.mockReset();
    mockProvider.parse.mockReset();
  });

  it('calls ClaudeNativeRunner.validate() and uses native runner', async () => {
    seedSession(mockDb);
    mockRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 200, inputTokens: 0, outputTokens: 0, model: 'claude-native', provider: 'claude-code-native' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 150, inputTokens: 0, outputTokens: 0, model: 'claude-native', provider: 'claude-code-native' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: true, quiet: true });

    expect(mockValidate).toHaveBeenCalledTimes(1);
    expect(mockFromConfig).not.toHaveBeenCalled();
    expect(mockRunAnalysis).toHaveBeenCalledTimes(2);
    const promptQualityUsage = mockDb.prepare(`
      SELECT estimated_cost_usd
      FROM analysis_usage
      WHERE session_id = 'sess1' AND analysis_type = 'prompt_quality'
    `).get() as { estimated_cost_usd: number };
    expect(promptQualityUsage.estimated_cost_usd).toBe(0);
  });
});

describe('runInsightsCommand — --force flag', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockProviderRunAnalysis.mockReset();
    mockFromConfig.mockReset();
    mockInsertSession.mockReset();
    mockInsertMessages.mockReset();
    mockProvider.parse.mockReset();
  });

  it('re-analyzes even if analysis_usage exists with matching message_count', async () => {
    seedSession(mockDb, 'sess1', 10);

    mockDb.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model, session_message_count)
        VALUES ('sess1', 'session', 'openai', 'gpt-4', 10)
    `).run();

    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, force: true, quiet: true });

    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(2);
  });
});

describe('runInsightsCommand — resume detection', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockProviderRunAnalysis.mockReset();
    mockFromConfig.mockReset();
    mockInsertSession.mockReset();
    mockInsertMessages.mockReset();
    mockProvider.parse.mockReset();
  });

  it('skips analysis only when both passes exactly match input, pipeline, provider, and model', async () => {
    seedSession(mockDb, 'sess1', 10);
    markSessionCurrent(mockDb, 'sess1');

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({
      sessionId: 'sess1',
      native: false,
      quiet: true,
    });

    expect(mockProviderRunAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    ['provider', 'anthropic'],
    ['model', 'different-model'],
    ['input_revision', 'sha256:stale'],
    ['pipeline_revision', 'old-pipeline'],
    ['session_message_count', 9],
  ])('restarts both passes when prompt-quality %s is stale', async (column, value) => {
    seedSession(mockDb, 'sess1', 10);
    markSessionCurrent(mockDb, 'sess1');
    mockDb.prepare(`UPDATE analysis_usage SET ${column} = ? WHERE session_id = ? AND analysis_type = ?`)
      .run(value, 'sess1', 'prompt_quality');
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 1, inputTokens: 1, outputTokens: 1, model: 'gpt-4o', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 1, inputTokens: 1, outputTokens: 1, model: 'gpt-4o', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(2);
  });

  it('restarts both passes when message content changes without changing message_count', async () => {
    seedSession(mockDb, 'sess1', 10);
    markSessionCurrent(mockDb, 'sess1');
    mockDb.prepare(`UPDATE messages SET content = 'Changed in place' WHERE session_id = 'sess1'`).run();
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 1, inputTokens: 1, outputTokens: 1, model: 'gpt-4o', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 1, inputTokens: 1, outputTokens: 1, model: 'gpt-4o', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(2);
  });

  it('restarts analysis when only the session pass was recorded', async () => {
    seedSession(mockDb, 'sess1', 10);
    mockDb.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model, session_message_count)
        VALUES ('sess1', 'session', 'openai', 'gpt-4', 10)
    `).run();
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({ sessionId: 'sess1', native: false, quiet: true });

    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(2);
  });

  it('proceeds when message_count differs from analysis_usage', async () => {
    seedSession(mockDb, 'sess1', 15);

    mockDb.prepare(`
      INSERT INTO analysis_usage (session_id, analysis_type, provider, model, session_message_count)
        VALUES ('sess1', 'session', 'openai', 'gpt-4', 10)
    `).run();

    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({
      sessionId: 'sess1',
      native: false,
      quiet: true,
    });

    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(2);
  });

  it('proceeds when no analysis_usage row exists', async () => {
    seedSession(mockDb, 'sess1', 8);

    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 100, inputTokens: 50, outputTokens: 50, model: 'gpt-4', provider: 'openai' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 80, inputTokens: 30, outputTokens: 30, model: 'gpt-4', provider: 'openai' });

    const { runInsightsCommand } = await import('../insights.js');
    await runInsightsCommand({
      sessionId: 'sess1',
      native: false,
      quiet: true,
    });

    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(2);
  });
});

describe('syncSingleFile', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockInsertSession.mockReset();
    mockInsertMessages.mockReset();
    mockProvider.parse.mockReset();
  });

  it('calls provider.parse() and inserts session and messages', async () => {
    const fakeSession = {
      id: 'parsed-sess',
      project_id: 'p1',
      project_name: 'test',
      project_path: '/test',
      messages: [{ id: 'm1', type: 'user', content: 'hello', timestamp: new Date().toISOString() }],
      messageCount: 5,
    };
    mockProvider.parse.mockResolvedValueOnce(fakeSession);
    mockInsertSession.mockReturnValue(true);

    const { syncSingleFile } = await import('../sync.js');
    await syncSingleFile({ filePath: '/path/to/session.jsonl' });

    expect(mockProvider.parse).toHaveBeenCalledWith('/path/to/session.jsonl');
    expect(mockInsertSession).toHaveBeenCalledWith(fakeSession, false);
    expect(mockInsertMessages).toHaveBeenCalledWith(fakeSession);
  });

  it('does nothing if provider.parse() returns null', async () => {
    mockProvider.parse.mockResolvedValueOnce(null);

    const { syncSingleFile } = await import('../sync.js');
    await syncSingleFile({ filePath: '/path/to/empty.jsonl' });

    expect(mockInsertSession).not.toHaveBeenCalled();
    expect(mockInsertMessages).not.toHaveBeenCalled();
  });
});

// ── insightsCheckCommand tests ────────────────────────────────────────────────

describe('insightsCheckCommand — count-based behavior', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockRunAnalysis.mockReset();
    mockValidate.mockReset();
    mockFromConfig.mockReset();
    mockProviderRunAnalysis.mockReset();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  function seedSessions(db: Database.Database, count: number, analyzedCount = 0): void {
    db.exec(`INSERT OR IGNORE INTO projects (id, name, path, last_activity) VALUES ('pc1', 'proj', '/p', datetime('now'));`);
    for (let i = 0; i < count; i++) {
      const sid = `chk-sess-${i}`;
      db.exec(`INSERT OR IGNORE INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count) VALUES ('${sid}', 'pc1', 'proj', '/p', datetime('now', '-${i} minutes'), datetime('now', '-${i} minutes'), 10);`);
      if (i < analyzedCount) {
        markSessionCurrent(db, sid);
      }
    }
  }

  it('exits silently when 0 unanalyzed sessions', async () => {
    seedSessions(mockDb, 2, 2);
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false });
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('--quiet outputs just the count for unanalyzed sessions', async () => {
    seedSessions(mockDb, 5, 0);
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: true });
    const written = (stdoutSpy.mock.calls as Array<[unknown]>).map(c => String(c[0])).join('');
    expect(written.trim()).toBe('5');
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('--quiet exits silently when 0 unanalyzed sessions', async () => {
    seedSessions(mockDb, 3, 3);
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: true });
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('counts a session whose saved passes were invalidated after message repair', async () => {
    seedSessions(mockDb, 1, 0);
    mockDb.exec(`
      INSERT INTO analysis_usage
        (session_id, analysis_type, provider, model, session_message_count)
      VALUES
        ('chk-sess-0', 'session', 'openai', 'gpt-4', NULL),
        ('chk-sess-0', 'prompt_quality', 'openai', 'gpt-4', NULL);
    `);

    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: true });

    const written = (stdoutSpy.mock.calls as Array<[unknown]>).map(c => String(c[0])).join('');
    expect(written.trim()).toBe('1');
  });

  it('counts a session whose message count matches but pipeline revision is stale', async () => {
    seedSessions(mockDb, 1, 1);
    mockDb.prepare(`UPDATE analysis_usage SET pipeline_revision = 'old-pipeline' WHERE session_id = 'chk-sess-0'`).run();

    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: true });

    const written = (stdoutSpy.mock.calls as Array<[unknown]>).map(c => String(c[0])).join('');
    expect(written.trim()).toBe('1');
  });

  it('prints count and suggest --analyze for 3-10 unanalyzed sessions', async () => {
    seedSessions(mockDb, 5, 0);
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false });
    const output = (consoleSpy.mock.calls as Array<unknown[]>).map(c => String(c[0])).join('\n');
    expect(output).toContain('5');
    expect(output).toMatch(/insights check --analyze/i);
    // No time estimate for < 11 sessions
    expect(output).not.toMatch(/~\d+ min/i);
  });

  it('prints count + time estimate for 11+ unanalyzed sessions', async () => {
    seedSessions(mockDb, 12, 0);
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false });
    const output = (consoleSpy.mock.calls as Array<unknown[]>).map(c => String(c[0])).join('\n');
    expect(output).toContain('12');
    expect(output).toMatch(/insights check --analyze/i);
    // Should have time estimate (~X min)
    expect(output).toMatch(/~\d/);
  });

  it('respects --days lookback window', async () => {
    mockDb.exec(`INSERT OR IGNORE INTO projects (id, name, path, last_activity) VALUES ('pd1', 'proj', '/p', datetime('now'));`);
    mockDb.exec(`INSERT OR IGNORE INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count) VALUES ('old-s', 'pd1', 'proj', '/p', datetime('now', '-8 days'), datetime('now', '-8 days'), 10);`);
    mockDb.exec(`INSERT OR IGNORE INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count) VALUES ('new-s', 'pd1', 'proj', '/p', datetime('now', '-1 days'), datetime('now', '-1 days'), 10);`);
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: true });
    const written = (stdoutSpy.mock.calls as Array<[unknown]>).map(c => String(c[0])).join('');
    expect(written.trim()).toBe('1');
  });
});

describe('insightsCheckCommand — auto-analyze (1-2 sessions)', () => {
  const originalExitCode = process.exitCode;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockRunAnalysis.mockReset();
    mockValidate.mockReset();
    mockFromConfig.mockReset();
    mockProviderRunAnalysis.mockReset();
    process.exitCode = undefined;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  function seedOne(db: Database.Database, id: string): void {
    db.exec(`INSERT OR IGNORE INTO projects (id, name, path, last_activity) VALUES ('pa1', 'proj', '/p', datetime('now'));`);
    db.exec(`INSERT OR IGNORE INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count) VALUES ('${id}', 'pa1', 'proj', '/p', datetime('now'), datetime('now'), 10);`);
    db.exec(`INSERT OR IGNORE INTO messages (id, session_id, type, content, timestamp) VALUES ('${id}-message', '${id}', 'user', 'Analyze this session.', datetime('now'));`);
  }

  it('auto-analyzes 1 unanalyzed session using configured provider', async () => {
    seedOne(mockDb, 'auto-1');
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 500, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 400, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' });
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false });
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockFromConfig).toHaveBeenCalledTimes(1);
    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(2);
  });

  it('auto-analyzes 2 unanalyzed sessions using configured provider', async () => {
    seedOne(mockDb, 'auto-2a');
    seedOne(mockDb, 'auto-2b');
    mockProviderRunAnalysis
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 500, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 400, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 500, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 400, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' });
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false });
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockFromConfig).toHaveBeenCalledTimes(1);
    expect(mockProviderRunAnalysis).toHaveBeenCalledTimes(4);
  });

  it('retains automatic work for a later run when another analysis holds the lock', async () => {
    seedOne(mockDb, 'auto-busy');
    mockAcquireLlmLock.mockReturnValueOnce(null);

    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false });

    expect(mockProviderRunAnalysis).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(75);
  });
});

describe('insightsCheckCommand — --analyze flag', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    mockRunAnalysis.mockReset();
    mockValidate.mockReset();
    mockFromConfig.mockReset();
    mockProviderRunAnalysis.mockReset();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  function seedSessions(db: Database.Database, count: number): void {
    db.exec(`INSERT OR IGNORE INTO projects (id, name, path, last_activity) VALUES ('pb1', 'proj', '/p', datetime('now'));`);
    for (let i = 0; i < count; i++) {
      db.exec(`INSERT OR IGNORE INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count) VALUES ('an-sess-${i}', 'pb1', 'proj', '/p', datetime('now', '-${i} minutes'), datetime('now', '-${i} minutes'), 10);`);
      db.exec(`INSERT OR IGNORE INTO messages (id, session_id, type, content, timestamp) VALUES ('an-sess-${i}-message', 'an-sess-${i}', 'user', 'Analyze this session.', datetime('now', '-${i} minutes'));`);
    }
  }

  it('processes all sessions with --analyze and shows [N/total] progress', async () => {
    seedSessions(mockDb, 3);
    for (let i = 0; i < 3; i++) {
      mockProviderRunAnalysis
        .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 1000, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
        .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 800, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' });
    }
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false, analyze: true });
    // Progress lines go to process.stdout.write
    const stdoutOutput = (stdoutSpy.mock.calls as Array<[unknown]>).map(c => String(c[0])).join('');
    expect(stdoutOutput).toMatch(/\[1\/3\]/);
    expect(stdoutOutput).toMatch(/\[2\/3\]/);
    expect(stdoutOutput).toMatch(/\[3\/3\]/);
    // Summary line goes to console.log
    const logOutput = (consoleSpy.mock.calls as Array<unknown[]>).map(c => String(c[0])).join('\n');
    expect(logOutput).toMatch(/Analyzed 3 session/i);
  });

  it('continues processing after one session fails', async () => {
    seedSessions(mockDb, 3);
    mockProviderRunAnalysis
      .mockRejectedValueOnce(new Error('fail on session 0'))
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 1000, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 800, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
      .mockResolvedValueOnce({ rawJson: makeAnalysisResponse(), durationMs: 1000, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' })
      .mockResolvedValueOnce({ rawJson: makePQResponse(), durationMs: 800, inputTokens: 0, outputTokens: 0, model: 'anthropic', provider: 'anthropic' });
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false, analyze: true });
    const stdoutOutput = (stdoutSpy.mock.calls as Array<[unknown]>).map(c => String(c[0])).join('');
    const errOutput = (consoleErrSpy.mock.calls as Array<unknown[]>).map(c => String(c[0])).join('\n');
    const logOutput = (consoleSpy.mock.calls as Array<unknown[]>).map(c => String(c[0])).join('\n');
    expect(stdoutOutput).toMatch(/\[1\/3\]/);
    expect(errOutput).toMatch(/analysis provider request failed/i);
    expect(errOutput).not.toContain('fail on session 0');
    expect(logOutput).toMatch(/Analyzed 2 session/i);
  });

  it('exits silently with --analyze when 0 unanalyzed sessions', async () => {
    const { insightsCheckCommand } = await import('../insights.js');
    await insightsCheckCommand({ days: 7, quiet: false, analyze: true });
    expect(mockRunAnalysis).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
