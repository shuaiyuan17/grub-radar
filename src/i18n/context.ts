import { createContext, use } from 'react';
import type { Locale } from './locales';
import { MESSAGES, type Messages } from './messages';

export interface I18nValue {
  locale: Locale;
  t: Messages;
  setLocale: (locale: Locale) => void;
}

// Defaults to English with a no-op switch, so components also render on
// their own (e.g. in unit tests) without a provider.
export const I18nContext = createContext<I18nValue>({
  locale: 'en',
  t: MESSAGES.en,
  setLocale: () => undefined,
});

export function useI18n(): I18nValue {
  return use(I18nContext);
}

/** Shorthand for the current catalog. */
export function useT(): Messages {
  return useI18n().t;
}
