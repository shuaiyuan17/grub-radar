import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { metaTags } from '../scripts/link-preview';
import { devLogin, freshUser } from './session';

// A /place/:id link shared with someone who doesn't have that spot. Ana shares; Ben is her
// friend; Cyd isn't. Fictional people and places.
//
// SHOTS_DIR=/some/dir saves screenshots along the way (not in CI).

const SHOTS = process.env.SHOTS_DIR;

const runningAnimations = (page: Page) =>
  page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

async function shot(page: Page, name: string, info: TestInfo) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect.poll(() => runningAnimations(page)).toBe(0);
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png`, fullPage: true });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function noSeriousA11yIssues(page: Page) {
  await expect.poll(() => runningAnimations(page)).toBe(0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

/** A same-origin JSON call from the page (the session cookie rides along). */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-grub-request': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    },
    { method, path, body },
  );
}

async function newPage(browser: Browser, info: TestInfo) {
  const u = info.project.use;
  const ctx = await browser.newContext({
    baseURL: u.baseURL,
    viewport: u.viewport,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    deviceScaleFactor: u.deviceScaleFactor,
    userAgent: u.userAgent,
  });
  return ctx.newPage();
}

const KITE_NOTE = 'get the cold noodles';
const ANA_SECRET = 'ana-private-notes-e2e';

interface World {
  ana: Page;
  anaId: string;
  kite: string;
  lantern: string;
}

/** Ana with two spots she shares (and a private note), and an invite link. */
async function anaWithSpots(browser: Browser, info: TestInfo): Promise<World & { invite: string }> {
  const ana = await newPage(browser, info);
  await devLogin(ana, { as: freshUser(`ana-${info.project.name}`), demo: false });
  expect(
    (await api(ana, 'PATCH', '/api/me', { displayName: 'Ana', avatarEmoji: '🦊' })).status,
  ).toBe(200);
  const me = (await api(ana, 'GET', '/api/me')).body as { user: { id: string } };
  const kite = await api(ana, 'POST', '/api/spots', {
    name: 'Kite Noodle Bar',
    kind: 'food',
    location: { lat: 47.6101, lng: -122.3301 },
    status: 'been',
    verdict: 'good',
    note: KITE_NOTE,
  });
  expect(kite.status).toBe(201);
  const kiteId = (kite.body as { id: string }).id;
  expect((await api(ana, 'PATCH', `/api/spots/${kiteId}`, { myNote: ANA_SECRET })).status).toBe(
    200,
  );
  const lantern = await api(ana, 'POST', '/api/spots', {
    name: 'Paper Lantern Cafe',
    kind: 'coffee',
    location: { lat: 47.6152, lng: -122.3201 },
    note: 'flat white, window seat',
  });
  expect(lantern.status).toBe(201);
  const invite = await api(ana, 'POST', '/api/invites');
  expect(invite.status).toBe(201);
  return {
    ana,
    anaId: me.user.id,
    kite: kiteId,
    lantern: (lantern.body as { id: string }).id,
    invite: (invite.body as { token: string }).token,
  };
}

test('a friend opens a shared link: the place, her take, add to my radar (once)', async ({
  browser,
}, info) => {
  const { ana, kite, invite } = await anaWithSpots(browser, info);

  // the owner's page is the same as ever, plus "share"
  await ana.goto(`/place/${kite}`);
  await expect(ana.getByRole('heading', { level: 1 })).toHaveText('Kite Noodle Bar');
  const share = ana.getByRole('button', { name: /Share Kite Noodle Bar/ });
  await expect(share).toBeVisible();
  await expect(ana.getByText('shared with you')).toHaveCount(0);
  await ana.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await ana.evaluate(() => {
    // no share sheet in headless Chromium: the link is copied
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  });
  await share.click();
  await expect(ana.getByText(/link copied/)).toBeVisible();
  await noSeriousA11yIssues(ana);
  await shot(ana, 'share-1-owner', info);

  // Ben, her friend
  const ben = await newPage(browser, info);
  await devLogin(ben, { as: freshUser(`ben-${info.project.name}`), demo: false });
  expect((await api(ben, 'PATCH', '/api/me', { displayName: 'Ben' })).status).toBe(200);
  expect((await api(ben, 'POST', '/api/invites/accept', { token: invite })).status).toBe(201);

  const bodies: string[] = [];
  ben.on('response', (r) => {
    if (r.url().includes('/api/'))
      void r.text().then(
        (t) => bodies.push(t),
        () => undefined,
      );
  });
  await ben.goto(`/place/${kite}`);
  await expect(ben.getByRole('heading', { level: 1 })).toHaveText('Kite Noodle Bar');
  await expect(ben.getByText('shared with you')).toBeVisible();
  const takes = ben.getByRole('region', { name: 'friends’ verdicts' });
  await expect(takes.getByText('Ana')).toBeVisible();
  await expect(takes.getByText('loved it')).toBeVisible();
  await expect(takes.getByText(`“${KITE_NOTE}”`)).toBeVisible();
  await expect(ben.getByRole('figure')).toContainText('where it is');
  await noHorizontalScroll(ben);
  await noSeriousA11yIssues(ben);
  await shot(ben, 'share-2-friend-view', info);
  expect(bodies.join('\n')).not.toContain(ANA_SECRET);

  // add to my radar: as "want", then it's Ben's own page
  await ben.getByRole('button', { name: /Add Kite Noodle Bar to your radar/ }).click();
  await expect(ben.getByText('on your radar. been already? mark it below.')).toBeVisible();
  await expect(ben.getByText('shared with you')).toHaveCount(0);
  await expect(ben.getByText('want to try').first()).toBeVisible();
  await shot(ben, 'share-3-added', info);
  await ben.reload();
  await expect(ben.getByRole('button', { name: /Share Kite Noodle Bar/ })).toBeVisible();
  // adding again changes nothing: one entry, 200
  const again = await api(ben, 'POST', '/api/spots', { placeId: kite, status: 'want' });
  expect(again.status).toBe(200);
  const list = (await api(ben, 'GET', '/api/spots')).body as { id: string; note?: string }[];
  expect(list.filter((s) => s.id === kite)).toHaveLength(1);
  // none of Ana's words came with it
  expect(list.find((s) => s.id === kite)?.note).toBeUndefined();

  await ana.context().close();
  await ben.context().close();
});

test("a friend's list: tap a card, land on the shared view with their take first, go back", async ({
  browser,
}, info) => {
  const { ana, anaId, lantern, invite } = await anaWithSpots(browser, info);
  const ben = await newPage(browser, info);
  await devLogin(ben, { as: freshUser(`ben2-${info.project.name}`), demo: false });
  expect((await api(ben, 'PATCH', '/api/me', { displayName: 'Ben' })).status).toBe(200);
  expect((await api(ben, 'POST', '/api/invites/accept', { token: invite })).status).toBe(201);

  await ben.goto(`/friends/${anaId}`);
  await expect(ben.getByRole('heading', { name: 'Ana’s spots' })).toBeVisible();
  const card = ben.getByRole('link', { name: 'Paper Lantern Cafe' });
  // a real link, keyboard-focusable, with a visible focus ring
  await card.focus();
  await expect(card).toBeFocused();
  await shot(ben, 'share-4-friend-list', info);
  // tap the card itself, away from the name
  const box = await ben
    .getByRole('listitem')
    .filter({ hasText: 'Paper Lantern Cafe' })
    .boundingBox();
  expect(box).not.toBeNull();
  if (box) await ben.mouse.click(box.x + box.width - 12, box.y + box.height - 12);
  await expect(ben).toHaveURL(new RegExp(`/place/${lantern}$`));
  await expect(ben.getByRole('heading', { level: 1 })).toHaveText('Paper Lantern Cafe');
  const takes = ben.getByRole('region', { name: 'friends’ verdicts' });
  await expect(takes.getByRole('listitem').first()).toContainText('Ana');
  await expect(takes.getByRole('listitem').first()).toContainText('flat white, window seat');
  await noSeriousA11yIssues(ben);
  await shot(ben, 'share-5-from-friend-list', info);

  await ben.getByRole('link', { name: 'back' }).click();
  await expect(ben).toHaveURL(new RegExp(`/friends/${anaId}$`));
  await expect(ben.getByRole('heading', { name: 'Ana’s spots' })).toBeVisible();

  await ana.context().close();
  await ben.context().close();
});

test('a non-friend sees the place only, and nothing of whoever has it', async ({
  browser,
}, info) => {
  const { ana, kite } = await anaWithSpots(browser, info);
  const cyd = await newPage(browser, info);
  await devLogin(cyd, { as: freshUser(`cyd-${info.project.name}`), demo: false });
  const bodies: string[] = [];
  cyd.on('response', (r) => {
    if (r.url().includes('/api/'))
      void r.text().then(
        (t) => bodies.push(t),
        () => undefined,
      );
  });
  await cyd.goto(`/place/${kite}`);
  await expect(cyd.getByRole('heading', { level: 1 })).toHaveText('Kite Noodle Bar');
  await expect(cyd.getByText(/none of your friends have a take/)).toBeVisible();
  await expect(cyd.getByRole('region', { name: 'friends’ verdicts' })).toHaveCount(0);
  await noHorizontalScroll(cyd);
  await shot(cyd, 'share-6-non-friend', info);
  const seen = bodies.join('\n');
  for (const s of ['Ana', KITE_NOTE, ANA_SECRET, 'loved it', '"good"'])
    expect(seen).not.toContain(s);

  // reduced motion: nothing moves here either
  await cyd.emulateMedia({ reducedMotion: 'reduce' });
  await cyd.reload();
  await expect(cyd.getByRole('heading', { level: 1 })).toHaveText('Kite Noodle Bar');
  expect(await runningAnimations(cyd)).toBe(0);

  await ana.context().close();
  await cyd.context().close();
});

test('signed out: the wall says a spot was shared, then sign in comes back to it', async ({
  browser,
  page,
}, info) => {
  const { ana, kite } = await anaWithSpots(browser, info);
  const bodies: string[] = [];
  page.on('response', (r) => {
    const type = r.headers()['content-type'] ?? '';
    if (/font|image/.test(type)) return;
    void r.text().then(
      (t) => bodies.push(t),
      () => undefined,
    );
  });
  await page.goto(`/place/${kite}`);
  await expect(page.getByText('someone shared a spot with you. sign in to see it.')).toBeVisible();
  await shot(page, 'share-7-wall', info);
  // nothing of the place before sign-in
  expect(bodies.join('\n')).not.toContain('Kite Noodle');

  await page.getByRole('button', { name: 'Sign in with Apple' }).click();
  await expect(page).toHaveURL(/\/auth\/authorize/);
  expect(new URL(page.url()).searchParams.get('state')).toBeTruthy();
  await page
    .getByLabel('Apple ID')
    .fill(`dee-share-${info.project.name}-${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(new RegExp(`/place/${kite}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kite Noodle Bar');
  await expect(page.getByText('shared with you')).toBeVisible();

  await ana.context().close();
});

test('link previews for /place/:id are the generic card, with nothing of the place', async ({
  browser,
  request,
}, info) => {
  const { ana, kite } = await anaWithSpots(browser, info);
  const res = await request.get(`/place/${kite}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; facebookexternalhit/1.1; Twitterbot/1.0)' },
  });
  expect(res.status()).toBe(200);
  const html = await res.text();
  const home = metaTags(await (await request.get('/')).text());
  const here = metaTags(html);
  expect(here.get('og:title')).toBe(home.get('og:title'));
  expect(here.get('og:image')).toBe(home.get('og:image'));
  expect(html).not.toContain('Kite Noodle');
  await ana.context().close();
});
