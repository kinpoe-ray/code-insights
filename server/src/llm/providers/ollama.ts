// Ollama provider implementation (local models, no API key required)

import type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '../types.js';
import { defaultLLMCapabilities, flattenContent } from '../types.js';
import {
  invalidProviderResponse,
  isProviderRecord,
  parseProviderJson,
} from './provider-response.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export function createOllamaClient(model: string, baseUrl?: string): LLMClient {
  const url = (baseUrl || DEFAULT_OLLAMA_URL).trim().replace(/\/$/, '');

  return {
    provider: 'ollama',
    model,
    capabilities: defaultLLMCapabilities('ollama'),
    prepareMessages: (messages) => messages,

    async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
      let response: Response;
      try {
        response = await fetch(`${url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: options?.signal,
          body: JSON.stringify({
            model,
            // flattenContent converts ContentBlock[] to string; strings pass through unchanged.
            messages: messages.map(m => ({ role: m.role, content: flattenContent(m.content) })),
            stream: false,
            options: { temperature: options?.temperature ?? 0.7 },
          }),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        // Network-level failure — Ollama is likely not running.
        // On macOS/Linux, Node's undici surfaces ECONNREFUSED via err.cause.code.
        // On Windows, undici may wrap it in an AggregateError, making cause.code undefined —
        // the TypeError fallback ('fetch failed') handles that case.
        const cause = (err as { cause?: { code?: string } })?.cause;
        if (cause?.code === 'ECONNREFUSED' || (err instanceof TypeError && err.message.includes('fetch'))) {
          throw new Error('Cannot connect to the configured Ollama endpoint.');
        }
        throw new Error('Ollama request could not be completed.');
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Ollama request was rejected (HTTP ${response.status}).`);
        }
        if (response.status === 429) {
          throw new Error('Ollama request was rate limited (HTTP 429).');
        }
        throw new Error(`Ollama request failed (HTTP ${response.status}).`);
      }

      const data = await parseProviderJson(response, 'Ollama');
      if (
        !isProviderRecord(data)
        || !isProviderRecord(data.message)
        || typeof data.message.content !== 'string'
      ) {
        invalidProviderResponse('Ollama');
      }

      return {
        content: data.message.content,
        usage: {
          inputTokens: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : 0,
          outputTokens: typeof data.eval_count === 'number' ? data.eval_count : 0,
        },
      };
    },

    estimateTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },
  };
}

/**
 * Discover installed Ollama models by querying the local API.
 * Returns empty array if Ollama is not running or unreachable.
 */
export async function discoverOllamaModels(
  baseUrl?: string
): Promise<Array<{ name: string; size: number; modifiedAt: string }>> {
  const url = (baseUrl || DEFAULT_OLLAMA_URL).trim().replace(/\/$/, '');
  try {
    const response = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = await response.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
    return (data.models || []).map(m => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
    }));
  } catch {
    return [];
  }
}
