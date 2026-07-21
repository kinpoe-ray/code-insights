export const DASHBOARD_SESSION_HEADER = 'X-Code-Insights-Session';
const DASHBOARD_SESSION_PATH = '/api/session';

interface SessionState {
  token: string | null;
  bootstrap: Promise<string> | null;
}

const sessionByBaseUrl = new Map<string, SessionState>();
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Dashboard URL must be a valid loopback HTTP URL');
  }

  if (
    url.protocol !== 'http:'
    || !LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
    || url.username
    || url.password
  ) {
    throw new Error('Dashboard URL must use a loopback HTTP host');
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('Dashboard URL must not contain a path, query, or fragment');
  }
  return url.origin;
}

function assertApiPath(path: string): void {
  if (!path.startsWith('/api/')) {
    throw new Error('dashboardFetch only accepts a relative /api/ path');
  }
}

function getState(baseUrl: string): SessionState {
  let state = sessionByBaseUrl.get(baseUrl);
  if (!state) {
    state = { token: null, bootstrap: null };
    sessionByBaseUrl.set(baseUrl, state);
  }
  return state;
}

async function bootstrapSession(baseUrl: string, state: SessionState): Promise<string> {
  if (!state.bootstrap) {
    const pending = (async () => {
      const response = await fetch(`${baseUrl}${DASHBOARD_SESSION_PATH}`, {
        method: 'GET',
      });
      if (!response.ok) {
        throw new Error(`Dashboard session bootstrap failed (${response.status})`);
      }
      const token = response.headers.get(DASHBOARD_SESSION_HEADER);
      if (!token) throw new Error('Dashboard session token header is missing');
      return token;
    })();
    state.bootstrap = pending;
    void pending.catch(() => {
      if (state.bootstrap === pending) state.bootstrap = null;
    });
  }

  const token = await state.bootstrap;
  state.token = token;
  return token;
}

async function getSessionToken(baseUrl: string, state: SessionState): Promise<string> {
  return state.token ?? bootstrapSession(baseUrl, state);
}

function authenticatedFetch(
  url: string,
  init: RequestInit | undefined,
  token: string,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(DASHBOARD_SESSION_HEADER, token);
  return fetch(url, { ...init, headers });
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
 * Authenticated transport for CLI calls to the local dashboard.
 * Tokens are cached in process memory per normalized loopback base URL.
 */
export async function dashboardFetch(
  baseUrlValue: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const baseUrl = normalizeBaseUrl(baseUrlValue);
  assertApiPath(path);
  const state = getState(baseUrl);

  const token = await getSessionToken(baseUrl, state);
  const url = `${baseUrl}${path}`;
  const response = await authenticatedFetch(url, init, token);
  if (!await isLocalSessionRejection(response)) return response;

  await response.body?.cancel().catch(() => {});
  if (state.token === token) {
    state.token = null;
    state.bootstrap = null;
  }
  const refreshedToken = await getSessionToken(baseUrl, state);
  return authenticatedFetch(url, init, refreshedToken);
}
