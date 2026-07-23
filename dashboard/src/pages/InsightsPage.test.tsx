import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import type { Insight } from '@/lib/types';

const decisionInsight: Insight = {
  id: 'insight-1',
  session_id: 'session-1',
  project_id: 'project-1',
  project_name: 'Stable Project',
  type: 'decision',
  title: 'Architecture decision',
  content: 'Keep the existing backend contract.',
  summary: 'Preserve stable data keys.',
  bullets: '[]',
  confidence: 0.9,
  source: 'llm',
  metadata: JSON.stringify({
    situation: 'The codebase needed a stable seam.',
    choice: 'Keep backend_key unchanged.',
    reasoning: 'Routes remain compatible.',
    evidence: ['server response'],
  }),
  timestamp: '2026-07-22T08:00:00.000Z',
  created_at: '2026-07-22T08:00:00.000Z',
  scope: 'session',
  analysis_version: 'test',
  linked_insight_ids: null,
};

vi.mock('@/hooks/useInsights', () => ({
  useInsights: () => ({ data: [decisionInsight], isLoading: false, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useSessions', () => ({
  useSessions: () => ({ data: [] }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: [{ id: 'project-1', name: 'Stable Project' }] }),
}));

vi.mock('@/hooks/useDispatchDiscovery', () => ({
  useDispatchDiscovery: () => ({
    shouldShowCallout: false,
    markCalloutDismissed: vi.fn(),
    markDispatchOpened: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSavedFilters', () => ({
  useSavedFilters: () => ({ savedFilters: [], saveFilter: vi.fn(), deleteFilter: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { facets: [] } }),
}));

vi.mock('@/components/LlmNudgeBanner', () => ({ LlmNudgeBanner: () => null }));
vi.mock('@/components/filters/SourceToolSelect', () => ({ SourceToolSelect: () => null }));
vi.mock('@/components/filters/SaveFilterPopover', () => ({ SaveFilterPopover: () => null }));
vi.mock('@/components/filters/SavedFiltersDropdown', () => ({ SavedFiltersDropdown: () => null }));
vi.mock('@/components/dispatch/DispatchDrawer', () => ({ DispatchDrawer: () => null }));
vi.mock('@/components/dispatch/FloatingActionBar', () => ({ FloatingActionBar: () => null }));

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return (
    <button data-testid="language-switch" type="button" onClick={() => setLocale('zh-CN')}>
      switch
    </button>
  );
}

function RouteProbe() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname}{location.search}</output>;
}

describe('Insights page language', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('translates visible controls and metadata while preserving query values and AI text', async () => {
    const { default: InsightsPage } = await import('./InsightsPage');
    const route = '/insights?q=Architecture&type=decision&view=type';

    render(
      <MemoryRouter initialEntries={[route]}>
        <LocaleProvider>
          <LanguageSwitch />
          <RouteProbe />
          <InsightsPage />
        </LocaleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Insights' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search insights...')).toHaveValue('Architecture');
    expect(screen.getByRole('tab', { name: 'By Type' })).toHaveAttribute('data-state', 'active');
    expect(screen.getAllByText('Decision').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Architecture decision/ }));
    expect(screen.getByText('Situation')).toBeInTheDocument();
    expect(screen.getByText('Choice')).toBeInTheDocument();
    expect(screen.getByText('The codebase needed a stable seam.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('language-switch'));

    expect(screen.getByRole('heading', { name: '洞察' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索洞察…')).toHaveValue('Architecture');
    expect(screen.getByRole('tab', { name: '按类型' })).toHaveAttribute('data-state', 'active');
    expect(screen.getAllByText('决策').length).toBeGreaterThan(0);
    expect(screen.getByText('场景')).toBeInTheDocument();
    expect(screen.getByText('选择')).toBeInTheDocument();
    expect(screen.getByText('The codebase needed a stable seam.')).toBeInTheDocument();
    expect(screen.getByTestId('route')).toHaveTextContent(route);
  }, 30_000);
});
