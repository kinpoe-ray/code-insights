/**
 * Shared SSE parsing utility for fetch()-based streaming.
 * Uses fetch() + ReadableStream (not EventSource) to support AbortController.
 */

export interface ParsedSSEEvent {
  event: string;
  data: string;
}

/**
 * Parse SSE events from a byte stream.
 *
 * TextDecoder streaming preserves split UTF-8 code points. A final decoder
 * flush and synthetic blank line dispatch an event even when the server closes
 * without SSE's customary trailing blank line.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let dataLines: string[] = [];
  let reachedEnd = false;

  const consumeLine = (rawLine: string): ParsedSSEEvent | null => {
    const line = rawLine.endsWith('\r')
      ? rawLine.slice(0, -1)
      : rawLine;
    if (line === '') {
      if (dataLines.length === 0) {
        currentEvent = '';
        return null;
      }
      const event = {
        event: currentEvent || 'message',
        data: dataLines.join('\n'),
      };
      currentEvent = '';
      dataLines = [];
      return event;
    }
    if (line.startsWith(':')) return null;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') currentEvent = value;
    if (field === 'data') dataLines.push(value);
    return null;
  };

  const cancelOnAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', cancelOnAbort, { once: true });
  if (signal?.aborted) cancelOnAbort();

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const event = consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
        newline = buffer.indexOf('\n');
      }
    }

    if (!signal?.aborted) {
      if (buffer.length > 0) {
        const event = consumeLine(buffer);
        if (event) yield event;
      }
      const finalEvent = consumeLine('');
      if (finalEvent) yield finalEvent;
    }
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
    if (!reachedEnd) {
      await reader.cancel(signal?.reason).catch(() => {});
    }
    reader.releaseLock();
  }
}
