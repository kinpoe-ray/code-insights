import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { FloatingActionBar } from './FloatingActionBar';

function LanguageSwitch() {
  const { setLocale } = useLocale();

  return (
    <button type="button" onClick={() => setLocale('zh-CN')}>
      switch
    </button>
  );
}

describe('Dispatch action bar language', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('updates its public labels when the user switches to Chinese', async () => {
    const user = userEvent.setup();

    render(
      <LocaleProvider>
        <LanguageSwitch />
        <FloatingActionBar count={3} onOpen={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByText('3 insights selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Post' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByText('已选择 3 条洞察')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建帖子' })).toBeInTheDocument();
  });
});
