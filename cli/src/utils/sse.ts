export interface ParsedSSEEvent {
  event: string;
  data: string;
}

/**
 * Parse an SSE byte stream without assuming chunk or UTF-8 boundaries.
 * The optional signal cancels a pending read and the reader lock is always
 * released, including early consumer return.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let reachedEnd = false;

  const consumeLine = (rawLine: string): ParsedSSEEvent | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      if (dataLines.length === 0) {
        eventName = '';
        return null;
      }
      const event = {
        event: eventName || 'message',
        data: dataLines.join('\n'),
      };
      eventName = '';
      dataLines = [];
      return event;
    }
    if (line.startsWith(':')) return null;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
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
