import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/config.js', () => ({
  loadConfig: () => ({ dashboard: { port: 7890 } }),
}));

vi.mock('ora', () => ({
  default: () => {
    const spinner = {
      text: '',
      start: () => spinner,
      succeed: vi.fn(),
      fail: vi.fn(),
    };
    return spinner;
  },
}));

const mockFetch = vi.fn();

function sseResponse(events: string): Response {
  return new Response(events, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function chunkedSseResponse(events: string, splitAt: number): Response {
  const bytes = new TextEncoder().encode(events);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, splitAt));
      controller.enqueue(bytes.slice(splitAt));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sessionResponse(token = 'cli-dashboard-session'): Response {
  return new Response(null, {
    status: 204,
    headers: { 'X-Code-Insights-Session': token },
  });
}

async function runReflectWith(stream: Response): Promise<void> {
  mockFetch
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(sessionResponse())
    .mockResolvedValueOnce(new Response(JSON.stringify({
      totalSessions: 8,
      totalAllSessions: 8,
    }), { status: 200 }))
    .mockResolvedValueOnce(stream);

  const { reflectCommand } = await import('../reflect.js');
  await reflectCommand.parseAsync([
    'node',
    'code-insights',
    '--week',
    '2026-W29',
  ]);
}

describe('reflect command SSE completion', () => {
  const originalDashboardUrl = process.env.CODE_INSIGHTS_DASHBOARD_URL;
  const originalLockToken = process.env.CODE_INSIGHTS_LOCK_TOKEN;

  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.CODE_INSIGHTS_DASHBOARD_URL;
    delete process.env.CODE_INSIGHTS_LOCK_TOKEN;
  });

  afterEach(() => {
    if (originalDashboardUrl === undefined) {
      delete process.env.CODE_INSIGHTS_DASHBOARD_URL;
    } else {
      process.env.CODE_INSIGHTS_DASHBOARD_URL = originalDashboardUrl;
    }
    if (originalLockToken === undefined) {
      delete process.env.CODE_INSIGHTS_LOCK_TOKEN;
    } else {
      process.env.CODE_INSIGHTS_LOCK_TOKEN = originalLockToken;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects when the server sends an SSE error event', async () => {
    const stream = sseResponse(
      'event: error\n' +
      'data: {"error":"LLM provider unavailable"}\n\n',
    );

    await expect(runReflectWith(stream)).rejects.toThrow('LLM provider unavailable');
  });

  it('rejects when the SSE stream ends without a complete event', async () => {
    const stream = sseResponse(
      'event: progress\n' +
      'data: {"message":"Synthesizing..."}\n\n',
    );

    await expect(runReflectWith(stream)).rejects.toThrow(/ended without a complete event/i);
  });

  it('resolves when the server sends a complete event', async () => {
    const stream = sseResponse(
      'event: complete\n' +
      'data: {"results":{"friction-wins":{"narrative":"Done"}}}\n\n',
    );

    await expect(runReflectWith(stream)).resolves.toBeUndefined();
  });

  it('handles split UTF-8 and a complete event without a trailing blank line', async () => {
    const payload =
      'event: progress\ndata: {"message":"综合🙂"}\n\n'
      + 'event: complete\ndata: {"results":{"friction-wins":{"narrative":"完成"}}}';
    const bytes = new TextEncoder().encode(payload);
    const emojiStart = bytes.findIndex(
      (value, index) => value === 0xf0 && bytes[index + 1] === 0x9f,
    );

    await expect(runReflectWith(
      chunkedSseResponse(payload, emojiStart + 1),
    )).resolves.toBeUndefined();
  });

  it('uses CODE_INSIGHTS_DASHBOARD_URL before the configured port', async () => {
    process.env.CODE_INSIGHTS_DASHBOARD_URL = 'http://127.0.0.1:9123/';
    process.env.CODE_INSIGHTS_LOCK_TOKEN = 'delegated-maintenance-token';
    const stream = sseResponse(
      'event: complete\n' +
      'data: {"results":{"friction-wins":{"narrative":"Done"}}}\n\n',
    );

    await runReflectWith(stream);

    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9123/api/health');
    expect(mockFetch.mock.calls[1]?.[0]).toBe('http://127.0.0.1:9123/api/session');
    expect(mockFetch.mock.calls[3]?.[0]).toBe('http://127.0.0.1:9123/api/reflect/generate');
    const headers = new Headers((mockFetch.mock.calls[3]?.[1] as RequestInit).headers);
    expect(headers.get('x-code-insights-lock-token')).toBe('delegated-maintenance-token');
    expect(headers.get('x-code-insights-session')).toBe('cli-dashboard-session');
  });

  it('passes --source to the aggregation check and generation request', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        totalSessions: 8,
        totalAllSessions: 8,
      }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse(
        'event: complete\n' +
        'data: {"results":{"friction-wins":{"narrative":"Done"}}}\n\n',
      ));

    const { reflectCommand } = await import('../reflect.js');
    await reflectCommand.parseAsync([
      'node',
      'code-insights',
      '--week',
      '2026-W29',
      '--source',
      'codex-cli',
    ]);

    const aggregationUrl = new URL(String(mockFetch.mock.calls[2]?.[0]));
    expect(aggregationUrl.pathname).toBe('/api/facets/aggregated');
    expect(aggregationUrl.searchParams.get('source')).toBe('codex-cli');

    const generationOptions = mockFetch.mock.calls[3]?.[1] as RequestInit;
    expect(JSON.parse(String(generationOptions.body))).toMatchObject({
      period: '2026-W29',
      source: 'codex-cli',
    });
  });
});

describe('reflect backfill SSE completion', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function runBackfillWith(
    stream: Response,
  ): Promise<{ completed: number; failed: number }> {
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(stream);
    const module = await import('../reflect.js') as typeof import('../reflect.js') & {
      backfillBatchToEndpoint(
        baseUrl: string,
        endpoint: string,
        sessionIds: string[],
        offset: number,
        total: number,
      ): Promise<{ completed: number; failed: number }>;
    };
    return module.backfillBatchToEndpoint(
      'http://localhost:7890',
      '/api/facets/backfill',
      ['session-1'],
      0,
      1,
    );
  }

  it('rejects a busy/error event instead of reporting a zero-work success', async () => {
    const stream = sseResponse(
      'event: error\n' +
      'data: {"error":"Another operation is running","code":"LLM_BUSY"}\n\n',
    );

    await expect(runBackfillWith(stream)).rejects.toThrow('Another operation is running');
  });

  it('rejects a truncated backfill stream without a complete event', async () => {
    const stream = sseResponse(
      'event: progress\n' +
      'data: {"completed":0,"failed":0}\n\n',
    );

    await expect(runBackfillWith(stream)).rejects.toThrow(/without a complete event/i);
  });

  it('returns the complete backfill result at EOF without a blank line', async () => {
    const stream = sseResponse(
      'event: complete\n'
      + 'data: {"completed":2,"failed":1}',
    );

    await expect(runBackfillWith(stream)).resolves.toEqual({
      completed: 2,
      failed: 1,
    });
  });
});
