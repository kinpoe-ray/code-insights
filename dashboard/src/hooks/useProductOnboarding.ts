import { useCallback, useEffect, useState } from 'react';
import {
  PRODUCT_ONBOARDING_CHANGE_EVENT,
  PRODUCT_ONBOARDING_MODULES,
  PRODUCT_ONBOARDING_RESTART_EVENT,
  clearProductOnboardingStatus,
  readProductOnboardingStatus,
  writeProductOnboardingStatus,
  type ProductOnboardingModule,
  type ProductOnboardingStatus,
} from '@/lib/product-onboarding';

type ProductOnboardingProgress = Record<
  ProductOnboardingModule,
  ProductOnboardingStatus | null
>;

function readProgress(): ProductOnboardingProgress {
  return Object.fromEntries(
    PRODUCT_ONBOARDING_MODULES.map((module) => [
      module,
      readProductOnboardingStatus(module),
    ]),
  ) as ProductOnboardingProgress;
}

export function useProductOnboarding(module: ProductOnboardingModule) {
  const [status, setStatus] = useState<ProductOnboardingStatus | null>(() => (
    readProductOnboardingStatus(module)
  ));
  const [visible, setVisible] = useState(() => status === null);

  const dismiss = useCallback(() => {
    writeProductOnboardingStatus(module, 'dismissed');
    setStatus('dismissed');
    setVisible(false);
  }, [module]);

  const complete = useCallback(() => {
    writeProductOnboardingStatus(module, 'completed');
    setStatus('completed');
    setVisible(false);
  }, [module]);

  const replay = useCallback(() => {
    clearProductOnboardingStatus(module);
    setStatus(null);
    setVisible(true);
  }, [module]);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const changedModule = (event as CustomEvent<{ module?: ProductOnboardingModule | 'all' }>)
        .detail?.module;
      if (changedModule !== module && changedModule !== 'all') return;
      const nextStatus = readProductOnboardingStatus(module);
      setStatus(nextStatus);
      setVisible(nextStatus === null);
    };
    const handleRestart = () => {
      setStatus(null);
      setVisible(true);
    };

    window.addEventListener(PRODUCT_ONBOARDING_CHANGE_EVENT, handleChange);
    window.addEventListener(PRODUCT_ONBOARDING_RESTART_EVENT, handleRestart);
    window.addEventListener('storage', handleChange);
    return () => {
      window.removeEventListener(PRODUCT_ONBOARDING_CHANGE_EVENT, handleChange);
      window.removeEventListener(PRODUCT_ONBOARDING_RESTART_EVENT, handleRestart);
      window.removeEventListener('storage', handleChange);
    };
  }, [module]);

  return { status, visible, dismiss, complete, replay };
}

export function useProductOnboardingProgress() {
  const [progress, setProgress] = useState<ProductOnboardingProgress>(readProgress);

  useEffect(() => {
    const refresh = () => setProgress(readProgress());
    window.addEventListener(PRODUCT_ONBOARDING_CHANGE_EVENT, refresh);
    window.addEventListener(PRODUCT_ONBOARDING_RESTART_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PRODUCT_ONBOARDING_CHANGE_EVENT, refresh);
      window.removeEventListener(PRODUCT_ONBOARDING_RESTART_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return progress;
}
