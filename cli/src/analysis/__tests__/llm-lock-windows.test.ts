import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockSpawnSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }));

import { acquireLlmLock } from '../llm-lock.js';

describe('LLM process lock on Windows', () => {
  let tempDir: string;
  let platformSpy: ReturnType<typeof vi.spyOn>;
  let previousSystemRoot: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-insights-llm-lock-win32-'));
    process.env.CODE_INSIGHTS_LLM_LOCK_DIR = join(tempDir, 'llm.lock');
    previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = 'D:\\Windows';
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '638881234567890000\n' });
  });

  afterEach(() => {
    platformSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.CODE_INSIGHTS_LLM_LOCK_DIR;
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    mockSpawnSync.mockReset();
  });

  it('uses the system PowerShell executable instead of caller PATH resolution', () => {
    const lock = acquireLlmLock();

    expect(lock).not.toBeNull();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.any(Array),
      expect.objectContaining({ windowsHide: true }),
    );
    lock?.release();
  });
});
