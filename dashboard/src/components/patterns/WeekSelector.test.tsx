import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { WeekSelector } from './WeekSelector';

describe('WeekSelector', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'zh-CN');
  });

  it('localizes the public week navigation and date range', () => {
    render(
      <LocaleProvider>
        <WeekSelector
          currentWeek="2026-W10"
          weeks={[{
            week: '2026-W10',
            sessionCount: 3,
            hasSnapshot: true,
            generatedAt: '2026-03-08T00:00:00.000Z',
          }]}
          onWeekChange={vi.fn()}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole('navigation', { name: '周选择器' })).toBeInTheDocument();
    expect(screen.getByLabelText('上一周')).toBeInTheDocument();
    expect(screen.getByText('2026年3月2日至8日')).toBeInTheDocument();
    expect(screen.getByText('从3月2日到3月8日的一周')).toBeInTheDocument();
  });
});
