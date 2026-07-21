import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function response(
  status: number,
  token?: string,
  body = '{}',
): Response {
  const headers = new Headers();
  if (token) headers.set('X-Code-Insights-Session', token);
  return new Response(status === 204 ? null : body, { status, headers });
}

async function loadAdapter() {
  return import('./dashboard-http.js');
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

  it('single-flights bootstrap and authenticates concurrent API requests', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return response(204, 'session-one');
      return response(200);
    });
    const { dashboardFetch, DASHBOARD_SESSION_HEADER } = await loadAdapter();

    const [first, second] = await Promise.all([
      dashboardFetch('/api/projects'),
      dashboardFetch('/api/sessions'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/session')).toHaveLength(1);
    for (const call of fetchMock.mock.calls.filter(call => call[0] !== '/api/session')) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get(DASHBOARD_SESSION_HEADER)).toBe('session-one');
    }
  });

  it('merges caller headers and preserves request options for SSE and downloads', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'session-two'))
      .mockResolvedValueOnce(response(200));
    const { dashboardFetch, DASHBOARD_SESSION_HEADER } = await loadAdapter();
    const controller = new AbortController();

    await dashboardFetch('/api/export/generate/stream?scope=all', {
      method: 'POST',
      body: '{"scope":"all"}',
      signal: controller.signal,
      headers: new Headers({
        'Content-Type': 'application/json',
        'X-Caller': 'kept',
      }),
    });

    const init = fetchMock.mock.calls[1][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"scope":"all"}');
    expect(init.signal).toBe(controller.signal);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Caller')).toBe('kept');
    expect(headers.get(DASHBOARD_SESSION_HEADER)).toBe('session-two');
  });

  it('refreshes after one 401 and retries the protected request exactly once', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'expired-session'))
      .mockResolvedValueOnce(response(
        401,
        undefined,
        '{"code":"LOCAL_SESSION_INVALID"}',
      ))
      .mockResolvedValueOnce(response(204, 'fresh-session'))
      .mockResolvedValueOnce(response(200));
    const { dashboardFetch, DASHBOARD_SESSION_HEADER } = await loadAdapter();

    const result = await dashboardFetch('/api/projects');

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers)
        .get(DASHBOARD_SESSION_HEADER),
    ).toBe('expired-session');
    expect(
      new Headers((fetchMock.mock.calls[3][1] as RequestInit).headers)
        .get(DASHBOARD_SESSION_HEADER),
    ).toBe('fresh-session');
  });

  it('returns a second 401 without entering an unbounded refresh loop', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'expired-session'))
      .mockResolvedValueOnce(response(
        401,
        undefined,
        '{"code":"LOCAL_SESSION_REQUIRED"}',
      ))
      .mockResolvedValueOnce(response(204, 'still-invalid'))
      .mockResolvedValueOnce(response(401));
    const { dashboardFetch } = await loadAdapter();

    const result = await dashboardFetch('/api/projects');

    expect(result.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not replay a business 401 response or its non-idempotent request', async () => {
    fetchMock
      .mockResolvedValueOnce(response(204, 'valid-session'))
      .mockResolvedValueOnce(response(
        401,
        undefined,
        '{"code":"PROVIDER_AUTH_FAILED"}',
      ));
    const { dashboardFetch } = await loadAdapter();

    const result = await dashboardFetch('/api/analysis/queue', {
      method: 'POST',
      body: '{"sessionIds":["session-1"]}',
    });

    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ code: 'PROVIDER_AUTH_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-project URLs before fetch so the token cannot leak externally', async () => {
    const { dashboardFetch } = await loadAdapter();

    await expect(
      dashboardFetch('https://avatars.githubusercontent.com/user' as never),
    ).rejects.toThrow(/relative.*api/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when bootstrap does not return a token header', async () => {
    fetchMock.mockResolvedValueOnce(response(204));
    const { dashboardFetch } = await loadAdapter();

    await expect(dashboardFetch('/api/projects')).rejects.toThrow(/session token/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
