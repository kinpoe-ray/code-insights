import { describe, expect, it, vi } from 'vitest';
import { parseSSEStream } from './sse';

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = [];
  for await (const event of parseSSEStream(stream)) events.push(event);
  return events;
}

describe('parseSSEStream', () => {
  it('decodes split UTF-8 and flushes a final event without a blank line', async () => {
    const bytes = new TextEncoder().encode(
      'event: progress\ndata: 你好🙂\n\n'
      + 'event: done\ndata: 完成',
    );
    const emojiStart = bytes.findIndex(
      (value, index) => value === 0xf0 && bytes[index + 1] === 0x9f,
    );
    const chunks = [
      bytes.slice(0, emojiStart + 1),
      bytes.slice(emojiStart + 1, bytes.length - 1),
      bytes.slice(bytes.length - 1),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    await expect(collect(stream)).resolves.toEqual([
      { event: 'progress', data: '你好🙂' },
      { event: 'done', data: '完成' },
    ]);
    expect(stream.locked).toBe(false);
  });

  it('cancels a pending read on abort and releases the reader lock', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: progress\ndata: first\n\n'),
        );
      },
      cancel,
    });
    const controller = new AbortController();
    const events = parseSSEStream(stream, controller.signal);

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { event: 'progress', data: 'first' },
    });
    const pending = events.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('releases the reader when the consumer stops early', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: progress\ndata: first\n\n'),
        );
      },
    });
    const events = parseSSEStream(stream);

    await events.next();
    await events.return(undefined);

    expect(stream.locked).toBe(false);
  });
});
