import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { ErrorCard } from './ErrorCard';

describe('ErrorCard', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'zh-CN');
  });

  it('renders its default recovery text in the selected language', () => {
    render(
      <LocaleProvider>
        <ErrorCard onRetry={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByText('出现了一些问题')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
