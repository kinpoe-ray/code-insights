// Server persistence adapter for the shared CLI-core AnalysisEngine.
// Prompt construction, budgeting, chunking, merging, usage and error
// normalization live in cli/src/analysis/analysis-engine.ts.

import { createAnalysisEngine } from '@code-insights/cli/analysis/analysis-engine';
import { createLLMClient, isLLMConfigured } from './client.js';
import type { SQLiteMessageRow } from './prompt-types.js';
import {
  ANALYSIS_VERSION,
  convertToInsightRows,
  saveInsightsToDb,
  deleteSessionInsights,
  saveFacetsToDb,
  type InsightRow,
  type SessionData,
} from './analysis-db.js';
import type {
  AnalysisProgress,
  AnalysisOptions,
  AnalysisResult,
} from './analysis-internal.js';
import { saveAnalysisUsage } from './analysis-usage-db.js';

export { analyzePromptQuality } from './prompt-quality-analysis.js';
export { findRecurringInsights } from './recurring-insights.js';
export type { RecurringInsightGroup, RecurringInsightResult } from './recurring-insights.js';
export { extractFacetsOnly } from './facet-extraction.js';

export type { AnalysisProgress, AnalysisOptions, AnalysisResult };
export type { InsightRow, SessionData };

function legacyErrorType(
  error: {
    kind: 'empty' | 'parse' | 'provider' | 'aborted' | 'partial_failure';
    parseErrorType?: string;
  },
): string {
  if (error.kind === 'aborted') return 'abort';
  if (error.kind === 'provider') return 'api_error';
  if (error.kind === 'partial_failure') return 'partial_failure';
  return error.parseErrorType ?? error.kind;
}

/**
 * Analyze one session and persist only a complete result.
 *
 * The shared engine is pure: this adapter is the only place that writes the
 * server result to SQLite. A partial or aborted run never reaches these writes.
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
    const engine = createAnalysisEngine({ client: createLLMClient() });
    const outcome = await engine.analyzeSession(
      { session, messages },
      {
        signal: options?.signal,
        onProgress: options?.onProgress
          ? (progress) => options.onProgress?.(progress)
          : undefined,
      },
    );

    if (!outcome.ok || outcome.completeness !== 'complete') {
      return {
        success: false,
        insights: [],
        error: outcome.ok ? 'Analysis result was incomplete.' : outcome.error.message,
        error_type: outcome.ok ? 'partial_failure' : legacyErrorType(outcome.error),
        ...(!outcome.ok && outcome.error.responseLength !== undefined && {
          response_length: outcome.error.responseLength,
        }),
        usage: {
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          ...(outcome.usage.cacheCreationTokens > 0 && {
            cacheCreationTokens: outcome.usage.cacheCreationTokens,
          }),
          ...(outcome.usage.cacheReadTokens > 0 && {
            cacheReadTokens: outcome.usage.cacheReadTokens,
          }),
        },
        completeness: outcome.completeness,
        stats: outcome.stats,
        warnings: outcome.warnings,
      };
    }

    options?.onProgress?.({ phase: 'saving' });
    const insights = convertToInsightRows(outcome.response, session);

    saveInsightsToDb(insights);
    deleteSessionInsights(session.id, {
      excludeTypes: ['prompt_quality'],
      excludeIds: insights.map((insight) => insight.id),
    });

    if (outcome.response.facets) {
      saveFacetsToDb(session.id, outcome.response.facets, ANALYSIS_VERSION);
    }

    if (outcome.usage.inputTokens > 0 || outcome.usage.outputTokens > 0) {
      saveAnalysisUsage({
        session_id: session.id,
        analysis_type: 'session',
        provider: outcome.usage.provider,
        model: outcome.usage.model,
        input_tokens: outcome.usage.inputTokens,
        output_tokens: outcome.usage.outputTokens,
        cache_creation_tokens: outcome.usage.cacheCreationTokens,
        cache_read_tokens: outcome.usage.cacheReadTokens,
        estimated_cost_usd: outcome.usage.estimatedCostUsd,
        duration_ms: outcome.usage.durationMs,
        chunk_count: outcome.usage.chunkCount,
      });
    }

    return {
      success: true,
      insights,
      usage: {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        ...(outcome.usage.cacheCreationTokens > 0 && {
          cacheCreationTokens: outcome.usage.cacheCreationTokens,
        }),
        ...(outcome.usage.cacheReadTokens > 0 && {
          cacheReadTokens: outcome.usage.cacheReadTokens,
        }),
      },
      completeness: outcome.completeness,
      stats: outcome.stats,
      warnings: outcome.warnings,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        insights: [],
        error: 'Analysis cancelled',
        error_type: 'abort',
      };
    }
    return {
      success: false,
      insights: [],
      error: 'The analysis provider request failed.',
      error_type: 'api_error',
    };
  }
}
