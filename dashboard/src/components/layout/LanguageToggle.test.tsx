import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { LanguageToggle } from './LanguageToggle';

describe('LanguageToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('lets the user switch between English and Chinese', async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <LanguageToggle />
      </LocaleProvider>,
    );

    const toggle = screen.getByRole('button', { name: 'Switch to Chinese' });
    expect(toggle).toHaveTextContent('中文');

    await user.click(toggle);

    expect(screen.getByRole('button', { name: '切换为英文' })).toHaveTextContent('EN');
  });
});
