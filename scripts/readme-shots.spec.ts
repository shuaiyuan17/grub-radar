import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { devLogin, freshUser } from '../e2e/session';

// README screenshots (see readme-shots.config.ts): the list, the radar and a place page
// with a friend's verdict, at phone size, from the fictional demo list. Never production.

// gitignored; the README uses the WebP made from it (see readme-shots.config.ts)
const OUT = new URL('../test-results/', import.meta.url);
const WEEKDAY_DINNER = new Date(2026, 9, 14, 19, 0);

async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
    )
    .toBe(0);
  await page.evaluate(() => document.fonts.ready);
}

async function person(browser: Browser, info: TestInfo, name: string, emoji: string) {
  const u = info.project.use;
  const ctx = await browser.newContext({
    baseURL: u.baseURL,
    viewport: u.viewport,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    deviceScaleFactor: u.deviceScaleFactor,
    userAgent: u.userAgent,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(WEEKDAY_DINNER);
  await page.addInitScript(() => {
    Math.random = () => 0;
    localStorage.setItem('grub-radar:lang', 'en');
  });
  await devLogin(page, { as: freshUser(`readme-${name.toLowerCase()}`) });
  const res = await page.evaluate(
    async ({ name, emoji }) =>
      (
        await fetch('/api/me', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-grub-request': '1' },
          body: JSON.stringify({ displayName: name, avatarEmoji: emoji }),
        })
      ).status,
    { name, emoji },
  );
  expect(res).toBeLessThan(300);
  return page;
}

async function post(page: Page, path: string, body: unknown = {}) {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-grub-request': '1' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as unknown;
    },
    { path, body },
  );
}

test('readme screenshots', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const me = await person(browser, info, 'Sam', '🐻');
  const friend = await person(browser, info, 'Ana', '🦊');
  const { token } = (await post(friend, '/api/invites')) as { token: string };
  await post(me, '/api/invites/accept', { token });

  const shots: Buffer[] = [];
  const snap = async () => {
    await settle(me);
    shots.push(await me.screenshot());
  };

  await me.goto('/');
  await expect(me.getByRole('article').first()).toBeVisible();
  await snap();

  await me.goto('/radar');
  await expect(me.getByRole('heading', { level: 1 })).toBeVisible();
  await snap();

  await me.goto('/place/lucky-thread');
  await expect(
    me.getByRole('region', { name: 'friends’ verdicts' }).getByText('Ana'),
  ).toBeVisible();
  // start at the name, so the friend's verdict is in the frame
  await me.getByRole('heading', { level: 1 }).evaluate((h) => {
    window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 6);
  });
  await snap();

  // a plain side-by-side composite, drawn by the browser itself
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const imgs = shots
    .map((b) => `<img src="data:image/png;base64,${b.toString('base64')}">`)
    .join('');
  await page.setContent(
    `<style>
      body { margin: 0; background: #f4efe4; }
      #c { display: inline-flex; gap: 28px; padding: 32px; }
      img { width: 360px; border-radius: 28px; border: 2px solid #1e1b18;
            box-shadow: 4px 5px 0 #1e1b18; }
    </style><div id="c">${imgs}</div>`,
  );
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL('readme-screens.png', OUT), await page.locator('#c').screenshot());
});
