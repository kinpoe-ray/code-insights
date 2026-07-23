import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';

vi.mock('@/hooks/useSessions', () => ({
  useSessions: () => ({ data: [], isLoading: false }),
  useDeletedSessionCount: () => ({ data: 0 }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/hooks/useInsights', () => ({
  useInsights: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/hooks/useFacets', () => ({
  useMissingFacets: () => ({ data: { sessionIds: [] } }),
}));

vi.mock('@/hooks/useAnalysisQueue', () => ({
  useQueuedSessionIds: () => new Set<string>(),
}));

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

describe('Sessions page language', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it('updates visible copy without translating filter values or the route', async () => {
    const { default: SessionsPage } = await import('./SessionsPage');
    const route = '/sessions?q=needle&source=codex-cli&character=deep_focus&status=analyzed&dateRange=7d&outcome=success';

    render(
      <MemoryRouter initialEntries={[route]}>
        <LocaleProvider>
          <LanguageSwitch />
          <RouteProbe />
          <SessionsPage />
        </LocaleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByPlaceholderText('Search sessions...')).toHaveValue('needle');
    expect(screen.getByText('No matching sessions')).toBeInTheDocument();
    expect(screen.getAllByText('All Projects').length).toBeGreaterThan(0);
    expect(screen.getByText('Clear filters')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('language-switch'));

    expect(screen.getByPlaceholderText('搜索会话…')).toHaveValue('needle');
    expect(screen.getByText('没有匹配的会话')).toBeInTheDocument();
    expect(screen.getAllByText('全部项目').length).toBeGreaterThan(0);
    expect(screen.getByText('清除筛选')).toBeInTheDocument();
    expect(screen.getByTestId('route')).toHaveTextContent(route);
  }, 30_000);
});
