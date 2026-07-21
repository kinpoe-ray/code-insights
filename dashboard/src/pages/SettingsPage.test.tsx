import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMConfig } from '@/lib/types';
import SettingsPage from './SettingsPage';

Object.defineProperties(Element.prototype, {
  hasPointerCapture: { value: () => false, configurable: true },
  setPointerCapture: { value: () => {}, configurable: true },
  releasePointerCapture: { value: () => {}, configurable: true },
  scrollIntoView: { value: () => {}, configurable: true },
});

const settingsMocks = vi.hoisted(() => ({
  config: {} as LLMConfig,
  mutateAsync: vi.fn(),
  testLlmConfig: vi.fn(),
}));

vi.mock('@/hooks/useConfig', () => ({
  useLlmConfig: () => ({ data: settingsMocks.config, isLoading: false }),
  useSaveLlmConfig: () => ({
    mutateAsync: settingsMocks.mutateAsync,
    isPending: false,
  }),
}));

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({ profile: null, saveProfile: vi.fn() }),
  normalizeGithubUsername: () => '',
}));

vi.mock('@/lib/api', () => ({
  fetchOllamaModels: vi.fn(() => new Promise(() => {})),
  fetchLlamaCppModels: vi.fn().mockResolvedValue({ models: [] }),
  testLlmConfig: settingsMocks.testLlmConfig,
}));

describe('SettingsPage provider capabilities', () => {
  beforeEach(() => {
    settingsMocks.config = {
      dashboardPort: 7890,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://anthropic-compatible.example.test',
      providers: [
        { id: 'openai', supportsCustomBaseUrl: false },
        { id: 'anthropic', supportsCustomBaseUrl: true },
        { id: 'gemini', supportsCustomBaseUrl: false },
        { id: 'ollama', supportsCustomBaseUrl: true },
        { id: 'llamacpp', supportsCustomBaseUrl: true },
      ],
    };
    settingsMocks.mutateAsync.mockReset();
    settingsMocks.testLlmConfig.mockReset();
    settingsMocks.testLlmConfig.mockResolvedValue({ success: true });
  });

  it('shows the base URL field when the backend declares support', () => {
    render(<SettingsPage />);

    expect(screen.getByText('Base URL (optional)')).toBeInTheDocument();
  });

  it('hides the base URL field when the backend does not declare support', () => {
    settingsMocks.config = {
      ...settingsMocks.config,
      provider: 'ollama',
      model: 'llama3.3',
      baseUrl: undefined,
      providers: settingsMocks.config.providers?.map((provider) => (
        provider.id === 'ollama'
          ? { ...provider, supportsCustomBaseUrl: false }
          : provider
      )),
    };

    render(<SettingsPage />);

    expect(screen.queryByText('Base URL (optional)')).not.toBeInTheDocument();
  });

  it('does not submit the previous provider base URL after switching providers', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(screen.getByRole('option', { name: 'OpenAI' }));
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-new-openai-key');
    await user.click(screen.getByRole('button', { name: 'Save & Test' }));

    await waitFor(() => expect(settingsMocks.testLlmConfig).toHaveBeenCalledOnce());
    expect(settingsMocks.testLlmConfig).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-new-openai-key',
    });
  });
});
