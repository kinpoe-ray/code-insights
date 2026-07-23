import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router';
import { capturePageView, captureDashboardLoaded } from '@/lib/telemetry';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Layout } from '@/components/layout/Layout';
import DashboardPage from '@/pages/DashboardPage';
import SessionsPage from '@/pages/SessionsPage';
import SessionDetailPage from '@/pages/SessionDetailPage';
import InsightsPage from '@/pages/InsightsPage';
import AnalyticsPage from '@/pages/AnalyticsPage';
import SettingsPage from '@/pages/SettingsPage';
import ExportPage from '@/pages/ExportPage';
import JournalPage from '@/pages/JournalPage';
import PatternsPage from '@/pages/PatternsPage';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';

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

function RouteEffects() {
  const { pathname } = useLocation();
  const { t } = useLocale();
  const [searchParams] = useSearchParams();
  const insightParam = searchParams.get('insight');
  const navStartRef = useRef<number>(Date.now());

  // Scroll to top on route change, unless deep-linking to a specific insight
  useEffect(() => {
    const isInsightDeepLink = pathname === '/insights' && insightParam;
    if (!isInsightDeepLink) {
      window.scrollTo(0, 0);
    }
  }, [pathname, insightParam]);

  // Update document.title per route, track page views, and capture dashboard_loaded
  useEffect(() => {
    const segment = '/' + pathname.split('/')[1];
    const titleKey = ROUTE_TITLES[segment];
    document.title = titleKey ? `${t(titleKey)} — Code Insights` : 'Code Insights';

    // Track page view on every route change
    capturePageView(pathname);

    // Capture dashboard_loaded with time since navigation started
    if (titleKey) {
      const loadTimeMs = Date.now() - navStartRef.current;
      captureDashboardLoaded(segment.slice(1), loadTimeMs);
    }
    // Reset nav start for next navigation
    navStartRef.current = Date.now();
  }, [pathname, t]);

  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <RouteEffects />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/patterns" element={<PatternsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/journal" element={<JournalPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
