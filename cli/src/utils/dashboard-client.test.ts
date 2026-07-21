import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function response(status: number, token?: string, body = '{}'): Response {
  const headers = new Headers();
  if (token) headers.set('X-Code-Insights-Session', token);
  return new Response(status === 204 ? null : body, { status, headers });
}

async function loadClient() {
  return import('./dashboard-client.js');
}

describe('dashboardFetch', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('single-flights a memory-only token per normalized base URL', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/session')) return response(204, 'cli-session');
      return response(200);
    });
    const { dashboardFetch, DASHBOARD_SESSION_HEADER } = await loadClient();

    await Promise.all([
      dashboardFetch('http://localhost:7890/', '/api/projects'),
      dashboardFetch('http://localhost:7890', '/api/sessions'),
    ]);

    expect(
      fetchMock.mock.calls.filter(call => call[0] === 'http://localhost:7890/api/session'),
    ).toHaveLength(1);
    for (const call of fetchMock.mock.calls.filter(
      call => call[0] !== 'http://localhost:7890/api/session',
    )) {
      expect(
        new Headers((call[1] as RequestInit).headers).get(DASHBOARD_SESSION_HEADER),
      ).toBe('cli-session');
    }
  });

  it('keeps tokens separate for different dashboard base URLs', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://localhost:7890/api/session') return response(204, 'first');
      if (url === 'http://127.0.0.1:9123/api/session') return response(204, 'second');
      return response(200);
    });
    const { dashboardFetch, DASHBOARD_SESSION_HEADER } = await loadClient();

    await dashboardFetch('http://localhost:7890', '/api/projects');
    await dashboardFetch('http://127.0.0.1:9123', '/api/projects');

    expect(
      new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers)
        .get(DASHBOARD_SESSION_HEADER),
    ).toBe('first');
    expect(
      new Headers((fetchMock.mock.calls[3][1] as RequestInit).headers)
        .get(DASHBOARD_SESSION_HEADER),
    ).toBe('second');
  });

  it('merges headers and preserves SSE request body and abort signal', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'stream-session'))
      .mockResolvedValueOnce(response(200));
    const { dashboardFetch, DASHBOARD_SESSION_HEADER } = await loadClient();
    const controller = new AbortController();

    await dashboardFetch('http://localhost:7890', '/api/reflect/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Code-Insights-Lock-Token': 'maintenance',
      },
      body: '{"period":"all"}',
      signal: controller.signal,
    });

    const init = fetchMock.mock.calls[1][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"period":"all"}');
    expect(init.signal).toBe(controller.signal);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Code-Insights-Lock-Token')).toBe('maintenance');
    expect(headers.get(DASHBOARD_SESSION_HEADER)).toBe('stream-session');
  });

  it('refreshes and retries once after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'expired'))
      .mockResolvedValueOnce(response(
        401,
        undefined,
        '{"code":"LOCAL_SESSION_INVALID"}',
      ))
      .mockResolvedValueOnce(response(204, 'fresh'))
      .mockResolvedValueOnce(response(200));
    const { dashboardFetch } = await loadClient();

    const result = await dashboardFetch('http://localhost:7890', '/api/projects');

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not replay a business 401 or its POST body', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'valid'))
      .mockResolvedValueOnce(response(
        401,
        undefined,
        '{"code":"PROVIDER_AUTH_FAILED"}',
      ));
    const { dashboardFetch } = await loadClient();

    const result = await dashboardFetch(
      'http://localhost:7890',
      '/api/reflect/generate',
      { method: 'POST', body: '{"period":"all"}' },
    );

    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ code: 'PROVIDER_AUTH_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects remote dashboard hosts and non-API paths before token bootstrap', async () => {
    const { dashboardFetch } = await loadClient();

    await expect(
      dashboardFetch('https://evil.example', '/api/projects'),
    ).rejects.toThrow(/loopback/i);
    await expect(
      dashboardFetch('http://localhost:7890', 'https://evil.example/api' as never),
    ).rejects.toThrow(/relative.*api/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never places the token in the request URL or body', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'header-only-secret'))
      .mockResolvedValueOnce(response(200));
    const { dashboardFetch } = await loadClient();

    await dashboardFetch('http://localhost:7890', '/api/reflect/generate', {
      method: 'POST',
      body: '{"period":"all"}',
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:7890/api/session');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('header-only-secret');
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('header-only-secret');
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe('{"period":"all"}');
  });
});
