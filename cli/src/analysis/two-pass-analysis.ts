import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { AnalysisLanguage } from '../types.js';
import { getDb } from '../db/client.js';
import { redactCredentialText } from '../privacy/outbound-credential-guard.js';
import { createAnalysisEngine, type AnalysisProgress } from './analysis-engine.js';
import {
  applyGeneratedTitle,
  convertPQToInsightRow,
  convertToInsightRows,
  deleteSessionFacets,
  deleteSessionInsights,
  saveFacetsToDb,
  saveInsightsToDb,
  ANALYSIS_VERSION,
  type InsightRow,
  type SessionData,
} from './analysis-db.js';
import { calculateAnalysisCost } from './analysis-pricing.js';
import { saveAnalysisUsage, type SaveAnalysisUsageData } from './analysis-usage-db.js';
import { prepareBoundedConversationRequest, type LLMClient } from './llm-client.js';
import {
  sanitizeMessageReferences,
  sanitizePromptQualityMessageReferences,
} from './message-references.js';
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
export const TWO_PASS_PIPELINE_REVISION = `analysis-${ANALYSIS_VERSION}/two-pass-v5`;

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

/**
 * Structured failure from a prepare pass. The message matches what the CLI
 * surfaces; `details` lets non-CLI callers (the server dashboard adapter) map
 * the failure onto their own error-type contract without parsing the message.
 */
export class AnalysisPassError extends Error {
  readonly details: {
    errorType?: string;
    responseLength?: number;
  };

  constructor(message: string, details: { errorType?: string; responseLength?: number } = {}) {
    super(message);
    this.name = 'AnalysisPassError';
    this.details = details;
  }
}

/** Execution options shared by both prepare passes. */
export interface AnalysisRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
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
  /** Every published row: session insights followed by the prompt-quality insight. */
  insights: InsightRow[];
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
  runner: AnalysisRunner | LLMClient,
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
  runner: AnalysisRunner | LLMClient,
  analysisLanguage: AnalysisLanguage = 'auto',
  runOptions?: AnalysisRunOptions,
): Promise<PreparedSessionPass> {
  let response: AnalysisResponse;
  let provider: string;
  let model: string;
  let usage: PreparedPassUsage;

  if (isAnalysisLLMClient(runner)) {
    const outcome = await createAnalysisEngine({
      client: runner,
      analysisLanguage,
    }).analyzeSession(
      { session: input.session, messages: input.messages },
      {
        signal: runOptions?.signal,
        onProgress: runOptions?.onProgress,
      },
    );
    if (!outcome.ok || outcome.completeness !== 'complete') {
      const message = outcome.ok
        ? 'Analysis result was incomplete. json_parse_error'
        : [
            outcome.error.message,
            outcome.error.parseErrorType,
            outcome.error.code === 'PARTIAL_RESPONSE' ? 'json_parse_error' : undefined,
          ].filter(Boolean).join(' ');
      const errorType = !outcome.ok
        ? passErrorType(outcome.error.kind, outcome.error.parseErrorType)
        : 'partial_failure';
      throw new AnalysisPassError(`Session analysis failed: ${message}`, {
        errorType,
        ...(!outcome.ok && outcome.error.responseLength !== undefined && {
          responseLength: outcome.error.responseLength,
        }),
      });
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
    const analysisParams = {
      systemPrompt: SHARED_ANALYST_SYSTEM_PROMPT,
      userPrompt: `${buildCacheableConversationBlock(formattedMessages).text}\n${instructions}`,
    };
    // Retry once on malformed structured output, mirroring the prompt-quality
    // pass. jsonrepair patches minor damage (trailing commas, truncation); a
    // second model call covers the structurally broken JSON that weaker models
    // emit and jsonrepair cannot reconstruct (e.g. missing keys / colons).
    // Anything that is not an LLMClient must be a native AnalysisRunner.
    const nativeRunner = runner as AnalysisRunner;
    const attempts: RunAnalysisResult[] = [await runGuardedAnalysis(nativeRunner, analysisParams)];
    let parsed = parseAnalysisResponse(attempts[0].rawJson);
    if (!parsed.success) {
      attempts.push(await runGuardedAnalysis(nativeRunner, analysisParams));
      parsed = parseAnalysisResponse(attempts[attempts.length - 1].rawJson);
    }
    if (!parsed.success) {
      throw new AnalysisPassError(
        `Session analysis failed: ${parsed.error.error_type}: ${parsed.error.error_message}`,
        { errorType: parsed.error.error_type },
      );
    }
    const combined = combineRunAnalysisResults(attempts);
    response = parsed.data;
    provider = combined.provider;
    model = combined.model;
    usage = normalizeUsage({
      ...combined,
      estimatedCostUsd: 0,
      chunkCount: attempts.length,
    });
  }

  return {
    ...commonStageFields(input, provider, model, usage, analysisLanguage),
    kind: 'session',
    response,
  };
}

/** Map an engine failure kind onto the shared error-type vocabulary. */
function passErrorType(
  kind: 'empty' | 'parse' | 'provider' | 'aborted' | 'partial_failure',
  parseErrorType?: string,
): string {
  if (kind === 'aborted') return 'abort';
  if (kind === 'provider') return 'api_error';
  return parseErrorType ?? kind;
}

/** Short alias retained for callers that already use the pass-oriented name. */
export const prepareSessionPass = prepareSessionAnalysisPass;

async function runPromptQualityPass(
  input: FrozenSessionAnalysisInput,
  runner: AnalysisRunner | LLMClient,
  analysisLanguage: AnalysisLanguage,
  correctiveRetry = false,
  runOptions?: AnalysisRunOptions,
): Promise<RunAnalysisResult> {
  const formattedMessages = formatMessagesForAnalysis(input.messages);
  const humanMessageCount = input.messages.filter(message => message.type === 'user').length;
  const assistantMessageCount = input.messages.filter(message => message.type === 'assistant').length;
  const toolExchangeCount = input.messages.filter(message => Boolean(message.tool_calls)).length;
  const baseInstructions = buildPromptQualityInstructions(
    input.session.project_name,
    { humanMessageCount, assistantMessageCount, toolExchangeCount },
    sessionMetadata(input),
    { preference: analysisLanguage, messages: input.messages },
  );
  const instructions = correctiveRetry
    ? `${baseInstructions}

CORRECTION: Your previous response could not be parsed. Generate the complete
answer again as one shorter, strict JSON object. Use double-quoted keys and
strings, include every required field, and output no markdown, comments, or
explanatory text.`
    : baseInstructions;
  const conversationBlock = buildCacheableConversationBlock(formattedMessages);

  if (!isAnalysisLLMClient(runner)) {
    return runGuardedAnalysis(runner as AnalysisRunner, {
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
    throw new AnalysisPassError('Prompt quality request exceeds the provider context window.', {
      errorType: 'context_limit',
    });
  }
  const startedAt = Date.now();
  const response = await runner.chat(preparedRequest.messages, {
    temperature: 0,
    responseFormat: 'json',
    signal: runOptions?.signal,
  });
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

function combineRunAnalysisResults(
  attempts: RunAnalysisResult[],
): RunAnalysisResult {
  const latest = attempts.at(-1);
  if (!latest) {
    throw new Error('Analysis did not produce an attempt.');
  }
  return {
    ...latest,
    inputTokens: attempts.reduce((sum, attempt) => sum + attempt.inputTokens, 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + attempt.outputTokens, 0),
    cacheCreationTokens: attempts.reduce(
      (sum, attempt) => sum + (attempt.cacheCreationTokens ?? 0),
      0,
    ),
    cacheReadTokens: attempts.reduce(
      (sum, attempt) => sum + (attempt.cacheReadTokens ?? 0),
      0,
    ),
    durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
  };
}

/** Execute pass 2 against pass 1's frozen revision, without DB writes. */
export async function preparePromptQualityPass(
  input: FrozenSessionAnalysisInput,
  runner: AnalysisRunner | LLMClient,
  sessionStage?: PreparedSessionPass,
  analysisLanguage: AnalysisLanguage = 'auto',
  runOptions?: AnalysisRunOptions,
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

  const attempts = [await runPromptQualityPass(input, runner, analysisLanguage, false, runOptions)];
  let parsed = parsePromptQualityResponse(attempts[0].rawJson);
  if (!parsed.success) {
    attempts.push(await runPromptQualityPass(input, runner, analysisLanguage, true, runOptions));
    parsed = parsePromptQualityResponse(attempts[1].rawJson);
  }
  if (!parsed.success) {
    throw new AnalysisPassError(
      `Prompt quality analysis failed: ${parsed.error.error_type} `
      + `(response length ${parsed.error.response_length}).`,
      {
        errorType: parsed.error.error_type,
        responseLength: parsed.error.response_length,
      },
    );
  }
  const result = combineRunAnalysisResults(attempts);
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
      normalizeUsage({ ...result, estimatedCostUsd, chunkCount: attempts.length }),
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

    const publishedInsights = [...sessionInsights, promptQualityInsight];
    const result: PublishedTwoPassResult = {
      insightCount: sessionInsights.length,
      promptQualityScore: promptQualityStage.response.efficiency_score,
      insights: publishedInsights,
    };
    onPublished?.(result);
    return result;
  })();
}

export interface PublishedPromptQualityResult {
  insights: InsightRow[];
}

/**
 * Atomically replace only the prompt-quality artifacts of one prepared pass.
 *
 * Companion to publishPreparedTwoPass for callers that re-run pass 2 alone
 * (dashboard "re-analyze prompt quality", PQ backfill): the stage still carries
 * input/pipeline revisions, so freshness checks count it exactly like a
 * two-pass run's pass 2.
 */
export function publishPreparedPromptQualityPass(
  input: FrozenSessionAnalysisInput,
  promptQualityStage: PreparedPromptQualityPass,
  db: Database.Database = getDb(),
): PublishedPromptQualityResult {
  assertStageMatchesInput(promptQualityStage, input);
  assertStageUsesCurrentLanguagePolicy(promptQualityStage);

  return db.transaction((): PublishedPromptQualityResult => {
    const currentInput = freezeSessionAnalysisInput(promptQualityStage.sessionId, db);
    assertStageMatchesInput(promptQualityStage, currentInput);

    const sanitizedResponse = sanitizePromptQualityMessageReferences(
      promptQualityStage.response,
      currentInput.messages,
    );
    const insight = convertPQToInsightRow(sanitizedResponse, currentInput.session);
    saveInsightsToDb([insight], db);
    deleteSessionInsights(promptQualityStage.sessionId, {
      includeOnlyTypes: ['prompt_quality'],
      excludeIds: [insight.id],
    }, db);
    saveAnalysisUsage(usageWrite(promptQualityStage), db);

    return { insights: [insight] };
  })();
}
