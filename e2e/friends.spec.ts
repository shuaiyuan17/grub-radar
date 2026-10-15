import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devLogin, freshUser } from './session';

// Two people, two browsers: Ana sends an invite link, Ben opens it, signs in,
// accepts, and Ana's face shows up on Ben's cards. Fictional people and places
// (both start from the demo list, so their lists overlap).
//
// SHOTS_DIR=/some/dir saves screenshots along the way (not in CI).

const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // let the entrance animations finish, so the picture is the resting state
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
    )
    .toBe(0);
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });
}

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

/** Name and emoji, through the profile panel on /friends. */
async function setProfile(page: Page, name: string, emoji: string) {
  await page.goto('/friends');
  const field = page.getByLabel('your name');
  await field.fill(name);
  const pick = page.getByRole('radio', { name: `Use ${emoji}` });
  // tap the visible emoji (its label); the radio inside is visually hidden
  await page.locator('label').filter({ has: pick }).click();
  await expect(pick).toBeChecked();
  await page.getByRole('button', { name: 'save' }).click();
  await expect(page.getByText('saved. that’s how friends see you.')).toBeVisible();
}

test('invite link → sign in → accept → each other’s faces on the cards', async ({
  browser,
}, info) => {
  const project = info.project.name;
  const u = info.project.use;
  const contextOpts = {
    baseURL: u.baseURL,
    viewport: u.viewport,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    deviceScaleFactor: u.deviceScaleFactor,
    userAgent: u.userAgent,
  };
  const anaCtx = await browser.newContext(contextOpts);
  const benCtx = await browser.newContext(contextOpts);
  const ana = await anaCtx.newPage();
  const ben = await benCtx.newPage();

  // Ana: an account with the demo list, a name and an emoji
  await devLogin(ana, { as: freshUser(`ana-${project}`) });
  await setProfile(ana, 'Ana', '🦊');

  // …makes a link (no share sheet here: it lands on screen, and in the clipboard if allowed)
  await ana.getByRole('button', { name: 'invite a friend' }).click();
  const linkBox = ana.getByRole('textbox', { name: 'your invite link' });
  await expect(linkBox).toHaveValue(/\/invite#[A-Za-z0-9_-]{43}$/);
  const link = await linkBox.inputValue();
  await expect(ana.getByText(/^made .* works until /)).toHaveCount(1);
  await noHorizontalScroll(ana);
  await noSeriousA11yIssues(ana);
  await shot(ana, '1-friends-invite-link', project);

  // the token is in the fragment: it must never reach a server, in any request
  // URL, Referer, or sign-in's returnTo
  const { pathname, hash } = new URL(link);
  const token = hash.slice(1);
  expect(pathname).toBe('/invite');
  const seen: string[] = [];
  ben.on('request', (r) => {
    seen.push(r.url(), r.headers().referer ?? '', r.postData() ?? '');
  });

  // Ben opens it signed out: the wall says there's an invite
  await ben.goto(`${pathname}${hash}`);
  await expect(ben.getByText('someone sent you an invite. sign in to accept it.')).toBeVisible();
  await shot(ben, '2-invite-signed-out', project);

  // "Sign in with Apple": returnTo is /invite alone (stopped there: dev login stands in for Apple)
  let returnTo: string | null = null;
  await ben.route('**/auth/apple/start**', async (route) => {
    returnTo = new URL(route.request().url()).searchParams.get('returnTo');
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'stopped before Apple' });
  });
  await ben.getByRole('button', { name: /Sign in with Apple/ }).click();
  await expect.poll(() => returnTo).toBe('/invite');

  // back from sign-in at /invite, no fragment: the tab kept the token
  await devLogin(ben, { as: freshUser(`ben-${project}`) });
  await ben.goto('/invite');
  await expect(ben.getByText('Ana wants to be friends on grub radar.')).toBeVisible();
  await noHorizontalScroll(ben);
  await noSeriousA11yIssues(ben);
  await shot(ben, '3-invite-accept', project);
  await ben.getByRole('button', { name: 'accept' }).click();
  await expect(ben.getByText('you and Ana are friends now.')).toBeVisible();
  await shot(ben, '4-invite-accepted', project);
  // the only place the token went: the bodies of preview and accept
  const leaks = seen.filter((v) => v.includes(token) && !v.includes('"token"'));
  expect(leaks).toEqual([]);
  expect(seen.filter((v) => v.includes('"token"')).length).toBeGreaterThanOrEqual(2);

  // the link is spent: Ana's "links waiting" is empty again
  await ana.reload();
  await expect(ana.getByText('no links waiting.')).toBeVisible();
  await expect(ana.getByText(/^dev ben-/)).toBeVisible();

  // Ben's list: Ana has been to Lucky Thread, so her fox is on that card
  await ben.goto('/');
  const card = ben.getByRole('article').filter({ hasText: 'Lucky Thread Noodle Bar' });
  await expect(card.getByRole('img', { name: 'Friends who’ve been here: Ana' })).toBeVisible();
  await expect(card.getByRole('img', { name: /Friends who’ve been here/ })).toHaveText('🦊');
  await noHorizontalScroll(ben);
  await shot(ben, '5-list-with-friend-avatar', project);

  // …and her verdict on the place page
  await card.getByRole('link', { name: 'Lucky Thread Noodle Bar', exact: true }).click();
  const takes = ben.getByRole('region', { name: 'friends’ verdicts' });
  await expect(takes.getByText('Ana')).toBeVisible();
  await expect(takes.getByText('loved it')).toBeVisible();
  await noSeriousA11yIssues(ben);
  await shot(ben, '6-place-friend-verdicts', project);

  // Ana's shared list, from Ben's side: no private notes anywhere on the page
  await ben.goto('/friends');
  await ben.getByRole('link', { name: 'See Ana’s spots' }).click();
  await expect(ben.getByRole('heading', { level: 1 })).toContainText('Ana’s spots');
  await shot(ben, '7-friend-spots', project);

  // Ana goes private on Lucky Thread: Ben's card loses her face
  await ana.goto('/place/lucky-thread');
  const justMe = ana.getByRole('radio', { name: 'just me' });
  await expect(ana.getByRole('radio', { name: 'friends' })).toBeChecked();
  // the visible stamp, like a person taps it (the radio inside is visually hidden)
  await ana.getByRole('group', { name: 'who sees this spot' }).getByText('just me').click();
  await expect(ana.getByRole('alert')).toHaveCount(0);
  await expect(justMe).toBeChecked();
  await expect(ana.getByText('only you see this spot.')).toBeVisible();
  await shot(ana, '8-place-visibility-private', project);
  await ben.goto('/');
  await expect(
    ben
      .getByRole('article')
      .filter({ hasText: 'Lucky Thread Noodle Bar' })
      .getByRole('img', { name: /Friends who’ve been here/ }),
  ).toHaveCount(0);

  // a used link stays used, even for a third person
  const cyd = await (await browser.newContext(contextOpts)).newPage();
  await devLogin(cyd, { as: freshUser(`cyd-${project}`), demo: false });
  await cyd.goto(`${pathname}${hash}`);
  await expect(cyd.getByText(/has been used, revoked or has expired/)).toBeVisible();

  await anaCtx.close();
  await benCtx.close();
});

test('/admin: the owner sees numbers; anyone else, the ordinary not-found page', async ({
  page,
}, info) => {
  // someone else first: same page as any unknown URL, and the API is a plain 404
  await devLogin(page, { as: freshUser(`nobody-${info.project.name}`), demo: false });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'nothing on the radar here.' })).toBeVisible();
  await expect(page.getByText(/back office/)).toHaveCount(0);
  const api = await page.request.get('/api/admin/stats');
  expect(api.status()).toBe(404);
  const unknown = await page.request.get('/api/no-such-thing');
  expect(await api.text()).toBe(await unknown.text());

  // the admin (.dev.vars ADMIN_APPLE_SUBS names the dev user "admin")
  await devLogin(page, { as: 'admin', demo: false });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'the back office' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);
  await shot(page, '9-admin', info.project.name);
});
