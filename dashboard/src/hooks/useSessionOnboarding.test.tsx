import { act, fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_ONBOARDING_STORAGE_KEY,
  useSessionOnboarding,
} from './useSessionOnboarding';

describe('useSessionOnboarding', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts for a first-time visitor and persists dismissal', () => {
    const firstRun = renderHook(() => useSessionOnboarding());

    expect(firstRun.result.current.step).toBe(0);
    expect(firstRun.result.current.showWelcome).toBe(true);

    act(() => firstRun.result.current.hideWelcome());
    expect(firstRun.result.current.showWelcome).toBe(false);
    expect(firstRun.result.current.step).toBe(0);

    act(() => firstRun.result.current.dismiss());
    expect(firstRun.result.current.step).toBe(0);
    expect(firstRun.result.current.canReplay).toBe(true);
    expect(localStorage.getItem(SESSION_ONBOARDING_STORAGE_KEY)).toBe('dismissed');

    firstRun.unmount();
    const returningVisitor = renderHook(() => useSessionOnboarding());
    expect(returningVisitor.result.current.step).toBe(0);
    expect(returningVisitor.result.current.showWelcome).toBe(false);
  });

  it('can replay and complete the four-step journey', () => {
    localStorage.setItem(SESSION_ONBOARDING_STORAGE_KEY, 'dismissed');
    const { result } = renderHook(() => useSessionOnboarding());

    act(() => result.current.start());
    expect(result.current.step).toBe(1);
    expect(result.current.showWelcome).toBe(false);
    expect(localStorage.getItem(SESSION_ONBOARDING_STORAGE_KEY)).toBeNull();

    act(() => result.current.goToStep(2));
    expect(result.current.step).toBe(2);

    act(() => result.current.goToStep(3));
    expect(result.current.step).toBe(3);

    act(() => result.current.goToStep(4));
    expect(result.current.step).toBe(4);

    act(() => result.current.complete());
    expect(result.current.step).toBe(0);
    expect(result.current.canReplay).toBe(true);
    expect(localStorage.getItem(SESSION_ONBOARDING_STORAGE_KEY)).toBe('completed');
  });

  it('can be dismissed with Escape', () => {
    const { result } = renderHook(() => useSessionOnboarding());

    act(() => result.current.start());

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(result.current.step).toBe(0);
    expect(result.current.canReplay).toBe(true);
    expect(localStorage.getItem(SESSION_ONBOARDING_STORAGE_KEY)).toBe('dismissed');
  });
});
