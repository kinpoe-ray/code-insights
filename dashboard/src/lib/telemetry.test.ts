import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
}));
const dashboardFetch = vi.hoisted(() => vi.fn());

vi.mock('posthog-js', () => ({ default: posthog }));
vi.mock('./dashboard-http', () => ({ dashboardFetch }));

async function loadInitializedTelemetry() {
  dashboardFetch.mockResolvedValue(new Response(JSON.stringify({
    enabled: true,
    distinct_id: 'stable-machine-id',
  }), { status: 200 }));
  const telemetry = await import('./telemetry');
  await telemetry.initTelemetry();
  return telemetry;
}

type SyntheticCapture = {
  uuid: string;
  event: string;
  properties: Record<string, unknown>;
  $set?: Record<string, unknown>;
  timestamp?: Date;
};

function initializedBeforeSend() {
  const config = posthog.init.mock.calls[0]?.[1] as {
    before_send?: (
      capture: SyntheticCapture | null,
    ) => SyntheticCapture | null;
  };
  expect(config.before_send).toBeTypeOf('function');
  return config.before_send!;
}

describe('dashboard telemetry outbound allowlist', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reduces raw page URLs to a stable route category', async () => {
    const telemetry = await loadInitializedTelemetry();
    const sentinel =
      '/sessions/session-secret-123?email=private.person@example.com&path=/Users/private';

    telemetry.capturePageView(sentinel);

    expect(posthog.capture).toHaveBeenCalledWith('$pageview', {
      route_category: 'sessions',
    });
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toContain(
      'session-secret-123',
    );
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toContain(
      'private.person@example.com',
    );
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toContain(
      '/Users/private',
    );
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toContain(
      '$current_url',
    );
  });

  it('never sends session_character or arbitrary caller properties', async () => {
    const telemetry = await loadInitializedTelemetry();
    const opened = telemetry.captureDispatchOpenedFromInsights as (
      unsafe?: string,
    ) => void;

    opened('debugging-with-session-secret@example.com-/Users/private');
    telemetry.captureDispatchCalloutDismissed('try_it');
    telemetry.captureDashboardLoaded(
      'private.person@example.com/Users/private',
      Number.NaN,
    );

    expect(posthog.capture.mock.calls).toEqual([
      ['dispatch.opened_from_insights', {}],
      ['dispatch.discovery_callout_dismissed', { via: 'try_it' }],
      ['dashboard_loaded', { page: 'other', load_time_ms: 0 }],
    ]);
    const outbound = JSON.stringify(posthog.capture.mock.calls);
    expect(outbound).not.toContain('session_character');
    expect(outbound).not.toContain('example.com');
    expect(outbound).not.toContain('/Users/private');
  });

  it('rebuilds synthetic SDK-enriched payloads at the final send boundary', async () => {
    await loadInitializedTelemetry();
    const beforeSend = initializedBeforeSend();
    const enriched: SyntheticCapture = {
      uuid: 'event-uuid',
      event: '$pageview',
      properties: {
        token: 'injected-token',
        distinct_id: 'injected-identity',
        route_category:
          '/sessions/session-secret?email=private.person@example.com',
        $current_url:
          'https://localhost/sessions/session-secret?email=private.person@example.com',
        $session_id: 'sensitive-session-id',
        $window_id: 'sensitive-window-id',
        $title: 'Private Project',
        email: 'private.person@example.com',
        path: '/Users/private/project',
      },
      $set: { email: 'private.person@example.com' },
      timestamp: new Date('2026-07-18T12:00:00Z'),
    };

    const sanitized = beforeSend(enriched);

    expect(sanitized).toEqual({
      uuid: 'event-uuid',
      event: '$pageview',
      properties: {
        token: expect.any(String),
        distinct_id: 'stable-machine-id',
        $process_person_profile: false,
        route_category: 'sessions',
      },
    });
    const outbound = JSON.stringify(sanitized);
    expect(outbound).not.toContain('private.person@example.com');
    expect(outbound).not.toContain('session-secret');
    expect(outbound).not.toContain('sensitive-session-id');
    expect(outbound).not.toContain('sensitive-window-id');
    expect(outbound).not.toContain('/Users/private');
  });

  it('permits only aggregate dashboard events and their allowlisted fields', async () => {
    await loadInitializedTelemetry();
    const beforeSend = initializedBeforeSend();
    const capture = (
      event: string,
      properties: Record<string, unknown> = {},
    ) => beforeSend({
      uuid: `uuid-${event}`,
      event,
      properties: {
        ...properties,
        $current_url: 'https://localhost/private',
        $session_id: 'private-session',
        email: 'private.person@example.com',
      },
    });
    const commonProperties = {
      token: expect.any(String),
      distinct_id: 'stable-machine-id',
      $process_person_profile: false,
    };

    expect(capture('dispatch.discovery_callout_shown')).toEqual({
      uuid: 'uuid-dispatch.discovery_callout_shown',
      event: 'dispatch.discovery_callout_shown',
      properties: commonProperties,
    });
    expect(capture('dispatch.discovery_callout_dismissed', {
      via: 'try_it',
    })).toEqual({
      uuid: 'uuid-dispatch.discovery_callout_dismissed',
      event: 'dispatch.discovery_callout_dismissed',
      properties: { ...commonProperties, via: 'try_it' },
    });
    expect(capture('dispatch.opened_from_insights')).toEqual({
      uuid: 'uuid-dispatch.opened_from_insights',
      event: 'dispatch.opened_from_insights',
      properties: commonProperties,
    });
    expect(capture('dashboard_loaded', {
      page: '/analytics/private',
      load_time_ms: 12.7,
    })).toEqual({
      uuid: 'uuid-dashboard_loaded',
      event: 'dashboard_loaded',
      properties: {
        ...commonProperties,
        page: 'analytics',
        load_time_ms: 13,
      },
    });
    expect(capture('$identify')).toBeNull();
    expect(capture('$autocapture')).toBeNull();
  });

  it('bootstraps the stable identity without identify or remote SDK extras', async () => {
    await loadInitializedTelemetry();

    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        advanced_disable_flags: true,
        advanced_disable_feature_flags: true,
        disable_surveys: true,
        disable_web_experiments: true,
        disable_external_dependency_loading: true,
        capture_performance: false,
        capture_heatmaps: false,
        person_profiles: 'never',
        bootstrap: {
          distinctID: 'stable-machine-id',
          isIdentifiedID: false,
          featureFlags: {},
        },
        before_send: expect.any(Function),
      }),
    );
  });

  it('does not initialize or capture when telemetry is disabled', async () => {
    dashboardFetch.mockResolvedValue(new Response(JSON.stringify({
      enabled: false,
      distinct_id: 'stable-machine-id',
    }), { status: 200 }));
    const telemetry = await import('./telemetry');

    await telemetry.initTelemetry();
    telemetry.capturePageView('/sessions/private');
    telemetry.captureDashboardLoaded('dashboard', 10);

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
