import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureMock = vi.fn();

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = captureMock;
    identify = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./config.js', () => ({
  loadConfig: () => ({ telemetry: true }),
  getConfigDir: () => '/tmp/code-insights-test',
}));

const { captureError, trackEvent } = await import('./telemetry.js');

describe('telemetry outbound privacy boundary', () => {
  beforeEach(() => {
    captureMock.mockClear();
  });

  it('only sends allowlisted, non-sensitive event properties to PostHog', () => {
    const email = 'private.person@example.com';
    const absolutePath = '/Users/private.person/secret-project/transcript.jsonl';
    const llmResponse = 'LLM response: customer password=hunter2';

    trackEvent('analysis_run', {
      success: false,
      duration_ms: 42,
      error_type: 'api_error',
      llm_model: email,
      error_message: `${email} ${absolutePath}`,
      response_preview: llmResponse,
      raw_context: `at run (${absolutePath}:10:2)`,
    });

    expect(captureMock).toHaveBeenCalledOnce();
    const payload = captureMock.mock.calls[0][0];
    expect(payload.properties).toEqual({
      success: false,
      duration_ms: 42,
      error_type: 'api_error',
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(absolutePath);
    expect(serialized).not.toContain(llmResponse);
    expect(serialized).not.toContain('raw_context');
  });

  it('captures only an error classification and sanitized context', () => {
    const email = 'private.person@example.com';
    const absolutePath = '/Users/private.person/secret-project/analyze.ts';
    const llmResponse = 'LLM response: bearer=super-secret-token';
    const error = new Error(`${email} ${llmResponse}`);
    error.stack = `Error: ${error.message}\n    at analyze (${absolutePath}:21:9)`;

    captureError(error, {
      command: 'sync',
      error_type: 'api_error',
      llm_provider: 'anthropic',
      error_message: error.message,
      response_preview: llmResponse,
      raw_path: absolutePath,
    });

    expect(captureMock).toHaveBeenCalledOnce();
    const payload = captureMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      event: '$exception',
      properties: {
        $exception_type: 'Error',
        error_type: 'api_error',
        command: 'sync',
        llm_provider: 'anthropic',
      },
    });
    expect(Object.keys(payload.properties).sort()).toEqual(
      ['$exception_type', 'command', 'error_type', 'llm_provider'].sort(),
    );

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(absolutePath);
    expect(serialized).not.toContain(llmResponse);
    expect(serialized).not.toContain('stacktrace');
    expect(serialized).not.toContain('$exception_stack_trace_raw');
  });
});
