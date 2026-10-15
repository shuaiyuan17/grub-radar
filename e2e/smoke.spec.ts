import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const runningAnimations = (page: Page) =>
  page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

async function noSeriousA11yIssues(page: Page) {
  // let entrance animations finish: axe measures contrast at the current opacity
  await expect.poll(() => runningAnimations(page)).toBe(0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

/** Freeze the page clock and make Math.random() predictable, so the headline is too. */
async function pinTime(page: Page, date: Date) {
  await page.clock.setFixedTime(date);
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
}

const WEEKDAY_DINNER = new Date(2026, 9, 14, 19, 0); // Wednesday 19:00 local

test('list -> place -> back -> radar', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await pinTime(page, WEEKDAY_DINNER);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('what are we eating tonight?');
  await expect(page.getByRole('article')).toHaveCount(5);
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);

  // search lives in the header on desktop, behind a button on phones
  if (phone) {
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible();
    await page.getByRole('button', { name: 'Search my spots' }).click();
  }
  await page.getByRole('searchbox', { name: 'Search my spots' }).fill('brisket');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search my spots' }).fill('');

  await page.getByRole('link', { name: 'Lucky Thread Noodle Bar', exact: true }).click();
  await expect(page).toHaveURL(/\/place\/lucky-thread$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lucky Thread Noodle Bar');
  const take = page.getByRole('link', { name: /Take me to Lucky Thread/ });
  await expect(take).toBeVisible();
  await expect(take).toHaveAttribute(
    'href',
    /maps\.apple\.com\/\?daddr=47\.6135,-122\.3302.*dirflg=w/,
  );
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);

  await page.getByRole('link', { name: 'Back to the list' }).click();
  await expect(page).toHaveURL(/\/$/);

  if (phone)
    await page
      .getByRole('navigation', { name: 'View' })
      .getByRole('link', { name: 'radar' })
      .click();
  else await page.getByRole('link', { name: 'open the full radar' }).click();
  await expect(page).toHaveURL(/\/radar$/);
  await page.getByRole('button', { name: /^Hilltop Smokehouse/ }).click();
  await expect(page.getByRole('article', { name: 'Hilltop Smokehouse' })).toBeVisible();
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);
});

test('deep links work (SPA routing) and the dice rolls', async ({ page }) => {
  await page.goto('/radar?reach=1&kinds=coffee');
  await expect(page.getByText('2 in reach')).toBeVisible();
  await page.getByRole('button', { name: /can't decide/ }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
});

test('weekend daytime opens on weekend ideas', async ({ page }) => {
  await pinTime(page, new Date(2026, 9, 17, 11, 0)); // Saturday 11:00 local
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("it's the weekend. go further.");
  await expect(page.getByRole('button', { name: 'weekend' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('keyboard users can reach a card and see focus', async ({ page }) => {
  await pinTime(page, WEEKDAY_DINNER);
  await page.goto('/');
  await expect(page.getByRole('article').first()).toBeVisible();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => document.activeElement?.textContent ?? '');
    if (name === 'Lucky Thread Noodle Bar') break;
  }
  const focused = page.locator(':focus');
  await expect(focused).toHaveText('Lucky Thread Noodle Bar');
  const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('dashed');
});

test('where i am: denied location falls back to home', async ({ page, context }) => {
  await context.clearPermissions();
  await page.goto('/');
  await page
    .getByRole('group', { name: 'Measure distances from' })
    .filter({ visible: true })
    .getByRole('button', { name: 'where i am' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: /measuring from home/ })).toBeVisible();
});

test('motion settles: nothing keeps animating at idle', async ({ page }) => {
  await pinTime(page, WEEKDAY_DINNER);
  await page.goto('/');
  await expect(page.getByRole('article').first()).toBeVisible();
  // entrances (cards, highlighter, radar dots) are short; then the page is still
  await expect.poll(() => runningAnimations(page), { timeout: 3000 }).toBe(0);
  await page.goto('/radar');
  await expect(page.getByRole('slider')).toBeVisible();
  await expect.poll(() => runningAnimations(page), { timeout: 3000 }).toBe(0);
});

test('prefers-reduced-motion: no animations at all', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pinTime(page, WEEKDAY_DINNER);
  await page.goto('/');
  await expect(page.getByRole('article').first()).toBeVisible();
  expect(await runningAnimations(page)).toBe(0);

  // things that would animate: roll the dice (wiggle), hover it (boil), change mode (stagger)
  const dice = page.getByRole('button', { name: /can't decide/ }).filter({ visible: true });
  await dice.hover();
  await dice.click();
  expect(await runningAnimations(page)).toBe(0);
  await page.getByRole('button', { name: 'weekend' }).click();
  expect(await runningAnimations(page)).toBe(0);

  if (info.project.name === 'phone')
    await page.getByRole('link', { name: 'radar', exact: true }).click();
  else await page.getByRole('link', { name: 'open the full radar' }).click();
  await expect(page.getByRole('slider')).toBeVisible();
  expect(await runningAnimations(page)).toBe(0);
  await page.getByRole('slider').fill('0');
  expect(await runningAnimations(page)).toBe(0);
});
