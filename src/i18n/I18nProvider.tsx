import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nContext, type I18nValue } from './context';
import { loadZhFonts } from './fonts';
import type { Locale } from './locales';
import { MESSAGES } from './messages';
import { initialLocale, saveLocale } from './storage';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    if (locale === 'zh-Hans') void loadZhFonts();
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    saveLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: MESSAGES[locale], setLocale }),
    [locale, setLocale],
  );
  return <I18nContext value={value}>{children}</I18nContext>;
}
