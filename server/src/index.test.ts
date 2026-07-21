import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_SESSION_HEADER } from './security/local-dashboard-security.js';

const serveMock = vi.fn();

vi.mock('@hono/node-server', () => ({
  serve: serveMock,
}));

vi.mock('@code-insights/cli/utils/telemetry', () => ({
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  trackEvent: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock('@code-insights/cli/utils/browser', () => ({
  openUrl: vi.fn(),
}));

const { startServer } = await import('./index.js');

describe('startServer', () => {
  afterEach(() => {
    serveMock.mockReset();
  });

  it('binds the dashboard server to the IPv4 loopback interface', async () => {
    await startServer({
      port: 7890,
      staticDir: '/path/that/does-not-exist',
      openBrowser: false,
    });

    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 7890,
        hostname: '127.0.0.1',
      }),
      expect.any(Function),
    );
  });

  it('boots a protected app while keeping health and static fallback public', async () => {
    await startServer({
      port: 7890,
      staticDir: '/path/that/does-not-exist',
      openBrowser: false,
    });

    const fetchApp = serveMock.mock.calls[0]?.[0]?.fetch as
      | ((request: Request) => Promise<Response>)
      | undefined;
    expect(fetchApp).toBeTypeOf('function');

    const request = (
      path: string,
      headers: Record<string, string> = {},
    ) => fetchApp!(new Request(`http://localhost:7890${path}`, {
      headers: { Host: 'localhost:7890', ...headers },
    }));

    const health = await request('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await request('/')).status).toBe(200);
    expect((await request('/api/projects')).status).toBe(401);

    const bootstrap = await request('/api/session');
    const token = bootstrap.headers.get(DASHBOARD_SESSION_HEADER);
    expect(bootstrap.status).toBe(204);
    expect(token).toBeTruthy();
    expect(await bootstrap.text()).toBe('');

    const authorizedUnknown = await request('/api/not-a-route', {
      [DASHBOARD_SESSION_HEADER]: token!,
    });
    expect(authorizedUnknown.status).toBe(404);

    const rebindingAttempt = await fetchApp!(new Request('http://evil.example/', {
      headers: { Host: 'evil.example:7890' },
    }));
    expect(rebindingAttempt.status).toBe(403);
  });

  it('wakes durable queue recovery once the server is listening', async () => {
    const processQueue = vi.fn().mockResolvedValue({
      status: 'completed',
      completedCount: 0,
      rerunPendingCount: 0,
    });
    serveMock.mockImplementationOnce((
      _options: unknown,
      onListening: (info: { port: number }) => void,
    ) => {
      onListening({ port: 7890 });
    });

    await startServer({
      port: 7890,
      staticDir: '/path/that/does-not-exist',
      openBrowser: false,
      processQueue,
    });

    await vi.waitFor(() => {
      expect(processQueue).toHaveBeenCalledOnce();
    });
    expect(processQueue).toHaveBeenCalledWith({ quiet: true, maxItems: 1 });
  });
});
