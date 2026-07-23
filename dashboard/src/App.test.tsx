import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import App from './App';

const telemetry = vi.hoisted(() => ({
  capturePageView: vi.fn(),
  captureDashboardLoaded: vi.fn(),
}));

const dashboardPage = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { ready, resolve };
});

vi.mock('@/lib/telemetry', () => telemetry);

vi.mock('@/components/layout/Layout', async () => {
  const { Outlet } = await import('react-router');
  return {
    Layout: () => <main><Outlet /></main>,
  };
});

vi.mock('@/pages/DashboardPage', async () => {
  await dashboardPage.ready;
  return {
    default: () => <div>Dashboard page content</div>,
  };
});

describe('App lazy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/dashboard');
    localStorage.setItem('code-insights.locale', 'zh-CN');
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  it('shows an accessible localized fallback and reports dashboard_loaded only after the page mounts', async () => {
    render(
      <StrictMode>
        <LocaleProvider>
          <App />
        </LocaleProvider>
      </StrictMode>,
    );

    expect(screen.getByRole('status', { name: '正在加载页面…' })).toHaveAttribute('aria-busy', 'true');
    expect(telemetry.captureDashboardLoaded).not.toHaveBeenCalled();

    await act(async () => {
      dashboardPage.resolve();
      await dashboardPage.ready;
    });

    expect(await screen.findByText('Dashboard page content')).toBeInTheDocument();
    await waitFor(() => {
      expect(telemetry.captureDashboardLoaded).toHaveBeenCalledWith('dashboard', expect.any(Number));
    });
    expect(telemetry.captureDashboardLoaded).toHaveBeenCalledTimes(1);
  });
});
