import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '@code-insights/cli/db/schema';
import { saveConfig } from '@code-insights/cli/utils/config';

// ──────────────────────────────────────────────────────
// Module-scoped mutable DB reference for mocking.
// ──────────────────────────────────────────────────────

let testDb: Database.Database;
let lockTestDir: string;

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

function occupyLlmLock(): void {
  const lockPath = process.env.CODE_INSIGHTS_LLM_LOCK_DIR!;
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, 'pid'), `${process.pid}\n`);
}

vi.mock('@code-insights/cli/db/client', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock('@code-insights/cli/utils/telemetry', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('@code-insights/cli/utils/config', () => ({
  loadConfig: configMocks.loadConfig,
  saveConfig: configMocks.saveConfig,
}));

const mockTestLLMConfig = vi.fn().mockResolvedValue({ success: true });

vi.mock('../llm/client.js', () => ({
  loadLLMConfig: () => null,
  isLLMConfigured: () => false,
  testLLMConfig: (...args: unknown[]) => mockTestLLMConfig(...args),
}));

vi.mock('../llm/providers/ollama.js', () => ({
  discoverOllamaModels: vi.fn().mockResolvedValue([]),
}));

const { createApp } = await import('../index.js');

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function initTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('Config routes', () => {
  beforeEach(() => {
    lockTestDir = mkdtempSync(join(tmpdir(), 'code-insights-server-lock-'));
    process.env.CODE_INSIGHTS_LLM_LOCK_DIR = join(lockTestDir, 'llm.lock');
    testDb = initTestDb();
    mockTestLLMConfig.mockClear();
    configMocks.loadConfig.mockReset();
    configMocks.loadConfig.mockReturnValue(null);
    configMocks.saveConfig.mockReset();
  });

  afterEach(() => {
    testDb.close();
    delete process.env.CODE_INSIGHTS_LLM_LOCK_DIR;
    rmSync(lockTestDir, { recursive: true, force: true });
  });

  describe('GET /api/config/llm', () => {
    it('returns config shape when no config exists', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm');
      expect(res.status).toBe(200);
      const body = await res.json();
      // loadConfig returns null, so llm is undefined
      expect(body.dashboardPort).toBe(7890);
      expect(body.provider).toBeUndefined();
      expect(body.model).toBeUndefined();
    });

    it('returns custom base URL capabilities from the shared provider registry', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm');
      const body = await res.json();

      expect(body.providers).toEqual([
        { id: 'openai', supportsCustomBaseUrl: false },
        { id: 'anthropic', supportsCustomBaseUrl: true },
        { id: 'gemini', supportsCustomBaseUrl: false },
        { id: 'ollama', supportsCustomBaseUrl: true },
        { id: 'llamacpp', supportsCustomBaseUrl: true },
      ]);
    });

    it('does not expose a stale base URL for an unsupported provider', async () => {
      configMocks.loadConfig.mockReturnValue({
        sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
        dashboard: {
          llm: {
            provider: 'openai',
            model: 'gpt-4o',
            baseUrl: 'https://stale-endpoint.example.test',
          },
        },
      });

      const app = createApp();
      const res = await app.request('/api/config/llm');
      const body = await res.json();

      expect(body.baseUrl).toBeUndefined();
    });
  });

  describe('PUT /api/config/llm', () => {
    it('returns 400 for port above valid range', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardPort: 99999 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/dashboardPort/);
    });

    it('returns 400 for negative port', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardPort: -1 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/dashboardPort/);
    });

    it('returns 400 for non-integer port', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardPort: 'abc' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/dashboardPort/);
    });

    it('returns 400 for invalid provider name', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'notreal', model: 'some-model' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/provider/);
    });

    it('returns 400 when provider is given but model is empty', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // model is omitted — no existing config to fall back to, so model resolves to ''
        body: JSON.stringify({ provider: 'ollama' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/model/);
    });

    it('returns 200 with ok:true when no fields are provided (no-op)', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns 200 when updating with valid provider and model', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', model: 'llama3' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('calls saveConfig when LLM config changes', async () => {
      vi.mocked(saveConfig).mockClear();
      const app = createApp();
      await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }),
      });
      expect(vi.mocked(saveConfig)).toHaveBeenCalledOnce();
    });

    it('clears a stale base URL when switching to a provider that does not support it', async () => {
      configMocks.loadConfig.mockReturnValue({
        sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
        dashboard: {
          llm: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            apiKey: 'old-key',
            baseUrl: 'https://old-anthropic-endpoint.example.test',
          },
        },
      });

      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'new-key',
        }),
      });

      expect(res.status).toBe(200);
      expect(configMocks.saveConfig.mock.calls[0][0].dashboard.llm).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'new-key',
      });
    });

    it('rejects a credential-bearing base URL without echoing it', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          baseUrl: 'https://private-user:super-secret@gateway.example.test/v1',
        }),
      });

      expect(res.status).toBe(400);
      const responseBody = await res.json();
      expect(responseBody).toEqual({
        error: 'Base URL must not include a username or password.',
        code: 'BASE_URL_CREDENTIALS_FORBIDDEN',
      });
      expect(JSON.stringify(responseBody)).not.toContain('private-user');
      expect(JSON.stringify(responseBody)).not.toContain('super-secret');
      expect(configMocks.saveConfig).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/config/llm/test', () => {
    it('returns 400 when no LLM config exists and no body is provided', async () => {
      // loadLLMConfig mock returns null; no body in request
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();
    });

    it('returns 200 when body provides a valid config', async () => {
      // testLLMConfig mock resolves to { success: true }
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', model: 'llama3' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('rejects an unsupported provider with a custom base URL', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'test-key',
          baseUrl: 'https://unsupported.example.test/v1',
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: 'BASE_URL_UNSUPPORTED',
        error: 'OpenAI does not support a custom base URL.',
      });
      expect(mockTestLLMConfig).not.toHaveBeenCalled();
    });

    it('rejects a remote Anthropic HTTP endpoint before testing it', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          baseUrl: 'http://gateway.example.test/anthropic',
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Anthropic base URL must use HTTPS unless it targets the local machine.',
        code: 'BASE_URL_HTTPS_REQUIRED',
      });
      expect(mockTestLLMConfig).not.toHaveBeenCalled();
    });

    it('normalizes an accepted base URL before testing it', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'ollama',
          model: 'llama3',
          baseUrl: '  http://localhost:11434  ',
        }),
      });

      expect(res.status).toBe(200);
      expect(mockTestLLMConfig).toHaveBeenCalledWith({
        provider: 'ollama',
        model: 'llama3',
        baseUrl: 'http://localhost:11434',
      });
    });

    it('rejects an unknown provider before attempting a test call', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'not-a-provider',
          model: 'unknown-model',
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false });
      expect(mockTestLLMConfig).not.toHaveBeenCalled();
    });

    it('returns a recognizable busy response without testing the provider', async () => {
      occupyLlmLock();

      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', model: 'llama3' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'LLM_BUSY' });
      expect(mockTestLLMConfig).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/config/llm/ollama-models', () => {
    it('returns empty models array when no Ollama models are discovered', async () => {
      // discoverOllamaModels mock resolves to []
      const app = createApp();
      const res = await app.request('/api/config/llm/ollama-models');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.models).toEqual([]);
    });
  });
});
