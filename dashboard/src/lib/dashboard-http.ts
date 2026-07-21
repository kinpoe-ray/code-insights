export const DASHBOARD_SESSION_HEADER = 'X-Code-Insights-Session';
const DASHBOARD_SESSION_ENDPOINT = '/api/session';

export type DashboardApiPath = `/api/${string}`;

let cachedToken: string | null = null;
let bootstrapPromise: Promise<string> | null = null;

function assertApiPath(path: string): asserts path is DashboardApiPath {
  if (!path.startsWith('/api/')) {
    throw new Error('dashboardFetch only accepts a relative /api/ path');
  }
}

async function bootstrapSession(): Promise<string> {
  const response = await fetch(DASHBOARD_SESSION_ENDPOINT, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Dashboard session bootstrap failed (${response.status})`);
  }

  const token = response.headers.get(DASHBOARD_SESSION_HEADER);
  if (!token) {
    throw new Error('Dashboard session token header is missing');
  }
  return token;
}

async function getSessionToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (!bootstrapPromise) {
    const pending = bootstrapSession();
    bootstrapPromise = pending;
    void pending.catch(() => {
      if (bootstrapPromise === pending) bootstrapPromise = null;
    });
  }

  const token = await bootstrapPromise;
  cachedToken = token;
  return token;
}

function invalidateRejectedToken(rejectedToken: string): void {
  if (cachedToken === rejectedToken) {
    cachedToken = null;
    bootstrapPromise = null;
  }
}

function authenticatedFetch(
  path: DashboardApiPath,
  init: RequestInit | undefined,
  token: string,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(DASHBOARD_SESSION_HEADER, token);

  return fetch(path, {
    ...init,
    credentials: init?.credentials ?? 'same-origin',
    headers,
  });
}

async function isLocalSessionRejection(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const payload = await response.clone().json() as { code?: unknown };
    return payload.code === 'LOCAL_SESSION_REQUIRED'
      || payload.code === 'LOCAL_SESSION_INVALID';
  } catch {
    return false;
  }
}

/**
 * The only browser transport for Code Insights' local API.
 *
 * It never accepts external URLs, lazily bootstraps one process-scoped token,
 * and retries once after a 401 so a page can recover from a server restart.
 */
export async function dashboardFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  assertApiPath(path);

  const token = await getSessionToken();
  const response = await authenticatedFetch(path, init, token);
  if (!await isLocalSessionRejection(response)) return response;

  await response.body?.cancel().catch(() => {});
  invalidateRejectedToken(token);
  const refreshedToken = await getSessionToken();
  return authenticatedFetch(path, init, refreshedToken);
}
