/**
 * ProviderRunner — delegates analysis to the configured LLM provider
 * (OpenAI, Anthropic, Gemini, or Ollama).
 *
 * Design note: The CLI cannot import from @code-insights/server (server depends
 * on CLI — importing in the other direction would create a circular dependency).
 * All LLM providers use only Node.js built-in `fetch` on the supported Node.js
 * release lines (20.x, 22.x, or 24+), so this module
 * inlines the minimal provider dispatch that mirrors server/src/llm/client.ts.
 * If the server LLM client grows substantially (new providers, streaming, etc.),
 * that work is tracked in Issue #240.
 */

import { loadConfig } from '../utils/config.js';
import type { LLMProviderConfig } from '../types.js';
import { validateProviderBaseUrl } from '../constants/llm-providers.js';
import { guardOutboundCredentials } from '../privacy/outbound-credential-guard.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from './runner-types.js';
import {
  defaultLLMCapabilities,
  flattenContent,
  type ChatOptions,
  type LLMCapabilities,
  type LLMClient,
  type LLMMessage,
  type LLMResponse,
} from './llm-client.js';

type LLMChatFn = (messages: LLMMessage[], options?: ChatOptions) => Promise<LLMResponse>;

function providerHttpError(provider: string, status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(`${provider} request was rejected (HTTP ${status}).`);
  }
  if (status === 429) {
    return new Error(`${provider} request was rate limited (HTTP 429).`);
  }
  return new Error(`${provider} request failed (HTTP ${status}).`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseProviderJson(response: Response, provider: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`${provider} returned an invalid response.`);
  }
}

function invalidProviderResponse(provider: string): never {
  throw new Error(`${provider} returned an invalid response.`);
}

function normalizeRuntimeProviderConfig(config: LLMProviderConfig): LLMProviderConfig {
  const validation = validateProviderBaseUrl(config.provider, config.baseUrl);
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  const normalized = { ...config };
  if (validation.value === undefined) {
    delete normalized.baseUrl;
  } else {
    normalized.baseUrl = validation.value;
  }
  return normalized;
}

function replaceIsolatedSurrogates(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[i] + value[i + 1];
        i++;
      } else {
        result += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\ufffd';
    } else {
      result += value[i];
    }
  }
  return result;
}

function sanitizeMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string'
      ? replaceIsolatedSurrogates(message.content)
      : message.content.map((block) => ({
          ...block,
          text: replaceIsolatedSurrogates(block.text),
        })),
  }));
}

// ── Provider implementations ──────────────────────────────────────────────────

function makeOpenAIChat(apiKey: string, model: string): LLMChatFn {
  return async (messages, options) => {
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
          messages: messages.map((message) => ({
            role: message.role,
            content: flattenContent(message.content),
          })),
          temperature: options?.temperature ?? 0.7,
          max_tokens: 8192,
        }),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error('OpenAI request could not be completed.');
    }
    if (!response.ok) {
      throw providerHttpError('OpenAI', response.status);
    }
    const data = await parseProviderJson(response, 'OpenAI');
    if (!isRecord(data) || !Array.isArray(data.choices)) {
      invalidProviderResponse('OpenAI');
    }
    const choice = data.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') {
      invalidProviderResponse('OpenAI');
    }
    const usage = isRecord(data.usage)
      && typeof data.usage.prompt_tokens === 'number'
      && typeof data.usage.completion_tokens === 'number'
      ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
        }
      : undefined;
    return {
      content: choice.message.content,
      usage: usage
        ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
        : undefined,
    };
  };
}

function makeAnthropicChat(apiKey: string, model: string, baseUrl?: string): LLMChatFn {
  // baseUrl allows Anthropic-compatible endpoints (e.g. Zhipu BigModel's /api/anthropic).
  // Defaults to the official Anthropic API when unset.
  const base = (baseUrl || 'https://api.anthropic.com').trim().replace(/\/$/, '');
  return async (messages, options) => {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    let response: Response;
    try {
      response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        signal: options?.signal,
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          ...(options?.temperature !== undefined && { temperature: options.temperature }),
          system: systemMsg?.content,
          messages: chatMsgs.map(m => ({ role: m.role, content: m.content })),
        }),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error('Anthropic request could not be completed.');
    }
    if (!response.ok) {
      throw providerHttpError('Anthropic', response.status);
    }
    const data = await parseProviderJson(response, 'Anthropic');
    if (!isRecord(data) || !Array.isArray(data.content)) {
      invalidProviderResponse('Anthropic');
    }
    const firstContent = data.content[0];
    if (!isRecord(firstContent) || typeof firstContent.text !== 'string') {
      invalidProviderResponse('Anthropic');
    }
    const usage = isRecord(data.usage)
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
  };
}

function makeGeminiChat(apiKey: string, model: string): LLMChatFn {
  return async (messages, options) => {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const body: Record<string, unknown> = {
      contents: chatMsgs.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: flattenContent(m.content) }],
      })),
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: 8192,
        ...(options?.responseFormat !== 'text' && { responseMimeType: 'application/json' }),
      },
    };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: flattenContent(systemMsg.content) }] };
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
      if (isAbortError(error)) throw error;
      throw new Error('Gemini request could not be completed.');
    }
    if (!response.ok) {
      throw providerHttpError('Gemini', response.status);
    }
    const data = await parseProviderJson(response, 'Gemini');
    if (!isRecord(data) || !Array.isArray(data.candidates)) {
      invalidProviderResponse('Gemini');
    }
    const candidate = data.candidates[0];
    const content = isRecord(candidate) ? candidate.content : undefined;
    const parts = isRecord(content) ? content.parts : undefined;
    const firstPart = Array.isArray(parts) ? parts[0] : undefined;
    if (!isRecord(firstPart) || typeof firstPart.text !== 'string') {
      invalidProviderResponse('Gemini');
    }
    const usage = isRecord(data.usageMetadata)
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
  };
}

function makeOllamaChat(model: string, baseUrl?: string): LLMChatFn {
  const url = (baseUrl || 'http://localhost:11434').trim().replace(/\/$/, '');
  return async (messages, options) => {
    let response: Response;
    try {
      response = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options?.signal,
        body: JSON.stringify({
          model,
          messages: messages.map((message) => ({
            role: message.role,
            content: flattenContent(message.content),
          })),
          stream: false,
          options: { temperature: options?.temperature ?? 0.7 },
        }),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error('Cannot connect to the configured Ollama endpoint.');
    }
    if (!response.ok) {
      throw providerHttpError('Ollama', response.status);
    }
    const data = await parseProviderJson(response, 'Ollama');
    if (!isRecord(data) || !isRecord(data.message) || typeof data.message.content !== 'string') {
      invalidProviderResponse('Ollama');
    }
    return {
      content: data.message.content,
      usage: {
        inputTokens: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : 0,
        outputTokens: typeof data.eval_count === 'number' ? data.eval_count : 0,
      },
    };
  };
}

function makeLlamaCppChat(model: string, baseUrl?: string): LLMChatFn {
  // Use 0.3 temperature — small quantized models produce more consistent structured JSON
  // output at lower temperatures (LLM Expert requirement).
  const url = (baseUrl || 'http://localhost:8080').trim().replace(/\/$/, '');
  return async (messages, options) => {
    let response: Response;
    try {
      response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options?.signal,
        body: JSON.stringify({
          model,
          messages: messages.map((message) => ({
            role: message.role,
            content: flattenContent(message.content),
          })),
          temperature: options?.temperature ?? 0.3,
          max_tokens: 4096,
          ...(options?.responseFormat !== 'text' && {
            response_format: { type: 'json_object' },
          }),
        }),
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const cause = (err as { cause?: { code?: string } })?.cause;
      if (cause?.code === 'ECONNREFUSED' || (err instanceof TypeError && (err as TypeError).message.includes('fetch'))) {
        throw new Error('Cannot connect to the configured llama-server endpoint.');
      }
      throw new Error('llama-server request could not be completed.');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Detect exceed_context_size_error: mirrors server/src/llm/providers/llamacpp.ts detection.
      if (response.status >= 400) {
        let errorBody: { error?: { type?: string; n_prompt_tokens?: number; n_ctx?: number } } = {};
        try { errorBody = JSON.parse(detail); } catch { /* not JSON */ }
        if (errorBody?.error?.type === 'exceed_context_size_error') {
          throw new Error('Session exceeds the configured llama-server context window.');
        }
      }
      throw providerHttpError('llama-server', response.status);
    }
    const data = await parseProviderJson(response, 'llama-server');
    if (!isRecord(data) || !Array.isArray(data.choices)) {
      invalidProviderResponse('llama-server');
    }
    const choice = data.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') {
      invalidProviderResponse('llama-server');
    }
    const usage = isRecord(data.usage)
      && typeof data.usage.prompt_tokens === 'number'
      && typeof data.usage.completion_tokens === 'number'
      ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
        }
      : undefined;
    return {
      content: choice.message.content,
      usage: usage
        ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
        : undefined,
    };
  };
}

function makeChatFn(config: LLMProviderConfig): LLMChatFn {
  switch (config.provider) {
    case 'openai':    return makeOpenAIChat(config.apiKey ?? '', config.model);
    case 'anthropic': return makeAnthropicChat(config.apiKey ?? '', config.model, config.baseUrl);
    case 'gemini':    return makeGeminiChat(config.apiKey ?? '', config.model);
    case 'ollama':    return makeOllamaChat(config.model, config.baseUrl);
    case 'llamacpp':  return makeLlamaCppChat(config.model, config.baseUrl);
    default:          throw new Error(`Unknown LLM provider: ${(config as LLMProviderConfig).provider}`);
  }
}

// ── ProviderRunner ────────────────────────────────────────────────────────────

export class ProviderRunner implements AnalysisRunner, LLMClient {
  readonly name: string;
  readonly model: string;
  readonly provider: string;
  readonly capabilities: LLMCapabilities;
  private readonly transport: LLMChatFn;
  private readonly _knownSecrets: string[];

  constructor(config: LLMProviderConfig) {
    const normalizedConfig = normalizeRuntimeProviderConfig(config);
    this.name = normalizedConfig.provider;
    this.model = normalizedConfig.model;
    this.provider = normalizedConfig.provider;
    this.capabilities = defaultLLMCapabilities(normalizedConfig.provider);
    this._knownSecrets = normalizedConfig.apiKey ? [normalizedConfig.apiKey] : [];
    this.transport = makeChatFn(normalizedConfig);
  }

  /**
   * Create a ProviderRunner from the current CLI config.
   * Throws if LLM is not configured.
   */
  static fromConfig(): ProviderRunner {
    const config = loadConfig();
    const llm = config?.dashboard?.llm;
    if (!llm) {
      throw new Error('LLM not configured. Run `code-insights config llm` to configure a provider.');
    }
    // Local providers (ollama, llamacpp) do not require an API key
    if (llm.provider !== 'ollama' && llm.provider !== 'llamacpp' && !llm.apiKey) {
      throw new Error(
        `LLM provider '${llm.provider}' requires an API key. Run \`code-insights config llm\` to set it.`
      );
    }
    return new ProviderRunner(llm);
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / (this.provider === 'llamacpp' ? 3 : 4));
  }

  prepareMessages(messages: LLMMessage[]): LLMMessage[] {
    const sanitized = sanitizeMessages(messages);
    const guarded = guardOutboundCredentials(sanitized, {
      provider: this.provider,
      knownSecrets: this._knownSecrets,
    });
    return guarded.messages;
  }

  async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
    return this.transport(this.prepareMessages(messages), options);
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();

    const messages: LLMMessage[] = [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ];

    const response = await this.chat(messages);

    return {
      rawJson: response.content,
      durationMs: Date.now() - start,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      ...(response.usage?.cacheCreationTokens !== undefined && {
        cacheCreationTokens: response.usage.cacheCreationTokens,
      }),
      ...(response.usage?.cacheReadTokens !== undefined && {
        cacheReadTokens: response.usage.cacheReadTokens,
      }),
      model: this.model,
      provider: this.provider,
    };
  }
}
