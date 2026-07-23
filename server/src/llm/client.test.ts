import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock, LLMMessage } from './types.js';

vi.mock('@code-insights/cli/utils/config', () => ({
  loadConfig: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createClientFromConfig } from './client.js';

function responseFor(provider: string): Response {
  const body = provider === 'anthropic'
    ? { content: [{ text: '{}' }] }
    : provider === 'gemini'
      ? { candidates: [{ content: { parts: [{ text: '{}' }] } }] }
      : { choices: [{ message: { content: '{}' } }] };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function malformedJsonResponse(secret: string): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError(`malformed provider body: ${secret}`)),
    text: () => Promise.resolve(secret),
  } as unknown as Response;
}

function abortedJsonResponse(error: Error): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.reject(error),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

describe('createClientFromConfig outbound credential guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['openai', 'gpt-4o'],
    ['anthropic', 'claude-sonnet-4-5'],
    ['gemini', 'gemini-2.5-flash'],
  ] as const)('guards every %s chat call before the provider adapter', async (provider, model) => {
    mockFetch.mockResolvedValueOnce(responseFor(provider));
    const apiKey = `exact-${provider}-config-secret`;
    const client = createClientFromConfig({ provider, model, apiKey });

    await client.chat([{
      role: 'user',
      content: `configured=${apiKey}\nAuthorization: Bearer bearer-secret-value-123456`,
    }]);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    expect(body).not.toContain(apiKey);
    expect(body).not.toContain('bearer-secret-value-123456');
    expect(body).toContain('[REDACTED:known-secret]');
    expect(body).toContain('[REDACTED:authorization]');
  });

  it('preserves Anthropic content block shape and cache_control after guarding', async () => {
    mockFetch.mockResolvedValueOnce(responseFor('anthropic'));
    const client = createClientFromConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'anthropic-api-key',
    });
    const blocks: ContentBlock[] = [{
      type: 'text',
      text: 'x-api-key: header-secret-value-123456',
      cache_control: { type: 'ephemeral' },
    }];
    const messages: LLMMessage[] = [{ role: 'user', content: blocks }];

    await client.chat(messages);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([{
      type: 'text',
      text: 'x-api-key: [REDACTED:api-key-header]',
      cache_control: { type: 'ephemeral' },
    }]);
    expect(blocks[0].text).toBe('x-api-key: header-secret-value-123456');
  });

  it('sends the Gemini API key in a header, never in the URL', async () => {
    mockFetch.mockResolvedValueOnce(responseFor('gemini'));
    const client = createClientFromConfig({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'gemini-url-secret',
    });

    await client.chat([{ role: 'user', content: 'hello' }]);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('gemini-url-secret');
    expect((init.headers as Record<string, string>)['x-goog-api-key'])
      .toBe('gemini-url-secret');
  });

  it.each([
    ['openai', 'gpt-4o', 'OpenAI request was rejected (HTTP 401).'],
    ['anthropic', 'claude-sonnet-4-5', 'Anthropic request was rejected (HTTP 401).'],
    ['gemini', 'gemini-2.5-flash', 'Gemini request was rejected (HTTP 401).'],
  ] as const)('does not expose remote %s error details', async (provider, model, expected) => {
    const secret = `remote-${provider}-error-secret`;
    mockFetch.mockResolvedValueOnce(errorResponse({
      error: { message: `credential rejected: ${secret}` },
    }, 401));
    const client = createClientFromConfig({ provider, model, apiKey: 'configured-key' });

    const request = client.chat([{ role: 'user', content: 'hello' }]);
    await expect(request).rejects.toThrow(expected);
    await expect(request).rejects.not.toThrow(secret);
  });

  it.each([
    ['ollama', 'llama3'],
    ['llamacpp', 'gemma-4-12b'],
  ] as const)('does not echo the configured %s URL rejected at construction', (
    provider,
    model,
  ) => {
    const secret = `configured-${provider}-url-secret`;
    const construct = () => createClientFromConfig({
        provider,
        model,
        baseUrl: `http://user:${secret}@localhost:1234`,
      });

    expect(construct).toThrow('Base URL must not include a username or password.');
    try {
      construct();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'remote Anthropic HTTP',
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        apiKey: 'anthropic-key',
        baseUrl: 'http://gateway.example.test/anthropic',
      },
      'Anthropic base URL must use HTTPS unless it targets the local machine.',
    ],
    [
      'embedded credentials',
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        apiKey: 'anthropic-key',
        baseUrl: 'https://private-user:runtime-url-secret@gateway.example.test',
      },
      'Base URL must not include a username or password.',
    ],
    [
      'file protocol',
      {
        provider: 'ollama',
        model: 'llama3',
        baseUrl: 'file:///tmp/ollama.sock',
      },
      'Base URL must use the HTTP or HTTPS protocol.',
    ],
    [
      'unsupported provider override',
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'gemini-key',
        baseUrl: 'https://gateway.example.test',
      },
      'Google Gemini does not support a custom base URL.',
    ],
  ] as const)('rejects a runtime %s base URL before fetch', (_label, config, expected) => {
    expect(() => createClientFromConfig(config)).toThrow(expected);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['http://localhost:8080/anthropic/', 'http://localhost:8080/anthropic/v1/messages'],
    ['https://gateway.example.test/anthropic/', 'https://gateway.example.test/anthropic/v1/messages'],
  ])('uses an accepted normalized Anthropic endpoint %s', async (baseUrl, expectedUrl) => {
    mockFetch.mockResolvedValueOnce(responseFor('anthropic'));
    const client = createClientFromConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'anthropic-key',
      baseUrl: `  ${baseUrl}  `,
    });

    await client.chat([{ role: 'user', content: 'hello' }]);

    expect(mockFetch.mock.calls[0][0]).toBe(expectedUrl);
  });

  const providers = [
    [{ provider: 'openai', model: 'gpt-4o', apiKey: 'key' }, 'OpenAI'],
    [{ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'key' }, 'Anthropic'],
    [{ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'key' }, 'Gemini'],
    [{ provider: 'ollama', model: 'llama3' }, 'Ollama'],
    [{ provider: 'llamacpp', model: 'gemma-4-12b' }, 'llama-server'],
  ] as const;

  it.each(providers)('normalizes malformed 200 JSON from $1', async (config, provider) => {
    const secret = `malformed-${config.provider}-body-secret`;
    mockFetch.mockResolvedValueOnce(malformedJsonResponse(secret));
    const request = createClientFromConfig(config).chat([{ role: 'user', content: 'hello' }]);

    await expect(request).rejects.toThrow(`${provider} returned an invalid response.`);
    await expect(request).rejects.not.toThrow(secret);
  });

  it.each(providers)('rejects an invalid 200 response shape from $1', async (config, provider) => {
    mockFetch.mockResolvedValueOnce(errorResponse({}, 200));
    const request = createClientFromConfig(config).chat([{ role: 'user', content: 'hello' }]);

    await expect(request).rejects.toThrow(`${provider} returned an invalid response.`);
  });

  it.each(providers)('preserves AbortError while parsing a $1 response', async (config) => {
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    mockFetch.mockResolvedValueOnce(abortedJsonResponse(abort));
    const request = createClientFromConfig(config).chat([{ role: 'user', content: 'hello' }]);

    await expect(request).rejects.toBe(abort);
  });
});
