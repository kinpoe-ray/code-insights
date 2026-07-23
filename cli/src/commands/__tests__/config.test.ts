import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock('../../utils/config.js', () => ({
  loadConfig: configMocks.loadConfig,
  saveConfig: configMocks.saveConfig,
  isConfigured: () => true,
}));

vi.mock('../../utils/telemetry.js', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: configMocks.prompt,
  },
}));

describe('config llm provider capabilities', () => {
  beforeEach(async () => {
    vi.resetModules();
    configMocks.loadConfig.mockReset();
    configMocks.saveConfig.mockReset();
    configMocks.prompt.mockReset();
    configMocks.loadConfig.mockReturnValue({
      sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('rejects a custom base URL for a provider that does not support it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { configCommand } = await import('../config.js');

    await configCommand.parseAsync(
      [
        'llm',
        '--provider', 'openai',
        '--model', 'gpt-4o',
        '--api-key', 'sk-test-key',
        '--base-url', 'https://unsupported.example.test/v1',
      ],
      { from: 'user' },
    );

    expect(configMocks.saveConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('BASE_URL_UNSUPPORTED'));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('OpenAI does not support a custom base URL.'),
    );
  });

  it('rejects credential-bearing URLs without echoing their contents', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { configCommand } = await import('../config.js');

    await configCommand.parseAsync(
      [
        'llm',
        '--provider', 'anthropic',
        '--model', 'claude-sonnet-4-20250514',
        '--api-key', 'anthropic-test-key',
        '--base-url', 'https://private-user:super-secret@gateway.example.test/v1',
      ],
      { from: 'user' },
    );

    expect(configMocks.saveConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const output = errorSpy.mock.calls.flat().join(' ');
    expect(output).toContain('BASE_URL_CREDENTIALS_FORBIDDEN');
    expect(output).not.toContain('private-user');
    expect(output).not.toContain('super-secret');
  });

  it('normalizes an accepted base URL before saving it', async () => {
    const { configCommand } = await import('../config.js');

    await configCommand.parseAsync(
      [
        'llm',
        '--provider', 'ollama',
        '--model', 'llama3',
        '--base-url', '  http://localhost:11434  ',
      ],
      { from: 'user' },
    );

    expect(configMocks.saveConfig.mock.calls[0][0].dashboard.llm).toEqual({
      provider: 'ollama',
      model: 'llama3',
      baseUrl: 'http://localhost:11434',
    });
  });

  it('preserves credentials and endpoint when only changing the model for the same provider', async () => {
    configMocks.loadConfig.mockReturnValue({
      sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
      dashboard: {
        llm: {
          provider: 'anthropic',
          model: 'previous-model',
          apiKey: 'existing-anthropic-key',
          baseUrl: 'https://gateway.example.test/anthropic',
        },
      },
    });
    const { configCommand } = await import('../config.js');

    await configCommand.parseAsync(
      ['llm', '--provider', 'anthropic', '--model', 'replacement-model'],
      { from: 'user' },
    );

    expect(process.exitCode).toBeUndefined();
    expect(configMocks.saveConfig.mock.calls[0][0].dashboard.llm).toEqual({
      provider: 'anthropic',
      model: 'replacement-model',
      apiKey: 'existing-anthropic-key',
      baseUrl: 'https://gateway.example.test/anthropic',
    });
  });

  it('requires credentials again when explicitly changing the endpoint', async () => {
    configMocks.loadConfig.mockReturnValue({
      sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
      dashboard: {
        llm: {
          provider: 'anthropic',
          model: 'previous-model',
          apiKey: 'old-gateway-key',
          baseUrl: 'https://old-gateway.example.test/anthropic',
        },
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { configCommand } = await import('../config.js');

    await expect(configCommand.parseAsync(
      [
        'llm',
        '--provider', 'anthropic',
        '--model', 'replacement-model',
        '--base-url', 'https://new-gateway.example.test/anthropic',
      ],
      { from: 'user' },
    )).rejects.toThrow();

    expect(configMocks.saveConfig).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('requires an API key');
  });

  it('does not prompt for or preserve a base URL when switching to OpenAI', async () => {
    configMocks.loadConfig.mockReturnValue({
      sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
      dashboard: {
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          apiKey: 'old-anthropic-key',
          baseUrl: 'https://old-anthropic-endpoint.example.test',
        },
      },
    });
    configMocks.prompt
      .mockResolvedValueOnce({ provider: 'openai' })
      .mockResolvedValueOnce({ model: 'gpt-4o' })
      .mockResolvedValueOnce({ apiKey: 'new-openai-key' })
      .mockResolvedValueOnce({ baseUrl: 'https://should-not-be-prompted.example.test' });

    const { configCommand } = await import('../config.js');
    await configCommand.parseAsync(['llm'], { from: 'user' });

    expect(configMocks.prompt).toHaveBeenCalledTimes(3);
    expect(configMocks.saveConfig.mock.calls[0][0].dashboard.llm).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'new-openai-key',
    });
  });
});
