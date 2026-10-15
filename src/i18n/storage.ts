import { detectLocale, isLocale, type Locale } from './locales';

export const LANG_KEY = 'grub-radar:lang';

/** Saved choice first, then the browser's languages. */
export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage off: fall through to the browser languages
  }
  if (typeof navigator === 'undefined') return detectLocale([]);
  return detectLocale(navigator.languages.length ? navigator.languages : [navigator.language]);
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(LANG_KEY, locale);
  } catch {
    // fine: it just won't be remembered
  }
}
