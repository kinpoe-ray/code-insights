import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const boundaries = vi.hoisted(() => ({
  syncSingleFile: vi.fn(),
  enqueue: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('../sync.js', () => ({ syncSingleFile: boundaries.syncSingleFile }));
vi.mock('../../db/queue.js', () => ({ enqueue: boundaries.enqueue }));
vi.mock('child_process', () => ({ spawn: boundaries.spawn }));

describe('session-end automatic hook', () => {
  let configDir: string;
  const originalConfigDir = process.env.CODE_INSIGHTS_CONFIG_DIR;
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'code-insights-session-end-'));
    process.env.CODE_INSIGHTS_CONFIG_DIR = configDir;
    delete process.env.CODE_INSIGHTS_HOOK_ACTIVE;
    boundaries.syncSingleFile.mockReset();
    boundaries.enqueue.mockReset();
    boundaries.spawn.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.CODE_INSIGHTS_CONFIG_DIR;
    else process.env.CODE_INSIGHTS_CONFIG_DIR = originalConfigDir;
    delete process.env.CODE_INSIGHTS_HOOK_ACTIVE;
    vi.restoreAllMocks();
    if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
  });

  it('does not sync, enqueue, or start a worker while automatic maintenance is paused', async () => {
    writeFileSync(join(configDir, 'maintenance.paused'), '', { mode: 0o600 });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation((event, listener) => {
      if (event === 'data') {
        (listener as (chunk: string) => void)(JSON.stringify({
          session_id: 'paused-session',
          transcript_path: '/tmp/paused-session.jsonl',
        }));
      } else if (event === 'end') {
        (listener as () => void)();
      }
      return process.stdin;
    });

    const { sessionEndCommand } = await import('../session-end.js');
    await sessionEndCommand({ quiet: true });

    expect(boundaries.syncSingleFile).not.toHaveBeenCalled();
    expect(boundaries.enqueue).not.toHaveBeenCalled();
    expect(boundaries.spawn).not.toHaveBeenCalled();
  });

  it('continues automatic sync and analysis after maintenance is resumed', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation((event, listener) => {
      if (event === 'data') {
        (listener as (chunk: string) => void)(JSON.stringify({
          session_id: 'active-session',
          transcript_path: '/tmp/active-session.jsonl',
        }));
      } else if (event === 'end') {
        (listener as () => void)();
      }
      return process.stdin;
    });

    const { sessionEndCommand } = await import('../session-end.js');
    await sessionEndCommand({ quiet: true });

    expect(boundaries.syncSingleFile).toHaveBeenCalledWith({
      filePath: '/tmp/active-session.jsonl',
      quiet: true,
      sourceTool: undefined,
    });
    expect(boundaries.enqueue).toHaveBeenCalledWith('active-session', 'native');
    expect(boundaries.spawn).toHaveBeenCalledOnce();
  });
});
