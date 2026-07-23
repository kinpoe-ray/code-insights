import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { StatsHero } from './StatsHero';

function LanguageSwitch() {
  const { setLocale } = useLocale();

  return (
    <button type="button" onClick={() => setLocale('zh-CN')}>
      switch
    </button>
  );
}

describe('Dashboard stats language', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('updates visible metric labels when the user switches to Chinese', async () => {
    const user = userEvent.setup();

    render(
      <LocaleProvider>
        <LanguageSwitch />
        <StatsHero
          totalSessions={3}
          totalMessages={1_230_000}
          totalToolCalls={4}
          totalDurationMin={30}
          totalProjects={2}
          isExact
        />
      </LocaleProvider>,
    );

    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('1.2M')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByText('会话')).toBeInTheDocument();
    expect(screen.getByText('123万')).toBeInTheDocument();
  });
});
