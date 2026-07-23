import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { CommandPalette } from './CommandPalette';

vi.mock('@/hooks/useSearch', () => ({
  useSearch: () => ({ data: { sessions: [], insights: [] }, isLoading: false }),
}));

describe('CommandPalette', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'zh-CN');
  });

  it('shows navigation and search controls in the selected language', () => {
    render(
      <LocaleProvider>
        <MemoryRouter>
          <CommandPalette isOpen onClose={vi.fn()} />
        </MemoryRouter>
      </LocaleProvider>,
    );

    expect(screen.getByPlaceholderText('搜索会话、洞察和项目…')).toBeInTheDocument();
    expect(screen.getByText('前往仪表盘')).toBeInTheDocument();
  });
});
