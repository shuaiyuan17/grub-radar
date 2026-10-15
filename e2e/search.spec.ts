import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devLogin, freshUser } from './session';

// Apple Maps here is the stub (e2e/apple-stub.ts, APPLE_MAPS_BASE): fictional places only.

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function noSeriousA11yIssues(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
    )
    .toBe(0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const searchBox = (page: Page) =>
  page.getByRole('searchbox', { name: 'Search Apple Maps for a restaurant, café or bakery' });

test('type a craving, tap an Apple Maps result, it is on your radar', async ({ page }, info) => {
  await devLogin(page, { as: freshUser(`apple-${info.project.name}`), demo: false });
  const searches: { url: string; body: unknown }[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/places/search'))
      searches.push({ url: r.url(), body: r.postDataJSON() as unknown });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'add your first spot' }).click();
  await expect(page).toHaveURL(/\/add$/);

  // quick: the box is focused, type and the results come
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.type('pho', { delay: 40 });
  const results = page.getByRole('list', { name: 'Places on Apple Maps' });
  await expect(results.getByRole('listitem')).toHaveCount(3);
  // debounced: one request for the word, not one per letter
  expect(searches).toHaveLength(1);
  // where you are travels in the body, never in the URL
  expect(new URL(searches[0]?.url ?? '').search).toBe('');
  expect(searches[0]?.body).toMatchObject({ q: 'pho', lang: 'en' });
  const owl = results.getByRole('listitem').filter({ hasText: 'Night Owl Pho' });
  await expect(owl).toContainText('101 Lantern St, Seattle, WA 98101');
  await expect(owl).toContainText(/\d+(\.\d)? mi/);
  await expect(page.getByText('places from Apple Maps')).toBeVisible();
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);

  // one tap
  await page.getByRole('button', { name: 'Add Night Owl Pho to your radar' }).click();
  await expect(page).toHaveURL(/\/place\/p-[0-9a-z]{26}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Night Owl Pho');
  await expect(page.getByText('101 Lantern St, Seattle, WA 98101')).toBeVisible();
  await expect(page.getByText('on your radar. been already? mark it below.')).toBeVisible();
  await expect(page.getByText('want to try').first()).toBeVisible();
  // Apple Maps says nothing about price or cuisine, so neither do we: no guessed "$$"
  const about = page.getByRole('list', { name: 'About this spot' });
  await expect(about.getByText('price?')).toBeVisible();
  await expect(about.getByText('cuisine?')).toBeVisible();
  await expect(about).not.toContainText('$');
  const placeUrl = page.url();

  // then the rest is yours: been, "loved it"
  await page.getByRole('button', { name: 'mark as been' }).click();
  await page.getByText('loved it', { exact: true }).click();
  await noSeriousA11yIssues(page);
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expect(page.getByText('· loved it')).toBeVisible();
  await noHorizontalScroll(page);

  // on your list (and only your spots are there: Apple's other results aren't)
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'Night Owl Pho' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Night Owl Pho' })).toContainText(
    'cuisine? · price?',
  );

  // searching again: it's "on your list", and opens your entry instead of adding twice
  await page.goto('/add?q=pho');
  const open = page.getByRole('link', { name: 'Open Night Owl Pho (already on your list)' });
  await expect(open).toBeVisible();
  await open.click();
  expect(page.url()).toBe(placeUrl);
  await expect(page.getByText('· loved it')).toBeVisible();
});

test('nothing on Apple Maps: add it by hand, with what you typed', async ({ page }) => {
  await devLogin(page, { as: freshUser('apple-none'), demo: false });
  await page.goto('/add');
  await searchBox(page).fill('corner stall');
  await expect(page.getByText('nothing on Apple Maps for “corner stall”.')).toBeVisible();
  await page.getByRole('link', { name: /add it by hand/ }).click();
  await expect(page).toHaveURL(/\/add\/manual\?name=corner%20stall$/);
  await expect(page.getByLabel('name')).toHaveValue('corner stall');
});

test('zh: the search speaks Chinese', async ({ page }) => {
  await devLogin(page, { as: freshUser('apple-zh'), demo: false });
  await page.addInitScript(() => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
  });
  await page.goto('/add');
  const box = page.getByRole('searchbox', { name: '在 Apple 地图上搜餐厅、咖啡馆或面包店' });
  await expect(box).toBeFocused();
  await box.fill('coffee');
  await expect(page.getByText('Apple 地图上找到 1 家 · 点一下就加上')).toBeVisible();
  await expect(page.getByRole('button', { name: '加上 Paper Kite Coffee 到雷达' })).toBeVisible();
  await noHorizontalScroll(page);
});
