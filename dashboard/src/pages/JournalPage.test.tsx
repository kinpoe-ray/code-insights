import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import JournalPage from './JournalPage';

vi.mock('@/hooks/useInsights', () => ({
  useInsights: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useSessions', () => ({
  useSessions: () => ({ data: [] }),
}));

vi.mock('@/hooks/useConfig', () => ({
  useLlmConfig: () => ({ data: {} }),
}));

vi.mock('@/components/filters/SourceToolSelect', () => ({
  SourceToolSelect: () => null,
}));

describe('JournalPage localization', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'zh-CN');
  });

  it('renders the journal surface in Chinese without changing data values', () => {
    render(
      <MemoryRouter>
        <LocaleProvider>
          <JournalPage />
        </LocaleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '知识日志' })).toBeInTheDocument();
    expect(screen.getByText('还没有记录经验或决策。分析会话后，它们会按时间显示在这里。')).toBeInTheDocument();
  });
});
