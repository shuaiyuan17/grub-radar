import { expect, test, type Locator, type Page } from '@playwright/test';
import { devLogin } from './session';

// Narrow-phone layout guard: nothing may push the page sideways, and the
// home panel's field + save button and the list's count + roll button stay
// inside their rows without colliding. (The list / radar nav floats over the
// content on purpose, so it is not part of the overlap check.)
//
// isMobile is off so the viewport can't zoom out to fit an overflow, which
// would hide it from scrollWidth.
test.use({ isMobile: false });

const WIDTHS = [320, 402] as const;
const LANGS = [
  { lang: 'en', home: /^(set your home|Set your home location|Change your home location)$/ },
  { lang: 'zh-Hans', home: /^(设置你的家|设置家的位置|修改家的位置)$/ },
] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b as Box;
}

function expectInside(inner: Box, outer: Box, what: string) {
  // a couple of px for the hand-drawn tilts (the roll button sits at -2deg)
  const slack = 2;
  expect(inner.x, `${what}: left edge`).toBeGreaterThanOrEqual(outer.x - slack);
  expect(inner.x + inner.width, `${what}: right edge`).toBeLessThanOrEqual(
    outer.x + outer.width + slack,
  );
}

function expectApart(a: Box, b: Box, what: string) {
  const overlap =
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap, `${what} overlap`).toBe(false);
}

async function noSidewaysScroll(page: Page, width: number) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  expect(m.sw).toBeLessThanOrEqual(m.iw);
  expect(m.sw).toBeLessThanOrEqual(width);
}

test.beforeEach(async ({ page }) => {
  await devLogin(page);
});

for (const { lang, home } of LANGS) {
  for (const width of WIDTHS) {
    test(`${lang} @ ${width}px: no sideways overflow, home panel + list toolbar fit`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'phone', 'phone widths only');
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((l) => {
        localStorage.setItem('grub-radar:lang', l);
      }, lang);
      await page.goto('/');

      // list toolbar: count and roll button inside their row, not on top of each other
      const roll = page.getByRole('button', { name: /can't decide\? roll|选不出来？摇一个/ });
      await expect(roll).toBeVisible();
      const count = page.getByText(/^\d+ (spots?|家) · /);
      const row = count.locator('xpath=..');
      const rowBox = await box(row);
      const countBox = await box(count);
      const rollBox = await box(roll);
      expectInside(countBox, rowBox, 'count');
      expectInside(rollBox, rowBox, 'roll button');
      expectApart(countBox, rollBox, 'count / roll button');
      await noSidewaysScroll(page, width);

      // home panel: the coordinates field and save button stay inside the panel
      await page.getByRole('button', { name: home }).filter({ visible: true }).first().click();
      const input = page.locator('input[inputmode="decimal"]');
      await expect(input).toBeVisible();
      const panel = page.locator('section').filter({ has: input });
      const field = input.locator('xpath=..');
      const save = panel.locator('button[type="submit"]');
      const panelBox = await box(panel);
      const fieldBox = await box(field);
      const saveBox = await box(save);
      expectInside(fieldBox, panelBox, 'coordinates field');
      expectInside(await box(input), panelBox, 'coordinates input');
      expectInside(saveBox, panelBox, 'save button');
      expectApart(fieldBox, saveBox, 'field / save button');
      await noSidewaysScroll(page, width);
    });
  }
}

test('desktop: the home panel field and save button share a row inside the panel', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop only');
  await page.goto('/');
  await page
    .getByRole('button', {
      name: /^(set your home|Set your home location|Change your home location)$/,
    })
    .filter({ visible: true })
    .first()
    .click();
  const input = page.locator('input[inputmode="decimal"]');
  await expect(input).toBeVisible();
  const panel = page.locator('section').filter({ has: input });
  const panelBox = await box(panel);
  const fieldBox = await box(input.locator('xpath=..'));
  const saveBox = await box(panel.locator('button[type="submit"]'));
  expectInside(fieldBox, panelBox, 'coordinates field');
  expectInside(saveBox, panelBox, 'save button');
  expectApart(fieldBox, saveBox, 'field / save button');
  // same row: the button sits after the field
  expect(saveBox.x).toBeGreaterThan(fieldBox.x + fieldBox.width);
  await noSidewaysScroll(page, 1440);
});
