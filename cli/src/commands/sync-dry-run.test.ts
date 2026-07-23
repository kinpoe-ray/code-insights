import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe.sequential('sync --dry-run filesystem safety', () => {
  let tempDir: string;
  let configDir: string;
  let codexHome: string;
  let previousConfigDir: string | undefined;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-insights-dry-run-'));
    configDir = path.join(tempDir, 'config-that-does-not-exist');
    codexHome = path.join(tempDir, 'codex');
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'sessions', 'rollout-dry-run.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'dry-run', timestamp: '2026-01-01T00:00:00Z', cwd: tempDir },
      }),
    );

    previousConfigDir = process.env.CODE_INSIGHTS_CONFIG_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODE_INSIGHTS_CONFIG_DIR = configDir;
    process.env.CODEX_HOME = codexHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CODE_INSIGHTS_CONFIG_DIR;
    else process.env.CODE_INSIGHTS_CONFIG_DIR = previousConfigDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers sessions without creating a config directory or SQLite database', async () => {
    const { runSync } = await import('./sync.js');

    await expect(runSync({ dryRun: true, quiet: true, source: 'codex-cli' }))
      .resolves.toMatchObject({ syncedCount: 0, errorCount: 0 });

    expect(fs.existsSync(configDir)).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'data.db'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sync-state.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
  });
});
