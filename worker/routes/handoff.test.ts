/**
 * POST /auth/callback answers with the "signing you in…" page; its form
 * POSTs to /auth/finish, which does the slow part. These pin down that splitting it kept
 * every guarantee: state checked before anything, single use, the nonce,
 * nothing usable without the page's `t`, strict CSP, no script.
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppleKeys } from '../auth/appleKeys';
import app from '../index';
import { PENDING_COOKIE } from '../auth/pending';
import { SIGNING_IN_SCRIPT, SIGNING_IN_STYLE } from '../auth/signingInPage';
import {
  call,
  cookieFrom,
  fakeAppleKeys,
  followHandoff,
  finishInit,
  handoffValue,
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
  const t = (await handoffValue(page)) ?? '';
  const cookie = cookieFrom(page, PENDING_COOKIE) ?? '';
  return { mock, start, page, t, cookie };
}

/** The page's form submit (or a forgery of it). */
function finish(
  t: string | undefined,
  cookie: string | undefined,
  headers?: Record<string, string>,
) {
  return exports.default.fetch(
    new Request('https://grub.test/auth/finish', finishInit(t, cookie, headers)),
  );
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
  it('answers at once, before any Apple work and with one D1 round trip, with no session yet', async () => {
    const { page, mock, t } = await handoff();
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(mock.calls).toHaveLength(0);
    expect(mock.keyFetches).toHaveLength(0);
    expect(cookieFrom(page, '__Host-grub_session')).toBeNull();
    expect(await countRows('users')).toBe(0);
    expect(t).toMatch(/^[\w-]{32}$/);
    // `t` is in the form body only: no URL anywhere on the page carries it
    const html = await page.clone().text();
    expect(html).toContain('<form id="go" method="POST" action="/auth/finish">');
    expect(html).not.toMatch(/finish\?/);
    expect(html).not.toMatch(/http-equiv="refresh"/);
    // one D1 round trip on this request: spending the state (single use), nothing else
    expect(timingNames(page)).not.toContain('d1_2');
    expect(page.headers.get('server-timing')).toContain('d1;desc="1 round trips"');
  });

  it('runs only its own one-line script and style, both allowed by hash', async () => {
    const { page, t } = await handoff();
    const html = await page.text();
    expect(html.match(/<script/gi)).toHaveLength(1);
    expect(html).toContain(`<script>${SIGNING_IN_SCRIPT}</script>`);
    expect(html).toContain(`<style>${SIGNING_IN_STYLE}</style>`);
    expect(html).toContain(`<input type="hidden" name="t" value="${t}">`);
    // the no-JS fallback: a real submit button in the same form
    expect(html).toMatch(/<button id="more" type="submit">[^<]+<\/button>\s*<\/form>/);
    // the script drops that button for good before it submits
    expect(SIGNING_IN_SCRIPT).toMatch(/getElementById\('more'\)\.remove\(\);.*\.submit\(\);$/);
    const hash = async (text: string) =>
      btoa(
        String.fromCharCode(
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
        ),
      );
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      `style-src 'sha256-${await hash(SIGNING_IN_STYLE)}'`,
      `script-src 'sha256-${await hash(SIGNING_IN_SCRIPT)}'`,
      "base-uri 'none'",
      "form-action 'self'",
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

describe('the hand-off when the state cookie did not come back', () => {
  // The pending cookie is set on OUR response to Apple's POST (a top-level
  // navigation: first-party, unlike the state cookie riding on the cross-site
  // request) and read on a same-origin POST from our own page, so a browser that
  // drops the state cookie still keeps this one. e2e/auth.spec.ts checks that in
  // a real browser whose cookie jar never saw /auth/apple/start.
  it('sets the same __Host-, Lax, two-minute pending cookie, and /auth/finish completes', async () => {
    const mock = appleAnswers();
    const start = await startSignIn('/radar');
    mock.setNonce(start.nonce);
    const page = await postCallback({ code: 'c.fictional', state: start.state });
    expect(page.status).toBe(200);
    const line = setCookieLine(page, PENDING_COOKIE) ?? '';
    expect(line).toMatch(/^__Host-grub_signin=/);
    expect(line).toMatch(/; SameSite=Lax/);
    expect(line).toMatch(/; Max-Age=120/);
    const t = (await handoffValue(page)) ?? '';
    const cookie = cookieFrom(page, PENDING_COOKIE) ?? '';
    // the hand-off is exactly as strict: no `t`, no cookie, or cross-site is refused
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await finish(undefined, cookie)).headers.get('location')).toBe('/?signin=failed');
    expect((await finish(t, undefined)).headers.get('location')).toBe('/?signin=failed');
    expect(
      (await finish(t, cookie, { 'sec-fetch-site': 'cross-site' })).headers.get('location'),
    ).toBe('/?signin=failed');
    const res = await finish(t, cookie);
    expect(res.headers.get('location')).toBe('/radar');
    expect(cookieFrom(res, '__Host-grub_session')).not.toBeNull();
  });
});

describe('POST /auth/finish', () => {
  it('signs in and goes back to returnTo, with the timing breakdown, and never logs `t`', async () => {
    const log = vi.spyOn(console, 'log');
    const { t, cookie, mock } = await handoff();
    const res = await finish(t, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/radar');
    expect(cookieFrom(res, '__Host-grub_session')).not.toBeNull();
    expect(setCookieLine(res, PENDING_COOKIE)).toMatch(/Max-Age=0/);
    expect(mock.calls).toHaveLength(1);
    expect(timingNames(res)).toEqual(
      expect.arrayContaining(['apple_token', 'jwks', 'id_token_verify', 'signin_db', 'total']),
    );
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('/auth/finish');
    expect(logged).not.toContain(t);
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

  it('without the matching `t` in the body, it neither signs in nor spends or clears the hand-off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { t, cookie, mock } = await handoff();
    for (const sent of [undefined, '', 'guess', `${t}x`]) {
      const res = await finish(sent, cookie);
      expect(res.headers.get('location'), String(sent)).toBe('/?signin=failed');
      expect(setCookieLine(res, PENDING_COOKIE), String(sent)).toBeUndefined();
    }
    // `t` in the query string is not `t` in the body
    const inUrl = await exports.default.fetch(
      new Request(`https://grub.test/auth/finish?t=${t}`, finishInit(undefined, cookie)),
    );
    expect(inUrl.headers.get('location')).toBe('/?signin=failed');
    expect(mock.calls).toHaveLength(0);
    // the real page's submit still completes it
    expect((await finish(t, cookie)).headers.get('location')).toBe('/radar');
  });

  it('refuses a cross-site (or same-site) submit even with the right cookie and `t`', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { t, cookie, mock } = await handoff();
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await finish(t, cookie, { 'sec-fetch-site': site });
      expect(res.headers.get('location'), site).toBe('/?signin=failed');
      expect(setCookieLine(res, PENDING_COOKIE), site).toBeUndefined();
    }
    expect(mock.calls).toHaveLength(0);
    expect((await finish(t, cookie)).headers.get('location')).toBe('/radar');
  });

  it('without Sec-Fetch-Site, needs an Origin that is ours (and refuses neither)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { t, cookie, mock } = await handoff();
    const bare = (origin?: string) =>
      exports.default.fetch(
        new Request('https://grub.test/auth/finish', {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie,
            ...(origin ? { origin } : {}),
          },
          body: new URLSearchParams({ t }).toString(),
        }),
      );
    for (const origin of [undefined, 'https://evil.example', 'null']) {
      const res = await bare(origin);
      expect(res.headers.get('location'), String(origin)).toBe('/?signin=failed');
      expect(setCookieLine(res, PENDING_COOKIE), String(origin)).toBeUndefined();
    }
    expect(mock.calls).toHaveLength(0);
    expect((await bare('https://grub.test')).headers.get('location')).toBe('/radar');
  });

  it('in production that Origin is PUBLIC_ORIGIN, not whatever host the request came in on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { t, cookie } = await handoff();
    const prod = { ...env, ENVIRONMENT: 'production' };
    const post = (origin: string) =>
      app.request(
        'https://grub.test/auth/finish',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin },
          body: new URLSearchParams({ t }).toString(),
        },
        prod,
      );
    expect((await post('https://grub.test')).headers.get('location')).toBe('/?signin=failed');
    expect((await post(env.PUBLIC_ORIGIN)).headers.get('location')).toBe('/radar');
  });

  it('Apple says invalid_grant (the code was already spent): go to returnTo, not the error page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn('/radar');
    mockApple(apple, () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const page = await postCallback({ code: 'c', state: start.state }, start.cookie);
    const res = await followHandoff(page);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/radar');
    expect(cookieFrom(res, '__Host-grub_session')).toBeNull();
    expect(await countRows('sessions')).toBe(0);
    // any other Apple error is still a plain failure
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const again = await startSignIn('/radar');
    mockApple(apple, () => Response.json({ error: 'invalid_client' }, { status: 400 }));
    const failed = await followHandoff(
      await postCallback({ code: 'c', state: again.state }, again.cookie),
    );
    expect(failed.headers.get('location')).toBe('/?signin=failed');
  });

  it('a double submit: one signs in, the loser lands on returnTo too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn('/radar');
    let spent = false;
    mockApple(apple, async () => {
      if (spent) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      spent = true;
      return tokenResponse(await apple.idToken({ nonce: start.nonce }));
    });
    const page = await postCallback({ code: 'c', state: start.state }, start.cookie);
    const t = (await handoffValue(page)) ?? '';
    const cookie = cookieFrom(page, PENDING_COOKIE) ?? '';
    const [a, b] = await Promise.all([finish(t, cookie), finish(t, cookie)]);
    expect([a.headers.get('location'), b.headers.get('location')]).toEqual(['/radar', '/radar']);
    expect([a, b].filter((r) => cookieFrom(r, '__Host-grub_session'))).toHaveLength(1);
    expect(await countRows('sessions')).toBe(1);
  });

  it('refuses a missing, forged or tampered hand-off cookie', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { t, cookie, mock } = await handoff();
    const [name, value = ''] = cookie.split('=');
    // change one ciphertext character, always to a different one
    const i = value.length - 10;
    const flipped = value.slice(0, i) + (value[i] === 'A' ? 'B' : 'A') + value.slice(i + 1);
    expect(flipped).not.toBe(value);
    for (const c of [undefined, `${name}=${btoa('{}')}.AAAA`, `${name}=${flipped}`]) {
      const res = await finish(t, c);
      expect(res.headers.get('location')).toBe('/?signin=failed');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('a GET (preload, stale history entry) does nothing and goes home', async () => {
    const { t, cookie, mock } = await handoff();
    const res = await call(`/auth/finish?t=${t}`, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(setCookieLine(res, PENDING_COOKIE)).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
    expect((await finish(t, cookie)).headers.get('location')).toBe('/radar');
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
