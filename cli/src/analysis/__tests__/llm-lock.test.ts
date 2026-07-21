import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const testState = vi.hoisted(() => ({ home: '' }));
const processBoundary = vi.hoisted(() => ({
  startTime: 'Sat Jul 18 12:00:00 2026',
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => testState.home };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args?: readonly string[], options?: unknown) => {
      const isMacProcessStartQuery = command === '/bin/ps'
        && args?.[0] === '-o'
        && args?.[1] === 'lstart='
        && args?.[2] === '-p'
        && /^\d+$/.test(args?.[3] ?? '');
      if (isMacProcessStartQuery) {
        const stdout = `${processBoundary.startTime}\n`;
        return {
          pid: process.pid,
          output: [null, stdout, ''],
          stdout,
          stderr: '',
          status: 0,
          signal: null,
        };
      }

      // Dead-owner tests still use a real child process. Only the OS process
      // birth query is controlled because /bin/ps is unavailable in sandboxed
      // macOS test runners.
      return Reflect.apply(actual.spawnSync, actual, [command, args, options]);
    }),
  };
});

import { acquireLlmLock, isLlmLockTokenOwner } from '../llm-lock.js';

describe('LLM process lock', () => {
  beforeEach(() => {
    testState.home = mkdtempSync(join(tmpdir(), 'code-insights-llm-lock-'));
    delete process.env.CODE_INSIGHTS_LOCK_HELD;
    delete process.env.CODE_INSIGHTS_CONFIG_DIR;
    delete process.env.CODE_INSIGHTS_LLM_LOCK_DIR;
    delete process.env.CODE_INSIGHTS_LOCK_TOKEN;
  });

  afterEach(() => {
    rmSync(testState.home, { recursive: true, force: true });
    delete process.env.CODE_INSIGHTS_LOCK_HELD;
    delete process.env.CODE_INSIGHTS_CONFIG_DIR;
    delete process.env.CODE_INSIGHTS_LLM_LOCK_DIR;
    delete process.env.CODE_INSIGHTS_LOCK_TOKEN;
  });

  it('creates an unguessable ownership token that can validate delegated work', () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');

    const lock = acquireLlmLock();

    expect(lock?.token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(readFileSync(join(lockPath, 'token'), 'utf-8').trim()).toBe(lock?.token);
    expect(isLlmLockTokenOwner(lock?.token)).toBe(true);
    expect(isLlmLockTokenOwner('wrong-token')).toBe(false);
    lock?.release();
    expect(isLlmLockTokenOwner(lock?.token)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('keeps process birth identity stable across caller environments', () => {
    const previousLocale = process.env.LC_ALL;
    const previousTimezone = process.env.TZ;
    const previousPath = process.env.PATH;
    const fakeBin = join(testState.home, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nprintf "different-ps-identity\\n"\n');
    chmodSync(join(fakeBin, 'ps'), 0o700);
    let lock: ReturnType<typeof acquireLlmLock> = null;
    try {
      process.env.LC_ALL = 'C';
      process.env.TZ = 'UTC';
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
      lock = acquireLlmLock();
      expect(lock).not.toBeNull();

      process.env.LC_ALL = 'zh_CN.UTF-8';
      process.env.TZ = 'Asia/Shanghai';
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
      expect(isLlmLockTokenOwner(lock?.token)).toBe(true);
      expect(acquireLlmLock()).toBeNull();
    } finally {
      lock?.release();
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('rejects a stale capability after its owner process has exited', () => {
    const deadProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), `${deadProcess.pid}\n`);
    writeFileSync(join(lockPath, 'token'), 'stale-token\n');

    expect(isLlmLockTokenOwner('stale-token')).toBe(false);
  });

  it('reclaims a lock owned by a dead process', () => {
    const deadProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(deadProcess.pid).toBeTypeOf('number');

    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), `${deadProcess.pid}\n`);

    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, 'pid'), 'utf-8').trim()).toBe(String(process.pid));
    lock?.release();
  });

  it('reclaims a stale lock after its PID has been reused by another process', () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), `${process.pid}\n`);
    writeFileSync(join(lockPath, 'process-start'), 'a-different-process-birth\n');
    writeFileSync(join(lockPath, 'token'), 'stale-token\n');

    expect(isLlmLockTokenOwner('stale-token')).toBe(false);
    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(readFileSync(join(lockPath, 'token'), 'utf-8').trim()).not.toBe('stale-token');
    lock?.release();
  });

  it('inherits a parent-held lock without releasing the parent lock', () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), `${process.pid}\n`);
    writeFileSync(join(lockPath, 'token'), 'parent-token\n');
    process.env.CODE_INSIGHTS_LOCK_HELD = '1';
    process.env.CODE_INSIGHTS_LOCK_TOKEN = 'parent-token';

    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(lock?.token).toBe('parent-token');
    lock?.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, 'pid'), 'utf-8').trim()).toBe(String(process.pid));
  });

  it('fails closed when an inherited marker no longer has a live owning lock', () => {
    process.env.CODE_INSIGHTS_LOCK_HELD = '1';
    process.env.CODE_INSIGHTS_LOCK_TOKEN = 'orphaned-token';

    expect(acquireLlmLock()).toBeNull();
  });

  it('does not release a lock whose owner PID no longer matches', () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    const lock = acquireLlmLock();
    expect(lock).not.toBeNull();

    const replacementPid = process.pid + 1;
    writeFileSync(join(lockPath, 'pid'), `${replacementPid}\n`);

    lock?.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, 'pid'), 'utf-8').trim()).toBe(String(replacementPid));
  });

  it('does not release a replacement lock owned by the same process with a new token', () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    const original = acquireLlmLock();
    expect(original).not.toBeNull();

    // Simulate external cleanup followed by a fresh acquisition before the old
    // handle reaches its finally block. PID alone cannot distinguish the two.
    rmSync(lockPath, { recursive: true, force: true });
    const replacement = acquireLlmLock();
    expect(replacement).not.toBeNull();
    expect(replacement?.token).not.toBe(original?.token);

    original?.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, 'token'), 'utf-8').trim()).toBe(replacement?.token);
    replacement?.release();
  });

  it('places the lock under CODE_INSIGHTS_CONFIG_DIR when configured', () => {
    const configDir = join(testState.home, 'custom-config');
    const expectedLockPath = join(configDir, 'locks', 'llm.lock');
    process.env.CODE_INSIGHTS_CONFIG_DIR = configDir;

    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(existsSync(expectedLockPath)).toBe(true);
    lock?.release();
  });

  it('prefers CODE_INSIGHTS_LLM_LOCK_DIR over the configured config directory', () => {
    const explicitLockPath = join(testState.home, 'shared-lock', 'llm.lock');
    process.env.CODE_INSIGHTS_CONFIG_DIR = join(testState.home, 'custom-config');
    process.env.CODE_INSIGHTS_LLM_LOCK_DIR = explicitLockPath;

    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(existsSync(explicitLockPath)).toBe(true);
    lock?.release();
  });

  it('does not reclaim a stale lock while another process owns the recovery guard', () => {
    const deadProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    const recoveryPath = `${lockPath}.reclaim`;
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), `${deadProcess.pid}\n`);
    mkdirSync(recoveryPath);
    writeFileSync(join(recoveryPath, 'pid'), `${process.pid}\n`);

    const lock = acquireLlmLock();

    expect(lock).toBeNull();
    expect(readFileSync(join(lockPath, 'pid'), 'utf-8').trim()).toBe(String(deadProcess.pid));
  });

  it('reclaims an ownerless lock after the PID-write grace period', () => {
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    mkdirSync(lockPath, { recursive: true });
    const oldTimestamp = new Date(Date.now() - 120_000);
    utimesSync(lockPath, oldTimestamp, oldTimestamp);

    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(readFileSync(join(lockPath, 'pid'), 'utf-8').trim()).toBe(String(process.pid));
    lock?.release();
  });

  it('reclaims a recovery guard owned by a dead process', () => {
    const deadMain = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadRecovery = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const lockPath = join(testState.home, '.code-insights', 'locks', 'llm.lock');
    const recoveryPath = `${lockPath}.reclaim`;
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'pid'), `${deadMain.pid}\n`);
    mkdirSync(recoveryPath);
    writeFileSync(join(recoveryPath, 'pid'), `${deadRecovery.pid}\n`);

    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(readFileSync(join(lockPath, 'pid'), 'utf-8').trim()).toBe(String(process.pid));
    expect(existsSync(recoveryPath)).toBe(false);
    lock?.release();
  });
});
