import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nContext, type I18nValue } from './context';
import { loadZhFonts } from './fonts';
import type { Locale } from './locales';
import { MESSAGES } from './messages';
import { initialLocale, saveLocale } from './storage';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // index.html's boot script already set <html lang> before first paint;
  // keep it in sync on switches, before the browser paints the new text
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
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
