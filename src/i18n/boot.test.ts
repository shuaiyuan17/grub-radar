import { bootLangScript } from './boot';
import { LANG_KEY, initialLocale } from './storage';

function setBrowserLanguages(langs: string[]) {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: langs });
  Object.defineProperty(navigator, 'language', { configurable: true, value: langs[0] ?? '' });
}

function runBoot() {
  document.documentElement.lang = 'en'; // what index.html ships
  // run the generated inline script, as the browser would
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(bootLangScript()) as () => void;
  run();
  return document.documentElement.lang;
}

describe('boot lang script (index.html)', () => {
  beforeEach(() => {
    localStorage.clear();
    setBrowserLanguages(['en-US']);
  });

  it.each<[string | null, string[], string]>([
    [null, ['zh-CN', 'en'], 'zh-Hans'],
    [null, ['en-GB'], 'en'],
    [null, ['fr-FR'], 'en'],
    ['zh-Hans', ['en-US'], 'zh-Hans'],
    ['en', ['zh-CN'], 'en'],
    ['klingon', ['zh-TW'], 'zh-Hans'], // junk saved value is ignored
  ])('saved %j + browser %j -> %s, same as the React provider', (saved, langs, expected) => {
    if (saved) localStorage.setItem(LANG_KEY, saved);
    setBrowserLanguages(langs);
    expect(runBoot()).toBe(expected);
    expect(initialLocale()).toBe(expected);
  });

  it('survives storage throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setBrowserLanguages(['zh-CN']);
    expect(runBoot()).toBe('zh-Hans');
    spy.mockRestore();
  });
});
