import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef } from 'react';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router';
import { capturePageView, captureDashboardLoaded } from '@/lib/telemetry';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Layout } from '@/components/layout/Layout';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';

// Keep the app shell available immediately and load each screen only when its
// route is visited. Page modules pull in charts, markdown and session tooling
// that are not needed for every dashboard visit.
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const SessionsPage = lazy(() => import('@/pages/SessionsPage'));
const SessionDetailPage = lazy(() => import('@/pages/SessionDetailPage'));
const InsightsPage = lazy(() => import('@/pages/InsightsPage'));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const ExportPage = lazy(() => import('@/pages/ExportPage'));
const JournalPage = lazy(() => import('@/pages/JournalPage'));
const PatternsPage = lazy(() => import('@/pages/PatternsPage'));

const ROUTE_TITLES: Record<string, MessageKey> = {
  '/dashboard': 'nav.dashboard',
  '/sessions': 'nav.sessions',
  '/insights': 'nav.insights',
  '/analytics': 'nav.analytics',
  '/patterns': 'nav.patterns',
  '/export': 'nav.export',
  '/journal': 'nav.journal',
  '/settings': 'nav.settings',
};

interface RouteLoadTelemetryContextValue {
  reportPageLoaded: (page: string) => void;
}

const RouteLoadTelemetryContext = createContext<RouteLoadTelemetryContextValue | null>(null);

function RouteLoadTimingProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const timingRef = useRef({
    pathname,
    startedAt: Date.now(),
    reported: false,
  });

  // This runs above the Suspense boundary, so the timer starts before a lazy
  // route begins loading rather than after React retries its suspended render.
  if (timingRef.current.pathname !== pathname) {
    timingRef.current = {
      pathname,
      startedAt: Date.now(),
      reported: false,
    };
  }

  const reportPageLoaded = useCallback((page: string) => {
    const timing = timingRef.current;
    if (timing.pathname !== pathname || timing.reported) return;
    timing.reported = true;
    captureDashboardLoaded(page, Date.now() - timing.startedAt);
  }, [pathname]);

  return (
    <RouteLoadTelemetryContext.Provider value={{ reportPageLoaded }}>
      {children}
    </RouteLoadTelemetryContext.Provider>
  );
}

function useRouteLoadTelemetry() {
  const context = useContext(RouteLoadTelemetryContext);
  if (!context) throw new Error('useRouteLoadTelemetry must be used within RouteLoadTimingProvider');
  return context;
}

function RouteEffects() {
  const { pathname } = useLocation();
  const { t } = useLocale();
  const [searchParams] = useSearchParams();
  const insightParam = searchParams.get('insight');

  // Scroll to top on route change, unless deep-linking to a specific insight
  useEffect(() => {
    const isInsightDeepLink = pathname === '/insights' && insightParam;
    if (!isInsightDeepLink) {
      window.scrollTo(0, 0);
    }
  }, [pathname, insightParam]);

  // Update document.title and track page views on every route change.
  useEffect(() => {
    const segment = '/' + pathname.split('/')[1];
    const titleKey = ROUTE_TITLES[segment];
    document.title = titleKey ? `${t(titleKey)} — Code Insights` : 'Code Insights';

    // Track page view on every route change
    capturePageView(pathname);

  }, [pathname, t]);

  return null;
}

function RouteLoadingFallback() {
  const { t } = useLocale();

  // The page-level loading and error states remain authoritative. This only
  // covers the brief interval while a route chunk is fetched.
  return (
    <div
      className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-3 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={t('common.loadingPage')}
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      <span className="ml-2">{t('common.loadingPage')}</span>
    </div>
  );
}

function RouteLoadedPage({
  page,
  Page,
}: {
  page: string;
  Page: LazyExoticComponent<ComponentType>;
}) {
  const { reportPageLoaded } = useRouteLoadTelemetry();

  // Effects run after the lazy page has committed, so dashboard_loaded means
  // that users can see the route rather than merely that navigation started.
  useEffect(() => {
    reportPageLoaded(page);
  }, [page, reportPageLoaded]);

  return <Page />;
}

function lazyRoute(page: string, Page: LazyExoticComponent<ComponentType>) {
  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <RouteLoadedPage page={page} Page={Page} />
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <RouteLoadTimingProvider>
        <RouteEffects />
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={lazyRoute('dashboard', DashboardPage)} />
            <Route path="/sessions" element={lazyRoute('sessions', SessionsPage)} />
            <Route path="/sessions/:id" element={lazyRoute('sessions', SessionDetailPage)} />
            <Route path="/insights" element={lazyRoute('insights', InsightsPage)} />
            <Route path="/analytics" element={lazyRoute('analytics', AnalyticsPage)} />
            <Route path="/patterns" element={lazyRoute('patterns', PatternsPage)} />
            <Route path="/settings" element={lazyRoute('settings', SettingsPage)} />
            <Route path="/export" element={lazyRoute('export', ExportPage)} />
            <Route path="/journal" element={lazyRoute('journal', JournalPage)} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </RouteLoadTimingProvider>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
