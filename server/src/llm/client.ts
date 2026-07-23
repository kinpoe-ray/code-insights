// LLM client factory — server-side.
// Config is loaded from ~/.code-insights/config.json via the CLI config system.
// No localStorage or browser APIs used here.

import { loadConfig } from '@code-insights/cli/utils/config';
import { guardOutboundCredentials } from '@code-insights/cli/privacy/outbound-credential-guard';
import { validateProviderBaseUrl } from '@code-insights/cli/constants/llm-providers';
import type { LLMClient } from './types.js';
import type { LLMProviderConfig } from './types.js';
import { createOpenAIClient } from './providers/openai.js';
import { createAnthropicClient } from './providers/anthropic.js';
import { createGeminiClient } from './providers/gemini.js';
import { createOllamaClient } from './providers/ollama.js';
import { createLlamaCppClient } from './providers/llamacpp.js';

/**
 * Load LLM config from the CLI config file.
 */
export function loadLLMConfig(): LLMProviderConfig | null {
  const config = loadConfig();
  return config?.dashboard?.llm ?? null;
}

/**
 * Check if LLM is configured.
 */
export function isLLMConfigured(): boolean {
  const llm = loadLLMConfig();
  if (!llm) return false;
  // Local providers: no API key required — configured if a model is set
  if (llm.provider === 'ollama' || llm.provider === 'llamacpp') return !!llm.model;
  return !!llm.apiKey && !!llm.model;
}

/**
 * Create an LLM client from the current config.
 * Throws if LLM is not configured.
 */
export function createLLMClient(): LLMClient {
  const config = loadLLMConfig();
  if (!config) {
    throw new Error('LLM not configured. Run `code-insights config llm` to configure a provider.');
  }
  return createClientFromConfig(config);
}

/**
 * Create an LLM client from a specific config object (used for testing).
 */
export function createClientFromConfig(config: LLMProviderConfig): LLMClient {
  const baseUrlValidation = validateProviderBaseUrl(config.provider, config.baseUrl);
  if (!baseUrlValidation.ok) {
    throw new Error(baseUrlValidation.message);
  }
  const normalizedConfig = { ...config };
  if (baseUrlValidation.value === undefined) {
    delete normalizedConfig.baseUrl;
  } else {
    normalizedConfig.baseUrl = baseUrlValidation.value;
  }

  let adapter: LLMClient;
  switch (normalizedConfig.provider) {
    case 'openai':
      adapter = createOpenAIClient(normalizedConfig.apiKey ?? '', normalizedConfig.model);
      break;
    case 'anthropic':
      adapter = createAnthropicClient(
        normalizedConfig.apiKey ?? '',
        normalizedConfig.model,
        normalizedConfig.baseUrl,
      );
      break;
    case 'gemini':
      adapter = createGeminiClient(normalizedConfig.apiKey ?? '', normalizedConfig.model);
      break;
    case 'ollama':
      adapter = createOllamaClient(normalizedConfig.model, normalizedConfig.baseUrl);
      break;
    case 'llamacpp':
      adapter = createLlamaCppClient(normalizedConfig.model, normalizedConfig.baseUrl);
      break;
    default:
      throw new Error('Unknown LLM provider.');
  }

  const knownSecrets = normalizedConfig.apiKey ? [normalizedConfig.apiKey] : [];
  return {
    provider: adapter.provider,
    model: adapter.model,
    capabilities: adapter.capabilities,
    prepareMessages(messages) {
      const guarded = guardOutboundCredentials(messages, {
        provider: normalizedConfig.provider,
        knownSecrets,
      });
      return guarded.messages;
    },
    estimateTokens(text: string): number {
      return adapter.estimateTokens(text);
    },
    async chat(messages, options) {
      return adapter.chat(this.prepareMessages(messages), options);
    },
  };
}

/**
 * Test LLM connectivity with the given config.
 */
export async function testLLMConfig(config: LLMProviderConfig): Promise<{ success: boolean; error?: string }> {
  try {
    const client = createClientFromConfig(config);
    await client.chat([{ role: 'user', content: 'Respond with exactly this JSON and nothing else: {"status":"ok"}' }]);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
