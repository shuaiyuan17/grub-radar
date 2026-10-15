import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { checkImage } from '../worker/lib/imageGuard';
import { containsExif, exifBody, withExif } from '../worker/test/images';
import { devLogin, freshUser } from './session';

// Photos, with three people in three browsers: Ana adds photos of a spot
// (one straight from a "camera", EXIF with a GPS position and a sideways
// orientation), her friend Ben sees them under her verdict, Cyd (not a
// friend) gets a 404 for the very same URL, and Ana deletes one.
// Fictional people and places.
//
// SHOTS_DIR=/some/dir saves screenshots along the way (not in CI).

const SHOTS = process.env.SHOTS_DIR;

async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
    )
    .toBe(0);
}

async function shot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });
}

async function noSeriousA11yIssues(page: Page) {
  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function newPage(browser: Browser, info: TestInfo, extra: { reducedMotion?: 'reduce' } = {}) {
  const u = info.project.use;
  const ctx = await browser.newContext({
    baseURL: u.baseURL,
    viewport: u.viewport,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    deviceScaleFactor: u.deviceScaleFactor,
    userAgent: u.userAgent,
    ...extra,
  });
  const page = await ctx.newPage();
  const csp: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) csp.push(m.text());
  });
  return { ctx, page, csp };
}

/** A same-origin JSON write from the page (what the app's fetch sends). */
async function apiWrite(page: Page, path: string, body: unknown = {}): Promise<unknown> {
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

/**
 * A real JPEG, 400x200 (wide), made by the browser, then given what a phone
 * camera adds: an EXIF block with GPS coordinates and orientation 6 ("rotate
 * 90° to display"), so it should come out 200x400 (tall).
 */
async function cameraJpeg(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 200;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#e0583a';
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#ffd84a';
    ctx.fillRect(200, 0, 200, 200);
    ctx.fillStyle = '#1e1b18';
    ctx.font = 'bold 60px sans-serif';
    ctx.fillText('pho', 140, 120);
    const blob = await new Promise<Blob | null>((r) => {
      c.toBlob(r, 'image/jpeg', 0.9);
    });
    if (!blob) throw new Error('no jpeg');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  const base = new Uint8Array(Buffer.from(b64, 'base64'));
  const withGps = withExif(base, exifBody({ gps: true, orientation: 6 }));
  expect(containsExif(withGps)).toBe(true);
  return Buffer.from(withGps);
}

/** What the server stores and serves for a photo URL, read as the given browser. */
async function served(page: Page, url: string) {
  const res = await page.request.get(url);
  return { res, bytes: new Uint8Array(await res.body()) };
}

test('add photos, a friend sees them, a stranger gets a 404, delete one', async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const project = info.project.name;
  const ana = await newPage(browser, info);
  const ben = await newPage(browser, info, { reducedMotion: 'reduce' });
  const cyd = await newPage(browser, info);

  await devLogin(ana.page, { as: freshUser(`photo-ana-${project}`) });
  await devLogin(ben.page, { as: freshUser(`photo-ben-${project}`) });
  await devLogin(cyd.page, { as: freshUser(`photo-cyd-${project}`) });
  // Ana and Ben are friends (the invite flow itself is friends.spec.ts)
  const { token } = (await apiWrite(ana.page, '/api/invites')) as { token: string };
  await apiWrite(ben.page, '/api/invites/accept', { token });

  // --- Ana: the empty frame, then a photo straight from the "camera"
  await ana.page.goto('/place/lucky-thread');
  await expect(ana.page.getByText('no photo yet')).toBeVisible();
  await shot(ana.page, '1-place-no-photo', project);
  const camera = await cameraJpeg(ana.page);
  const picker = ana.page.getByLabel('Add photos of this spot');
  await picker.setInputFiles({ name: 'IMG_0420.JPG', mimeType: 'image/jpeg', buffer: camera });
  const first = ana.page.getByRole('button', { name: 'Photo 1 of 1, view larger' });
  await expect(first).toBeVisible();
  await expect(ana.page.getByRole('alert')).toHaveCount(0);

  // what the server keeps: WebP, turned upright (200x400), no EXIF, no GPS
  const firstUrl = (await first.locator('img').getAttribute('src')) ?? '';
  expect(firstUrl).toMatch(/^\/api\/photos\/ph_[0-9a-z]{26}$/);
  const one = await served(ana.page, firstUrl);
  expect(one.res.status()).toBe(200);
  expect(one.res.headers()['content-type']).toBe('image/webp');
  expect(one.res.headers()['cache-control']).toMatch(/^private, max-age=/);
  expect(containsExif(one.bytes)).toBe(false);
  expect(checkImage(one.bytes)).toEqual({
    ok: true,
    type: 'image/webp',
    width: 200,
    height: 400,
  });
  expect(one.bytes.length).toBeLessThan(300 * 1024);

  // --- a browser that can't encode WebP (older Safari hands back PNG): JPEG, still no EXIF
  await ana.page.addInitScript(() => {
    const proto = HTMLCanvasElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'toBlob')?.value as (
      this: HTMLCanvasElement,
      ...args: Parameters<HTMLCanvasElement['toBlob']>
    ) => void;
    proto.toBlob = function (cb, type, quality) {
      original.call(this, cb, type === 'image/webp' ? 'image/png' : type, quality);
    };
  });
  await ana.page.reload();
  await ana.page
    .getByLabel('Add photos of this spot')
    .setInputFiles({ name: 'IMG_0421.JPG', mimeType: 'image/jpeg', buffer: camera });
  const second = ana.page.getByRole('button', { name: 'Photo 2 of 2, view larger' });
  await expect(second).toBeVisible();
  const secondUrl = (await second.locator('img').getAttribute('src')) ?? '';
  const two = await served(ana.page, secondUrl);
  expect(two.res.headers()['content-type']).toBe('image/jpeg');
  expect(containsExif(two.bytes)).toBe(false);
  expect(checkImage(two.bytes)).toMatchObject({ ok: true, width: 200, height: 400 });

  // --- something the browser can't decode: a friendly message, nothing stored
  await ana.page.getByLabel('Add photos of this spot').setInputFiles({
    name: 'IMG_0422.HEIC',
    mimeType: 'image/heic',
    buffer: Buffer.from('not really a heic file'),
  });
  await expect(ana.page.getByRole('alert')).toContainText('couldn’t open “IMG_0422.HEIC”');
  await expect(ana.page.getByRole('button', { name: /^Photo \d of 2, view larger$/ })).toHaveCount(
    2,
  );
  await noHorizontalScroll(ana.page);
  await noSeriousA11yIssues(ana.page);
  await shot(ana.page, '2-place-with-photos', project);

  // the big view
  await second.click();
  const viewer = ana.page.getByRole('dialog');
  await expect(viewer.getByRole('heading')).toHaveText('photo · 2 / 2');
  await expect
    .poll(() => viewer.locator('img').evaluate((img: HTMLImageElement) => img.naturalHeight))
    .toBe(400);
  await viewer.getByLabel('caption').fill('the broth, up close');
  await viewer.getByRole('button', { name: 'save' }).click();
  await expect(viewer.getByRole('alert')).toHaveCount(0);
  await noSeriousA11yIssues(ana.page);
  await shot(ana.page, '3-viewer-owner', project);
  await viewer.getByRole('button', { name: 'close' }).click();
  await expect(viewer).toHaveCount(0);

  // --- Ben, her friend: her photos under her verdict, view-only, no motion (he asked for less)
  await ben.page.goto('/place/lucky-thread');
  const takes = ben.page.getByRole('region', { name: 'friends’ verdicts' });
  await expect(takes.getByText('loved it')).toBeVisible();
  const anaPhotos = takes.getByRole('button', { name: /’s photo \d of 2, view larger$/ });
  await expect(anaPhotos).toHaveCount(2);
  await anaPhotos.nth(1).click();
  const benViewer = ben.page.getByRole('dialog');
  await expect(benViewer.getByText('the broth, up close')).toBeVisible();
  await expect(benViewer.getByRole('button', { name: 'delete photo' })).toHaveCount(0);
  await expect
    .poll(() => benViewer.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(200);
  // reduced motion: nothing animates, the dialog's backdrop included
  expect(
    await ben.page.evaluate(() =>
      document.getAnimations().map((a) => (a as CSSAnimation).animationName),
    ),
  ).toEqual([]);
  await noSeriousA11yIssues(ben.page);
  await shot(ben.page, '4-friend-sees-photos', project);
  await benViewer.getByRole('button', { name: 'close' }).click();
  expect((await ben.page.request.get(firstUrl)).status()).toBe(200);

  // --- Cyd, not a friend: the same URL is a 404, word for word an unknown photo's
  const stranger = await cyd.page.request.get(firstUrl);
  expect(stranger.status()).toBe(404);
  const unknown = await cyd.page.request.get(`/api/photos/ph_${'0'.repeat(26)}`);
  expect(await stranger.text()).toBe(await unknown.text());
  await cyd.page.goto('/place/lucky-thread');
  await expect(cyd.page.locator('main')).toBeVisible();
  await expect(cyd.page.getByRole('region', { name: 'friends’ verdicts' })).toHaveCount(0);
  expect(await cyd.page.content()).not.toContain(firstUrl);

  // --- Ana deletes the first one: gone for her, for Ben, from storage
  await ana.page.getByRole('button', { name: 'Photo 1 of 2, view larger' }).click();
  await viewer.getByRole('button', { name: 'delete photo' }).click();
  await viewer.getByRole('button', { name: 'yes, delete' }).click();
  await expect(viewer.getByRole('heading')).toHaveText('photo · 1 / 1');
  await viewer.getByRole('button', { name: 'close' }).click();
  await expect(ana.page.getByRole('button', { name: /^Photo \d of \d, view larger$/ })).toHaveCount(
    1,
  );
  expect((await ana.page.request.get(firstUrl)).status()).toBe(404);
  expect((await ben.page.request.get(firstUrl)).status()).toBe(404);
  expect((await ben.page.request.get(secondUrl)).status()).toBe(200);

  // the CSP allowed everything (the blob: upload previews included)
  expect([...ana.csp, ...ben.csp, ...cyd.csp]).toEqual([]);

  await ana.ctx.close();
  await ben.ctx.close();
  await cyd.ctx.close();
});

test('zh: the photo frame speaks Chinese', async ({ page }, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
  });
  await devLogin(page, { as: freshUser(`photo-zh-${info.project.name}`) });
  await page.goto('/place/lucky-thread');
  await expect(page.getByText('还没有照片')).toBeVisible();
  await expect(page.getByLabel('给这家店添加照片')).toBeAttached();
  await expect(page.getByText('添加照片', { exact: true })).toBeVisible();
  await shot(page, '5-zh-place-no-photo', info.project.name);
});
