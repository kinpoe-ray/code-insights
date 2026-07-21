import { beforeEach, describe, expect, it, vi } from 'vitest';

const dashboardFetch = vi.hoisted(() => vi.fn());

vi.mock('./dashboard-http', () => ({ dashboardFetch }));

const { backfillFacets } = await import('./api');

describe('backfillFacets SSE transport', () => {
  beforeEach(() => {
    dashboardFetch.mockReset();
  });

  it('uses the shared byte parser for split UTF-8 and EOF completion', async () => {
    const bytes = new TextEncoder().encode(
      'event: progress\ndata: {"message":"提取🙂"}\n\n'
      + 'event: complete\ndata: {"completed":2,"failed":1}',
    );
    const emojiStart = bytes.findIndex(
      (value, index) => value === 0xf0 && bytes[index + 1] === 0x9f,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, emojiStart + 1));
        controller.enqueue(bytes.slice(emojiStart + 1));
        controller.close();
      },
    });
    dashboardFetch.mockResolvedValue(new Response(stream, { status: 200 }));

    await expect(backfillFacets(['session-1', 'session-2'])).resolves.toEqual({
      completed: 2,
      failed: 1,
    });
    expect(stream.locked).toBe(false);
    expect(dashboardFetch).toHaveBeenCalledWith(
      '/api/facets/backfill',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sessionIds: ['session-1', 'session-2'],
        }),
      }),
    );
  });

  it('surfaces an SSE error event instead of reporting zero work', async () => {
    dashboardFetch.mockResolvedValue(new Response(
      'event: error\ndata: {"error":"provider unavailable"}',
      { status: 200 },
    ));

    await expect(backfillFacets(['session-1'])).rejects.toThrow(
      'provider unavailable',
    );
  });

  it('cancels and unlocks the stream when aborted', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    dashboardFetch.mockResolvedValue(new Response(stream, { status: 200 }));
    const controller = new AbortController();

    const pending = backfillFacets(['session-1'], controller.signal);
    controller.abort(new DOMException('User aborted backfill', 'AbortError'));

    await expect(pending).rejects.toThrow(/aborted backfill/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(dashboardFetch).toHaveBeenCalledWith(
      '/api/facets/backfill',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
