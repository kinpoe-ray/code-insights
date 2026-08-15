// Server adapter over the shared CLI-core two-pass pipeline.
// freeze → prepare both passes → atomic publish live in
// cli/src/analysis/two-pass-analysis.ts. This module maps that contract onto
// the AnalysisResult shape the dashboard routes consume. Every analysis
// triggered here produces revision-stamped usage rows, so freshness checks
// (isAlreadyAnalyzed in cli/src/commands/insights.ts) count dashboard runs
// exactly like queue runs instead of re-analyzing — and re-paying for — them.

import { createLLMClient, isLLMConfigured } from './client.js';
import { loadConfiguredAnalysisLanguage } from '@code-insights/cli/analysis/analysis-language';
import { classifyStoredUserMessage } from '@code-insights/cli/analysis/message-format';
import {
  AnalysisPassError,
  freezeSessionAnalysisInput,
  preparePromptQualityPass,
  prepareSessionAnalysisPass,
  publishPreparedPromptQualityPass,
  publishPreparedTwoPass,
  type PreparedPassUsage,
} from '@code-insights/cli/analysis/two-pass-analysis';
import type { InsightRow, SessionData } from '@code-insights/cli/analysis/analysis-db';
import type { SQLiteMessageRow } from '@code-insights/cli/analysis/prompt-types';
import type {
  AnalysisProgress,
  AnalysisOptions,
  AnalysisResult,
} from './analysis-internal.js';

export { findRecurringInsights } from './recurring-insights.js';
export type { RecurringInsightGroup, RecurringInsightResult } from './recurring-insights.js';
export { extractFacetsOnly } from './facet-extraction.js';

export type { AnalysisProgress, AnalysisOptions, AnalysisResult };
export type { InsightRow, SessionData };

function usageForResult(usage: PreparedPassUsage): AnalysisResult['usage'] {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheCreationTokens > 0 && { cacheCreationTokens: usage.cacheCreationTokens }),
    ...(usage.cacheReadTokens > 0 && { cacheReadTokens: usage.cacheReadTokens }),
  };
}

function summedUsage(stages: PreparedPassUsage[]): AnalysisResult['usage'] {
  return usageForResult({
    inputTokens: stages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: stages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cacheCreationTokens: stages.reduce((sum, usage) => sum + usage.cacheCreationTokens, 0),
    cacheReadTokens: stages.reduce((sum, usage) => sum + usage.cacheReadTokens, 0),
    estimatedCostUsd: 0,
    durationMs: 0,
    chunkCount: 0,
  });
}

function failureFromError(error: unknown): AnalysisResult {
  if (error instanceof AnalysisPassError) {
    return {
      success: false,
      insights: [],
      error: error.message,
      error_type: error.details.errorType ?? 'parse',
      ...(error.details.responseLength !== undefined && {
        response_length: error.details.responseLength,
      }),
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { success: false, insights: [], error: 'Analysis cancelled', error_type: 'abort' };
  }
  if (error instanceof Error && error.message.includes('not found in local database')) {
    return { success: false, insights: [], error: error.message, error_type: 'not_found' };
  }
  return {
    success: false,
    insights: [],
    error: 'The analysis provider request failed.',
    error_type: 'api_error',
  };
}

/**
 * Analyze one session through the full two-pass pipeline.
 *
 * Identical to the CLI queue path: freeze → prepare session pass → prepare
 * prompt-quality pass → one atomic publish. A partial or aborted run never
 * reaches the database, and both usage rows carry input/pipeline revisions.
 */
export async function analyzeSession(
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: AnalysisOptions,
): Promise<AnalysisResult> {
  if (!isLLMConfigured()) {
    return {
      success: false,
      insights: [],
      error: 'LLM not configured. Run `code-insights config llm` to configure a provider.',
    };
  }

  if (messages.length === 0) {
    return {
      success: false,
      insights: [],
      error: 'No messages found for this session.',
    };
  }

  try {
    const analysisLanguage = loadConfiguredAnalysisLanguage();
    const client = createLLMClient();
    const input = freezeSessionAnalysisInput(session.id);

    const sessionStage = await prepareSessionAnalysisPass(input, client, analysisLanguage, {
      signal: options?.signal,
      onProgress: options?.onProgress,
    });
    const promptQualityStage = await preparePromptQualityPass(
      input,
      client,
      sessionStage,
      analysisLanguage,
      { signal: options?.signal },
    );

    options?.onProgress?.({ phase: 'saving' });
    const published = publishPreparedTwoPass(input, sessionStage, promptQualityStage);

    return {
      success: true,
      insights: published.insights,
      usage: summedUsage([sessionStage.usage, promptQualityStage.usage]),
      completeness: 'complete',
    };
  } catch (error) {
    return failureFromError(error);
  }
}

/**
 * Re-run the prompt-quality pass alone through the same two-pass machinery:
 * corrective retry on malformed output, revision-stamped usage row, atomic
 * replace of the session's prompt_quality insight.
 */
export async function analyzePromptQuality(
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: AnalysisOptions,
): Promise<AnalysisResult> {
  if (!isLLMConfigured()) {
    return {
      success: false,
      insights: [],
      error: 'LLM not configured. Run `code-insights config llm` to configure a provider.',
    };
  }

  if (messages.length === 0) {
    return {
      success: false,
      insights: [],
      error: 'No messages found for this session.',
    };
  }

  // Only genuine human messages count (not tool-results or system artifacts);
  // fewer than 2 means there is nothing to evaluate and no LLM call to make.
  const humanMessages = messages.filter(
    message => message.type === 'user' && classifyStoredUserMessage(message.content) === 'human',
  );
  if (humanMessages.length < 2) {
    return {
      success: false,
      insights: [],
      error: 'Not enough user messages to analyze prompt quality (need at least 2).',
    };
  }

  try {
    const analysisLanguage = loadConfiguredAnalysisLanguage();
    const client = createLLMClient();
    const input = freezeSessionAnalysisInput(session.id);

    options?.onProgress?.({ phase: 'analyzing' });
    const stage = await preparePromptQualityPass(
      input,
      client,
      undefined,
      analysisLanguage,
      { signal: options?.signal },
    );

    options?.onProgress?.({ phase: 'saving' });
    const published = publishPreparedPromptQualityPass(input, stage);

    return {
      success: true,
      insights: published.insights,
      usage: usageForResult(stage.usage),
    };
  } catch (error) {
    return failureFromError(error);
  }
}
