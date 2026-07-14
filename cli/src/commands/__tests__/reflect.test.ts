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

async function runReflectWith(stream: Response): Promise<void> {
  mockFetch
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
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

  it('uses CODE_INSIGHTS_DASHBOARD_URL before the configured port', async () => {
    process.env.CODE_INSIGHTS_DASHBOARD_URL = 'http://127.0.0.1:9123/';
    process.env.CODE_INSIGHTS_LOCK_TOKEN = 'delegated-maintenance-token';
    const stream = sseResponse(
      'event: complete\n' +
      'data: {"results":{"friction-wins":{"narrative":"Done"}}}\n\n',
    );

    await runReflectWith(stream);

    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9123/api/health');
    expect(mockFetch.mock.calls[2]?.[0]).toBe('http://127.0.0.1:9123/api/reflect/generate');
    expect((mockFetch.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      'x-code-insights-lock-token': 'delegated-maintenance-token',
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

  async function runBackfillWith(stream: Response): Promise<void> {
    mockFetch.mockResolvedValueOnce(stream);
    const module = await import('../reflect.js') as typeof import('../reflect.js') & {
      backfillBatchToEndpoint(
        baseUrl: string,
        endpoint: string,
        sessionIds: string[],
        offset: number,
        total: number,
      ): Promise<{ completed: number; failed: number }>;
    };
    await module.backfillBatchToEndpoint(
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
});
