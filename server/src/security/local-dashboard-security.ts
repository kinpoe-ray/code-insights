import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const DASHBOARD_SESSION_ENDPOINT = '/api/session';
export const DASHBOARD_SESSION_HEADER = 'X-Code-Insights-Session';

export interface LocalDashboardSecurityOptions {
  /**
   * Test seam. Production callers should use the default cryptographic source.
   * The returned bytes never leave this module except as the bootstrap header.
   */
  tokenFactory?: () => Buffer;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function isLoopbackHostname(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return LOOPBACK_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

function isAllowedOrigin(value: string | undefined): boolean {
  if (!value) return true;
  if (value === 'null') return false;
  try {
    const origin = new URL(value);
    return origin.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(origin.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function tokenMatches(expected: Buffer, provided: string): boolean {
  const actual = Buffer.from(provided, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Protect the local dashboard through one deep middleware seam.
 *
 * Static files and the minimal health endpoint do not require a token. The
 * bootstrap endpoint returns the process-scoped token in a no-store response
 * header. Every other /api request must present that token, including SSE and
 * OPTIONS requests.
 */
export function createLocalDashboardSecurity(
  options: LocalDashboardSecurityOptions = {},
): MiddlewareHandler {
  const tokenBytes = options.tokenFactory?.() ?? randomBytes(32);
  const token = tokenBytes.toString('base64url');
  const expectedHeader = Buffer.from(token, 'utf8');

  return async (c, next) => {
    if (!isLoopbackHostname(c.req.header('Host'))) {
      return c.json(
        { error: 'Local dashboard host rejected', code: 'LOCAL_HOST_REJECTED' },
        403,
      );
    }

    if (!isAllowedOrigin(c.req.header('Origin'))) {
      return c.json(
        { error: 'Local dashboard origin rejected', code: 'LOCAL_ORIGIN_REJECTED' },
        403,
      );
    }

    const path = c.req.path;
    if (path === DASHBOARD_SESSION_ENDPOINT) {
      if (c.req.method !== 'GET') {
        c.header('Allow', 'GET');
        return c.json({ error: 'Method not allowed' }, 405);
      }
      if (c.req.header('Sec-Fetch-Site') === 'cross-site') {
        return c.json(
          { error: 'Cross-site bootstrap rejected', code: 'LOCAL_BOOTSTRAP_REJECTED' },
          403,
        );
      }

      c.header(DASHBOARD_SESSION_HEADER, token);
      c.header('Cache-Control', 'no-store, private');
      c.header('Pragma', 'no-cache');
      c.header('Cross-Origin-Resource-Policy', 'same-origin');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(null, 204);
    }

    if (path === '/api/health') {
      return next();
    }

    if (path === '/api' || path.startsWith('/api/')) {
      const provided = c.req.header(DASHBOARD_SESSION_HEADER);
      if (!provided) {
        c.header('Cache-Control', 'no-store');
        return c.json(
          {
            error: 'Local dashboard session required',
            code: 'LOCAL_SESSION_REQUIRED',
          },
          401,
        );
      }
      if (!tokenMatches(expectedHeader, provided)) {
        c.header('Cache-Control', 'no-store');
        return c.json(
          {
            error: 'Local dashboard session invalid',
            code: 'LOCAL_SESSION_INVALID',
          },
          401,
        );
      }
    }

    return next();
  };
}
