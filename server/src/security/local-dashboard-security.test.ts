import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_SESSION_ENDPOINT,
  DASHBOARD_SESSION_HEADER,
  createLocalDashboardSecurity,
} from './local-dashboard-security.js';

const TOKEN_BYTES = Buffer.alloc(32, 7);
const TOKEN = TOKEN_BYTES.toString('base64url');

function createSecuredApp() {
  const app = new Hono();
  app.use('*', createLocalDashboardSecurity({
    tokenFactory: () => TOKEN_BYTES,
  }));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/private', (c) => c.json({ secret: true }));
  app.post('/api/private', (c) => c.json({ changed: true }));
  app.get('/assets/app.js', (c) => c.text('asset'));
  app.get('*', (c) => c.html('<html>dashboard</html>'));
  return app;
}

const allowedHost = { Host: 'localhost:7890' };

describe('LocalDashboardSecurity middleware', () => {
  it('bootstraps one memory-only token through a no-store response header', async () => {
    const app = createSecuredApp();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await app.request(DASHBOARD_SESSION_ENDPOINT, {
      headers: {
        ...allowedHost,
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get(DASHBOARD_SESSION_HEADER)).toBe(TOKEN);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await response.text()).toBe('');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('keeps health and static files public while protecting every other API', async () => {
    const app = createSecuredApp();

    expect((await app.request('/api/health', { headers: allowedHost })).status).toBe(200);
    expect((await app.request('/assets/app.js', { headers: allowedHost })).status).toBe(200);
    expect((await app.request('/', { headers: allowedHost })).status).toBe(200);

    const missing = await app.request('/api/private', { headers: allowedHost });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: 'Local dashboard session required',
      code: 'LOCAL_SESSION_REQUIRED',
    });
  });

  it('accepts the token for browser JSON, SSE-style GET, and native CLI requests', async () => {
    const app = createSecuredApp();
    const authenticated = {
      ...allowedHost,
      [DASHBOARD_SESSION_HEADER]: TOKEN,
    };

    const browserGet = await app.request('/api/private', {
      headers: {
        ...authenticated,
        Origin: 'http://127.0.0.1:5173',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    const browserPost = await app.request('/api/private', {
      method: 'POST',
      headers: {
        ...authenticated,
        Origin: 'http://localhost:7890',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    const cliGet = await app.request('/api/private', {
      headers: authenticated,
    });

    expect(browserGet.status).toBe(200);
    expect(browserPost.status).toBe(200);
    expect(cliGet.status).toBe(200);
  });

  it('rejects malformed, external, and DNS-rebinding hosts before serving anything', async () => {
    const app = createSecuredApp();

    for (const host of ['evil.example:7890', 'localhost.evil.example:7890', '']) {
      const response = await app.request('/assets/app.js', {
        headers: { Host: host },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('rejects external or null browser origins even when the token is correct', async () => {
    const app = createSecuredApp();

    for (const origin of ['https://evil.example', 'null']) {
      const response = await app.request('/api/private', {
        headers: {
          ...allowedHost,
          Origin: origin,
          [DASHBOARD_SESSION_HEADER]: TOKEN,
        },
      });
      expect(response.status).toBe(403);
    }
  });

  it('rejects cross-site bootstrap and never exposes the token through CORS', async () => {
    const app = createSecuredApp();
    const response = await app.request(DASHBOARD_SESSION_ENDPOINT, {
      headers: {
        ...allowedHost,
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get(DASHBOARD_SESSION_HEADER)).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await response.text()).not.toContain(TOKEN);
  });

  it('does not echo a wrong token and protects preflight requests', async () => {
    const app = createSecuredApp();
    const wrongToken = 'wrong-session-token';
    const wrong = await app.request('/api/private', {
      headers: {
        ...allowedHost,
        [DASHBOARD_SESSION_HEADER]: wrongToken,
      },
    });
    const preflight = await app.request('/api/private', {
      method: 'OPTIONS',
      headers: {
        ...allowedHost,
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': DASHBOARD_SESSION_HEADER,
      },
    });

    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(wrongToken);
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
