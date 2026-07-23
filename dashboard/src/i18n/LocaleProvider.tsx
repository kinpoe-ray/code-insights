import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { enUS, zhCN, type MessageKey } from './messages/catalog';
import type { MessageDefinition, TranslationValues } from './messages/types';

export type Locale = 'en-US' | 'zh-CN';

export const LOCALE_STORAGE_KEY = 'code-insights.locale';

const messages: Record<Locale, Record<MessageKey, MessageDefinition>> = {
  'en-US': enUS,
  'zh-CN': zhCN,
};

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: TranslationValues) => string;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatRelativeDate: (value: Date | string | number) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'en-US' || stored === 'zh-CN') return stored;
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }

  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
    ? 'zh-CN'
    : 'en-US';
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  }, [locale]);

  const t = useCallback((key: MessageKey, values: TranslationValues = {}) => {
    const definition = messages[locale][key];
    return typeof definition === 'function' ? definition(values) : definition;
  }, [locale]);
  const formatDate = useCallback((value: Date | string | number, options?: Intl.DateTimeFormatOptions) => (
    new Intl.DateTimeFormat(locale, options).format(new Date(value))
  ), [locale]);
  const formatNumber = useCallback((value: number, options?: Intl.NumberFormatOptions) => (
    new Intl.NumberFormat(locale, options).format(value)
  ), [locale]);
  const formatRelativeDate = useCallback((value: Date | string | number) => {
    const deltaMs = new Date(value).getTime() - Date.now();
    const absoluteMs = Math.abs(deltaMs);
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (absoluteMs < 60_000) return formatter.format(0, 'second');
    if (absoluteMs < 3_600_000) return formatter.format(Math.round(deltaMs / 60_000), 'minute');
    if (absoluteMs < 86_400_000) return formatter.format(Math.round(deltaMs / 3_600_000), 'hour');
    if (absoluteMs < 2_592_000_000) return formatter.format(Math.round(deltaMs / 86_400_000), 'day');
    if (absoluteMs < 31_536_000_000) return formatter.format(Math.round(deltaMs / 2_592_000_000), 'month');
    return formatter.format(Math.round(deltaMs / 31_536_000_000), 'year');
  }, [locale]);
  const value = useMemo(
    () => ({ locale, setLocale, t, formatDate, formatNumber, formatRelativeDate }),
    [locale, t, formatDate, formatNumber, formatRelativeDate],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used within LocaleProvider');
  return context;
}
