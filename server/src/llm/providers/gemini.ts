// Gemini provider implementation (server-side, no browser dependencies)

import type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '../types.js';
import { defaultLLMCapabilities, flattenContent } from '../types.js';
import {
  invalidProviderResponse,
  isProviderRecord,
  parseProviderJson,
} from './provider-response.js';

export function createGeminiClient(apiKey: string, model: string): LLMClient {
  return {
    provider: 'gemini',
    model,
    capabilities: defaultLLMCapabilities('gemini'),
    prepareMessages: (messages) => messages,

    async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages.filter(m => m.role !== 'system');

      const contents = chatMessages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        // flattenContent converts ContentBlock[] to string; strings pass through unchanged.
        parts: [{ text: flattenContent(m.content) }],
      }));

      const generationConfig: Record<string, unknown> = {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: 8192,
      };

      // JSON mode is the default for analysis calls (prevents markdown fences and prose prefixes).
      // Dispatch and other text callers pass responseFormat: 'text' to get plain markdown output.
      if (options?.responseFormat !== 'text') {
        generationConfig.responseMimeType = 'application/json';
      }

      const body: Record<string, unknown> = {
        contents,
        generationConfig,
      };

      if (systemMessage) {
        body.systemInstruction = {
          // flattenContent handles string | ContentBlock[] system messages.
          parts: [{ text: flattenContent(systemMessage.content) }],
        };
      }

      let response: Response;
      try {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          signal: options?.signal,
          body: JSON.stringify(body),
          },
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error('Gemini request could not be completed.');
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Gemini request was rejected (HTTP ${response.status}).`);
        }
        if (response.status === 429) {
          throw new Error('Gemini request was rate limited (HTTP 429).');
        }
        throw new Error(`Gemini request failed (HTTP ${response.status}).`);
      }

      const data = await parseProviderJson(response, 'Gemini');
      if (!isProviderRecord(data) || !Array.isArray(data.candidates)) {
        invalidProviderResponse('Gemini');
      }
      const candidate = data.candidates[0];
      const content = isProviderRecord(candidate) ? candidate.content : undefined;
      const parts = isProviderRecord(content) ? content.parts : undefined;
      const firstPart = Array.isArray(parts) ? parts[0] : undefined;
      if (!isProviderRecord(firstPart) || typeof firstPart.text !== 'string') {
        invalidProviderResponse('Gemini');
      }
      const usage = isProviderRecord(data.usageMetadata)
        && typeof data.usageMetadata.promptTokenCount === 'number'
        && typeof data.usageMetadata.candidatesTokenCount === 'number'
        ? {
            promptTokenCount: data.usageMetadata.promptTokenCount,
            candidatesTokenCount: data.usageMetadata.candidatesTokenCount,
          }
        : undefined;

      return {
        content: firstPart.text,
        usage: usage ? {
          inputTokens: usage.promptTokenCount,
          outputTokens: usage.candidatesTokenCount,
        } : undefined,
      };
    },

    estimateTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },
  };
}
