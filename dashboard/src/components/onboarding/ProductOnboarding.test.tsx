import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { readProductOnboardingStatus } from '@/lib/product-onboarding';
import { ContextualOnboarding, DashboardOnboardingChecklist } from './ProductOnboarding';

function RouteProbe() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname}</output>;
}

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return (
    <button type="button" onClick={() => setLocale('zh-CN')}>
      switch language
    </button>
  );
}

describe('product onboarding surfaces', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('presents the product journey and starts with Sessions', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <LocaleProvider>
          <RouteProbe />
          <DashboardOnboardingChecklist />
        </LocaleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Complete your first review in four stops' })).toBeInTheDocument();
    expect(screen.getByText('0/4 complete')).toBeInTheDocument();
    expect(screen.getByText('About 4 minutes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sessions Reconstruct one conversation/ })).toHaveAttribute('href', '/sessions');

    fireEvent.click(screen.getByRole('link', { name: 'Start the 4-minute review' }));

    expect(screen.getByTestId('route')).toHaveTextContent('/sessions');
    expect(readProductOnboardingStatus('dashboard')).toBe('completed');
  });

  it('shows a lightweight contextual guide once and localizes it', () => {
    const onAction = vi.fn();
    render(
      <MemoryRouter>
        <LocaleProvider>
          <LanguageSwitch />
          <ContextualOnboarding module="patterns" onAction={onAction} />
        </LocaleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Look for repeated evidence, not a one-off story' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'switch language' }));
    expect(screen.getByRole('heading', { name: '找重复证据，不被单次故事带走' })).toBeInTheDocument();
    expect(screen.getByText('适合什么时候来')).toBeInTheDocument();
    expect(screen.getByText(/你能选出一个下周要改变的重复行为/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '开始找一个重复信号' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('onboarding-patterns')).not.toBeInTheDocument();
    expect(readProductOnboardingStatus('patterns')).toBe('completed');
  });

  it('does not reopen a dismissed guide on the next render', () => {
    const firstRender = render(
      <MemoryRouter>
        <LocaleProvider>
          <ContextualOnboarding module="insights" />
        </LocaleProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss guide' }));
    expect(readProductOnboardingStatus('insights')).toBe('dismissed');

    firstRender.unmount();
    render(
      <MemoryRouter>
        <LocaleProvider>
          <ContextualOnboarding module="insights" />
        </LocaleProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('onboarding-insights')).not.toBeInTheDocument();
  });
});
