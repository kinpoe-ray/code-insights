import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../data/source.js', () => ({
  resolveDataSource: vi.fn(async () => ({
    name: 'test',
    prepare: vi.fn(),
  })),
}));

vi.mock('../../../utils/config.js', () => ({
  loadConfig: () => ({ dashboard: { port: 7890 } }),
}));

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('patternsAction dashboard transport', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps health public and authenticates results and snapshot requests', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: { 'X-Code-Insights-Session': 'stats-session' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        frictionCategories: [],
        effectivePatterns: [],
        outcomeDistribution: {},
        workflowDistribution: {},
        characterDistribution: {},
        totalSessions: 1,
        frictionTotal: 0,
        totalAllSessions: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({ snapshot: null }));

    const { patternsAction } = await import('./patterns.js');
    await patternsAction({
      period: 'all',
      source: 'codex-cli',
      noSync: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:7890/api/health');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:7890/api/session');

    const resultsUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    const snapshotUrl = new URL(String(fetchMock.mock.calls[3]?.[0]));
    expect(resultsUrl.pathname).toBe('/api/reflect/results');
    expect(resultsUrl.searchParams.get('source')).toBe('codex-cli');
    expect(snapshotUrl.pathname).toBe('/api/reflect/snapshot');
    expect(snapshotUrl.searchParams.get('source')).toBe('codex-cli');

    for (const callIndex of [2, 3]) {
      const headers = new Headers(
        (fetchMock.mock.calls[callIndex]?.[1] as RequestInit).headers,
      );
      expect(headers.get('X-Code-Insights-Session')).toBe('stats-session');
    }
  });
});
