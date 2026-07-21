// OpenAI provider implementation (server-side, no browser dependencies)

import type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '../types.js';
import { defaultLLMCapabilities, flattenContent } from '../types.js';
import {
  invalidProviderResponse,
  isProviderRecord,
  parseProviderJson,
} from './provider-response.js';

export function createOpenAIClient(apiKey: string, model: string): LLMClient {
  return {
    provider: 'openai',
    model,
    capabilities: defaultLLMCapabilities('openai'),
    prepareMessages: (messages) => messages,

    async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
      let response: Response;
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          signal: options?.signal,
          body: JSON.stringify({
            model,
            // flattenContent converts ContentBlock[] to string; strings pass through unchanged.
            // OpenAI gets automatic prefix caching for free when prefixes match — no extra config needed.
            messages: messages.map(m => ({ role: m.role, content: flattenContent(m.content) })),
            temperature: options?.temperature ?? 0.7,
            max_tokens: 8192,
          }),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error('OpenAI request could not be completed.');
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`OpenAI request was rejected (HTTP ${response.status}).`);
        }
        if (response.status === 429) {
          throw new Error('OpenAI request was rate limited (HTTP 429).');
        }
        throw new Error(`OpenAI request failed (HTTP ${response.status}).`);
      }

      const data = await parseProviderJson(response, 'OpenAI');
      if (!isProviderRecord(data) || !Array.isArray(data.choices)) {
        invalidProviderResponse('OpenAI');
      }
      const choice = data.choices[0];
      if (
        !isProviderRecord(choice)
        || !isProviderRecord(choice.message)
        || typeof choice.message.content !== 'string'
      ) {
        invalidProviderResponse('OpenAI');
      }
      const usage = isProviderRecord(data.usage)
        && typeof data.usage.prompt_tokens === 'number'
        && typeof data.usage.completion_tokens === 'number'
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
          }
        : undefined;

      return {
        content: choice.message.content,
        usage: usage ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        } : undefined,
      };
    },

    estimateTokens(text: string): number {
      // Rough estimate: ~4 characters per token for English
      return Math.ceil(text.length / 4);
    },
  };
}
