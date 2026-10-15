import { expect, test, type Locator, type Page } from '@playwright/test';
import { devLogin, freshUser, withSession } from './session';

// Narrow-phone layout guard: nothing may push the page sideways, and the
// home panel's field + save button and the list's count + roll button stay
// inside their rows without colliding. (The list / radar nav floats over the
// content on purpose, so it is not part of the overlap check.)
//
// isMobile is off so the viewport can't zoom out to fit an overflow, which
// would hide it from scrollWidth.
test.use({ isMobile: false });

// 320/430: the ends of the phone range; 365/375: around the header's container-query steps
const WIDTHS = [320, 365, 375, 402, 430] as const;
const LANGS = [
  { lang: 'en', home: /^(set your home|Set your home location|Change your home location)$/ },
  { lang: 'zh-Hans', home: /^(设置你的家|设置家的位置|修改家的位置)$/ },
] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b as Box;
}

function expectInside(inner: Box, outer: Box, what: string) {
  // a couple of px for the hand-drawn tilts (the roll button sits at -2deg)
  const slack = 2;
  expect(inner.x, `${what}: left edge`).toBeGreaterThanOrEqual(outer.x - slack);
  expect(inner.x + inner.width, `${what}: right edge`).toBeLessThanOrEqual(
    outer.x + outer.width + slack,
  );
}

function expectApart(a: Box, b: Box, what: string) {
  const overlap =
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap, `${what} overlap`).toBe(false);
}

async function noSidewaysScroll(page: Page, width: number) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  expect(m.sw).toBeLessThanOrEqual(m.iw);
  expect(m.sw).toBeLessThanOrEqual(width);
}

/**
 * Measure with the real fonts, not fallback metrics: wait for every face in
 * flight, and in zh until the headline's ZCOOL KuaiLe and (when a note on the
 * page has Han text) Long Cang slices are actually loaded.
 */
async function fontsSettled(page: Page, lang: string) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (lang !== 'zh-Hans') return;
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const han = (el: Element | null) =>
          (el?.textContent ?? '').match(/\p{Script=Han}+/gu)?.join('') ?? '';
        const head = han(document.querySelector('h1'));
        const notes = [...document.querySelectorAll('.note')].map(han).join('');
        const faces: [string, string][] = [];
        if (head) faces.push(['ZCOOL KuaiLe', head]);
        if (notes) faces.push(['Long Cang', notes]);
        for (const [family, text] of faces) await document.fonts.load(`16px "${family}"`, text);
        await document.fonts.ready;
        return faces.every(([family, text]) => document.fonts.check(`16px "${family}"`, text));
      }),
    )
    .toBe(true);
}

// "desktop …" tests run in the desktop project; the rest in the phone ones (Chromium and
// WebKit). Skip the others before signing in.
const PHONES = ['phone', 'webkit-phone'];
test.beforeEach(async ({ page }, info) => {
  const desktop = info.title.startsWith('desktop');
  test.skip(
    desktop ? info.project.name !== 'desktop' : !PHONES.includes(info.project.name),
    desktop ? 'desktop only' : 'phones only',
  );
  // a user per test (with the demo spots): the shared dev user's write brake (60/min)
  // is too small for three projects' worth of demo imports
  await devLogin(page, { as: freshUser('layout') });
});

for (const { lang, home } of LANGS) {
  for (const width of WIDTHS) {
    test(`${lang} @ ${width}px: no sideways overflow, home panel + list toolbar fit`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((l) => {
        localStorage.setItem('grub-radar:lang', l);
      }, lang);
      await page.goto('/');
      await fontsSettled(page, lang);

      // list toolbar: count and roll button inside their row, not on top of each other
      const roll = page.getByRole('button', { name: /can't decide\? roll|选不出来？摇一个/ });
      await expect(roll).toBeVisible();
      const count = page.getByText(/^\d+ (spots?|家) · /);
      const row = count.locator('xpath=..');
      const rowBox = await box(row);
      const countBox = await box(count);
      const rollBox = await box(roll);
      expectInside(countBox, rowBox, 'count');
      expectInside(rollBox, rowBox, 'roll button');
      expectApart(countBox, rollBox, 'count / roll button');
      await noSidewaysScroll(page, width);

      // home panel: the coordinates field and save button stay inside the panel
      await page.getByRole('button', { name: home }).filter({ visible: true }).first().click();
      const input = page.locator('input[inputmode="decimal"]');
      await expect(input).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const panel = page.locator('section').filter({ has: input });
      const field = input.locator('xpath=..');
      const save = panel.locator('button[type="submit"]');
      const panelBox = await box(panel);
      const fieldBox = await box(field);
      const saveBox = await box(save);
      expectInside(fieldBox, panelBox, 'coordinates field');
      expectInside(await box(input), panelBox, 'coordinates input');
      expectInside(saveBox, panelBox, 'save button');
      expectApart(fieldBox, saveBox, 'field / save button');
      await noSidewaysScroll(page, width);
    });
  }
}

test('desktop: the home panel field and save button share a row inside the panel', async ({
  page,
}) => {
  await page.goto('/');
  await fontsSettled(page, 'en');
  await page
    .getByRole('button', {
      name: /^(set your home|Set your home location|Change your home location)$/,
    })
    .filter({ visible: true })
    .first()
    .click();
  const input = page.locator('input[inputmode="decimal"]');
  await expect(input).toBeVisible();
  const panel = page.locator('section').filter({ has: input });
  const panelBox = await box(panel);
  const fieldBox = await box(input.locator('xpath=..'));
  const saveBox = await box(panel.locator('button[type="submit"]'));
  expectInside(fieldBox, panelBox, 'coordinates field');
  expectInside(saveBox, panelBox, 'save button');
  expectApart(fieldBox, saveBox, 'field / save button');
  // same row: the button sits after the field
  expect(saveBox.x).toBeGreaterThan(fieldBox.x + fieldBox.width);
  await noSidewaysScroll(page, 1440);
});

// --- every text field, on every page that has one -------------------------------------
//
// WebKit gives a bare <input> a wide intrinsic size, so a field whose frame is sized by
// its content ran off its card on iPhones (Chromium never showed it). Each field and
// its hand-drawn frame must sit inside its card, and the page must not scroll sideways.

const INPUT_WIDTHS = [320, 375, 402, 430] as const;

interface FitReport {
  fields: number;
  bad: string[];
  scrollWidth: number;
  innerWidth: number;
}

/** Measures every visible text field on the page against its frame, card and the viewport. */
function measureFields(): FitReport {
  const slack = 2; // the hand-drawn tilts
  const vw = window.innerWidth;
  const bad: string[] = [];
  let fields = 0;
  const skip = new Set(['checkbox', 'radio', 'file', 'hidden', 'range']);
  for (const el of document.querySelectorAll<HTMLElement>('input, textarea, select')) {
    if (el instanceof HTMLInputElement && skip.has(el.type)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue; // visually hidden
    fields++;
    const label = (el as HTMLInputElement).labels?.[0]?.textContent.trim();
    const name = [label, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.id].find(
      Boolean,
    );
    const frame = el.closest('.sk') ?? el;
    const card =
      frame.parentElement?.closest('.sk:not(.flat), [role="dialog"], dialog, main') ??
      document.body;
    const c = card.getBoundingClientRect();
    const inside = (b: DOMRect, o: { left: number; right: number }) =>
      b.left >= o.left - slack && b.right <= o.right + slack;
    const px = (b: DOMRect) => `${Math.round(b.left)}..${Math.round(b.right)}`;
    if (!inside(r, c)) bad.push(`"${name}" input ${px(r)} outside its card ${px(c)}`);
    const f = frame.getBoundingClientRect();
    if (frame !== el && !inside(f, c))
      bad.push(`"${name}" frame ${px(f)} outside its card ${px(c)}`);
    if (!inside(c, { left: 0, right: vw })) bad.push(`"${name}" card ${px(c)} outside 0..${vw}`);
  }
  return {
    fields,
    bad,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: vw,
  };
}

/** At each phone width: `min` fields or more, all inside their cards, no sideways scroll. */
async function fieldsFit(page: Page, min: number) {
  for (const width of INPUT_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    // a frame for the resize (and the ink redraw) to land
    await page.evaluate(
      () =>
        new Promise((r) => {
          requestAnimationFrame(r);
        }),
    );
    const m = await page.evaluate(measureFields);
    expect(m.fields, `fields on the page @ ${width}px`).toBeGreaterThanOrEqual(min);
    expect(m.bad, `@ ${width}px`).toEqual([]);
    expect(m.scrollWidth, `sideways scroll @ ${width}px`).toBeLessThanOrEqual(m.innerWidth);
    expect(m.scrollWidth, `sideways scroll @ ${width}px`).toBeLessThanOrEqual(width);
  }
}

test('fields fit: settings (token name, then the new token)', async ({ page }) => {
  await page.goto('/settings');
  const name = page.getByLabel('name it (it shows as “found by …”)');
  await expect(name).toBeVisible();
  await fieldsFit(page, 1);
  await name.fill('grok bot');
  await page.getByRole('button', { name: 'make a token' }).click();
  await expect(page.getByLabel(/^your new token/)).toBeVisible();
  await fieldsFit(page, 2);
});

test('fields fit: settings in Chinese', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
  });
  await page.goto('/settings');
  await expect(page.getByLabel('起个名字（会显示为“发现者”）')).toBeVisible();
  await fieldsFit(page, 1);
});

test('fields fit: the name prompt', async ({ page }) => {
  // the prompt shows while the account has no name (name.spec.ts walks the real flow, which
  // WebKit can't: it won't keep the Secure sign-in cookies on http://localhost). This route
  // is the page's newest, so it runs instead of devLogin's: it adds the cookie itself.
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch({ headers: withSession(page, route.request().headers()) });
    const me = (await res.json()) as { user: { nameSet: boolean } };
    me.user.nameSet = false;
    await route.fulfill({ status: res.status(), json: me });
  });
  await page.goto('/');
  const d = page.getByRole('dialog', { name: 'what should we call you?' });
  await expect(d.getByRole('textbox', { name: 'your name' })).toBeVisible({ timeout: 15_000 });
  await fieldsFit(page, 1);
});

test('fields fit: friends (profile name, invite link)', async ({ page }) => {
  await page.goto('/friends');
  await expect(page.getByRole('textbox', { name: 'your name' })).toBeVisible();
  await fieldsFit(page, 1);
  await page.getByRole('button', { name: 'invite a friend' }).click();
  await expect(page.getByRole('textbox', { name: 'your invite link' })).toBeVisible();
  await fieldsFit(page, 2);
});

test('fields fit: add (search)', async ({ page }) => {
  await page.goto('/add');
  await expect(page.getByRole('searchbox')).toBeVisible();
  await fieldsFit(page, 1);
});

test('fields fit: add by hand', async ({ page }) => {
  await page.goto('/add/manual');
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await fieldsFit(page, 4);
});

test('fields fit: edit a spot', async ({ page }) => {
  await page.goto('/place/lucky-thread/edit');
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await fieldsFit(page, 3);
});

test('fields fit: a place (dishes, notes)', async ({ page }) => {
  await page.goto('/place/lucky-thread');
  await expect(page.getByLabel('add a dish')).toBeVisible();
  await expect(page.getByPlaceholder('add a note')).toBeVisible();
  await fieldsFit(page, 2);
});

test('fields fit: the home panel', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', {
      name: /^(set your home|Set your home location|Change your home location)$/,
    })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.locator('input[inputmode="decimal"]')).toBeVisible();
  await fieldsFit(page, 1);
});

/** A JPEG without its APP1-APP15 segments (the canvas adds ICC / EXIF; the server refuses them). */
function stripJpegMetadata(b: Buffer): Buffer {
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1] ?? 0;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const end = i + 2 + b.readUInt16BE(i + 2);
    if (marker < 0xe1 || marker > 0xef) parts.push(b.subarray(i, end));
    i = end;
  }
  parts.push(b.subarray(i));
  return Buffer.concat(parts);
}

test('fields fit: a photo caption', async ({ page }) => {
  await page.goto('/place/lucky-thread');
  // a small JPEG from the browser's canvas (no EXIF), stored through the API: WebKit's
  // request interception (the session route) drops an XHR upload's body
  const jpeg = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#e0583a';
    ctx.fillRect(0, 0, 120, 80);
    const blob = await new Promise<Blob | null>((r) => {
      c.toBlob(r, 'image/jpeg', 0.9);
    });
    if (!blob) throw new Error('no jpeg');
    let s = '';
    for (const b of new Uint8Array(await blob.arrayBuffer())) s += String.fromCharCode(b);
    return btoa(s);
  });
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(`${origin}/api/photos?place=lucky-thread`, {
    headers: withSession(page, {
      'content-type': 'image/jpeg',
      'x-grub-request': '1',
      origin,
    }),
    data: stripJpegMetadata(Buffer.from(jpeg, 'base64')),
  });
  expect(res.status(), await res.text()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: 'Photo 1 of 1, view larger' }).click();
  await expect(page.getByRole('dialog').getByLabel('caption')).toBeVisible();
  await fieldsFit(page, 1);
});
