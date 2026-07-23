// Facet-only extraction — backfill path for sessions that already have insights.
// Extracted from analysis.ts to keep each analysis responsibility in its own module.

import { jsonrepair } from 'jsonrepair';
import { createLLMClient, isLLMConfigured, loadLLMConfig } from './client.js';
import { calculateAnalysisCost } from './analysis-pricing.js';
import { saveAnalysisUsage } from './analysis-usage-db.js';
import type { SQLiteMessageRow, AnalysisResponse } from './prompt-types.js';
import { formatMessagesForAnalysis } from './message-format.js';
import { extractJsonPayload, validateAnalysisFacets } from './response-parsers.js';
import { SHARED_ANALYST_SYSTEM_PROMPT, buildCacheableConversationBlock, buildFacetOnlyInstructions } from './prompts.js';
import { prepareBoundedConversationRequest } from './types.js';
import {
  ANALYSIS_VERSION,
  saveFacetsToDb,
  type SessionData,
} from './analysis-db.js';
import { buildSessionMeta } from './analysis-internal.js';
import { loadConfiguredAnalysisLanguage } from '@code-insights/cli/analysis/analysis-language';

/**
 * Extract facets only for a session that already has insights (backfill).
 * Uses the full conversation transcript for accurate friction attribution.
 * Falls back to truncation for sessions exceeding token limits.
 */
export async function extractFacetsOnly(
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: { signal?: AbortSignal }
): Promise<{ success: boolean; error?: string }> {
  if (!isLLMConfigured()) {
    return { success: false, error: 'LLM not configured.' };
  }

  if (messages.length === 0) {
    return { success: false, error: 'No messages found.' };
  }

  try {
    const startTime = Date.now();
    const client = createLLMClient();
    const formattedMessages = formatMessagesForAnalysis(messages);

    const sessionMeta = buildSessionMeta(session);
    const analysisLanguage = loadConfiguredAnalysisLanguage();
    const preparedRequest = prepareBoundedConversationRequest(client, [
      { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
      { role: 'user', content: [
        buildCacheableConversationBlock(formattedMessages),
        { type: 'text' as const, text: buildFacetOnlyInstructions(
          session.project_name,
          session.summary,
          sessionMeta,
          { preference: analysisLanguage, messages },
        ) },
      ] },
    ]);
    if (!preparedRequest) {
      return {
        success: false,
        error: 'Facet extraction request exceeds the provider context window.',
      };
    }
    const response = await client.chat(preparedRequest.messages, { signal: options?.signal });

    const jsonPayload = extractJsonPayload(response.content);
    if (!jsonPayload) {
      return { success: false, error: 'Facet extraction returned an invalid response.' };
    }

    let parsedFacets: unknown;
    try {
      parsedFacets = JSON.parse(jsonPayload);
    } catch {
      try {
        parsedFacets = JSON.parse(jsonrepair(jsonPayload));
      } catch {
        return { success: false, error: 'Facet extraction returned an invalid response.' };
      }
    }
    const facets: AnalysisResponse['facets'] | undefined = validateAnalysisFacets(parsedFacets);

    if (!facets) {
      return { success: false, error: 'Facet extraction returned an invalid response.' };
    }
    saveFacetsToDb(session.id, facets, ANALYSIS_VERSION);

    // Record analysis cost to analysis_usage table (V7).
    const llmConfig = loadLLMConfig();
    if (llmConfig && response.usage) {
      const costUsd = calculateAnalysisCost(llmConfig.provider, llmConfig.model, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheCreationTokens: response.usage.cacheCreationTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
      });
      saveAnalysisUsage({
        session_id: session.id,
        analysis_type: 'facet',
        provider: llmConfig.provider,
        model: llmConfig.model,
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        cache_creation_tokens: response.usage.cacheCreationTokens,
        cache_read_tokens: response.usage.cacheReadTokens,
        estimated_cost_usd: costUsd,
        duration_ms: Date.now() - startTime,
        chunk_count: 1,
      });
    }

    return { success: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, error: 'Cancelled' };
    }
    return {
      success: false,
      error: 'Facet extraction provider request failed.',
    };
  }
}
