import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { devLogin, freshUser } from './session';

// "what should we call you?": an account Apple gave no name to (hidden, or a retried
// first sign-in) is asked before the app, and friends never see the stand-in "you".
// Through the local Apple stub with "Share my name" unticked. Fictional people only.
//
// SHOTS_DIR=/some/dir saves screenshots along the way (not in CI).

const SHOTS = process.env.SHOTS_DIR;
const settled = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
    )
    .toBe(0);

async function shot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settled(page);
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });
}

async function noSeriousA11yIssues(page: Page) {
  await settled(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

/** A fresh Apple ID for the stub (it sends `user` only on an ID's first sign-in). */
const appleId = (prefix: string, info: TestInfo) =>
  `${prefix}${info.project.name}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** On the wall: Sign in with Apple, as `who`, with the name hidden. */
async function signInWithoutName(page: Page, who: string) {
  await page.getByRole('button', { name: 'Sign in with Apple' }).click();
  await expect(page).toHaveURL(/\/auth\/authorize/);
  await page.getByLabel('Apple ID').fill(who);
  await page.getByLabel('Share my name').uncheck();
  await page.getByRole('button', { name: 'Continue' }).click();
}

const prompt = (page: Page) => page.getByRole('dialog', { name: 'what should we call you?' });

/** Fills in the dialog and saves. */
async function chooseName(page: Page, name: string, emoji: string) {
  const d = prompt(page);
  await d.getByRole('textbox', { name: 'your name' }).fill(name);
  const pick = d.getByRole('radio', { name: `Use ${emoji}` });
  // tap the visible emoji (its label); the radio inside is visually hidden
  await d
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: `Use ${emoji}` }) })
    .click();
  await expect(pick).toBeChecked();
  await d.getByRole('button', { name: 'save' }).click();
  await expect(d).toBeHidden();
}

/** A signed-in browser of its own, like the project's. */
async function newPerson(browser: Browser, info: TestInfo) {
  const u = info.project.use;
  const ctx = await browser.newContext({
    baseURL: u.baseURL,
    viewport: u.viewport,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    deviceScaleFactor: u.deviceScaleFactor,
    userAgent: u.userAgent,
  });
  return { ctx, page: await ctx.newPage() };
}

/** POST from the page itself (same origin, the app's CSRF header). */
function apiPost(page: Page, path: string, body: unknown = {}) {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-grub-request': '1' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    { path, body },
  );
}

/** A dev user with a fresh invite link; returns the link's path (`/invite#…`). */
async function inviter(page: Page, label: string) {
  await devLogin(page, { as: label, demo: false });
  const made = await apiPost(page, '/api/invites');
  expect(made.status).toBe(201);
  return String(made.json.path);
}

test('no name from Apple: asked before the app, saved once, never again', async ({
  page,
}, info) => {
  const project = info.project.name;
  await page.goto('/radar');
  await signInWithoutName(page, appleId('nell', info));

  // back where we started, but the question comes first, and the app isn't there behind it
  await expect(page).toHaveURL(/\/radar$/);
  const d = prompt(page);
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute('aria-modal', 'true');
  await expect(d.getByText('your friends will see this.')).toBeVisible();
  const field = d.getByRole('textbox', { name: 'your name' });
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  await expect(page.getByRole('slider')).toHaveCount(0);
  await noSeriousA11yIssues(page);
  await shot(page, 'name-prompt', project);

  // required: Esc doesn't dismiss, and Tab doesn't leave
  await page.keyboard.press('Escape');
  await expect(d).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await d.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  // nothing typed: a note, not a request
  await d.getByRole('button', { name: 'save' }).click();
  await expect(d.getByRole('alert')).toHaveText('type a name first.');

  await chooseName(page, 'Nell', '🐸');
  await expect(page.getByRole('slider')).toBeVisible();
  await shot(page, 'name-saved', project);

  // chosen for good: a fresh load goes straight to the app, as Nell
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: /^Signed in as Nell/ }).filter({ visible: true }),
  ).toBeVisible();
  await expect(prompt(page)).toHaveCount(0);
  const me = await page.evaluate(async () => (await fetch('/api/me')).text());
  expect(JSON.parse(me)).toMatchObject({
    user: { displayName: 'Nell', avatarEmoji: '🐸', nameSet: true },
  });
});

test('reduced motion: the dialog arrives without animating', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await signInWithoutName(page, appleId('still', info));
  const d = prompt(page);
  await expect(d).toBeVisible();
  expect(await d.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test('an invite survives the question: sign in from the link, name yourself, accept', async ({
  browser,
}, info) => {
  const project = info.project.name;
  const ana = await newPerson(browser, info);
  const ben = await newPerson(browser, info);
  try {
    const anaLabel = freshUser(`ana-${project}`);
    const link = await inviter(ana.page, anaLabel);

    // Ben opens it signed out and signs in from the wall, Apple keeping his name back
    await ben.page.goto(link);
    await expect(
      ben.page.getByText('someone sent you an invite. sign in to accept it.'),
    ).toBeVisible();
    await signInWithoutName(ben.page, appleId('ben', info));

    // back at /invite: asked first; the tab still holds the token
    await expect(ben.page).toHaveURL(/\/invite$/);
    await expect(prompt(ben.page)).toBeVisible();
    const kept = await ben.page.evaluate(() => sessionStorage.getItem('grub-radar:invite'));
    expect(kept).toBe(link.split('#')[1]);
    await shot(ben.page, 'name-prompt-invite', project);

    await chooseName(ben.page, 'Ben', '🐼');
    // …and the invite carries on
    await expect(
      ben.page.getByText(`dev ${anaLabel} wants to be friends on grub radar.`),
    ).toBeVisible();
    await ben.page.getByRole('button', { name: 'accept' }).click();
    await expect(ben.page.getByText(`you and dev ${anaLabel} are friends now.`)).toBeVisible();
    expect(await ben.page.evaluate(() => sessionStorage.getItem('grub-radar:invite'))).toBeNull();

    // Ana sees the name Ben chose
    await ana.page.goto('/friends');
    await expect(ana.page.getByRole('link', { name: 'See Ben’s spots' })).toBeVisible();
  } finally {
    await ana.ctx.close();
    await ben.ctx.close();
  }
});

test('friends see "a friend" (never "you") until a name is chosen', async ({ browser }, info) => {
  const project = info.project.name;
  const ana = await newPerson(browser, info);
  const cara = await newPerson(browser, info);
  try {
    const link = await inviter(ana.page, freshUser(`ana-${project}`));

    // Cara signs up without a name, and (like accounts from before the question
    // existed) is friends with Ana before choosing one
    await cara.page.goto('/');
    await signInWithoutName(cara.page, appleId('cara', info));
    await expect(prompt(cara.page)).toBeVisible();
    const accepted = await apiPost(cara.page, '/api/invites/accept', {
      token: link.split('#')[1],
    });
    expect(accepted.status).toBe(201);

    // what Ana gets, and what Ana sees
    const list = await ana.page.evaluate(async () => (await fetch('/api/friends')).text());
    expect(list).toContain('"displayName":null');
    expect(list).not.toContain('"you"');
    await ana.page.goto('/friends');
    const link1 = ana.page.getByRole('link', { name: 'See a friend’s spots' });
    await expect(link1).toBeVisible();
    await expect(ana.page.getByText('a friend', { exact: true })).toBeVisible();
    await expect(ana.page.getByText('you', { exact: true })).toHaveCount(0);
    await shot(ana.page, 'friends-placeholder', project);

    // Cara names herself; Ana sees it
    await chooseName(cara.page, 'Cara', '🦊');
    await ana.page.reload();
    await expect(ana.page.getByRole('link', { name: 'See Cara’s spots' })).toBeVisible();
    await expect(ana.page.getByText('a friend', { exact: true })).toHaveCount(0);
  } finally {
    await ana.ctx.close();
    await cara.ctx.close();
  }
});
