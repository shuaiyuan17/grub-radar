/**
 * POST /auth/callback answers with the "signing you in…" page; GET
 * /auth/finish does the slow part. These pin down that splitting it kept
 * every guarantee: state checked before anything, single use, the nonce,
 * nothing usable without the page's `t`, strict CSP, no script.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppleKeys } from '../auth/appleKeys';
import { PENDING_COOKIE } from '../auth/pending';
import { SIGNING_IN_STYLE } from '../auth/signingInPage';
import {
  call,
  cookieFrom,
  fakeAppleKeys,
  followHandoff,
  handoffTarget,
  mockApple,
  postCallback,
  setCookieLine,
  startSignIn,
  timingNames,
  tokenResponse,
} from '../test/helpers';

const apple = await fakeAppleKeys();

function appleAnswers() {
  let nonce = '';
  const mock = mockApple(apple, async () => tokenResponse(await apple.idToken({ nonce })));
  return {
    ...mock,
    setNonce(n: string) {
      nonce = n;
    },
  };
}

/** Start, then Apple's form_post: the hand-off page, not yet signed in. */
async function handoff(headers: Record<string, string> = {}) {
  const mock = appleAnswers();
  const start = await startSignIn('/radar');
  mock.setNonce(start.nonce);
  const page = await call('/auth/callback', {
    method: 'POST',
    cookie: start.cookie,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
      ...headers,
    },
    body: new URLSearchParams({ code: 'c.fictional', state: start.state }).toString(),
  });
  const target = (await handoffTarget(page)) ?? '';
  const cookie = cookieFrom(page, PENDING_COOKIE) ?? '';
  return { mock, start, page, target, cookie };
}

const countRows = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

beforeEach(async () => {
  await resetAppleKeys(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM auth_identities'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /auth/callback: the "signing you in…" page', () => {
  it('answers at once, before any Apple or D1 work, with no session yet', async () => {
    const { page, mock, target } = await handoff();
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(mock.calls).toHaveLength(0);
    expect(mock.keyFetches).toHaveLength(0);
    expect(cookieFrom(page, '__Host-grub_session')).toBeNull();
    expect(await countRows('users')).toBe(0);
    expect(target).toMatch(/^\/auth\/finish\?t=[\w-]{32}$/);
    // no D1 at all on this request
    expect(timingNames(page)).not.toContain('d1_1');
    expect(page.headers.get('server-timing')).toContain('d1;desc="0 round trips"');
  });

  it('is static: no script, CSP allows only its own style by hash', async () => {
    const { page, target } = await handoff();
    const html = await page.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(`<style>${SIGNING_IN_STYLE}</style>`);
    expect(html).toContain(`<a href="${target}">`);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(SIGNING_IN_STYLE),
    );
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      `style-src 'sha256-${hash}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('speaks Chinese when the browser does', async () => {
    const { page } = await handoff({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    const html = await page.text();
    expect(html).toContain('<html lang="zh-Hans">');
    expect(html).toContain('正在登录…');
    const en = await (await handoff({ 'accept-language': 'en-US' })).page.text();
    expect(en).toContain('signing you in…');
  });

  it('hands off in a __Host-, HttpOnly, Lax, two-minute cookie that hides the code', async () => {
    const { page, cookie } = await handoff();
    const line = setCookieLine(page, PENDING_COOKIE) ?? '';
    expect(line).toMatch(/; Max-Age=120/);
    expect(line).toMatch(/; Path=\//);
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; SameSite=Lax/);
    expect(line).not.toMatch(/Domain=/);
    // sealed: neither the code nor its base64 shows
    const value = decodeURIComponent(cookie.split('=').slice(1).join('='));
    expect(value).not.toContain('c.fictional');
    expect(value).not.toContain(btoa('"code":"c.fictional"').slice(0, 12));
    // the state cookie is already spent
    expect(setCookieLine(page, '__Host-grub_siwa')).toMatch(/Max-Age=0/);
  });

  it('errors and bad state still redirect straight away, no page, no hand-off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn();
    const forged = await postCallback({ code: 'c', state: 'other' }, start.cookie);
    expect(forged.status).toBe(303);
    expect(forged.headers.get('location')).toBe('/?signin=failed');
    expect(setCookieLine(forged, PENDING_COOKIE)).toBeUndefined();
    const noCode = await postCallback({ state: start.state }, start.cookie);
    expect(noCode.headers.get('location')).toBe('/?signin=failed');
    expect(setCookieLine(noCode, PENDING_COOKIE)).toBeUndefined();
  });
});

describe('GET /auth/finish', () => {
  it('signs in and goes back to returnTo, with the timing breakdown', async () => {
    const { target, cookie, mock } = await handoff();
    const res = await call(target, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/radar');
    expect(cookieFrom(res, '__Host-grub_session')).not.toBeNull();
    expect(setCookieLine(res, PENDING_COOKIE)).toMatch(/Max-Age=0/);
    expect(mock.calls).toHaveLength(1);
    expect(timingNames(res)).toEqual(
      expect.arrayContaining(['apple_token', 'jwks', 'id_token_verify', 'signin_db', 'total']),
    );
  });

  it('runs the token exchange and the key fetch at the same time', async () => {
    // Apple's token endpoint answers only once the keys were asked for: a
    // sequential exchange-then-keys would never get an answer (and fail)
    let keysAsked!: () => void;
    const asked = new Promise<void>((resolve) => {
      keysAsked = resolve;
    });
    let nonce = '';
    mockApple(
      apple,
      async () => {
        const timeout = new Promise<'timeout'>((r) => {
          setTimeout(() => {
            r('timeout');
          }, 2000);
        });
        if ((await Promise.race([asked, timeout])) === 'timeout')
          return Response.json({ error: 'sequential' }, { status: 400 });
        return tokenResponse(await apple.idToken({ nonce }));
      },
      () => {
        keysAsked();
        return Response.json(apple.jwks);
      },
    );
    const start = await startSignIn();
    nonce = start.nonce;
    const res = await followHandoff(
      await postCallback({ code: 'c', state: start.state }, start.cookie),
    );
    expect(res.headers.get('location')).toBe('/');
  });

  it('without the page’s `t`, it neither signs in nor spends or clears the hand-off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { target, cookie, mock } = await handoff();
    for (const path of ['/auth/finish', '/auth/finish?t=guess', `${target}x`]) {
      const res = await call(path, { cookie });
      expect(res.headers.get('location'), path).toBe('/?signin=failed');
      expect(setCookieLine(res, PENDING_COOKIE), path).toBeUndefined();
    }
    expect(mock.calls).toHaveLength(0);
    // the real page's refresh still completes it
    expect((await call(target, { cookie })).headers.get('location')).toBe('/radar');
  });

  it('refuses a missing, forged or tampered hand-off cookie', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { target, cookie, mock } = await handoff();
    const [name, value = ''] = cookie.split('=');
    const flipped = value.slice(0, -2) + (value.endsWith('A') ? 'B' : 'A') + value.slice(-1);
    for (const c of [undefined, `${name}=${btoa('{}')}.AAAA`, `${name}=${flipped}`]) {
      const res = await call(target, { cookie: c });
      expect(res.headers.get('location')).toBe('/?signin=failed');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('never runs for a prefetch or prerender (a one-time code must not be spent)', async () => {
    const { target, cookie, mock } = await handoff();
    const speculative: Record<string, string>[] = [
      { 'sec-purpose': 'prefetch' },
      { purpose: 'prefetch' },
      { 'sec-purpose': 'prefetch;prerender' },
    ];
    for (const h of speculative) {
      const res = await call(target, { cookie, headers: h });
      expect(res.status).toBe(503);
      expect(setCookieLine(res, PENDING_COOKIE)).toBeUndefined();
    }
    expect(mock.calls).toHaveLength(0);
    expect((await call(target, { cookie })).headers.get('location')).toBe('/radar');
  });

  it('still checks the nonce from the original state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = mockApple(apple, async () =>
      tokenResponse(await apple.idToken({ nonce: 'stolen' })),
    );
    const start = await startSignIn();
    const res = await followHandoff(
      await postCallback({ code: 'c', state: start.state }, start.cookie),
    );
    expect(mock.calls).toHaveLength(1);
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(cookieFrom(res, '__Host-grub_session')).toBeNull();
    expect(await countRows('users')).toBe(0);
  });
});

describe('GET /auth/callback', () => {
  it('is never Apple: a quiet redirect home, not a 404 (iOS preloads it)', async () => {
    const res = await call('/auth/callback?code=x&state=y');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
