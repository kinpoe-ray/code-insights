// LLM provider metadata: model lists, pricing, API key links.
// This is a runtime constant, not a type — kept here to avoid inflating types.ts.
// Types (LLMProvider, ProviderInfo, etc.) live in cli/src/types.ts.

import type { ProviderInfo } from '../types.js';

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    supportsCustomBaseUrl: false,
    apiKeyLink: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Most capable', inputCostPer1M: 2.5, outputCostPer1M: 10 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast & cheap', inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: '128k context', inputCostPer1M: 10, outputCostPer1M: 30 },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    apiKeyLink: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Best balance', inputCostPer1M: 3, outputCostPer1M: 15 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', description: 'Fast & cheap', inputCostPer1M: 0.80, outputCostPer1M: 4 },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', description: 'Most capable', inputCostPer1M: 15, outputCostPer1M: 75 },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    requiresApiKey: true,
    supportsCustomBaseUrl: false,
    apiKeyLink: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Fast & capable', inputCostPer1M: 0.1, outputCostPer1M: 0.4 },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: '2M context', inputCostPer1M: 1.25, outputCostPer1M: 5 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', description: 'Fast', inputCostPer1M: 0.075, outputCostPer1M: 0.3 },
      { id: 'gemma-3-27b-it', name: 'Gemma 4 27B IT', description: 'Local via Gemini API', inputCostPer1M: 0, outputCostPer1M: 0 },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    requiresApiKey: false,
    supportsCustomBaseUrl: true,
    models: [
      { id: 'llama3.3', name: 'Llama 3.3', description: 'Local, free' },
      { id: 'qwen3:14b', name: 'Qwen3 14B', description: 'Code-focused, free' },
      { id: 'mistral', name: 'Mistral', description: 'Local, free' },
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', description: 'Code-focused, free' },
      { id: 'gemma4', name: 'Gemma 4 12B', description: 'Google Gemma 4, free' },
      { id: 'gemma4:27b', name: 'Gemma 4 27B', description: 'Google Gemma 4 large, free' },
    ],
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp (Local)',
    requiresApiKey: false,
    supportsCustomBaseUrl: true,
    models: [
      { id: 'gemma-4-12b', name: 'Gemma 4 12B (Q4_K_M)', description: 'Flagship local model, free' },
      { id: 'gemma-4-27b', name: 'Gemma 4 27B (Q4_K_M)', description: 'Large local model, free' },
      { id: 'custom', name: 'Custom model', description: 'Any GGUF model loaded in llama-server' },
    ],
  },
];

export function getProviderInfo(providerId: string): ProviderInfo | undefined {
  return PROVIDERS.find(p => p.id === providerId);
}

export function getDefaultModel(providerId: string): string | undefined {
  return getProviderInfo(providerId)?.models[0]?.id;
}

export type ProviderBaseUrlErrorCode =
  | 'BASE_URL_UNSUPPORTED'
  | 'BASE_URL_INVALID'
  | 'BASE_URL_PROTOCOL_INVALID'
  | 'BASE_URL_CREDENTIALS_FORBIDDEN'
  | 'BASE_URL_HTTPS_REQUIRED';

export type ProviderBaseUrlValidation =
  | { ok: true; value: string | undefined }
  | { ok: false; code: ProviderBaseUrlErrorCode; message: string };

/**
 * Validate and normalize a provider's optional custom endpoint.
 *
 * This is the single outbound endpoint policy shared by CLI and Server config
 * entry points. Error messages never include the submitted value.
 */
export function validateProviderBaseUrl(
  providerId: string,
  baseUrl: unknown,
): ProviderBaseUrlValidation {
  if (baseUrl === undefined || baseUrl === null) {
    return { ok: true, value: undefined };
  }
  if (typeof baseUrl === 'string' && baseUrl.trim() === '') {
    return { ok: true, value: undefined };
  }
  const provider = getProviderInfo(providerId);
  if (provider && !provider.supportsCustomBaseUrl) {
    return {
      ok: false,
      code: 'BASE_URL_UNSUPPORTED',
      message: `${provider.name} does not support a custom base URL.`,
    };
  }
  if (typeof baseUrl !== 'string') {
    return {
      ok: false,
      code: 'BASE_URL_INVALID',
      message: 'Base URL must be a valid HTTP or HTTPS URL.',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return {
      ok: false,
      code: 'BASE_URL_INVALID',
      message: 'Base URL must be a valid HTTP or HTTPS URL.',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'BASE_URL_PROTOCOL_INVALID',
      message: 'Base URL must use the HTTP or HTTPS protocol.',
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: 'BASE_URL_CREDENTIALS_FORBIDDEN',
      message: 'Base URL must not include a username or password.',
    };
  }
  const isLocalHost = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1';
  if (providerId === 'anthropic' && parsed.protocol === 'http:' && !isLocalHost) {
    return {
      ok: false,
      code: 'BASE_URL_HTTPS_REQUIRED',
      message: 'Anthropic base URL must use HTTPS unless it targets the local machine.',
    };
  }
  return { ok: true, value: baseUrl.trim() };
}
