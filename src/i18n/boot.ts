import { detectLocale, LOCALES } from './locales';
import { LANG_KEY } from './storage';

/**
 * A tiny classic script for <head> that sets <html lang> before first paint,
 * so a Chinese visit never renders (or gets read aloud) under English rules.
 * Built from the same key, locale list and detection function the React
 * provider uses, so the two can't drift. Injected by vite.config.ts.
 */
export function bootLangScript(): string {
  return [
    '(function () {',
    '  try {',
    `    var key = ${JSON.stringify(LANG_KEY)};`,
    `    var locales = ${JSON.stringify(LOCALES)};`,
    `    var detect = ${detectLocale.toString()};`,
    '    var saved = null;',
    '    try { saved = localStorage.getItem(key); } catch (e) {}',
    '    var nav = navigator.languages && navigator.languages.length',
    '      ? navigator.languages : [navigator.language || ""];',
    '    document.documentElement.lang = locales.indexOf(saved) >= 0 ? saved : detect(nav);',
    '  } catch (e) {}',
    '})();',
  ].join('\n');
}
