import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processQueue = vi.hoisted(() => vi.fn());

vi.mock('../../analysis/queue-worker.js', () => ({
  processQueue,
}));
vi.mock('../../db/queue.js', () => ({
  getQueueStatus: vi.fn(),
  resetFailed: vi.fn(),
  pruneCompleted: vi.fn(),
}));

import { buildQueueCommand, queueProcessCommand } from '../queue.js';

describe('queue process command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    processQueue.mockResolvedValue({
      status: 'completed',
      completedCount: 0,
      rerunPendingCount: 0,
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('exposes limit and delay flags and forwards a seconds delay as milliseconds', async () => {
    const command = buildQueueCommand();
    const processCommand = command.commands.find((candidate) => candidate.name() === 'process');

    expect(processCommand?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--limit', '--delay']),
    );

    await queueProcessCommand({
      quiet: true,
      model: 'sonnet',
      limit: 5,
      delay: 10,
    });

    expect(processQueue).toHaveBeenCalledWith({
      quiet: true,
      model: 'sonnet',
      maxItems: 5,
      delayMs: 10_000,
    });
  });

  it('sets a recognizable temporary-failure exit code when the LLM lock is busy', async () => {
    processQueue.mockResolvedValue({
      status: 'busy',
      completedCount: 0,
      rerunPendingCount: 0,
    });

    await queueProcessCommand({ quiet: true });

    expect(process.exitCode).toBe(75);
  });

  it('sets a temporary-failure exit code when durable work is deferred', async () => {
    processQueue.mockResolvedValue({
      status: 'deferred',
      completedCount: 0,
      rerunPendingCount: 0,
      nextAttemptAt: '2026-07-18 13:00:30',
    });

    await queueProcessCommand({ quiet: true });

    expect(process.exitCode).toBe(75);
  });

  it('reports an intentional pause without treating retained work as a failure', async () => {
    processQueue.mockResolvedValue({
      status: 'paused',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queueProcessCommand();

    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('paused');
  });

  it('reports the maintenance deadline without treating retained work as a failure', async () => {
    processQueue.mockResolvedValue({
      status: 'deadline',
      completedCount: 1,
      rerunPendingCount: 0,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queueProcessCommand();

    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('deadline');
  });

  it('returns failure when a claimed queue item could not be analyzed', async () => {
    processQueue.mockResolvedValue({
      status: 'failed',
      completedCount: 0,
      rerunPendingCount: 0,
    });

    await queueProcessCommand({ quiet: true });

    expect(process.exitCode).toBe(1);
  });
});
