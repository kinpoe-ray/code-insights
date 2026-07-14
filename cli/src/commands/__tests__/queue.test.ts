import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processQueue = vi.hoisted(() => vi.fn());

vi.mock('../../analysis/queue-worker.js', () => ({
  PROCESS_QUEUE_BUSY: -1,
  PROCESS_QUEUE_FAILED: -2,
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
    processQueue.mockResolvedValue(0);
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
    processQueue.mockResolvedValue(-1);

    await queueProcessCommand({ quiet: true });

    expect(process.exitCode).toBe(75);
  });

  it('returns failure when a claimed queue item could not be analyzed', async () => {
    processQueue.mockResolvedValue(-2);

    await queueProcessCommand({ quiet: true });

    expect(process.exitCode).toBe(1);
  });
});
