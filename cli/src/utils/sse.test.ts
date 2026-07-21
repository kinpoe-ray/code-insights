import { describe, expect, it, vi } from 'vitest';
import { parseSSEStream } from './sse.js';

describe('CLI parseSSEStream', () => {
  it('decodes split UTF-8 and dispatches error/complete at EOF', async () => {
    const bytes = new TextEncoder().encode(
      'event: error\ndata: {"error":"失败🙂"}\n\n'
      + 'event: complete\ndata: {"completed":2,"failed":0}',
    );
    const emojiStart = bytes.findIndex(
      (value, index) => value === 0xf0 && bytes[index + 1] === 0x9f,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, emojiStart + 2));
        controller.enqueue(bytes.slice(emojiStart + 2));
        controller.close();
      },
    });
    const events: Array<{ event: string; data: string }> = [];

    for await (const event of parseSSEStream(stream)) events.push(event);

    expect(events).toEqual([
      { event: 'error', data: '{"error":"失败🙂"}' },
      { event: 'complete', data: '{"completed":2,"failed":0}' },
    ]);
    expect(stream.locked).toBe(false);
  });

  it('cancels a pending read on abort and releases the lock', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const events = parseSSEStream(stream, controller.signal);
    const pending = events.next();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
