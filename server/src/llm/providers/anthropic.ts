// Anthropic provider implementation (server-side, no browser dependencies)
// Note: 'anthropic-dangerous-direct-browser-access' header is intentionally omitted here —
// this runs server-side where direct API access is safe and expected.

import type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '../types.js';
import { defaultLLMCapabilities } from '../types.js';
import {
  invalidProviderResponse,
  isProviderRecord,
  parseProviderJson,
} from './provider-response.js';

export function createAnthropicClient(apiKey: string, model: string, baseUrl?: string): LLMClient {
  // baseUrl allows Anthropic-compatible endpoints (e.g. Zhipu BigModel's /api/anthropic).
  // Defaults to the official Anthropic API when unset.
  const base = (baseUrl || 'https://api.anthropic.com').trim().replace(/\/$/, '');
  return {
    provider: 'anthropic',
    model,
    capabilities: defaultLLMCapabilities('anthropic'),
    prepareMessages: (messages) => messages,

    async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
      // Extract system message if present
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages.filter(m => m.role !== 'system');

      let response: Response;
      try {
        response = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            // Enable prompt caching (ephemeral cache, 5-minute TTL).
            // This header is required for cache_control blocks to take effect.
            'anthropic-beta': 'prompt-caching-2024-07-31',
          },
          signal: options?.signal,
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            ...(options?.temperature !== undefined && { temperature: options.temperature }),
            // System message: pass ContentBlock[] through natively, or string as-is.
            system: systemMessage?.content,
            // Chat messages: pass ContentBlock[] content arrays natively (Anthropic supports this).
            // String content passes through unchanged for backward compatibility.
            messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
          }),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error('Anthropic request could not be completed.');
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Anthropic request was rejected (HTTP ${response.status}).`);
        }
        if (response.status === 429) {
          throw new Error('Anthropic request was rate limited (HTTP 429).');
        }
        throw new Error(`Anthropic request failed (HTTP ${response.status}).`);
      }

      const data = await parseProviderJson(response, 'Anthropic');
      if (!isProviderRecord(data) || !Array.isArray(data.content)) {
        invalidProviderResponse('Anthropic');
      }
      const firstContent = data.content[0];
      if (!isProviderRecord(firstContent) || typeof firstContent.text !== 'string') {
        invalidProviderResponse('Anthropic');
      }
      const usage = isProviderRecord(data.usage)
        && typeof data.usage.input_tokens === 'number'
        && typeof data.usage.output_tokens === 'number'
        ? {
            input_tokens: data.usage.input_tokens,
            output_tokens: data.usage.output_tokens,
            cache_creation_input_tokens: data.usage.cache_creation_input_tokens,
            cache_read_input_tokens: data.usage.cache_read_input_tokens,
          }
        : undefined;

      return {
        content: firstContent.text,
        usage: usage ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          ...(typeof usage.cache_creation_input_tokens === 'number' && {
            cacheCreationTokens: usage.cache_creation_input_tokens,
          }),
          ...(typeof usage.cache_read_input_tokens === 'number' && {
            cacheReadTokens: usage.cache_read_input_tokens,
          }),
        } : undefined,
      };
    },

    estimateTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },
  };
}
