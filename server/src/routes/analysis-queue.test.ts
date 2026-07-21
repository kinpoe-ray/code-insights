import { beforeEach, describe, expect, it, vi } from 'vitest';
const enqueueBatch = vi.hoisted(() => vi.fn());
const getQueueStatus = vi.hoisted(() => vi.fn());
const QueueBatchValidationError = vi.hoisted(() => (
  class QueueBatchValidationError extends Error {
    readonly invalidSessionIds: string[];

    constructor(message: string, invalidSessionIds: string[] = []) {
      super(message);
      this.invalidSessionIds = invalidSessionIds;
    }
  }
));

vi.mock('@code-insights/cli/db/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@code-insights/cli/db/queue')>();
  return {
    ...actual,
    enqueueBatch,
    getQueueStatus,
    QueueBatchValidationError,
  };
});

const { createAnalysisQueueRouter } = await import('./analysis-queue.js');

describe('analysis queue routes', () => {
  beforeEach(() => {
    enqueueBatch.mockReset();
    getQueueStatus.mockReset();
  });

  it('returns the current durable queue status', async () => {
    const status = {
      pending: 1,
      processing: 0,
      completed: 2,
      failed: 0,
      nextAttemptAt: '2026-07-18 13:00:30',
      items: [],
    };
    getQueueStatus.mockReturnValue(status);
    const app = createAnalysisQueueRouter({ wake: vi.fn() });

    const response = await app.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it('enqueues one provider batch, returns a 202 receipt, and wakes once', async () => {
    const order: string[] = [];
    enqueueBatch.mockImplementation(() => {
      order.push('committed');
      return {
        sessionIds: ['session-1', 'session-2'],
        queued: 1,
        alreadyActive: 1,
        enqueuedAt: '2026-07-18 12:00:00',
      };
    });
    const wake = vi.fn(() => {
      order.push('woken');
    });
    const app = createAnalysisQueueRouter({ wake });

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionIds: ['session-1', 'session-2', 'session-1'],
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      batch: {
        sessionIds: ['session-1', 'session-2'],
        queued: 1,
        alreadyActive: 1,
        enqueuedAt: '2026-07-18 12:00:00',
      },
    });
    expect(enqueueBatch).toHaveBeenCalledOnce();
    expect(enqueueBatch).toHaveBeenCalledWith(
      ['session-1', 'session-2', 'session-1'],
      'provider',
    );
    expect(wake).toHaveBeenCalledOnce();
    expect(order).toEqual(['committed', 'woken']);
  });

  it.each([
    { body: {}, label: 'a missing sessionIds field' },
    { body: { sessionIds: [] }, label: 'an empty batch' },
    { body: { sessionIds: 'session-1' }, label: 'a non-array batch' },
    { body: { sessionIds: ['session-1', 42] }, label: 'a non-string id' },
    {
      body: {
        sessionIds: Array.from(
          { length: 501 },
          (_, index) => `session-${index}`,
        ),
      },
      label: 'more than 500 ids',
    },
  ])('rejects $label without enqueueing or waking', async ({ body }) => {
    const wake = vi.fn();
    const app = createAnalysisQueueRouter({ wake });

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(enqueueBatch).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('does not accept an HTTP-selected runner', async () => {
    const wake = vi.fn();
    const app = createAnalysisQueueRouter({ wake });

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionIds: ['session-1'],
        runner: 'native',
      }),
    });

    expect(response.status).toBe(400);
    expect(enqueueBatch).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('only accepts sessionIds as the request body key', async () => {
    const wake = vi.fn();
    const app = createAnalysisQueueRouter({ wake });

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionIds: ['session-1'],
        unexpected: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(enqueueBatch).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('rejects a missing or deleted session atomically without waking', async () => {
    enqueueBatch.mockImplementation(() => {
      throw new QueueBatchValidationError(
        'Sessions are missing or deleted: missing',
        ['missing'],
      );
    });
    const wake = vi.fn();
    const app = createAnalysisQueueRouter({ wake });

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['valid', 'missing'] }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Sessions are missing or deleted',
      sessionIds: ['missing'],
    });
    expect(wake).not.toHaveBeenCalled();
  });
});
