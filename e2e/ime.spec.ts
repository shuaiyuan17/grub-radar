import { expect, test, type Page } from '@playwright/test';
import { devLogin, freshUser } from './session';

// Typing Chinese through a pinyin IME: "bao zi", then pick 包子. The bug: every
// keystroke mid-composition rewrote ?q= (a navigation), and Safari committed the
// pinyin typed so far each time: "bbabaobao zbao zi".
//
// Chromium: a real IME composition through CDP (Input.imeSetComposition, then
// Input.insertText to pick). WebKit: Playwright can't drive an IME there, so
// the spec dispatches the event sequence Safari produces (compositionend
// BEFORE the last input event) on the real page.

const PINYIN = ['b', 'ba', 'bao', 'bao z', 'bao zi'];
const q = (page: Page) => new URL(page.url()).searchParams.get('q');

/** Places searches the page makes, by query. */
function watchSearches(page: Page) {
  const qs: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/places/search')) qs.push((r.postDataJSON() as { q: string }).q);
  });
  return qs;
}

/** Composes `pick` from PINYIN in the focused box, pausing over the candidates. */
async function compose(page: Page, pick: string, during: () => Promise<void>) {
  if (page.context().browser()?.browserType().name() === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    for (const text of PINYIN) {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    }
    await during();
    await cdp.send('Input.insertText', { text: pick });
    return;
  }
  // WebKit: Safari's order, simulated
  const box = page.locator(':focus');
  await box.evaluate((el: HTMLInputElement, steps) => {
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    for (const s of steps) {
      el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: s }));
      value?.set?.call(el, s);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          isComposing: true,
          inputType: 'insertCompositionText',
          data: s,
        }),
      );
    }
  }, PINYIN);
  await during();
  await box.evaluate((el: HTMLInputElement, text) => {
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    value?.set?.call(el, text);
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        isComposing: false,
        inputType: 'insertFromComposition',
        data: text,
      }),
    );
  }, pick);
}

test('add: pinyin composes in place; one search and the URL only once 包子 is picked', async ({
  page,
}, info) => {
  await devLogin(page, { as: freshUser(`ime-add-${info.project.name}`) });
  const searches = watchSearches(page);
  await page.goto('/add');
  const box = page.getByRole('searchbox', {
    name: 'Search Apple Maps for a restaurant, café or bakery',
  });
  await expect(box).toBeFocused();

  await compose(page, '包子', async () => {
    await expect(box).toHaveValue('bao zi');
    // look at the candidates for a while: longer than the search's debounce
    await page.waitForTimeout(800);
    await expect(box).toHaveValue('bao zi');
    expect(q(page)).toBeNull();
    expect(searches).toEqual([]);
  });

  await expect(box).toHaveValue('包子');
  await expect.poll(() => searches).toEqual(['包子']);
  await expect.poll(() => q(page)).toBe('包子');
  await page.waitForTimeout(500);
  expect(searches).toEqual(['包子']);
  await expect(box).toHaveValue('包子');
});

test('list search: ?q= is written only once 包子 is picked', async ({ page, isMobile }, info) => {
  await devLogin(page, { as: freshUser(`ime-list-${info.project.name}`) });
  await page.goto('/');
  if (isMobile) await page.getByRole('button', { name: 'Search my spots' }).click();
  const box = page.locator(isMobile ? '#search-phone' : '#search-desktop');
  await box.click();
  await expect(box).toBeFocused();
  const cards = page.getByRole('article');
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();

  await compose(page, '包子', async () => {
    await expect(box).toHaveValue('bao zi');
    await page.waitForTimeout(500);
    expect(q(page)).toBeNull();
    expect(await cards.count()).toBe(before);
  });

  await expect.poll(() => q(page)).toBe('包子');
  await expect(box).toHaveValue('包子');
});
