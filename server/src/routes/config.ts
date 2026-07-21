import { Hono } from 'hono';
import {
  PROVIDERS,
  validateProviderBaseUrl,
} from '@code-insights/cli/constants/llm-providers';
import { loadConfig, saveConfig } from '@code-insights/cli/utils/config';
import type { ClaudeInsightConfig, LLMProviderConfig } from '@code-insights/cli/types';
import { loadLLMConfig, testLLMConfig } from '../llm/client.js';
import { llmBusyPayload, runWithLlmLock } from '../llm/llm-lock.js';
import { discoverOllamaModels } from '../llm/providers/ollama.js';
import { discoverLlamaCppModels } from '../llm/providers/llamacpp.js';

const app = new Hono();

const VALID_PROVIDERS = PROVIDERS.map((provider) => provider.id);

function maskApiKey(key: string | undefined): string | undefined {
  if (!key || key.length < 8) return key ? '***' : undefined;
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// GET /api/config/llm — return full config (API key masked)
app.get('/llm', (c) => {
  const config = loadConfig();
  const llm = config?.dashboard?.llm;

  return c.json({
    dashboardPort: config?.dashboard?.port ?? 7890,
    provider: llm?.provider,
    model: llm?.model,
    apiKey: maskApiKey(llm?.apiKey),
    baseUrl: PROVIDERS.find((provider) => provider.id === llm?.provider)?.supportsCustomBaseUrl
      ? llm?.baseUrl
      : undefined,
    providers: PROVIDERS.map(({ id, supportsCustomBaseUrl }) => ({
      id,
      supportsCustomBaseUrl,
    })),
  });
});

// PUT /api/config/llm — update dashboard port and/or LLM config
app.put('/llm', async (c) => {
  const body = await c.req.json<{
    dashboardPort?: number;
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: unknown;
  }>();

  const config: ClaudeInsightConfig = loadConfig() ?? {
    sync: { claudeDir: '', excludeProjects: [] },
  };

  let changed = false;

  // Update dashboard port if provided
  if (body.dashboardPort !== undefined) {
    const port = body.dashboardPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: 'dashboardPort must be an integer between 1 and 65535' }, 400);
    }
    config.dashboard = { ...config.dashboard, port };
    changed = true;
  }

  // Update LLM config if any LLM field is provided
  const hasLLMField = body.provider !== undefined || body.model !== undefined ||
    body.apiKey !== undefined || body.baseUrl !== undefined;

  if (hasLLMField) {
    if (body.provider !== undefined && !VALID_PROVIDERS.includes(body.provider as LLMProviderConfig['provider'])) {
      return c.json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` }, 400);
    }

    const existingLlm = config.dashboard?.llm ?? {} as Partial<LLMProviderConfig>;
    const provider = (body.provider as LLMProviderConfig['provider'])
      ?? existingLlm.provider
      ?? 'ollama';
    const providerInfo = PROVIDERS.find((candidate) => candidate.id === provider);
    const preserveExistingBaseUrl = existingLlm.provider === provider
      && providerInfo?.supportsCustomBaseUrl;
    const baseUrlCandidate = body.baseUrl !== undefined
      ? body.baseUrl
      : preserveExistingBaseUrl
        ? existingLlm.baseUrl
        : undefined;
    const baseUrlValidation = validateProviderBaseUrl(provider, baseUrlCandidate);
    if (!baseUrlValidation.ok) {
      return c.json({
        error: baseUrlValidation.message,
        code: baseUrlValidation.code,
      }, 400);
    }

    const updatedLlm: LLMProviderConfig = {
      provider,
      model: body.model ?? existingLlm.model ?? '',
      // Preserve existing API key if not provided in update
      ...(body.apiKey !== undefined
        ? { apiKey: body.apiKey || undefined }
        : existingLlm.apiKey !== undefined ? { apiKey: existingLlm.apiKey } : {}),
      ...(baseUrlValidation.value !== undefined
        ? { baseUrl: baseUrlValidation.value }
        : {}),
    };

    if (!updatedLlm.model) {
      return c.json({ error: 'model is required when setting LLM config' }, 400);
    }

    config.dashboard = { ...config.dashboard, llm: updatedLlm };
    changed = true;
  }

  if (!changed) {
    return c.json({ ok: true });
  }

  saveConfig(config);
  return c.json({ ok: true });
});

// POST /api/config/llm/test — validate LLM credentials with a test call
app.post('/llm/test', async (c) => {
  // Allow testing with body config or existing saved config
  let testConfig: LLMProviderConfig | null = null;

  try {
    const body = await c.req.json<Partial<LLMProviderConfig>>();
    if (body.provider && body.model) {
      const providerInfo = PROVIDERS.find((provider) => provider.id === body.provider);
      if (!providerInfo) {
        return c.json({
          success: false,
          error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
        }, 400);
      }
      testConfig = {
        provider: body.provider,
        model: body.model,
        ...(body.apiKey ? { apiKey: body.apiKey } : {}),
        ...(body.baseUrl !== undefined
          ? { baseUrl: body.baseUrl }
          : {}),
      };
    }
  } catch {
    // No body or invalid JSON — use existing config
  }

  if (!testConfig) {
    testConfig = loadLLMConfig();
  }

  if (!testConfig) {
    return c.json({
      success: false,
      error: 'No LLM config found. Run `code-insights config llm` or provide config in request body.',
    }, 400);
  }

  const baseUrlValidation = validateProviderBaseUrl(
    testConfig.provider,
    testConfig.baseUrl,
  );
  if (!baseUrlValidation.ok) {
    return c.json({
      error: baseUrlValidation.message,
      code: baseUrlValidation.code,
    }, 400);
  }
  if (baseUrlValidation.value === undefined) {
    delete testConfig.baseUrl;
  } else {
    testConfig.baseUrl = baseUrlValidation.value;
  }

  const locked = await runWithLlmLock(c, () => testLLMConfig(testConfig));
  if (!locked.acquired) return c.json(llmBusyPayload(), 409);
  const result = locked.value;
  return c.json(result, result.success ? 200 : 422);
});

// GET /api/config/llm/ollama-models — return locally available Ollama models
app.get('/llm/ollama-models', async (c) => {
  const baseUrl = c.req.query('baseUrl');
  const models = await discoverOllamaModels(baseUrl);
  return c.json({ models });
});

// GET /api/config/llm/llamacpp-models — return model(s) loaded in the running llama-server instance
app.get('/llm/llamacpp-models', async (c) => {
  const baseUrl = c.req.query('baseUrl');
  const models = await discoverLlamaCppModels(baseUrl);
  return c.json({ models });
});

export default app;
