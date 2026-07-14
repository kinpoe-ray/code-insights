import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireServerLlmLock } from './llm-lock.js';
import { acquireLlmLock } from '@code-insights/cli/analysis/llm-lock';

let lockTestDir: string | undefined;

afterEach(() => {
  delete process.env.CODE_INSIGHTS_LOCK_HELD;
  delete process.env.CODE_INSIGHTS_LOCK_TOKEN;
  delete process.env.CODE_INSIGHTS_LLM_LOCK_DIR;
  if (lockTestDir) rmSync(lockTestDir, { recursive: true, force: true });
  lockTestDir = undefined;
});

describe('server LLM lock', () => {
  it('serializes requests inside a server that inherited its parent lock', () => {
    lockTestDir = mkdtempSync(join(tmpdir(), 'code-insights-server-inherited-lock-'));
    process.env.CODE_INSIGHTS_LLM_LOCK_DIR = join(lockTestDir, 'llm.lock');
    const parentLock = acquireLlmLock();
    expect(parentLock).not.toBeNull();
    process.env.CODE_INSIGHTS_LOCK_HELD = '1';
    process.env.CODE_INSIGHTS_LOCK_TOKEN = parentLock?.token;

    const first = acquireServerLlmLock();
    expect(first).not.toBeNull();

    try {
      expect(acquireServerLlmLock()).toBeNull();
    } finally {
      first?.release();
    }

    const afterRelease = acquireServerLlmLock();
    expect(afterRelease).not.toBeNull();
    afterRelease?.release();
    parentLock?.release();
  });

  it('releases the underlying cross-process lock', () => {
    lockTestDir = mkdtempSync(join(tmpdir(), 'code-insights-server-lock-'));
    process.env.CODE_INSIGHTS_LLM_LOCK_DIR = join(lockTestDir, 'llm.lock');

    const first = acquireServerLlmLock();
    expect(first).not.toBeNull();
    expect(acquireServerLlmLock()).toBeNull();
    first?.release();

    const afterRelease = acquireServerLlmLock();
    expect(afterRelease).not.toBeNull();
    afterRelease?.release();
  });
});
