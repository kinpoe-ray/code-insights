// llama.cpp provider implementation (local models via llama-server, no API key required)
//
// Targets the OpenAI-compatible HTTP API exposed by llama-server:
//   POST /v1/chat/completions — chat completions
//   GET  /v1/models           — list loaded model(s)
//
// Temperature: 0.3 (lower than default 0.7 — small quantized models produce more
// consistent structured JSON output at lower temperatures per LLM Expert guidance)

import type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '../types.js';
import { defaultLLMCapabilities, flattenContent } from '../types.js';
import {
  invalidProviderResponse,
  isProviderRecord,
  parseProviderJson,
} from './provider-response.js';

const DEFAULT_LLAMACPP_URL = 'http://localhost:8080';

/** Strip <json>...</json> wrapper that some models emit despite response_format: json_object. */
function stripJsonTags(content: string): string {
  const match = content.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  return match?.[1]?.trim() ?? content;
}

// Default timeout for chat requests (10 minutes).
// Local inference with quantized models on CPU can be very slow — a 2000-token response
// at 10 tok/s takes ~3.5 minutes. Allow generous headroom for large sessions and slow hardware.
const DEFAULT_CHAT_TIMEOUT_MS = 600_000;

export function createLlamaCppClient(model: string, baseUrl?: string): LLMClient {
  const url = (baseUrl || DEFAULT_LLAMACPP_URL).trim().replace(/\/$/, '');

  return {
    provider: 'llamacpp',
    model,
    capabilities: defaultLLMCapabilities('llamacpp'),
    prepareMessages: (messages) => messages,

    async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
      // Inner helper — performs a single attempt at the llama-server completions endpoint.
      // Returns the raw content string so the caller can retry on parse failure if needed.
      const attempt = async (): Promise<{ content: string; inputTokens: number; outputTokens: number }> => {
        // Use caller-provided signal, or fall back to a default timeout to prevent indefinite hangs
        // when llama-server accepts the connection but stalls (model loading, GPU memory pressure).
        const signal = options?.signal ?? AbortSignal.timeout(DEFAULT_CHAT_TIMEOUT_MS);

        let res: Response;
        try {
          res = await fetch(`${url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
              model,
              // flattenContent converts ContentBlock[] to string; strings pass through unchanged.
              messages: messages.map(m => ({ role: m.role, content: flattenContent(m.content) })),
              temperature: options?.temperature ?? 0.3,
              max_tokens: 4096,
              // Grammar-constrained JSON output — only when caller expects JSON.
              // Text-format callers (e.g. Dispatch) return markdown/YAML, not JSON.
              ...(options?.responseFormat !== 'text' && { response_format: { type: 'json_object' } }),
            }),
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          // Network-level failure — llama-server is likely not running
          const cause = (err as { cause?: { code?: string } })?.cause;
          if (cause?.code === 'ECONNREFUSED' || (err instanceof TypeError && err.message.includes('fetch'))) {
            throw new Error('Cannot connect to the configured llama-server endpoint.');
          }
          throw new Error('llama-server request could not be completed.');
        }

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          if (res.status === 401 || res.status === 403) {
            throw new Error(`llama-server request was rejected (HTTP ${res.status}).`);
          }
          // Detect exceed_context_size_error: llama-server returns this when the request's
          // prompt + max_tokens exceeds the server's context window (-c flag at startup).
          if (res.status >= 400) {
            let errorBody: { error?: { type?: string; n_prompt_tokens?: number; n_ctx?: number } } = {};
            try { errorBody = JSON.parse(detail); } catch { /* not JSON */ }
            if (errorBody?.error?.type === 'exceed_context_size_error') {
              throw new Error('Session exceeds the configured llama-server context window.');
            }
          }
          if (res.status === 429) {
            throw new Error('llama-server request was rate limited (HTTP 429).');
          }
          throw new Error(`llama-server request failed (HTTP ${res.status}).`);
        }

        const data = await parseProviderJson(res, 'llama-server');
        if (!isProviderRecord(data) || !Array.isArray(data.choices)) {
          invalidProviderResponse('llama-server');
        }
        const choice = data.choices[0];
        if (
          !isProviderRecord(choice)
          || !isProviderRecord(choice.message)
          || typeof choice.message.content !== 'string'
        ) {
          invalidProviderResponse('llama-server');
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
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
        };
      };

      // Text-format callers (e.g. Dispatch) return markdown/YAML — skip JSON validation entirely.
      if (options?.responseFormat === 'text') {
        const result = await attempt();
        return {
          content: result.content,
          usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        };
      }

      // Perform the chat call with a single retry on JSON parse failure.
      // Small quantized models occasionally emit malformed JSON even with response_format: json_object.
      // One retry is enough to recover from transient formatting errors without burning tokens on
      // genuine capability failures (which would fail again anyway).
      const first = await attempt();

      // Strip <json>...</json> wrapper if present — some models follow the system prompt instruction
      // to wrap output in <json> tags even when response_format: json_object is set.
      const stripped = stripJsonTags(first.content);

      // Validate JSON structure — if content is not parseable, try once more.
      let jsonValid = false;
      try {
        JSON.parse(stripped);
        jsonValid = true;
      } catch {
        // not valid JSON
      }

      if (!jsonValid) {
        // Single retry on JSON parse failure (LLM Expert requirement).
        // Validate the retry result too — if both attempts fail, surface the error
        // instead of silently returning malformed content.
        const retry = await attempt();
        const retryStripped = stripJsonTags(retry.content);
        let retryValid = false;
        try {
          JSON.parse(retryStripped);
          retryValid = true;
        } catch {
          // still not valid JSON
        }

        if (!retryValid) {
          throw new Error('llama-server returned invalid JSON on both attempts.');
        }

        return {
          content: retryStripped,
          usage: {
            inputTokens: first.inputTokens + retry.inputTokens,
            outputTokens: first.outputTokens + retry.outputTokens,
          },
        };
      }

      return {
        content: stripped,
        usage: {
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
        },
      };

    },

    estimateTokens(text: string): number {
      // More conservative approximation: 3 chars per token.
      // chars/4 underestimates for code-heavy or multilingual content, which triggers
      // chunking too late and can still exceed the context window. chars/3 errs on the
      // side of earlier chunking, which is safer for quantized local models.
      return Math.ceil(text.length / 3);
    },
  };
}

/**
 * Discover models loaded in a running llama-server instance by querying GET /v1/models.
 * Returns empty array if llama-server is not running or unreachable.
 */
export async function discoverLlamaCppModels(
  baseUrl?: string
): Promise<Array<{ id: string; object: string }>> {
  const url = (baseUrl || DEFAULT_LLAMACPP_URL).trim().replace(/\/$/, '');
  try {
    const response = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = await response.json() as { data?: Array<{ id: string; object: string }> };
    return data.data || [];
  } catch {
    return [];
  }
}
