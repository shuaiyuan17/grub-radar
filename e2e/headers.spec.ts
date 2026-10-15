import { expect, test, type Page } from '@playwright/test';
import { devLogin } from './session';

/** Collects CSP violations the page reports (and console CSP errors). */
async function watchCsp(page: Page) {
  const console: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) console.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
  return async () => [
    ...console,
    ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)),
  ];
}

test('static files and SPA routes carry the security headers', async ({ request }) => {
  const home = await request.get('/');
  const html = await home.text();
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(script).toBeTruthy();
  for (const path of [
    '/',
    '/radar',
    '/place/lucky-thread',
    script ?? '',
    '/favicon.svg',
    '/og.png',
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const h = res.headers();
    const csp = h['content-security-policy'] ?? '';
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp, path).not.toContain('unsafe-inline');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy'], path).toContain('geolocation=(self)');
  }
});

test('the CSP blocks nothing the app needs (wall, app, zh fonts)', async ({ page }) => {
  const violations = await watchCsp(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Apple' })).toBeVisible();
  await devLogin(page);
  for (const path of ['/', '/radar', '/place/lucky-thread']) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
  }
  await page
    .getByRole('group', { name: 'Language' })
    .filter({ visible: true })
    .getByRole('button', { name: '中文' })
    .click();
  await page.evaluate(() => document.fonts.ready);
  expect(await violations()).toEqual([]);
});

test('the legal pages are plain HTML: signed out, without JS, nothing blocked', async ({
  browser,
  page,
}) => {
  // no JavaScript at all: still the whole page
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const bare = await noJs.newPage();
  for (const [path, title] of [
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Service'],
  ] as const) {
    const res = await bare.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(bare.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(bare.getByText('Last updated: 2026-10-15')).toBeVisible();
  }
  await noJs.close();

  // from the wall's footer, with the CSP watching
  const violations = await watchCsp(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'privacy policy' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy');
  // the hashed style applied: the paper card, in the app's font
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(255, 253, 248)');
  await page.getByRole('link', { name: 'Terms of Service' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of Service');
  expect(await violations()).toEqual([]);
});
