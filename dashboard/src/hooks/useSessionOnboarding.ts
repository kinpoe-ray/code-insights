import { useCallback, useEffect, useState } from 'react';

import {
  PRODUCT_ONBOARDING_RESTART_EVENT,
  SESSION_ONBOARDING_STORAGE_KEY,
  clearProductOnboardingStatus,
  readProductOnboardingStatus,
  writeProductOnboardingStatus,
} from '@/lib/product-onboarding';

export { SESSION_ONBOARDING_STORAGE_KEY } from '@/lib/product-onboarding';

export type SessionOnboardingStep = 0 | 1 | 2 | 3 | 4;

type SessionOnboardingStatus = 'dismissed' | 'completed';

function hasSeenOnboarding(): boolean {
  return readProductOnboardingStatus('sessions') !== null;
}

function persistStatus(status: SessionOnboardingStatus) {
  writeProductOnboardingStatus('sessions', status);
}

function clearStatus() {
  clearProductOnboardingStatus('sessions');
}

export function useSessionOnboarding() {
  const [seenInitially] = useState(hasSeenOnboarding);
  const [step, setStep] = useState<SessionOnboardingStep>(0);
  const [showWelcome, setShowWelcome] = useState(!seenInitially);

  const start = useCallback(() => {
    clearStatus();
    setShowWelcome(false);
    setStep(1);
  }, []);

  const hideWelcome = useCallback(() => {
    setShowWelcome(false);
  }, []);

  const dismiss = useCallback(() => {
    persistStatus('dismissed');
    setShowWelcome(false);
    setStep(0);
  }, []);

  const goToStep = useCallback((nextStep: Exclude<SessionOnboardingStep, 0>) => {
    setStep(nextStep);
  }, []);

  const complete = useCallback(() => {
    persistStatus('completed');
    setShowWelcome(false);
    setStep(0);
  }, []);

  useEffect(() => {
    const handleRestart = () => {
      setShowWelcome(true);
      setStep(0);
    };
    window.addEventListener(PRODUCT_ONBOARDING_RESTART_EVENT, handleRestart);
    return () => window.removeEventListener(PRODUCT_ONBOARDING_RESTART_EVENT, handleRestart);
  }, []);

  useEffect(() => {
    if (step === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dismiss, step]);

  return {
    step,
    showWelcome,
    canReplay: step === 0 && !showWelcome,
    start,
    hideWelcome,
    dismiss,
    goToStep,
    complete,
  };
}
