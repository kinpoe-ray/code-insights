import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';

describe('Code Insights data path overrides', () => {
  const originalConfigDir = process.env.CODE_INSIGHTS_CONFIG_DIR;
  const originalDb = process.env.CODE_INSIGHTS_DB;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.CODE_INSIGHTS_CONFIG_DIR;
    delete process.env.CODE_INSIGHTS_DB;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CODE_INSIGHTS_CONFIG_DIR;
    else process.env.CODE_INSIGHTS_CONFIG_DIR = originalConfigDir;
    if (originalDb === undefined) delete process.env.CODE_INSIGHTS_DB;
    else process.env.CODE_INSIGHTS_DB = originalDb;
  });

  it('uses CODE_INSIGHTS_CONFIG_DIR for config, sync state, and the default database', async () => {
    process.env.CODE_INSIGHTS_CONFIG_DIR = '/tmp/code-insights-custom';

    const config = await import('./config.js');
    const db = await import('../db/client.js');

    expect(config.getConfigDir()).toBe('/tmp/code-insights-custom');
    expect(config.getSyncStatePath()).toBe('/tmp/code-insights-custom/sync-state.json');
    expect(db.getDbPath()).toBe('/tmp/code-insights-custom/data.db');
  });

  it('prefers CODE_INSIGHTS_DB over the configured directory', async () => {
    process.env.CODE_INSIGHTS_CONFIG_DIR = '/tmp/code-insights-custom';
    process.env.CODE_INSIGHTS_DB = join('/tmp', 'code-insights-explicit', 'state.sqlite');

    const db = await import('../db/client.js');

    expect(db.getDbPath()).toBe('/tmp/code-insights-explicit/state.sqlite');
  });
});
