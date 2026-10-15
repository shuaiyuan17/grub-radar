import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devLogin, freshUser } from './session';

// each test signs in as a dev user of its own: these tests write to the list

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

test('a new account: empty list, add a spot, been + rating, a note, edit, delete', async ({
  page,
}, info) => {
  const phone = info.project.name === 'phone';
  await devLogin(page, { as: freshUser(`new-${info.project.name}`), demo: false });
  await page.goto('/');

  // empty, friendly, one obvious thing to do
  await expect(page.getByRole('heading', { name: 'nothing on your radar yet.' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);
  await page.getByRole('link', { name: 'add your first spot' }).click();
  await expect(page).toHaveURL(/\/add$/);

  // add by hand (the fallback under the Apple Maps search)
  await page.getByRole('link', { name: /add it by hand/ }).click();
  await expect(page).toHaveURL(/\/add\/manual$/);
  await page.getByLabel('name').fill('Night Owl Pho');
  await page.getByRole('radio', { name: 'food' }).check({ force: true });
  await page.getByLabel('where is it?').fill('47.6152, -122.3201');
  await page.getByLabel(/^cuisine/).fill('pho');
  await page.getByText('$', { exact: true }).click();
  await page.getByLabel(/^cravings/).fill('noodles, late night');
  await page.getByLabel(/^one-liner/).fill('the 1am bowl');
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);
  await page.getByRole('button', { name: 'add it' }).click();

  await expect(page).toHaveURL(/\/place\/p-[0-9a-z]{26}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Night Owl Pho');
  await expect(page.getByText('want to try').first()).toBeVisible();

  // been, 9/10, with a note
  await page.getByRole('button', { name: 'mark as been' }).click();
  await page.getByText('9', { exact: true }).click();
  await page.getByLabel('anything to remember?').fill('rare beef, extra basil');
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expect(page.getByText(/been here · 9\/10/)).toBeVisible();
  const mine = page.getByRole('region', { name: 'my note' });
  await expect(mine.getByText('rare beef, extra basil')).toBeVisible();

  // another note, appended
  await mine.getByLabel('New note').fill('closed mondays');
  await mine.getByRole('button', { name: 'add a note' }).click();
  await expect(mine.getByRole('listitem')).toHaveCount(2);

  // order this
  const order = page.getByRole('region', { name: 'order this' });
  await order.getByLabel('add a dish').fill('rare beef pho');
  await order.getByRole('button', { name: 'add', exact: true }).click();
  await order.getByRole('checkbox', { name: 'rare beef pho' }).click();
  await expect(order.getByRole('checkbox', { name: 'rare beef pho' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);

  // it's really saved: survives a reload
  await page.reload();
  await expect(page.getByText(/been here · 9\/10/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'my note' }).getByRole('listitem')).toHaveCount(2);

  // edit
  await page.getByRole('link', { name: 'Edit this spot' }).click();
  await page.getByLabel('name').fill('Night Owl Phở');
  await page.getByRole('button', { name: 'save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Night Owl Phở');

  // on the list
  await page.goto('/?q=owl');
  if (phone) await expect(page.getByRole('searchbox', { name: 'Search my spots' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Night Owl Phở' })).toBeVisible();

  // delete
  await page.getByRole('link', { name: 'Night Owl Phở', exact: true }).click();
  await page.getByRole('button', { name: 'delete' }).click();
  await page.getByRole('button', { name: 'yes, delete' }).click();
  await expect(page.getByRole('heading', { name: 'nothing on your radar yet.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'nothing on your radar yet.' })).toBeVisible();
});

test('a home left on this device moves to the account only after a yes', async ({ page }) => {
  await devLogin(page, { as: freshUser('home'), demo: true });
  // a v0 home on this device (fictional)
  await page.evaluate(() => {
    localStorage.setItem('grub-radar:home', JSON.stringify({ lat: 47.6062, lng: -122.3245 }));
  });
  await page.goto('/');
  const ask = page.getByRole('region', { name: 'save your home to your account?' });
  await expect(ask).toBeVisible();
  // used right away, even before answering
  await expect(page.getByRole('article').first()).toContainText("Mama Ko's Dumpling Window");
  await ask.getByRole('button', { name: 'save it' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'moved your home' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('grub-radar:home'))).toBeNull();

  // the account has it now: a reload (no device copy) measures from it, and doesn't ask
  await page.reload();
  await expect(page.getByRole('article').first()).toContainText("Mama Ko's Dumpling Window");
  await expect(page.getByText(/from a demo home/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'save your home to your account?' })).toHaveCount(
    0,
  );
});

test('"keep it on this device only" sends nothing to the account', async ({ page }) => {
  await devLogin(page, { as: freshUser('home-local'), demo: true });
  await page.evaluate(() => {
    localStorage.setItem('grub-radar:home', JSON.stringify({ lat: 47.6062, lng: -122.3245 }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'keep it on this device only' }).click();
  await page.reload();
  await expect(page.getByRole('article').first()).toContainText("Mama Ko's Dumpling Window");
  await expect(page.getByRole('region', { name: 'save your home to your account?' })).toHaveCount(
    0,
  );
  const home = await page.evaluate(async () => {
    const me = (await (await fetch('/api/me')).json()) as { home: unknown };
    return me.home;
  });
  expect(home).toBeNull();
});

test("one account can't see another's spots", async ({ browser }) => {
  const a = await browser.newPage();
  await devLogin(a, { as: freshUser('iso-a'), demo: false });
  await a.goto('/add/manual');
  await a.getByLabel('name').fill('Alice’s Secret Spot');
  await a.getByLabel('where is it?').fill('47.61, -122.33');
  await a.getByRole('button', { name: 'add it' }).click();
  await expect(a).toHaveURL(/\/place\/p-/);
  const path = new URL(a.url()).pathname;

  const b = await browser.newPage();
  await devLogin(b, { as: freshUser('iso-b'), demo: false });
  await b.goto('/');
  await expect(b.getByRole('heading', { name: 'nothing on your radar yet.' })).toBeVisible();
  await b.goto(path);
  await expect(b.getByRole('heading', { level: 1 })).toHaveText("that spot's not here.");
  await expect(b.getByText('Alice’s Secret Spot')).toHaveCount(0);
  await a.close();
  await b.close();
});
