import { jsonrepair } from 'jsonrepair';
import type { SessionData } from './analysis-db.js';
import { calculateAnalysisCost } from './analysis-pricing.js';
import { formatMessagesForAnalysis } from './message-format.js';
import {
  estimateRequestTokens,
  getRequestTokenBudget,
  type ContentBlock,
  type LLMClient,
  type LLMMessage,
  type LLMTokenUsage,
} from './llm-client.js';
import type { AnalysisResponse, SQLiteMessageRow, SessionMetadata } from './prompt-types.js';
import {
  SHARED_ANALYST_SYSTEM_PROMPT,
  buildCacheableConversationBlock,
  buildFacetOnlyInstructions,
  buildSessionAnalysisInstructions,
} from './prompts.js';
import {
  extractJsonPayload,
  parseAnalysisResponse,
  validateAnalysisFacets,
} from './response-parsers.js';

export interface AnalysisProgress {
  phase: 'analyzing';
  currentChunk: number;
  totalChunks: number;
}

export interface AnalysisUsage extends Required<LLMTokenUsage> {
  provider: string;
  model: string;
  estimatedCostUsd: number;
  durationMs: number;
  chunkCount: number;
  callCount: number;
}

export interface AnalysisStats {
  chunkCount: number;
  successfulChunks: number;
  failedChunks: number;
  callCount: number;
  facetCallCount: number;
}

export interface AnalyzeSessionInput {
  session: SessionData;
  messages: SQLiteMessageRow[];
}

export interface AnalyzeSessionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
  requireComplete?: boolean;
}

export interface AnalysisSuccess {
  ok: true;
  completeness: 'complete' | 'partial';
  response: AnalysisResponse;
  stats: AnalysisStats;
  warnings: string[];
  usage: AnalysisUsage;
}

export interface AnalysisFailure {
  ok: false;
  completeness: 'none' | 'partial';
  error: {
    kind: 'empty' | 'parse' | 'provider' | 'aborted' | 'partial_failure';
    code:
      | 'EMPTY_SESSION'
      | 'INVALID_RESPONSE'
      | 'PROVIDER_REQUEST_FAILED'
      | 'ANALYSIS_ABORTED'
      | 'PARTIAL_RESPONSE';
    message: string;
    parseErrorType?: 'json_parse_error' | 'no_json_found' | 'invalid_structure';
    responseLength?: number;
    failedChunks?: number[];
  };
  stats: AnalysisStats;
  warnings: string[];
  usage: AnalysisUsage;
}

export type AnalysisOutcome = AnalysisSuccess | AnalysisFailure;

export interface AnalysisEngine {
  analyzeSession(input: AnalyzeSessionInput, options?: AnalyzeSessionOptions): Promise<AnalysisOutcome>;
}

export interface AnalysisEngineDependencies {
  client: LLMClient;
  now?: () => number;
}

function buildSessionMeta(session: SessionData): SessionMetadata | undefined {
  let slashCommands: string[] = [];
  try {
    slashCommands = session.slash_commands ? JSON.parse(session.slash_commands) as string[] : [];
  } catch {
    slashCommands = [];
  }
  if (!session.compact_count && !session.auto_compact_count && slashCommands.length === 0) {
    return undefined;
  }
  return {
    compactCount: session.compact_count ?? 0,
    autoCompactCount: session.auto_compact_count ?? 0,
    slashCommands,
  };
}

function buildAnalysisRequest(formattedMessages: string, instructions: string): LLMMessage[] {
  return [
    { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        buildCacheableConversationBlock(formattedMessages),
        { type: 'text', text: instructions },
      ],
    },
  ];
}

interface PreparedAnalysisPrompt {
  systemMessage: LLMMessage;
  userRole: 'user' | 'assistant';
  conversationBlock: ContentBlock;
  instructionBlocks: ContentBlock[];
}

function prepareAnalysisPrompt(
  client: LLMClient,
  formattedMessages: string,
  instructions: string,
): PreparedAnalysisPrompt {
  const prepared = client.prepareMessages(buildAnalysisRequest(formattedMessages, instructions));
  const systemMessage = prepared.find((message) => message.role === 'system');
  const userMessage = prepared.find((message) => message.role !== 'system');
  if (
    !systemMessage
    || !userMessage
    || systemMessage.role !== 'system'
    || userMessage.role === 'system'
    || !Array.isArray(userMessage.content)
    || userMessage.content.length < 2
  ) {
    throw new Error('Outbound preparation changed the analysis request shape.');
  }
  return {
    systemMessage,
    userRole: userMessage.role,
    conversationBlock: userMessage.content[0],
    instructionBlocks: userMessage.content.slice(1),
  };
}

function buildPreparedRequest(
  prompt: PreparedAnalysisPrompt,
  conversationText: string,
): LLMMessage[] {
  return [
    prompt.systemMessage,
    {
      role: prompt.userRole,
      content: [
        { ...prompt.conversationBlock, text: conversationText },
        ...prompt.instructionBlocks,
      ],
    },
  ];
}

function requestTokens(client: LLMClient, request: LLMMessage[]): number {
  return estimateRequestTokens(client, request);
}

function splitPreparedConversation(
  prompt: PreparedAnalysisPrompt,
  client: LLMClient,
  budget: number,
): string[] {
  const formatted = prompt.conversationBlock.text;
  const pieces: string[] = [];
  let offset = 0;

  while (offset < formatted.length) {
    let low = 1;
    let high = formatted.length - offset;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const prefix = offset > 0 ? '[continued message]\n' : '';
      const suffix = offset + middle < formatted.length ? '\n[message continues]' : '';
      const candidate = `${prefix}${formatted.slice(offset, offset + middle)}${suffix}`;
      if (requestTokens(client, buildPreparedRequest(prompt, candidate)) <= budget) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === 0) {
      throw new Error('LLM context window is too small for the analysis instructions.');
    }
    const prefix = offset > 0 ? '[continued message]\n' : '';
    const suffix = offset + best < formatted.length ? '\n[message continues]' : '';
    pieces.push(`${prefix}${formatted.slice(offset, offset + best)}${suffix}`);
    offset += best;
  }

  return pieces;
}

function buildConversationChunks(
  prompt: PreparedAnalysisPrompt,
  client: LLMClient,
  budget: number,
): { chunks: string[]; warnings: string[] } {
  const warnings: string[] = [];
  if (
    requestTokens(client, buildPreparedRequest(prompt, prompt.conversationBlock.text))
    <= budget
  ) {
    return { chunks: [prompt.conversationBlock.text], warnings };
  }
  warnings.push('The prepared conversation was split across analysis chunks.');
  return {
    chunks: splitPreparedConversation(prompt, client, budget),
    warnings,
  };
}

function mergeAnalysisResponses(responses: AnalysisResponse[]): AnalysisResponse {
  if (responses.length === 1) return responses[0];
  const merged: AnalysisResponse = {
    summary: responses[0].summary,
    decisions: [],
    learnings: [],
  };
  for (const response of responses) {
    merged.decisions.push(...response.decisions);
    merged.learnings.push(...response.learnings);
  }
  const deduplicate = <T extends { title: string }>(items: T[]): T[] => {
    const titles = new Set<string>();
    return items.filter((item) => {
      const title = item.title.toLowerCase().trim();
      if (titles.has(title)) return false;
      titles.add(title);
      return true;
    });
  };
  merged.decisions = deduplicate(merged.decisions).slice(0, 3);
  merged.learnings = deduplicate(merged.learnings).slice(0, 5);
  return merged;
}

function parseFacets(content: string): AnalysisResponse['facets'] | undefined {
  const payload = extractJsonPayload(content);
  if (!payload) return undefined;
  try {
    return validateAnalysisFacets(JSON.parse(payload));
  } catch {
    try {
      return validateAnalysisFacets(JSON.parse(jsonrepair(payload)));
    } catch {
      return undefined;
    }
  }
}

function truncateConversationToBudget(
  prompt: PreparedAnalysisPrompt,
  client: LLMClient,
  budget: number,
): string | null {
  const formatted = prompt.conversationBlock.text;
  if (requestTokens(client, buildPreparedRequest(prompt, formatted)) <= budget) return formatted;
  const suffix = '\n\n[... conversation truncated for facet analysis ...]';
  let low = 0;
  let high = formatted.length;
  let best = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${formatted.slice(0, middle)}${suffix}`;
    if (requestTokens(client, buildPreparedRequest(prompt, candidate)) <= budget) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best >= 0 ? `${formatted.slice(0, best)}${suffix}` : null;
}

export function createAnalysisEngine(dependencies: AnalysisEngineDependencies): AnalysisEngine {
  const { client } = dependencies;
  const now = dependencies.now ?? Date.now;

  return {
    async analyzeSession(input, options = {}) {
      const startedAt = now();
      if (input.messages.length === 0) {
        const zeroUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
        return {
          ok: false,
          completeness: 'none',
          error: {
            kind: 'empty',
            code: 'EMPTY_SESSION',
            message: 'No messages found for this session.',
          },
          stats: {
            chunkCount: 0,
            successfulChunks: 0,
            failedChunks: 0,
            callCount: 0,
            facetCallCount: 0,
          },
          warnings: [],
          usage: {
            provider: client.provider,
            model: client.model,
            ...zeroUsage,
            estimatedCostUsd: calculateAnalysisCost(client.provider, client.model, zeroUsage),
            durationMs: now() - startedAt,
            chunkCount: 0,
            callCount: 0,
          },
        };
      }
      const instructions = buildSessionAnalysisInstructions(
        input.session.project_name,
        input.session.summary,
        buildSessionMeta(input.session),
      );
      const budget = getRequestTokenBudget(client);
      const formattedMessages = formatMessagesForAnalysis(input.messages);
      const preparedPrompt = prepareAnalysisPrompt(client, formattedMessages, instructions);
      const chunkPlan = buildConversationChunks(preparedPrompt, client, budget);
      const parsedResponses: AnalysisResponse[] = [];
      const failedChunkIndices: number[] = [];
      const parseFailures: Array<{
        index: number;
        error: {
          error_type: 'json_parse_error' | 'no_json_found' | 'invalid_structure';
          response_length: number;
        };
      }> = [];
      const usage: Required<LLMTokenUsage> = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      let callCount = 0;
      let facetCallCount = 0;
      const buildCurrentUsage = (): AnalysisUsage => ({
        provider: client.provider,
        model: client.model,
        ...usage,
        estimatedCostUsd: calculateAnalysisCost(client.provider, client.model, usage),
        durationMs: now() - startedAt,
        chunkCount: chunkPlan.chunks.length,
        callCount,
      });
      const abortedOutcome = (): AnalysisFailure => ({
        ok: false,
        completeness: parsedResponses.length > 0 ? 'partial' : 'none',
        error: {
          kind: 'aborted',
          code: 'ANALYSIS_ABORTED',
          message: 'Analysis cancelled.',
        },
        stats: {
          chunkCount: chunkPlan.chunks.length,
          successfulChunks: parsedResponses.length,
          failedChunks: failedChunkIndices.length,
          callCount,
          facetCallCount,
        },
        warnings: chunkPlan.warnings,
        usage: buildCurrentUsage(),
      });
      const thrownOutcome = (error: unknown): AnalysisFailure => {
        const aborted = error instanceof Error && error.name === 'AbortError';
        return {
          ok: false,
          completeness: parsedResponses.length > 0 ? 'partial' : 'none',
          error: {
            kind: aborted ? 'aborted' : 'provider',
            code: aborted ? 'ANALYSIS_ABORTED' : 'PROVIDER_REQUEST_FAILED',
            message: aborted
              ? 'Analysis cancelled.'
              : 'The analysis provider request failed.',
          },
          stats: {
            chunkCount: chunkPlan.chunks.length,
            successfulChunks: parsedResponses.length,
            failedChunks: failedChunkIndices.length + (aborted ? 0 : 1),
            callCount,
            facetCallCount,
          },
          warnings: chunkPlan.warnings,
          usage: buildCurrentUsage(),
        };
      };

      for (let index = 0; index < chunkPlan.chunks.length; index++) {
        if (options.signal?.aborted) return abortedOutcome();
        options.onProgress?.({
          phase: 'analyzing',
          currentChunk: index + 1,
          totalChunks: chunkPlan.chunks.length,
        });
        callCount++;
        let response;
        try {
          response = await client.chat(
            buildPreparedRequest(preparedPrompt, chunkPlan.chunks[index]),
            { signal: options.signal },
          );
        } catch (error) {
          return thrownOutcome(error);
        }
        usage.inputTokens += response.usage?.inputTokens ?? 0;
        usage.outputTokens += response.usage?.outputTokens ?? 0;
        usage.cacheCreationTokens += response.usage?.cacheCreationTokens ?? 0;
        usage.cacheReadTokens += response.usage?.cacheReadTokens ?? 0;
        if (options.signal?.aborted) return abortedOutcome();
        const parsed = parseAnalysisResponse(response.content);
        if (parsed.success) {
          parsedResponses.push(parsed.data);
        } else {
          failedChunkIndices.push(index + 1);
          parseFailures.push({
            index: index + 1,
            error: {
              error_type: parsed.error.error_type,
              response_length: parsed.error.response_length,
            },
          });
          chunkPlan.warnings.push(`Analysis chunk ${index + 1} could not be parsed.`);
        }
      }

      let analysisResponse = parsedResponses.length > 0
        ? mergeAnalysisResponses(parsedResponses)
        : undefined;

      if (
        chunkPlan.chunks.length > 1
        && analysisResponse
        && failedChunkIndices.length === 0
        && !analysisResponse.facets
      ) {
        const facetInstructions = buildFacetOnlyInstructions(
          input.session.project_name,
          input.session.summary,
          buildSessionMeta(input.session),
        );
        const facetPrompt = prepareAnalysisPrompt(
          client,
          formattedMessages,
          facetInstructions,
        );
        const facetConversation = truncateConversationToBudget(
          facetPrompt,
          client,
          budget,
        );
        if (facetConversation === null) {
          chunkPlan.warnings.push('Facet extraction skipped because instructions exceed the context budget.');
        } else {
          if (options.signal?.aborted) return abortedOutcome();
          callCount++;
          facetCallCount++;
          let facetResponse;
          try {
            facetResponse = await client.chat(
              buildPreparedRequest(facetPrompt, facetConversation),
              { signal: options.signal },
            );
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              return thrownOutcome(error);
            }
            chunkPlan.warnings.push('Facet extraction provider request failed.');
          }
          if (facetResponse) {
            usage.inputTokens += facetResponse.usage?.inputTokens ?? 0;
            usage.outputTokens += facetResponse.usage?.outputTokens ?? 0;
            usage.cacheCreationTokens += facetResponse.usage?.cacheCreationTokens ?? 0;
            usage.cacheReadTokens += facetResponse.usage?.cacheReadTokens ?? 0;
            if (options.signal?.aborted) return abortedOutcome();
            analysisResponse.facets = parseFacets(facetResponse.content);
            if (!analysisResponse.facets) {
              chunkPlan.warnings.push('Facet extraction response could not be parsed.');
            }
          }
        }
      }

      const failedChunks = chunkPlan.chunks.length - parsedResponses.length;
      const stats: AnalysisStats = {
        chunkCount: chunkPlan.chunks.length,
        successfulChunks: parsedResponses.length,
        failedChunks,
        callCount,
        facetCallCount,
      };
      const analysisUsage = buildCurrentUsage();

      if (
        chunkPlan.chunks.length > 1
        && failedChunkIndices.length > 0
        && (options.requireComplete ?? true)
      ) {
        return {
          ok: false,
          completeness: parsedResponses.length > 0 ? 'partial' : 'none',
          error: {
            kind: 'partial_failure',
            code: 'PARTIAL_RESPONSE',
            message: 'One or more analysis chunks failed.',
            failedChunks: failedChunkIndices,
          },
          stats,
          warnings: chunkPlan.warnings,
          usage: analysisUsage,
        };
      }

      if (!analysisResponse) {
        const firstFailure = parseFailures[0]?.error;
        return {
          ok: false,
          completeness: 'none',
          error: {
            kind: 'parse',
            code: 'INVALID_RESPONSE',
            message: 'The analysis provider returned an invalid response.',
            ...(firstFailure && {
              parseErrorType: firstFailure.error_type,
              responseLength: firstFailure.response_length,
            }),
          },
          stats,
          warnings: chunkPlan.warnings,
          usage: analysisUsage,
        };
      }

      return {
        ok: true,
        completeness: failedChunks === 0 ? 'complete' : 'partial',
        response: analysisResponse,
        stats,
        warnings: chunkPlan.warnings,
        usage: analysisUsage,
      };
    },
  };
}
