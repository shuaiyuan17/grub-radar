import { expect, test, type Page } from '@playwright/test';

const WEEKDAY_DINNER = new Date(2026, 9, 14, 19, 0);

async function zh(page: Page) {
  await page.clock.setFixedTime(WEEKDAY_DINNER);
  await page.addInitScript(() => {
    Math.random = () => 0;
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
  });
}

const isZhFont = (url: string) => /zcool-kuaile|long-cang/.test(url);

test('zh: list -> place -> radar, with zh fonts', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const fontUrls: string[] = [];
  page.on('requestfinished', (r) => {
    if (isZhFont(r.url())) fontUrls.push(r.url());
  });
  await zh(page);
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('今晚吃点啥？');
  await expect(page.getByRole('button', { name: '附近' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('5 家 · 由近到远')).toBeVisible();
  // headline uses ZCOOL KuaiLe once its slice has loaded
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('16px "ZCOOL KuaiLe"', '今晚吃点啥')))
    .toBe(true);
  expect(fontUrls.some((u) => u.includes('zcool-kuaile'))).toBe(true);
  // only a few unicode-range slices, not the whole font
  expect(new Set(fontUrls).size).toBeLessThan(30);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole('link', { name: 'Lucky Thread Noodle Bar', exact: true }).click();
  await expect(page.getByText('0.5 公里')).toBeVisible();
  await expect(page.getByRole('link', { name: /带我去 Lucky Thread Noodle Bar/ })).toBeVisible();
  await page.getByRole('link', { name: '回到列表' }).click();

  if (phone) await page.getByRole('link', { name: '雷达', exact: true }).click();
  else await page.getByRole('link', { name: '打开完整雷达' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('这次跑多远？');
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuetext', '自驾游');
  await page.getByRole('button', { name: /^Hilltop Smokehouse，吃的/ }).click();
  await expect(page.getByRole('article', { name: 'Hilltop Smokehouse' })).toContainText('开车');
  // ring labels are handwritten: Long Cang gets fetched once Chinese appears in a note
  await expect.poll(() => fontUrls.some((u) => u.includes('long-cang'))).toBe(true);
});

test('the en / 中文 toggle switches and is remembered', async ({ page }) => {
  await page.clock.setFixedTime(WEEKDAY_DINNER);
  await page.goto('/');
  const lang = page.getByRole('group', { name: 'Language' }).filter({ visible: true });
  await lang.getByRole('button', { name: '中文' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('button', { name: '附近' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '附近' })).toBeVisible();
  await page
    .getByRole('group', { name: '语言' })
    .filter({ visible: true })
    .getByRole('button', { name: 'en' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'near me' })).toBeVisible();
});

test('english visitors never download the zh fonts', async ({ page }) => {
  const fontUrls: string[] = [];
  page.on('request', (r) => {
    if (isZhFont(r.url())) fontUrls.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByRole('article').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.goto('/radar');
  await expect(page.getByRole('slider')).toBeVisible();
  expect(fontUrls).toEqual([]);
});

test('<html lang> is right before any app JavaScript runs', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
  });
  // block the app bundle: only index.html's inline boot script can set lang
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
});
