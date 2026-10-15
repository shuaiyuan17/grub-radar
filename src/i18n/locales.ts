/** Supported UI languages. Framework-free (the headline copy uses it too). */
export const LOCALES = ['en', 'zh-Hans'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * First browser language we support wins. Any Chinese variant gets
 * Simplified (the only Chinese we have); everything else falls back to en.
 *
 * Self-contained on purpose (no outer references): its source is also
 * inlined into index.html by the boot script (see boot.ts), so it must run
 * as plain JavaScript on its own.
 */
export function detectLocale(languages: readonly string[]): Locale {
  for (const raw of languages) {
    const lang = raw.toLowerCase();
    if (lang === 'zh' || lang.startsWith('zh-')) return 'zh-Hans';
    if (lang === 'en' || lang.startsWith('en-')) return 'en';
  }
  return 'en'; // DEFAULT_LOCALE, inlined (see above)
}
