import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  runCommandWithLlmLock,
  terminateChildProcessTree,
} from '../lock-run.js';

describe('terminateChildProcessTree', () => {
  it('uses taskkill without a shell to terminate a Windows process tree', () => {
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const child = {
      pid: 4242,
      kill(signal?: NodeJS.Signals | number): boolean {
        directSignals.push(signal);
        return true;
      },
    };

    terminateChildProcessTree(child, 'SIGTERM', {
      platform: 'win32',
      runTaskkill(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });

    expect(calls).toEqual([{
      command: 'taskkill',
      args: ['/PID', '4242', '/T', '/F'],
      options: expect.objectContaining({
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      }),
    }]);
    expect(directSignals).toEqual([]);
  });

  it('falls back to the direct child when taskkill is unavailable', () => {
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];
    const child = {
      pid: 4242,
      kill(signal?: NodeJS.Signals | number): boolean {
        directSignals.push(signal);
        return true;
      },
    };

    terminateChildProcessTree(child, 'SIGTERM', {
      platform: 'win32',
      runTaskkill() {
        throw Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' });
      },
    });

    expect(directSignals).toEqual(['SIGTERM']);
  });

  it('falls back to the direct child when taskkill reports failure', () => {
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];
    const child = {
      pid: 4242,
      kill(signal?: NodeJS.Signals | number): boolean {
        directSignals.push(signal);
        return true;
      },
    };

    terminateChildProcessTree(child, 'SIGKILL', {
      platform: 'win32',
      runTaskkill() {
        return { status: 1 };
      },
    });

    expect(directSignals).toEqual(['SIGKILL']);
  });
});

describe('runCommandWithLlmLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-insights-lock-run-'));
    lockPath = join(tempDir, 'llm.lock');
    process.env.CODE_INSIGHTS_LLM_LOCK_DIR = lockPath;
    delete process.env.CODE_INSIGHTS_LOCK_HELD;
  });

  afterEach(() => {
    delete process.env.CODE_INSIGHTS_LLM_LOCK_DIR;
    delete process.env.CODE_INSIGHTS_LOCK_HELD;
    delete process.env.LOCK_RUN_TEST_PID_FILE;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs a child with the inherited-lock marker and releases the lock', async () => {
    const result = await runCommandWithLlmLock([
      process.execPath,
      '-e',
      "process.exit(process.env.CODE_INSIGHTS_LOCK_HELD === '1' && /^[0-9a-f-]{36}$/i.test(process.env.CODE_INSIGHTS_LOCK_TOKEN || '') ? 0 : 9)",
    ]);

    expect(result).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns 75 without spawning work when another live process owns the lock', async () => {
    const marker = join(tempDir, 'should-not-exist');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), `${process.pid}\n`);

    const result = await runCommandWithLlmLock([
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);

    expect(result).toBe(75);
    expect(existsSync(marker)).toBe(false);
  });

  it('propagates the child exit status', async () => {
    const result = await runCommandWithLlmLock([
      process.execPath,
      '-e',
      'process.exit(7)',
    ]);

    expect(result).toBe(7);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'returns the signal exit code when the child trap exits zero and terminates the complete process group',
    async () => {
      const grandchildPidFile = join(tempDir, 'grandchild.pid');
      process.env.LOCK_RUN_TEST_PID_FILE = grandchildPidFile;
      const run = runCommandWithLlmLock([
        '/bin/bash',
        '-c',
        // Keep the grandchild alive well beyond this test's timeout. A short
        // sleep can finish naturally when the full suite heavily loads the
        // worker, making the wrapper correctly return 0 before TERM is sent.
        "trap 'exit 0' TERM; sleep 30 & printf '%s\\n' $! > \"$LOCK_RUN_TEST_PID_FILE\"; wait",
      ]);

      const deadline = Date.now() + 5_000;
      while (!existsSync(grandchildPidFile) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(grandchildPidFile)).toBe(true);
      const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, 'utf-8').trim(), 10);

      const signalStartedAt = Date.now();
      process.emit('SIGTERM', 'SIGTERM');
      const result = await run;

      expect(result).toBe(143);
      expect(Date.now() - signalStartedAt).toBeLessThan(1_500);
      expect(() => process.kill(grandchildPid, 0)).toThrow();
      delete process.env.LOCK_RUN_TEST_PID_FILE;
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'returns 130 when a child handles SIGINT and exits zero',
    async () => {
      const readyFile = join(tempDir, 'sigint-ready');
      const run = runCommandWithLlmLock([
        process.execPath,
        '-e',
        `process.on('SIGINT', () => process.exit(0)); require('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 30_000)`,
      ]);

      const deadline = Date.now() + 5_000;
      while (!existsSync(readyFile) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(readyFile)).toBe(true);

      process.emit('SIGINT', 'SIGINT');

      await expect(run).resolves.toBe(130);
      expect(existsSync(lockPath)).toBe(false);
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'waits for the Windows tree termination attempt before releasing the lock',
    async () => {
      const taskkillPids: number[] = [];
      const run = runCommandWithLlmLock([
        process.execPath,
        '-e',
        'setInterval(() => {}, 30_000)',
      ], {
        platform: 'win32',
        runTaskkill(_command, args) {
          expect(existsSync(lockPath)).toBe(true);
          const pid = Number.parseInt(args[1], 10);
          taskkillPids.push(pid);
          process.kill(pid, 'SIGTERM');
          return { status: 0 };
        },
      });

      process.emit('SIGTERM', 'SIGTERM');
      const result = await run;

      expect(result).toBe(143);
      expect(taskkillPids.length).toBeGreaterThanOrEqual(1);
      expect(new Set(taskkillPids).size).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
    },
    10_000,
  );

  it('rejects an empty command without creating the lock', async () => {
    await expect(runCommandWithLlmLock([])).rejects.toThrow(/command is required/i);
    expect(existsSync(lockPath)).toBe(false);
  });
});
