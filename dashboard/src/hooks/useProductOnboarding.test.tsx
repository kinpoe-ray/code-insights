import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_ONBOARDING_STORAGE_KEY,
  readProductOnboardingStatus,
  restartProductOnboarding,
  writeProductOnboardingStatus,
} from '@/lib/product-onboarding';
import { useProductOnboarding, useProductOnboardingProgress } from './useProductOnboarding';

describe('product onboarding state', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows an unseen module and remembers explicit completion', () => {
    const firstVisit = renderHook(() => useProductOnboarding('analytics'));

    expect(firstVisit.result.current.visible).toBe(true);
    expect(firstVisit.result.current.status).toBeNull();

    act(() => firstVisit.result.current.complete());

    expect(firstVisit.result.current.visible).toBe(false);
    expect(firstVisit.result.current.status).toBe('completed');
    expect(readProductOnboardingStatus('analytics')).toBe('completed');

    firstVisit.unmount();
    const returningVisit = renderHook(() => useProductOnboarding('analytics'));
    expect(returningVisit.result.current.visible).toBe(false);
  });

  it('distinguishes dismissal from completion', () => {
    const { result } = renderHook(() => useProductOnboarding('insights'));

    act(() => result.current.dismiss());

    expect(result.current.status).toBe('dismissed');
    expect(result.current.visible).toBe(false);
    expect(readProductOnboardingStatus('insights')).toBe('dismissed');
  });

  it('keeps the dashboard checklist in sync with module progress', () => {
    const { result } = renderHook(() => useProductOnboardingProgress());

    expect(result.current.sessions).toBeNull();

    act(() => writeProductOnboardingStatus('sessions', 'completed'));
    expect(result.current.sessions).toBe('completed');

    act(() => writeProductOnboardingStatus('patterns', 'dismissed'));
    expect(result.current.patterns).toBe('dismissed');
  });

  it('restarts every module, including the existing Sessions tour', () => {
    localStorage.setItem(SESSION_ONBOARDING_STORAGE_KEY, 'completed');
    writeProductOnboardingStatus('dashboard', 'completed');
    writeProductOnboardingStatus('insights', 'dismissed');
    const dashboard = renderHook(() => useProductOnboarding('dashboard'));

    expect(dashboard.result.current.visible).toBe(false);

    act(() => restartProductOnboarding());

    expect(dashboard.result.current.visible).toBe(true);
    expect(readProductOnboardingStatus('dashboard')).toBeNull();
    expect(readProductOnboardingStatus('insights')).toBeNull();
    expect(localStorage.getItem(SESSION_ONBOARDING_STORAGE_KEY)).toBeNull();
  });
});
