import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Response } from '@playwright/test';
import { SEED_SPOTS } from '../src/data/seed';

const wallButton = (page: Page) => page.getByRole('button', { name: 'Sign in with Apple' });
// names and the handwritten notes: distinctive enough that no UI string matches by accident
const spotText = SEED_SPOTS.flatMap((s) => [s.name, s.note]);

/** Every response body the page loaded, as text (fonts and images skipped). */
function recordResponses(page: Page) {
  const bodies: Promise<{ url: string; text: string }>[] = [];
  page.on('response', (res: Response) => {
    const type = res.headers()['content-type'] ?? '';
    if (/font|image/.test(type)) return;
    bodies.push(
      res
        .text()
        .then((text) => ({ url: res.url(), text }))
        .catch(() => ({ url: res.url(), text: '' })),
    );
  });
  return () => Promise.all(bodies);
}

/** Through the local Apple stub: Continue (or Cancel) as `who`. */
async function appleStub(page: Page, decision: 'Continue' | 'Cancel', who = 'tess') {
  await expect(page).toHaveURL(/localhost:4599\/auth\/authorize/);
  await page.getByLabel('Apple ID').fill(who);
  await page.getByRole('button', { name: decision }).click();
}

test.describe('signed out: the login wall', () => {
  test('is all you get, and no spot data reaches the browser', async ({ page }) => {
    const responses = recordResponses(page);
    for (const path of ['/', '/radar', '/place/lucky-thread']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('where should we eat?');
      await expect(wallButton(page)).toBeVisible();
      await expect(page.getByRole('article')).toHaveCount(0);
    }
    // the DOM
    const html = await page.content();
    for (const text of spotText) expect(html).not.toContain(text);
    // the network: HTML, JS, CSS and every API answer
    const seen = await responses();
    expect(seen.some((r) => r.url.endsWith('.js'))).toBe(true);
    for (const { url, text } of seen) {
      for (const s of spotText) expect(text, `"${s}" in ${url}`).not.toContain(s);
    }
    // and asking directly doesn't work either
    const direct = await page.evaluate(async () =>
      Promise.all(
        ['/api/spots', '/api/spots/lucky-thread', '/api/me'].map(async (p) => {
          const res = await fetch(p);
          return [res.status, await res.text()] as const;
        }),
      ),
    );
    for (const [status, body] of direct) {
      expect(status).toBe(401);
      expect(body).toContain('"unauthorized"');
    }
  });

  test('looks right and passes axe', async ({ page }) => {
    await page.goto('/');
    await expect(wallButton(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test('speaks Chinese too, with the switch at the top', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('group', { name: 'Language' })
      .getByRole('button', { name: '中文' })
      .click();
    await expect(page.getByRole('button', { name: '通过 Apple 登录' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  });
});

test.describe('Sign in with Apple (against the local Apple stub)', () => {
  test('round trip: sign in, stay signed in, sign out', async ({ page, context }, info) => {
    const phone = info.project.name === 'phone';
    await page.goto('/radar');
    await wallButton(page).click();
    await appleStub(page, 'Continue');

    // back where we started, signed in, with the name Apple gave us
    await expect(page).toHaveURL(/localhost:4173\/radar$/);
    await expect(page.getByRole('slider')).toBeVisible();
    const cookie = (await context.cookies()).find((c) => c.name === '__Host-grub_session');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.domain).toBe('localhost');
    expect((await context.cookies()).find((c) => c.name === '__Host-grub_siwa')).toBeUndefined();

    await page.goto('/');
    const account = page
      .getByRole('button', { name: /^Signed in as Tess/ })
      .filter({ visible: true });
    await expect(account).toBeVisible();
    if (!phone) await expect(account).toContainText('Tess');
    await expect(page.getByRole('article').first()).toBeVisible();

    await page.reload();
    await expect(account).toBeVisible();

    await account.click();
    await page.getByRole('button', { name: 'sign out' }).click();
    await expect(wallButton(page)).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === '__Host-grub_session')).toBeUndefined();
    await page.reload();
    await expect(wallButton(page)).toBeVisible();

    // the same Apple ID again is the same person (Apple sends no name the second time)
    await wallButton(page).click();
    await appleStub(page, 'Continue');
    await expect(
      page.getByRole('button', { name: /^Signed in as Tess/ }).filter({ visible: true }),
    ).toBeVisible();
  });

  test('cancelling on Apple’s page comes back to the wall with a note', async ({ page }) => {
    await page.goto('/');
    await wallButton(page).click();
    await appleStub(page, 'Cancel');
    await expect(page).toHaveURL(/\?signin=cancelled$/);
    await expect(page.getByRole('status')).toContainText('sign-in cancelled');
    await expect(wallButton(page)).toBeVisible();
  });
});
