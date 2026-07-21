import { describe, expect, it } from 'vitest';
import { PROVIDERS, validateProviderBaseUrl } from './llm-providers.js';

describe('LLM provider capabilities', () => {
  it('declares custom base URL support from the shared provider registry', () => {
    expect(
      Object.fromEntries(
        PROVIDERS.map((provider) => [provider.id, provider.supportsCustomBaseUrl]),
      ),
    ).toEqual({
      openai: false,
      anthropic: true,
      gemini: false,
      ollama: true,
      llamacpp: true,
    });
  });

  it.each([undefined, '', '   '])('accepts an empty custom base URL (%j)', (baseUrl) => {
    expect(validateProviderBaseUrl('anthropic', baseUrl)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('rejects a custom base URL when the provider does not support one', () => {
    expect(validateProviderBaseUrl('openai', 'https://gateway.example.test')).toEqual({
      ok: false,
      code: 'BASE_URL_UNSUPPORTED',
      message: 'OpenAI does not support a custom base URL.',
    });
  });

  it('rejects non-HTTP URL schemes with a stable error code', () => {
    expect(validateProviderBaseUrl('ollama', 'file:///tmp/ollama.sock')).toEqual({
      ok: false,
      code: 'BASE_URL_PROTOCOL_INVALID',
      message: 'Base URL must use the HTTP or HTTPS protocol.',
    });
  });

  it('rejects embedded credentials without echoing them', () => {
    const credentialUrl = 'https://private-user:super-secret@gateway.example.test/v1';
    const result = validateProviderBaseUrl('anthropic', credentialUrl);

    expect(result).toEqual({
      ok: false,
      code: 'BASE_URL_CREDENTIALS_FORBIDDEN',
      message: 'Base URL must not include a username or password.',
    });
    expect(JSON.stringify(result)).not.toContain('private-user');
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('requires HTTPS for a remote Anthropic endpoint', () => {
    expect(validateProviderBaseUrl('anthropic', 'http://gateway.example.test/anthropic')).toEqual({
      ok: false,
      code: 'BASE_URL_HTTPS_REQUIRED',
      message: 'Anthropic base URL must use HTTPS unless it targets the local machine.',
    });
  });

  it.each([
    'http://localhost:8080/anthropic',
    'http://127.0.0.1:8080/anthropic',
    'http://[::1]:8080/anthropic',
  ])('allows Anthropic HTTP on an exact loopback host (%s)', (baseUrl) => {
    expect(validateProviderBaseUrl('anthropic', baseUrl)).toEqual({
      ok: true,
      value: baseUrl,
    });
  });

  it('rejects loopback lookalikes for Anthropic HTTP', () => {
    expect(validateProviderBaseUrl('anthropic', 'http://localhost.example.test/anthropic')).toEqual({
      ok: false,
      code: 'BASE_URL_HTTPS_REQUIRED',
      message: 'Anthropic base URL must use HTTPS unless it targets the local machine.',
    });
  });

  it('allows a remote Anthropic HTTPS endpoint', () => {
    const baseUrl = 'https://gateway.example.test/anthropic';
    expect(validateProviderBaseUrl('anthropic', baseUrl)).toEqual({
      ok: true,
      value: baseUrl,
    });
  });

  it.each([
    ['ollama', 'http://localhost:11434'],
    ['ollama', 'https://ollama.example.test'],
    ['llamacpp', 'http://localhost:8080'],
    ['llamacpp', 'https://llamacpp.example.test'],
  ])('allows %s to use %s', (providerId, baseUrl) => {
    expect(validateProviderBaseUrl(providerId, baseUrl)).toEqual({
      ok: true,
      value: baseUrl,
    });
  });

  it('normalizes surrounding whitespace from an accepted URL', () => {
    expect(validateProviderBaseUrl('ollama', '  http://localhost:11434  ')).toEqual({
      ok: true,
      value: 'http://localhost:11434',
    });
  });

  it.each([42, {}, 'not a url'])('rejects a malformed base URL (%j)', (baseUrl) => {
    expect(validateProviderBaseUrl('ollama', baseUrl)).toEqual({
      ok: false,
      code: 'BASE_URL_INVALID',
      message: 'Base URL must be a valid HTTP or HTTPS URL.',
    });
  });
});
