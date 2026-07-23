import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { AnalysisLanguage } from '../types.js';
import { getDb } from '../db/client.js';
import { redactCredentialText } from '../privacy/outbound-credential-guard.js';
import { createAnalysisEngine } from './analysis-engine.js';
import {
  applyGeneratedTitle,
  convertPQToInsightRow,
  convertToInsightRows,
  deleteSessionFacets,
  deleteSessionInsights,
  saveFacetsToDb,
  saveInsightsToDb,
  ANALYSIS_VERSION,
  type SessionData,
} from './analysis-db.js';
import { calculateAnalysisCost } from './analysis-pricing.js';
import { saveAnalysisUsage, type SaveAnalysisUsageData } from './analysis-usage-db.js';
import { prepareBoundedConversationRequest, type LLMClient } from './llm-client.js';
import { sanitizeMessageReferences } from './message-references.js';
import { formatMessagesForAnalysis } from './message-format.js';
import type { AnalysisResponse, PromptQualityResponse, SQLiteMessageRow } from './prompt-types.js';
import {
  buildCacheableConversationBlock,
  buildPromptQualityInstructions,
  buildSessionAnalysisInstructions,
  SHARED_ANALYST_SYSTEM_PROMPT,
} from './prompts.js';
import { parseAnalysisResponse, parsePromptQualityResponse } from './response-parsers.js';
import type {
  AnalysisRunner,
  RunAnalysisParams,
  RunAnalysisResult,
} from './runner-types.js';

/**
 * Bump whenever pass orchestration, prompts, parsing, or publication semantics
 * change in a way that must not be mixed inside one durable campaign.
 */
export const LEGACY_TWO_PASS_PIPELINE_REVISION = `analysis-${ANALYSIS_VERSION}/two-pass-v1`;
export const TWO_PASS_PIPELINE_REVISION = `analysis-${ANALYSIS_VERSION}/two-pass-v4`;

export function pipelineRevisionForAnalysisLanguage(
  analysisLanguage: AnalysisLanguage,
): string {
  return analysisLanguage === 'auto'
    ? TWO_PASS_PIPELINE_REVISION
    : `${TWO_PASS_PIPELINE_REVISION}/lang-${analysisLanguage}`;
}

export interface SessionAnalysisRow extends SessionData {
  message_count: number;
}

/** Point-in-time input. Conversation text lives here, never in durable stages. */
export interface FrozenSessionAnalysisInput {
  session: SessionAnalysisRow;
  messages: SQLiteMessageRow[];
  inputRevision: string;
}

export interface PreparedPassUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  chunkCount: number;
}

interface PreparedPassBase {
  schemaVersion: 1;
  sessionId: string;
  inputRevision: string;
  sessionMessageCount: number;
  provider: string;
  model: string;
  /** Optional in the wire type so legacy JSON can be decoded and rejected safely. */
  analysisLanguage?: AnalysisLanguage;
  /** Optional in the wire type so legacy JSON can be decoded and rejected safely. */
  pipelineRevision?: string;
  usage: PreparedPassUsage;
}

/** Durable, JSON-only output of the first remote pass. */
export interface PreparedSessionPass extends PreparedPassBase {
  kind: 'session';
  response: AnalysisResponse;
}

/** Durable, JSON-only output of the second remote pass. */
export interface PreparedPromptQualityPass extends PreparedPassBase {
  kind: 'prompt_quality';
  response: PromptQualityResponse;
}

type CurrentPreparedPass = (PreparedSessionPass | PreparedPromptQualityPass) & {
  analysisLanguage: AnalysisLanguage;
  pipelineRevision: string;
};

export interface PublishedTwoPassResult {
  insightCount: number;
  promptQualityScore: number;
}

function loadSessionRow(db: Database.Database, sessionId: string): SessionAnalysisRow | null {
  return db.prepare(`
    SELECT id, project_id, project_name, project_path, summary, ended_at,
           message_count, compact_count, auto_compact_count, slash_commands
    FROM sessions
    WHERE id = ? AND deleted_at IS NULL
  `).get(sessionId) as SessionAnalysisRow | null;
}

function loadMessages(db: Database.Database, sessionId: string): SQLiteMessageRow[] {
  return db.prepare(`
    SELECT id, session_id, type, content, thinking, tool_calls, tool_results,
           usage, timestamp, parent_id
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(sessionId) as SQLiteMessageRow[];
}

export function calculateSessionInputRevision(
  session: SessionAnalysisRow,
  messages: SQLiteMessageRow[],
): string {
  // Explicit projection: unrelated schema additions must not invalidate a campaign.
  const stableInput = {
    revisionSchema: 1,
    session: {
      id: session.id,
      project_id: session.project_id,
      project_name: session.project_name,
      project_path: session.project_path,
      summary: session.summary,
      ended_at: session.ended_at,
      message_count: session.message_count,
      compact_count: session.compact_count ?? null,
      auto_compact_count: session.auto_compact_count ?? null,
      slash_commands: session.slash_commands ?? null,
    },
    messages: messages.map(message => ({
      id: message.id,
      session_id: message.session_id,
      type: message.type,
      content: message.content,
      thinking: message.thinking ?? null,
      tool_calls: message.tool_calls ?? null,
      tool_results: message.tool_results ?? null,
      usage: message.usage ?? null,
      timestamp: message.timestamp,
      parent_id: message.parent_id ?? null,
    })),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(stableInput)).digest('hex')}`;
}

/** Load the exact ordered input used by both passes and assign a stable revision. */
export function freezeSessionAnalysisInput(
  sessionId: string,
  db: Database.Database = getDb(),
): FrozenSessionAnalysisInput {
  const session = loadSessionRow(db, sessionId);
  if (!session) throw new Error(`Session '${sessionId}' not found in local database.`);
  const messages = loadMessages(db, sessionId);
  return { session, messages, inputRevision: calculateSessionInputRevision(session, messages) };
}

/** Backward-compatible descriptive alias used by existing callers/tests. */
export const loadFrozenSessionInput = freezeSessionAnalysisInput;

export function isAnalysisLLMClient(
  runner: AnalysisRunner,
): runner is AnalysisRunner & LLMClient {
  const candidate = runner as Partial<LLMClient>;
  return typeof candidate.chat === 'function'
    && typeof candidate.estimateTokens === 'function'
    && typeof candidate.provider === 'string'
    && typeof candidate.model === 'string'
    && candidate.capabilities !== undefined;
}

function parseSlashCommands(encoded: string | undefined): string[] {
  try {
    return JSON.parse(encoded ?? '[]') as string[];
  } catch {
    return [];
  }
}

function sessionMetadata(input: FrozenSessionAnalysisInput) {
  return {
    compactCount: input.session.compact_count ?? 0,
    autoCompactCount: input.session.auto_compact_count ?? 0,
    slashCommands: parseSlashCommands(input.session.slash_commands),
  };
}

function normalizeUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  estimatedCostUsd: number;
  durationMs: number;
  chunkCount?: number;
}): PreparedPassUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    estimatedCostUsd: usage.estimatedCostUsd,
    durationMs: usage.durationMs,
    chunkCount: usage.chunkCount ?? 1,
  };
}

/**
 * The configured-provider path has its own final outbound guard through
 * LLMClient.prepareMessages(). Non-LLM runners (notably ClaudeNativeRunner)
 * cross this shared boundary instead, immediately before runner invocation.
 */
function runGuardedAnalysis(
  runner: AnalysisRunner,
  params: RunAnalysisParams,
): Promise<RunAnalysisResult> {
  return runner.runAnalysis({
    ...params,
    systemPrompt: redactCredentialText(params.systemPrompt),
    userPrompt: redactCredentialText(params.userPrompt),
  });
}

function commonStageFields(
  input: FrozenSessionAnalysisInput,
  provider: string,
  model: string,
  usage: PreparedPassUsage,
  analysisLanguage: AnalysisLanguage,
): PreparedPassBase {
  return {
    schemaVersion: 1,
    sessionId: input.session.id,
    inputRevision: input.inputRevision,
    sessionMessageCount: input.session.message_count,
    provider,
    model,
    analysisLanguage,
    pipelineRevision: pipelineRevisionForAnalysisLanguage(analysisLanguage),
    usage,
  };
}

function assertStageMatchesInput(
  stage: PreparedSessionPass | PreparedPromptQualityPass,
  input: FrozenSessionAnalysisInput,
): void {
  if (
    stage.schemaVersion !== 1
    || stage.sessionId !== input.session.id
    || stage.sessionMessageCount !== input.session.message_count
    || stage.inputRevision !== input.inputRevision
  ) {
    throw new Error(
      `Session '${input.session.id}' changed since analysis was prepared; no results were published.`,
    );
  }
}

function assertStageUsesCurrentLanguagePolicy(
  stage: PreparedSessionPass | PreparedPromptQualityPass,
): asserts stage is CurrentPreparedPass {
  if (stage.analysisLanguage === undefined || stage.pipelineRevision === undefined) {
    throw new Error('Prepared analysis pass predates the current language policy pipeline.');
  }
  if (stage.pipelineRevision !== pipelineRevisionForAnalysisLanguage(stage.analysisLanguage)) {
    throw new Error('Prepared analysis pass does not match the current language policy pipeline.');
  }
}

/** Execute pass 1 without writing analysis artifacts to SQLite. */
export async function prepareSessionAnalysisPass(
  input: FrozenSessionAnalysisInput,
  runner: AnalysisRunner,
  analysisLanguage: AnalysisLanguage = 'auto',
): Promise<PreparedSessionPass> {
  let response: AnalysisResponse;
  let provider: string;
  let model: string;
  let usage: PreparedPassUsage;

  if (isAnalysisLLMClient(runner)) {
    const outcome = await createAnalysisEngine({
      client: runner,
      analysisLanguage,
    }).analyzeSession({
      session: input.session,
      messages: input.messages,
    });
    if (!outcome.ok || outcome.completeness !== 'complete') {
      const message = outcome.ok ? 'Analysis result was incomplete.' : outcome.error.message;
      throw new Error(`Session analysis failed: ${message}`);
    }
    response = outcome.response;
    provider = outcome.usage.provider;
    model = outcome.usage.model;
    usage = normalizeUsage(outcome.usage);
  } else {
    const instructions = buildSessionAnalysisInstructions(
      input.session.project_name,
      input.session.summary,
      sessionMetadata(input),
      { preference: analysisLanguage, messages: input.messages },
    );
    const formattedMessages = formatMessagesForAnalysis(input.messages);
    const result = await runGuardedAnalysis(runner, {
      systemPrompt: SHARED_ANALYST_SYSTEM_PROMPT,
      userPrompt: `${buildCacheableConversationBlock(formattedMessages).text}\n${instructions}`,
    });
    const parsed = parseAnalysisResponse(result.rawJson);
    if (!parsed.success) throw new Error(`Session analysis failed: ${parsed.error.error_message}`);
    response = parsed.data;
    provider = result.provider;
    model = result.model;
    usage = normalizeUsage({ ...result, estimatedCostUsd: 0, chunkCount: 1 });
  }

  return {
    ...commonStageFields(input, provider, model, usage, analysisLanguage),
    kind: 'session',
    response,
  };
}

/** Short alias retained for callers that already use the pass-oriented name. */
export const prepareSessionPass = prepareSessionAnalysisPass;

async function runPromptQualityPass(
  input: FrozenSessionAnalysisInput,
  runner: AnalysisRunner,
  analysisLanguage: AnalysisLanguage,
): Promise<RunAnalysisResult> {
  const formattedMessages = formatMessagesForAnalysis(input.messages);
  const humanMessageCount = input.messages.filter(message => message.type === 'user').length;
  const assistantMessageCount = input.messages.filter(message => message.type === 'assistant').length;
  const toolExchangeCount = input.messages.filter(message => Boolean(message.tool_calls)).length;
  const instructions = buildPromptQualityInstructions(
    input.session.project_name,
    { humanMessageCount, assistantMessageCount, toolExchangeCount },
    sessionMetadata(input),
    { preference: analysisLanguage, messages: input.messages },
  );
  const conversationBlock = buildCacheableConversationBlock(formattedMessages);

  if (!isAnalysisLLMClient(runner)) {
    return runGuardedAnalysis(runner, {
      systemPrompt: SHARED_ANALYST_SYSTEM_PROMPT,
      userPrompt: `${conversationBlock.text}\n${instructions}`,
    });
  }

  const preparedRequest = prepareBoundedConversationRequest(runner, [
    { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [conversationBlock, { type: 'text', text: instructions }],
    },
  ]);
  if (!preparedRequest) {
    throw new Error('Prompt quality request exceeds the provider context window.');
  }
  const startedAt = Date.now();
  const response = await runner.chat(preparedRequest.messages);
  return {
    rawJson: response.content,
    durationMs: Date.now() - startedAt,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    cacheCreationTokens: response.usage?.cacheCreationTokens,
    cacheReadTokens: response.usage?.cacheReadTokens,
    model: runner.model,
    provider: runner.provider,
  };
}

/** Execute pass 2 against pass 1's frozen revision, without DB writes. */
export async function preparePromptQualityPass(
  input: FrozenSessionAnalysisInput,
  runner: AnalysisRunner,
  sessionStage?: PreparedSessionPass,
  analysisLanguage: AnalysisLanguage = 'auto',
): Promise<PreparedPromptQualityPass> {
  if (sessionStage) {
    assertStageMatchesInput(sessionStage, input);
    if (sessionStage.kind !== 'session') {
      throw new Error('Prompt quality analysis requires a prepared session pass.');
    }
    assertStageUsesCurrentLanguagePolicy(sessionStage);
    if (sessionStage.analysisLanguage !== analysisLanguage) {
      throw new Error('Prompt quality analysis must use the same analysis language as session analysis.');
    }
  }

  const result = await runPromptQualityPass(input, runner, analysisLanguage);
  const parsed = parsePromptQualityResponse(result.rawJson);
  if (!parsed.success) {
    throw new Error(`Prompt quality analysis failed: ${parsed.error.error_message}`);
  }
  const estimatedCostUsd = isAnalysisLLMClient(runner)
    ? calculateAnalysisCost(result.provider, result.model, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        cacheReadTokens: result.cacheReadTokens,
      })
    : 0;
  return {
    ...commonStageFields(
      input,
      result.provider,
      result.model,
      normalizeUsage({ ...result, estimatedCostUsd, chunkCount: 1 }),
      analysisLanguage,
    ),
    kind: 'prompt_quality',
    response: parsed.data,
  };
}

function usageWrite(stage: CurrentPreparedPass): SaveAnalysisUsageData {
  return {
    session_id: stage.sessionId,
    analysis_type: stage.kind,
    provider: stage.provider,
    model: stage.model,
    input_tokens: stage.usage.inputTokens,
    output_tokens: stage.usage.outputTokens,
    cache_creation_tokens: stage.usage.cacheCreationTokens,
    cache_read_tokens: stage.usage.cacheReadTokens,
    estimated_cost_usd: stage.usage.estimatedCostUsd,
    duration_ms: stage.usage.durationMs,
    chunk_count: stage.usage.chunkCount,
    session_message_count: stage.sessionMessageCount,
    input_revision: stage.inputRevision,
    pipeline_revision: stage.pipelineRevision,
  };
}

/** Atomically replace every visible artifact produced by the two passes. */
export function publishPreparedTwoPass(
  input: FrozenSessionAnalysisInput,
  sessionStage: PreparedSessionPass,
  promptQualityStage: PreparedPromptQualityPass,
  onPublished?: (result: PublishedTwoPassResult) => void,
  db: Database.Database = getDb(),
): PublishedTwoPassResult {
  assertStageMatchesInput(sessionStage, input);
  assertStageMatchesInput(promptQualityStage, input);
  assertStageUsesCurrentLanguagePolicy(sessionStage);
  assertStageUsesCurrentLanguagePolicy(promptQualityStage);
  if (sessionStage.analysisLanguage !== promptQualityStage.analysisLanguage) {
    throw new Error('Prepared analysis passes use different analysis languages.');
  }
  if (
    sessionStage.kind !== 'session'
    || promptQualityStage.kind !== 'prompt_quality'
    || sessionStage.sessionId !== promptQualityStage.sessionId
    || sessionStage.inputRevision !== promptQualityStage.inputRevision
    || sessionStage.sessionMessageCount !== promptQualityStage.sessionMessageCount
  ) {
    throw new Error('Prepared analysis passes do not describe the same session revision.');
  }

  return db.transaction((): PublishedTwoPassResult => {
    const currentInput = freezeSessionAnalysisInput(sessionStage.sessionId, db);
    assertStageMatchesInput(sessionStage, currentInput);
    assertStageMatchesInput(promptQualityStage, currentInput);

    const filtered = sanitizeMessageReferences(
      sessionStage.response,
      promptQualityStage.response,
      currentInput.messages,
    );
    const sessionInsights = convertToInsightRows(
      filtered.sessionResponse,
      currentInput.session,
    );
    const promptQualityInsight = convertPQToInsightRow(
      filtered.promptQualityResponse,
      currentInput.session,
    );
    saveInsightsToDb([...sessionInsights, promptQualityInsight], db);
    deleteSessionInsights(sessionStage.sessionId, {
      excludeTypes: ['prompt_quality'],
      excludeIds: sessionInsights.map(insight => insight.id),
    }, db);
    deleteSessionInsights(sessionStage.sessionId, {
      excludeTypes: ['summary', 'decision', 'learning'],
      excludeIds: [promptQualityInsight.id],
    }, db);
    applyGeneratedTitle(sessionStage.sessionId, sessionInsights, db);

    if (sessionStage.response.facets) {
      saveFacetsToDb(sessionStage.sessionId, sessionStage.response.facets, ANALYSIS_VERSION, db);
    } else {
      deleteSessionFacets(sessionStage.sessionId, db);
    }
    saveAnalysisUsage(usageWrite(sessionStage), db);
    saveAnalysisUsage(usageWrite(promptQualityStage), db);

    const result = {
      insightCount: sessionInsights.length,
      promptQualityScore: promptQualityStage.response.efficiency_score,
    };
    onPublished?.(result);
    return result;
  })();
}
