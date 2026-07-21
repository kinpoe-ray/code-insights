// Client-side PostHog telemetry for the dashboard SPA.
//
// Initialization is fire-and-forget: we fetch the identity from the server
// (which checks if telemetry is enabled and returns the same stable machine ID
// used by the CLI) and only init posthog-js if the server says enabled.
//
// Config choices:
//   autocapture: false — we don't want PostHog to auto-capture clicks/DOM events
//   capture_pageview: false — we track page views manually on route change in
//     App.tsx via capturePageView() to match SPA navigation correctly
//   persistence: 'memory' — no localStorage/cookies, privacy-first
//   disable_session_recording: true — no video replay
//   ip: false — PostHog discards IP before storing

import posthog from 'posthog-js';
import type { BeforeSendFn } from 'posthog-js';
import { dashboardFetch } from './dashboard-http';

const POSTHOG_API_KEY = 'phc_552ZSApq5xuagswylfdw2vx8nckm31jn6LCpTVyVn8j';
const POSTHOG_HOST = 'https://code-insights.app/ingest';

let initialized = false;

type DashboardTelemetryEvent =
  | '$pageview'
  | 'dispatch.discovery_callout_shown'
  | 'dispatch.discovery_callout_dismissed'
  | 'dispatch.opened_from_insights'
  | 'dashboard_loaded';

const DASHBOARD_TELEMETRY_EVENTS = new Set<DashboardTelemetryEvent>([
  '$pageview',
  'dispatch.discovery_callout_shown',
  'dispatch.discovery_callout_dismissed',
  'dispatch.opened_from_insights',
  'dashboard_loaded',
]);

const ROUTE_CATEGORIES = new Set([
  'dashboard',
  'sessions',
  'insights',
  'analytics',
  'patterns',
  'export',
  'journal',
  'settings',
]);

function routeCategory(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  const category = pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  return category && ROUTE_CATEGORIES.has(category) ? category : 'other';
}

function sanitizeTelemetryProperties(
  event: DashboardTelemetryEvent,
  properties: Record<string, unknown>,
): Record<string, string | number> {
  if (event === '$pageview') {
    return {
      route_category: routeCategory(
        typeof properties.route_category === 'string'
          ? properties.route_category
          : '',
      ),
    };
  }
  if (event === 'dispatch.discovery_callout_dismissed') {
    const via = properties.via;
    return {
      via: via === 'x' || via === 'not_now' || via === 'try_it'
        ? via
        : 'not_now',
    };
  }
  if (event === 'dashboard_loaded') {
    const rawLoadTime = properties.load_time_ms;
    return {
      page: routeCategory(
        typeof properties.page === 'string' ? properties.page : '',
      ),
      load_time_ms: typeof rawLoadTime === 'number'
        && Number.isFinite(rawLoadTime)
        && rawLoadTime >= 0
        ? Math.round(rawLoadTime)
        : 0,
    };
  }
  return {};
}

function createBeforeSend(distinctId: string): BeforeSendFn {
  return (capture) => {
    if (
      !capture
      || !DASHBOARD_TELEMETRY_EVENTS.has(
        capture.event as DashboardTelemetryEvent,
      )
    ) {
      return null;
    }
    const event = capture.event as DashboardTelemetryEvent;
    return {
      uuid: capture.uuid,
      event,
      properties: {
        token: POSTHOG_API_KEY,
        distinct_id: distinctId,
        $process_person_profile: false,
        ...sanitizeTelemetryProperties(event, capture.properties),
      },
    };
  };
}

/**
 * The single outbound event seam. Every dashboard capture passes through the
 * event-specific allowlist above before PostHog can observe it.
 */
function captureAllowed(
  event: DashboardTelemetryEvent,
  properties: Record<string, unknown> = {},
): void {
  if (!initialized) return;
  try {
    posthog.capture(event, sanitizeTelemetryProperties(event, properties));
  } catch {
    // Telemetry must never affect the product.
  }
}

/**
 * Initialize posthog-js. Fire-and-forget from main.tsx — does not block render.
 * Fetches /api/telemetry/identity to get the shared distinct_id and enabled flag.
 */
export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  try {
    const res = await dashboardFetch('/api/telemetry/identity');
    if (!res.ok) return;
    const data = await res.json() as { enabled: boolean; distinct_id?: string };
    if (!data.enabled || !data.distinct_id?.trim()) return;

    posthog.init(POSTHOG_API_KEY, {
      api_host: POSTHOG_HOST,
      ui_host: 'https://us.i.posthog.com',
      autocapture: false,
      capture_pageview: false, // We track page views manually on route change
      capture_pageleave: false,
      capture_performance: false,
      capture_heatmaps: false,
      persistence: 'memory',
      disable_session_recording: true,
      disable_surveys: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      advanced_disable_feature_flags: true,
      ip: false,
      person_profiles: 'never',
      bootstrap: {
        distinctID: data.distinct_id,
        isIdentifiedID: false,
        featureFlags: {},
      },
      before_send: createBeforeSend(data.distinct_id),
    });

    initialized = true;
  } catch {
    // Telemetry init failure is always silent
  }
}

/**
 * Capture a page view event. Called from App.tsx on route change.
 */
export function capturePageView(path: string): void {
  captureAllowed('$pageview', { route_category: path });
}

export function captureDispatchCalloutShown(): void {
  captureAllowed('dispatch.discovery_callout_shown');
}

export function captureDispatchCalloutDismissed(via: 'x' | 'not_now' | 'try_it'): void {
  captureAllowed('dispatch.discovery_callout_dismissed', { via });
}

export function captureDispatchOpenedFromInsights(): void {
  captureAllowed('dispatch.opened_from_insights');
}

/**
 * Capture the dashboard_loaded event with load time.
 * @param page - The route segment (e.g. 'dashboard', 'sessions')
 * @param loadTimeMs - Time from navigation start to first render in ms
 */
export function captureDashboardLoaded(page: string, loadTimeMs: number): void {
  captureAllowed('dashboard_loaded', {
    page,
    load_time_ms: loadTimeMs,
  });
}
