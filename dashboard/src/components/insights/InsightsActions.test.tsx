import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { EmptyInsights } from '@/components/empty-states/EmptyInsights';
import { DispatchDiscoveryCallout } from './DispatchDiscoveryCallout';
import { DispatchEntryButton } from './DispatchEntryButton';

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return <button type="button" onClick={() => setLocale('zh-CN')}>switch</button>;
}

describe('Insights actions language', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('translates the empty state and writing actions when the locale changes', () => {
    render(
      <LocaleProvider>
        <LanguageSwitch />
        <EmptyInsights />
        <DispatchEntryButton sessionCharacter="feature_build" facetsLoaded onClick={vi.fn()} />
        <DispatchDiscoveryCallout onTryIt={vi.fn()} onDismiss={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByText('No insights yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write about this' })).toBeInTheDocument();
    expect(screen.getByText('Turn this session into a writeup')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByText('还没有洞察')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '写成文章' })).toBeInTheDocument();
    expect(screen.getByText('把这次会话写成文章')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '试试看' })).toBeInTheDocument();
  });
});
