import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { ConversationSearch } from './ConversationSearch';

describe('conversation search outline trigger', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('shows the turn count and toggles the outline', async () => {
    const user = userEvent.setup();
    const onToggleOutline = vi.fn();

    render(
      <LocaleProvider>
        <ConversationSearch
          messages={[]}
          onHighlightMessage={vi.fn()}
          outlineCount={7}
          outlineOpen={false}
          onToggleOutline={onToggleOutline}
        />
      </LocaleProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Toggle conversation outline, 7 turns' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('7')).toBeInTheDocument();

    await user.click(trigger);
    expect(onToggleOutline).toHaveBeenCalledOnce();
  });
});
