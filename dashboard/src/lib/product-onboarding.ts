export const SESSION_ONBOARDING_STORAGE_KEY = 'ci.sessions.onboarding.v1';
export const PRODUCT_ONBOARDING_CHANGE_EVENT = 'code-insights:onboarding-change';
export const PRODUCT_ONBOARDING_RESTART_EVENT = 'code-insights:onboarding-restart';

export const PRODUCT_ONBOARDING_MODULES = [
  'dashboard',
  'sessions',
  'insights',
  'analytics',
  'patterns',
] as const;

export type ProductOnboardingModule = (typeof PRODUCT_ONBOARDING_MODULES)[number];
export type ProductOnboardingStatus = 'dismissed' | 'completed';

const PRODUCT_ONBOARDING_STORAGE_PREFIX = 'ci.product.onboarding.v1';

function storageKey(module: ProductOnboardingModule) {
  return module === 'sessions'
    ? SESSION_ONBOARDING_STORAGE_KEY
    : `${PRODUCT_ONBOARDING_STORAGE_PREFIX}.${module}`;
}

function notifyChange(module: ProductOnboardingModule | 'all') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PRODUCT_ONBOARDING_CHANGE_EVENT, {
    detail: { module },
  }));
}

export function readProductOnboardingStatus(
  module: ProductOnboardingModule,
): ProductOnboardingStatus | null {
  if (typeof window === 'undefined') return 'completed';
  try {
    const value = window.localStorage.getItem(storageKey(module));
    return value === 'dismissed' || value === 'completed' ? value : null;
  } catch {
    return null;
  }
}

export function writeProductOnboardingStatus(
  module: ProductOnboardingModule,
  status: ProductOnboardingStatus,
) {
  try {
    window.localStorage.setItem(storageKey(module), status);
  } catch {
    // Keep the current-page experience usable when storage is unavailable.
  }
  notifyChange(module);
}

export function clearProductOnboardingStatus(module: ProductOnboardingModule) {
  try {
    window.localStorage.removeItem(storageKey(module));
  } catch {
    // Replaying still works for the current page when storage is unavailable.
  }
  notifyChange(module);
}

export function restartProductOnboarding() {
  if (typeof window === 'undefined') return;
  for (const module of PRODUCT_ONBOARDING_MODULES) {
    try {
      window.localStorage.removeItem(storageKey(module));
    } catch {
      // The restart event still reopens onboarding in the current tab.
    }
  }

  window.dispatchEvent(new Event(PRODUCT_ONBOARDING_RESTART_EVENT));
  notifyChange('all');
}
