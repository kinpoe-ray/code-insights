import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const fsMockState = vi.hoisted(() => ({
  failRename: false,
  mutateTargetAfterTempWrite: undefined as string | undefined,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFileSync: vi.fn((...args: any[]) => {
      const result = (actual.writeFileSync as any)(...args);
      const writtenPath = String(args[0]);
      if (
        fsMockState.mutateTargetAfterTempWrite
        && writtenPath.includes('.settings.json.')
        && writtenPath.endsWith('.tmp')
      ) {
        const target = fsMockState.mutateTargetAfterTempWrite;
        fsMockState.mutateTargetAfterTempWrite = undefined;
        actual.writeFileSync(target, JSON.stringify({ concurrentEdit: true }));
      }
      return result;
    }),
    renameSync: vi.fn((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (fsMockState.failRename) throw new Error('simulated rename failure');
      return actual.renameSync(oldPath, newPath);
    }),
  };
});

vi.mock('../../utils/telemetry.js', () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
  classifyError: vi.fn(() => ({ error_type: 'unknown', error_message: 'unknown' })),
}));

// Mock os module so homedir() returns our temp dir.
// Uses a mutable object (not a `let`) because vi.mock factories are hoisted before
// variable declarations — a plain object property is safe to read at any point.
const _mockOs = { homeDir: '' };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => _mockOs.homeDir,
  };
});

// ── Setup: isolated temp home dir per test ────────────────────────────────────

let mockHomeDir: string;

beforeEach(() => {
  // Each test gets its own temp dir as home — never touches real ~/.claude/settings.json
  mockHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-hook-test-'));
  _mockOs.homeDir = mockHomeDir;
  fsMockState.failRename = false;
  fsMockState.mutateTargetAfterTempWrite = undefined;
  // Reset module cache so CLAUDE_SETTINGS_DIR / HOOKS_FILE pick up the new mockHomeDir
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(mockHomeDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hooksFile(): string {
  return path.join(mockHomeDir, '.claude', 'settings.json');
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(hooksFile(), 'utf-8'));
}

function writeSettings(data: unknown): void {
  const dir = path.join(mockHomeDir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(hooksFile(), JSON.stringify(data));
}

function writeRawSettings(content: string): void {
  const dir = path.join(mockHomeDir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(hooksFile(), content);
}

function writeSymlinkedSettings(data: unknown): string {
  const settingsDir = path.join(mockHomeDir, '.claude');
  const targetDir = path.join(mockHomeDir, 'shared-claude-settings');
  const target = path.join(targetDir, 'settings.json');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data));
  fs.symlinkSync(target, hooksFile());
  return target;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('installHookCommand', () => {
  describe('default install', () => {
    it('installs a single SessionEnd hook (no Stop hook)', async () => {
      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;

      expect(hooks).toBeDefined();
      // v4.9+: only SessionEnd hook, no Stop hook
      expect(hooks.Stop).toBeUndefined();
      expect(Array.isArray(hooks.SessionEnd)).toBe(true);
      expect(hooks.SessionEnd).toHaveLength(1);
    });

    it('SessionEnd hook runs session-end command with 10s timeout', async () => {
      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
      const sessionEndCmd = hooks.SessionEnd[0].hooks[0];

      expect(sessionEndCmd.type).toBe('command');
      expect(sessionEndCmd.command).toContain('session-end --native -q');
      // Must use node + absolute path (not process.argv[1] which is unstable under npx)
      expect(sessionEndCmd.command).toMatch(/^node '.+index\.js' session-end --native -q$/);
      // 10s timeout — session-end exits immediately after spawning the worker
      expect(sessionEndCmd.timeout).toBe(10000);
    });

    it('can install a provider-backed SessionEnd hook for the configured LLM', async () => {
      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand({ native: false });

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      const command = hooks.SessionEnd[0].hooks[0].command;

      expect(command).toContain('session-end --provider -q');
      expect(command).not.toContain(' --native ');
    });

    it('preserves existing settings.json content', async () => {
      writeSettings({ theme: 'dark', someOtherKey: 42 });

      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      const settings = readSettings();
      expect(settings.theme).toBe('dark');
      expect(settings.someOtherKey).toBe(42);
    });

    it('fails closed and preserves an unparseable settings.json', async () => {
      const invalidSettings = '{"hooks":{"SessionEnd":[';
      writeRawSettings(invalidSettings);

      const { installHookCommand } = await import('../install-hook.js');

      await expect(installHookCommand()).rejects.toThrow(/parse/i);
      expect(fs.readFileSync(hooksFile(), 'utf-8')).toBe(invalidSettings);
    });

    it('preserves existing non-code-insights SessionEnd hooks', async () => {
      writeSettings({
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: 'other-tool end-session' }] }],
        },
      });

      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Should have 2 SessionEnd hooks: the existing one + our new one
      expect(hooks.SessionEnd).toHaveLength(2);
    });

    it('does not duplicate hook when installed twice', async () => {
      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();
      vi.resetModules();
      const { installHookCommand: installHookCommand2 } = await import('../install-hook.js');
      await installHookCommand2();

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Second install must be idempotent — still exactly one code-insights hook
      expect(hooks.SessionEnd).toHaveLength(1);
    });

    it('pins a custom Code Insights config directory into the hook command', async () => {
      const previous = process.env.CODE_INSIGHTS_CONFIG_DIR;
      process.env.CODE_INSIGHTS_CONFIG_DIR = path.join(mockHomeDir, 'custom config');
      try {
        const { installHookCommand } = await import('../install-hook.js');
        await installHookCommand();
      } finally {
        if (previous === undefined) delete process.env.CODE_INSIGHTS_CONFIG_DIR;
        else process.env.CODE_INSIGHTS_CONFIG_DIR = previous;
      }

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      expect(hooks.SessionEnd[0].hooks[0].command).toContain(
        `CODE_INSIGHTS_CONFIG_DIR='${path.join(mockHomeDir, 'custom config')}'`,
      );
    });

    it('atomically replaces settings.json through a same-directory rename', async () => {
      writeSettings({ theme: 'dark' });

      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      const renameSpy = vi.mocked(fs.renameSync);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [temporaryPath, destinationPath] = renameSpy.mock.calls[0];
      expect(path.dirname(String(temporaryPath))).toBe(path.dirname(hooksFile()));
      expect(destinationPath).toBe(hooksFile());
      expect(fs.existsSync(String(temporaryPath))).toBe(false);
    });

    it('writes settings.json with mode 0600', async () => {
      writeSettings({ theme: 'dark' });
      fs.chmodSync(hooksFile(), 0o644);

      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      expect(fs.statSync(hooksFile()).mode & 0o777).toBe(0o600);
    });

    it('removes the temporary settings file when atomic replacement fails', async () => {
      writeSettings({ theme: 'dark' });
      fsMockState.failRename = true;

      const { installHookCommand } = await import('../install-hook.js');
      await expect(installHookCommand()).rejects.toThrow('simulated rename failure');

      const renameSpy = vi.mocked(fs.renameSync);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [temporaryPath] = renameSpy.mock.calls[0];
      expect(fs.existsSync(String(temporaryPath))).toBe(false);
      expect(readSettings()).toEqual({ theme: 'dark' });
    });

    it('does not overwrite a concurrent settings edit made before atomic replacement', async () => {
      writeSettings({ theme: 'dark' });
      fsMockState.mutateTargetAfterTempWrite = hooksFile();

      const { installHookCommand } = await import('../install-hook.js');
      await expect(installHookCommand()).rejects.toThrow(/changed/i);

      expect(readSettings()).toEqual({ concurrentEdit: true });
    });

    it('rejects when settings.json cannot be written', async () => {
      fs.writeFileSync(path.join(mockHomeDir, '.claude'), 'not a directory');

      const { installHookCommand } = await import('../install-hook.js');

      await expect(installHookCommand()).rejects.toThrow();
    });

    it('updates a symlink target atomically without replacing the settings.json symlink', async () => {
      const target = writeSymlinkedSettings({ theme: 'dark' });

      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      expect(fs.lstatSync(hooksFile()).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(hooksFile())).toBe(fs.realpathSync(target));
      const settings = JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown>;
      expect(settings.theme).toBe('dark');
      expect(settings.hooks).toBeDefined();

      const renameSpy = vi.mocked(fs.renameSync);
      const [temporaryPath, destinationPath] = renameSpy.mock.calls.at(-1)!;
      expect(path.dirname(String(temporaryPath))).toBe(path.dirname(fs.realpathSync(target)));
      expect(destinationPath).toBe(fs.realpathSync(target));
    });

    it('fails closed without replacing a dangling settings.json symlink', async () => {
      const settingsDir = path.join(mockHomeDir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      const linkTarget = path.join(mockHomeDir, 'missing', 'settings.json');
      fs.symlinkSync(linkTarget, hooksFile());

      const { installHookCommand } = await import('../install-hook.js');
      await expect(installHookCommand()).rejects.toThrow(/symbolic link|symlink/i);

      expect(fs.lstatSync(hooksFile()).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(hooksFile())).toBe(linkTarget);
      expect(fs.existsSync(linkTarget)).toBe(false);
    });
  });

  describe('v4.8.x migration', () => {
    it('removes legacy Stop hook on install', async () => {
      writeSettings({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node /path/code-insights sync -q' }] }],
        },
      });

      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Legacy Stop hook removed; only our new SessionEnd hook remains
      expect(hooks.Stop).toBeUndefined();
      expect(hooks.SessionEnd).toHaveLength(1);
    });

    it('preserves non-code-insights Stop hooks during migration', async () => {
      writeSettings({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'other-tool cleanup' }] },
            { hooks: [{ type: 'command', command: 'node /path/code-insights sync -q' }] },
          ],
        },
      });

      const { installHookCommand } = await import('../install-hook.js');
      await installHookCommand();

      const settings = readSettings();
      const hooks = settings.hooks as Record<string, unknown[]>;
      // Our code-insights Stop hook removed; non-code-insights one preserved
      expect(hooks.Stop).toHaveLength(1);
      const remaining = hooks.Stop[0] as { hooks: Array<{ command: string }> };
      expect(remaining.hooks[0].command).toBe('other-tool cleanup');
    });
  });
});

describe('uninstallHookCommand', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('removes v4.9+ SessionEnd session-end hook', async () => {
    writeSettings({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /path/code-insights session-end --native -q', timeout: 10000 }] }],
      },
    });

    const { uninstallHookCommand } = await import('../install-hook.js');
    await uninstallHookCommand();

    const settings = readSettings();
    expect((settings.hooks as Record<string, unknown> | undefined)?.SessionEnd).toBeUndefined();
  });

  it('removes v4.8.x Stop and SessionEnd hooks (upgrade path)', async () => {
    writeSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node /path/code-insights sync -q' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /path/code-insights insights --hook --native -q', timeout: 300000 }] }],
      },
    });

    const { uninstallHookCommand } = await import('../install-hook.js');
    await uninstallHookCommand();

    const settings = readSettings();
    expect((settings.hooks as Record<string, unknown> | undefined)?.Stop).toBeUndefined();
    expect((settings.hooks as Record<string, unknown> | undefined)?.SessionEnd).toBeUndefined();
  });

  it('preserves non-code-insights Stop hooks', async () => {
    writeSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'other-tool cleanup' }] },
          { hooks: [{ type: 'command', command: 'node /path/code-insights sync -q' }] },
        ],
      },
    });

    const { uninstallHookCommand } = await import('../install-hook.js');
    await uninstallHookCommand();

    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(1);
    const remaining = hooks.Stop[0] as { hooks: Array<{ command: string }> };
    expect(remaining.hooks[0].command).toBe('other-tool cleanup');
  });

  it('preserves non-code-insights SessionEnd hooks', async () => {
    writeSettings({
      hooks: {
        SessionEnd: [
          { hooks: [{ type: 'command', command: 'other-tool end-session' }] },
          { hooks: [{ type: 'command', command: 'node /path/code-insights session-end --native -q', timeout: 10000 }] },
        ],
      },
    });

    const { uninstallHookCommand } = await import('../install-hook.js');
    await uninstallHookCommand();

    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.SessionEnd).toHaveLength(1);
    const remaining = hooks.SessionEnd[0] as { hooks: Array<{ command: string }> };
    expect(remaining.hooks[0].command).toBe('other-tool end-session');
  });

  it('handles missing settings.json gracefully', async () => {
    const { uninstallHookCommand } = await import('../install-hook.js');
    await expect(uninstallHookCommand()).resolves.toBeUndefined();
  });

  it('cleans up empty hooks object after removal', async () => {
    writeSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node /path/code-insights sync -q' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /path/code-insights session-end --native -q', timeout: 10000 }] }],
      },
    });

    const { uninstallHookCommand } = await import('../install-hook.js');
    await uninstallHookCommand();

    const settings = readSettings();
    expect(settings.hooks).toBeUndefined();
  });

  it('fails closed and preserves an unparseable settings.json', async () => {
    const invalidSettings = '{"hooks":{"SessionEnd":[';
    writeRawSettings(invalidSettings);

    const { uninstallHookCommand } = await import('../install-hook.js');
    await expect(uninstallHookCommand()).rejects.toThrow(/parse/i);

    expect(fs.readFileSync(hooksFile(), 'utf-8')).toBe(invalidSettings);
  });

  it('atomically writes uninstall changes and propagates replacement failures', async () => {
    writeSettings({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /path/code-insights session-end -q' }] }],
      },
    });
    fsMockState.failRename = true;

    const { uninstallHookCommand } = await import('../install-hook.js');
    await expect(uninstallHookCommand()).rejects.toThrow('simulated rename failure');

    expect(readSettings()).toEqual({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /path/code-insights session-end -q' }] }],
      },
    });
    const renameSpy = vi.mocked(fs.renameSync);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [temporaryPath] = renameSpy.mock.calls[0];
    expect(fs.existsSync(String(temporaryPath))).toBe(false);
  });

  it('does not overwrite a concurrent edit while uninstalling hooks', async () => {
    writeSettings({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /path/code-insights session-end -q' }] }],
      },
    });
    fsMockState.mutateTargetAfterTempWrite = hooksFile();

    const { uninstallHookCommand } = await import('../install-hook.js');
    await expect(uninstallHookCommand()).rejects.toThrow(/changed/i);

    expect(readSettings()).toEqual({ concurrentEdit: true });
  });

  it('updates a symlink target while preserving the settings.json symlink', async () => {
    const target = writeSymlinkedSettings({
      theme: 'dark',
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /path/code-insights session-end -q' }] }],
      },
    });

    const { uninstallHookCommand } = await import('../install-hook.js');
    await uninstallHookCommand();

    expect(fs.lstatSync(hooksFile()).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(hooksFile())).toBe(fs.realpathSync(target));
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ theme: 'dark' });
  });
});
