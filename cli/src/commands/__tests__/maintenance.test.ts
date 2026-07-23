import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';

describe('maintenance command', () => {
  let configDir: string;
  const originalConfigDir = process.env.CODE_INSIGHTS_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'code-insights-maintenance-'));
    process.env.CODE_INSIGHTS_CONFIG_DIR = configDir;
    process.exitCode = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.CODE_INSIGHTS_CONFIG_DIR;
    else process.env.CODE_INSIGHTS_CONFIG_DIR = originalConfigDir;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('pause creates the shared maintenance marker idempotently with private permissions', async () => {
    const { buildMaintenanceCommand } = await import('../maintenance.js');
    const program = new Command().addCommand(buildMaintenanceCommand());
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['maintenance', 'pause'], { from: 'user' });
    await program.parseAsync(['maintenance', 'pause'], { from: 'user' });

    const marker = join(configDir, 'maintenance.paused');
    expect(existsSync(marker)).toBe(true);
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(process.exitCode).toBeUndefined();
  });

  it('status prints a stable running token and exits zero when maintenance is active', async () => {
    const { buildMaintenanceCommand } = await import('../maintenance.js');
    const program = new Command().addCommand(buildMaintenanceCommand());
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk): boolean => {
      output += String(chunk);
      return true;
    });

    await program.parseAsync(['maintenance', 'status'], { from: 'user' });

    expect(output).toBe('running\n');
    expect(process.exitCode).toBe(0);
  });

  it('status prints a stable paused token and exits three when maintenance is paused', async () => {
    const { buildMaintenanceCommand } = await import('../maintenance.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await new Command()
      .addCommand(buildMaintenanceCommand())
      .parseAsync(['maintenance', 'pause'], { from: 'user' });
    process.exitCode = undefined;

    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk): boolean => {
      output += String(chunk);
      return true;
    });
    await new Command()
      .addCommand(buildMaintenanceCommand())
      .parseAsync(['maintenance', 'status'], { from: 'user' });

    expect(output).toBe('paused\n');
    expect(process.exitCode).toBe(3);
  });

  it('resume removes the marker idempotently and restores running status', async () => {
    const { buildMaintenanceCommand } = await import('../maintenance.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await new Command()
      .addCommand(buildMaintenanceCommand())
      .parseAsync(['maintenance', 'pause'], { from: 'user' });

    await new Command()
      .addCommand(buildMaintenanceCommand())
      .parseAsync(['maintenance', 'resume'], { from: 'user' });
    await new Command()
      .addCommand(buildMaintenanceCommand())
      .parseAsync(['maintenance', 'resume'], { from: 'user' });

    const marker = join(configDir, 'maintenance.paused');
    expect(existsSync(marker)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });
});
