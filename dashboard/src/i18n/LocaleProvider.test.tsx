import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from './LocaleProvider';

function LocaleProbe() {
  const { locale, setLocale, t, formatDate, formatNumber, formatRelativeDate } = useLocale();

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span>{t('nav.dashboard')}</span>
      <span>{t('dashboard.loaded', { sessions: 2, projects: 1 })}</span>
      <span>{formatDate(new Date('2026-07-22T00:00:00Z'), { month: 'long', day: 'numeric', timeZone: 'UTC' })}</span>
      <span>{formatNumber(1_230_000, { notation: 'compact', maximumFractionDigits: 1 })}</span>
      <span>{formatRelativeDate('2026-07-22T08:00:00Z')}</span>
      <button type="button" onClick={() => setLocale(locale === 'en-US' ? 'zh-CN' : 'en-US')}>
        switch
      </button>
    </div>
  );
}

describe('LocaleProvider', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-22T10:00:00Z').getTime());
    localStorage.clear();
    document.documentElement.lang = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('switches the visible language and persists the choice', async () => {
    localStorage.setItem('code-insights.locale', 'en-US');
    const user = userEvent.setup();

    render(
      <LocaleProvider>
        <LocaleProbe />
      </LocaleProvider>,
    );

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('2 sessions loaded · 1 project')).toBeInTheDocument();
    expect(screen.getByText('July 22')).toBeInTheDocument();
    expect(screen.getByText('1.2M')).toBeInTheDocument();
    expect(screen.getByText('2 hours ago')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en-US');

    await user.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByText('仪表盘')).toBeInTheDocument();
    expect(screen.getByText('已载入 2 个会话 · 1 个项目')).toBeInTheDocument();
    expect(screen.getByText('7月22日')).toBeInTheDocument();
    expect(screen.getByText('123万')).toBeInTheDocument();
    expect(screen.getByText('2小时前')).toBeInTheDocument();
    expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN');
    expect(localStorage.getItem('code-insights.locale')).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
