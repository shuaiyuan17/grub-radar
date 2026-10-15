import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import app from '../index';
import { sealValue, sha256Hex } from '../lib/crypto';
import { resetAppleKeys } from '../auth/appleKeys';
import {
  call,
  cookieFrom,
  fakeAppleKeys,
  finishInit,
  followHandoff,
  handoffValue,
  mockApple,
  postCallback,
  setCookieLine,
  startSignIn,
  tokenResponse,
  writeHeaders,
} from '../test/helpers';

const apple = await fakeAppleKeys();
const SUB = '000123.fictional-sub.0456';
const FIRST_TIME_USER = JSON.stringify({
  name: { firstName: 'Tess', lastName: 'Lau' },
  email: 'tess@privaterelay.appleid.com',
});

/** Apple answers the code exchange with an id_token carrying `nonce` (and claims). */
function appleAnswers(claims: Record<string, unknown> = {}) {
  let nonce = '';
  const mock = mockApple(apple, async () =>
    tokenResponse(await apple.idToken({ nonce, ...claims })),
  );
  return {
    ...mock,
    setNonce(n: string) {
      nonce = n;
    },
  };
}

async function signIn(
  opts: { returnTo?: string; claims?: Record<string, unknown>; user?: string } = {},
) {
  const apple = appleAnswers(opts.claims);
  const start = await startSignIn(opts.returnTo);
  apple.setNonce(start.nonce);
  const handoff = await postCallback(
    { code: 'c.fictional', state: start.state, ...(opts.user ? { user: opts.user } : {}) },
    start.cookie,
  );
  const res = await followHandoff(handoff);
  return { res, handoff, start, apple };
}

const countRows = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

beforeEach(async () => {
  await resetAppleKeys(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM auth_states_used'),
    env.DB.prepare('DELETE FROM auth_identities'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /auth/apple/start', () => {
  it('redirects to Apple and sets a short-lived, cross-site-readable state cookie', async () => {
    const { res, location } = await startSignIn('/radar');
    expect(res.status).toBe(302);
    expect(location.host).toBe('appleid.apple.com');
    const line = setCookieLine(res, '__Host-grub_siwa') ?? '';
    expect(line).toMatch(/; Max-Age=600/);
    expect(line).toMatch(/; Path=\//);
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; SameSite=None/);
    expect(line).not.toMatch(/Domain=/);
  });
});

describe('POST /auth/callback', () => {
  it('first sign-in: exchanges the code, creates the user, starts a session, goes back', async () => {
    const {
      res,
      handoff,
      start,
      apple: mock,
    } = await signIn({ returnTo: '/place/lucky-thread', user: FIRST_TIME_USER });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/place/lucky-thread');

    // the session cookie: __Host-, HttpOnly, Secure, Lax, 30 days
    const line = setCookieLine(res, '__Host-grub_session') ?? '';
    expect(line).toMatch(/^__Host-grub_session=[\w-]{43};/);
    expect(line).toMatch(/; Max-Age=2592000/);
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; SameSite=Lax/);
    // the state cookie is single use: gone with the callback's answer
    expect(setCookieLine(handoff, '__Host-grub_siwa')).toMatch(/Max-Age=0/);
    // and so is the hand-off
    expect(setCookieLine(res, '__Host-grub_signin')).toMatch(/Max-Age=0/);

    // what we sent Apple
    expect(mock.calls).toHaveLength(1);
    const form = mock.calls[0]!.form;
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c.fictional',
      client_id: 'me.shuaiyuan.grub.web',
      redirect_uri: 'https://grub.test/auth/callback',
    });
    const secret = form.get('client_secret') ?? '';
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: 'BQY23WRKNY' });
    expect(decodeJwt(secret)).toMatchObject({
      iss: 'TMTJYK5V5B',
      sub: 'me.shuaiyuan.grub.web',
      aud: 'https://appleid.apple.com',
    });
    expect(start.state).not.toBe('');

    // what we stored
    const identity = await env.DB.prepare(
      'SELECT provider, provider_sub, user_id, email, email_is_relay, refresh_token FROM auth_identities',
    ).first();
    expect(identity).toMatchObject({
      provider: 'apple',
      provider_sub: SUB,
      email: 'tess@privaterelay.appleid.com',
      email_is_relay: 1,
      refresh_token: 'rt.fictional',
    });
    const user = await env.DB.prepare('SELECT id, display_name, avatar_emoji FROM users').first<
      Record<string, string>
    >();
    expect(user?.id).toMatch(/^u_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(user).toMatchObject({ display_name: 'Tess', avatar_emoji: '🍜' });
    const token = cookieFrom(res, '__Host-grub_session')!.split('=')[1]!;
    const session = await env.DB.prepare('SELECT id, user_id FROM sessions').first<
      Record<string, string>
    >();
    expect(session).toEqual({ id: await sha256Hex(token), user_id: user?.id });

    // and the cookie works
    const me = await call('/api/me', { cookie: cookieFrom(res, '__Host-grub_session')! });
    expect(me.status).toBe(200);
  });

  it('a second sign-in with the same Apple ID is the same user, and keeps the name', async () => {
    await signIn({ user: FIRST_TIME_USER });
    // Apple sends `user` only the first time
    const { res } = await signIn({ claims: { email: undefined } });
    expect(res.headers.get('location')).toBe('/');
    expect(await countRows('users')).toBe(1);
    expect(await countRows('auth_identities')).toBe(1);
    expect(await countRows('sessions')).toBe(2);
    const row = await env.DB.prepare('SELECT display_name FROM users').first<{
      display_name: string;
    }>();
    expect(row?.display_name).toBe('Tess');
    const email = await env.DB.prepare('SELECT email FROM auth_identities').first<{
      email: string;
    }>();
    expect(email?.email).toBe('tess@privaterelay.appleid.com');
  });

  it('without a name from Apple the user is "you"', async () => {
    await signIn();
    const row = await env.DB.prepare('SELECT display_name FROM users').first<{
      display_name: string;
    }>();
    expect(row?.display_name).toBe('you');
  });

  it('sign-up is closed once the first account exists (SIGNUP_OPEN=false)', async () => {
    await signIn({ user: FIRST_TIME_USER });
    const { res } = await signIn({ claims: { sub: '000999.someone-else.0001' } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/?signin=closed');
    expect(cookieFrom(res, '__Host-grub_session')).toBeNull();
    expect(await countRows('users')).toBe(1);
    // the owner can still come back
    const again = await signIn();
    expect(again.res.headers.get('location')).toBe('/');
  });

  it('Cancel on Apple’s page comes back as ?signin=cancelled without calling Apple', async () => {
    const mock = appleAnswers();
    const start = await startSignIn();
    const res = await postCallback(
      { error: 'user_cancelled_authorize', state: start.state },
      start.cookie,
    );
    expect(res.headers.get('location')).toBe('/?signin=cancelled');
    expect(mock.calls).toHaveLength(0);
    expect(await countRows('users')).toBe(0);
  });

  it('an Apple error at the token endpoint is ?signin=failed, no account, no session', async () => {
    mockApple(apple, () => Response.json({ error: 'invalid_client' }, { status: 400 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn();
    const res = await followHandoff(
      await postCallback({ code: 'c', state: start.state }, start.cookie),
    );
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(cookieFrom(res, '__Host-grub_session')).toBeNull();
    expect(await countRows('users')).toBe(0);
  });

  it.each([
    [
      'a forged state cookie',
      (s: { cookie: string; state: string }) => ({
        cookie: `__Host-grub_siwa=${btoa('{}')}.AAAA`,
        state: s.state,
      }),
    ],
    [
      'a state that does not match the cookie',
      (s: { cookie: string; state: string }) => ({ cookie: s.cookie, state: 'other' }),
    ],
  ])('refuses %s, before talking to Apple', async (_label, tamper) => {
    const mock = appleAnswers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn();
    mock.setNonce(start.nonce);
    const t = tamper(start);
    const res = await postCallback({ code: 'c', state: t.state }, t.cookie);
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(mock.calls).toHaveLength(0);
    // and the pending sign-in's cookie is left alone
    expect(setCookieLine(res, '__Host-grub_siwa')).toBeUndefined();
  });

  it.each([
    ['a wrong state', 'forged'],
    ['no state', undefined],
  ])(
    'a cross-site "cancel" with %s neither cancels nor clears a pending sign-in',
    async (_label, forgedState) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const mock = appleAnswers();
      const start = await startSignIn();
      mock.setNonce(start.nonce);
      // the attacker's page auto-posts to our callback; the browser attaches the
      // SameSite=None state cookie
      const forged = await postCallback(
        { error: 'user_cancelled_authorize', ...(forgedState ? { state: forgedState } : {}) },
        start.cookie,
      );
      expect(forged.headers.get('location')).toBe('/?signin=failed');
      expect(setCookieLine(forged, '__Host-grub_siwa')).toBeUndefined();
      // Apple's real answer still completes the sign-in
      const real = await followHandoff(
        await postCallback({ code: 'c.fictional', state: start.state }, start.cookie),
      );
      expect(real.headers.get('location')).toBe('/');
      expect(cookieFrom(real, '__Host-grub_session')).not.toBeNull();
    },
  );

  it('signing in again ends the session this browser already had', async () => {
    const first = cookieFrom((await signIn()).res, '__Host-grub_session')!;
    const mock = appleAnswers();
    // the browser sends its session cookie on the same-site GET to /auth/apple/start...
    const start = await startSignIn('/', first);
    mock.setNonce(start.nonce);
    // ...but not on Apple's cross-site form_post (SameSite=Lax): only the state cookie
    const again = await followHandoff(
      await postCallback({ code: 'c', state: start.state }, start.cookie),
    );
    expect(cookieFrom(again, '__Host-grub_session')).not.toBe(first);
    expect(await countRows('sessions')).toBe(1);
    expect((await call('/api/me', { cookie: first })).status).toBe(401);
  });

  it('a sign-in started without a session revokes nothing', async () => {
    await signIn();
    await signIn();
    expect(await countRows('sessions')).toBe(2);
  });

  it('refuses an id_token minted for a different nonce (replayed token)', async () => {
    const mock = mockApple(apple, async () =>
      tokenResponse(await apple.idToken({ nonce: 'stolen' })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn();
    const res = await followHandoff(
      await postCallback({ code: 'c', state: start.state }, start.cookie),
    );
    expect(mock.calls).toHaveLength(1);
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(await countRows('users')).toBe(0);
  });

  it('refuses an id_token for another app (wrong aud)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { res } = await signIn({ claims: { aud: 'com.example.other' } });
    expect(res.headers.get('location')).toBe('/?signin=failed');
  });

  it('a state is good for one round trip: the browser drops the cookie, a replay fails', async () => {
    const { res, start } = await signIn();
    expect(res.headers.get('location')).toBe('/');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // the browser no longer has the cookie after the 303 (Max-Age=0)
    const replay = await postCallback({ code: 'c.fictional', state: start.state });
    expect(replay.headers.get('location')).toBe('/?signin=failed');
  });

  it('never sends people off-site after sign-in', async () => {
    const { res } = await signIn({ returnTo: '//evil.example/' });
    expect(res.headers.get('location')).toBe('/');
  });
});

/**
 * Browsers that don't send the SameSite=None state cookie back on Apple's
 * cross-site form_post (seen in production from an iPhone, 10/15): the sealed
 * `state` alone signs in, still single use, still nonce-checked. The cookie,
 * when it does come back, must still match.
 */
describe('POST /auth/callback without the state cookie (signed-state-only)', () => {
  /** The structured `request timing` records the Worker logged. */
  const timingLogs = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls
      .map((args) => args[0])
      .filter(
        (r): r is Record<string, unknown> =>
          typeof r === 'object' && r !== null && 'message' in r && r.message === 'request timing',
      );

  it('signs in with a valid sealed state and no cookie, and logs the path, not the state', async () => {
    const log = vi.spyOn(console, 'log');
    const mock = appleAnswers();
    const start = await startSignIn('/radar');
    mock.setNonce(start.nonce);
    const handoff = await postCallback({ code: 'c.fictional', state: start.state });
    expect(handoff.status).toBe(200);
    // no cookie came, so none is cleared (it may belong to another sign-in)
    expect(setCookieLine(handoff, '__Host-grub_siwa')).toBeUndefined();
    const res = await followHandoff(handoff);
    expect(res.headers.get('location')).toBe('/radar');
    expect(cookieFrom(res, '__Host-grub_session')).not.toBeNull();
    expect(mock.calls).toHaveLength(1);
    const callback = timingLogs(log).find((r) => r.path === '/auth/callback');
    expect(callback?.siwa_state).toBe('signed-state-only');
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(start.state);
    expect(logged).not.toContain(start.state.split('.')[1]);
  });

  it('the happy path with the cookie still works, and logs "cookie"', async () => {
    const log = vi.spyOn(console, 'log');
    const { res, handoff } = await signIn({ returnTo: '/radar' });
    expect(res.headers.get('location')).toBe('/radar');
    expect(cookieFrom(res, '__Host-grub_session')).not.toBeNull();
    expect(setCookieLine(handoff, '__Host-grub_siwa')).toMatch(/Max-Age=0/);
    const callback = timingLogs(log).find((r) => r.path === '/auth/callback');
    expect(callback?.siwa_state).toBe('cookie');
  });

  it('login CSRF is narrowed: an attacker-minted state cannot replace a victim’s live session', async () => {
    // the victim is signed in
    const victim = cookieFrom(
      (await signIn({ user: FIRST_TIME_USER })).res,
      '__Host-grub_session',
    )!;
    expect(await countRows('sessions')).toBe(1);
    // the attacker starts a sign-in in their own browser and gets Apple's code for their own
    // Apple ID, then has the victim's browser POST it (no state cookie there: never started)
    const mock = mockApple(apple, async () =>
      tokenResponse(await apple.idToken({ nonce: attacker.nonce, sub: '000666.attacker.0001' })),
    );
    const attacker = await startSignIn();
    const page = await postCallback({ code: 'c.attacker', state: attacker.state });
    expect(page.status).toBe(200);
    // the victim's browser runs the page: a same-origin POST, so its Lax session cookie goes too
    const t = (await handoffValue(page)) ?? '';
    const pending = cookieFrom(page, '__Host-grub_signin') ?? '';
    const res = await call('/auth/finish', finishInit(t, `${pending}; ${victim}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/?signin=already');
    // the victim's session is untouched, no new one, no account for the attacker, no exchange
    expect(cookieFrom(res, '__Host-grub_session')).toBeNull();
    expect(setCookieLine(res, '__Host-grub_session')).toBeUndefined();
    expect(await countRows('sessions')).toBe(1);
    expect(await countRows('users')).toBe(1);
    expect(mock.calls).toHaveLength(0);
    expect((await call('/api/me', { cookie: victim })).status).toBe(200);
    // and the hand-off is spent
    expect(setCookieLine(res, '__Host-grub_signin')).toMatch(/Max-Age=0/);
  });

  it('without the cookie, a browser that is already signed in stays as it is', async () => {
    const mine = cookieFrom((await signIn()).res, '__Host-grub_session')!;
    const mock = appleAnswers();
    const start = await startSignIn('/radar', mine);
    mock.setNonce(start.nonce);
    const page = await postCallback({ code: 'c', state: start.state });
    const t = (await handoffValue(page)) ?? '';
    const pending = cookieFrom(page, '__Host-grub_signin') ?? '';
    const res = await call('/auth/finish', finishInit(t, `${pending}; ${mine}`));
    expect(res.headers.get('location')).toBe('/?signin=already');
    expect(mock.calls).toHaveLength(0);
    expect((await call('/api/me', { cookie: mine })).status).toBe(200);
  });

  it('without the cookie, a dead session cookie does not block signing in', async () => {
    const mock = appleAnswers();
    const start = await startSignIn();
    mock.setNonce(start.nonce);
    const page = await postCallback({ code: 'c', state: start.state });
    const t = (await handoffValue(page)) ?? '';
    const pending = cookieFrom(page, '__Host-grub_signin') ?? '';
    const stale = `__Host-grub_session=${'x'.repeat(43)}`;
    const res = await call('/auth/finish', finishInit(t, `${pending}; ${stale}`));
    expect(res.headers.get('location')).toBe('/');
    expect(cookieFrom(res, '__Host-grub_session')).not.toBeNull();
  });

  it('with the cookie, signing in again still replaces this browser’s session (unchanged)', async () => {
    const first = cookieFrom((await signIn()).res, '__Host-grub_session')!;
    const mock = appleAnswers();
    const start = await startSignIn('/', first);
    mock.setNonce(start.nonce);
    const page = await postCallback({ code: 'c', state: start.state }, start.cookie);
    const t = (await handoffValue(page)) ?? '';
    const pending = cookieFrom(page, '__Host-grub_signin') ?? '';
    const res = await call('/auth/finish', finishInit(t, `${pending}; ${first}`));
    expect(res.headers.get('location')).toBe('/');
    expect(cookieFrom(res, '__Host-grub_session')).not.toBe(first);
    expect(await countRows('sessions')).toBe(1);
  });

  it('refuses a tampered state, before talking to Apple', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = appleAnswers();
    const start = await startSignIn();
    mock.setNonce(start.nonce);
    const s = start.state;
    const i = s.length - 5;
    const flipped = s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    for (const state of [flipped, `${s}A`, s.slice(0, -1), s.split('.')[1] ?? '', 'forged']) {
      const res = await postCallback({ code: 'c', state });
      expect(res.headers.get('location'), state).toBe('/?signin=failed');
      expect(setCookieLine(res, '__Host-grub_signin')).toBeUndefined();
    }
    expect(mock.calls).toHaveLength(0);
    // the real state is untouched by those attempts
    const real = await followHandoff(await postCallback({ code: 'c', state: s }));
    expect(real.headers.get('location')).toBe('/');
  });

  it('refuses an expired state (sealed by us, issued 11 minutes ago)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = appleAnswers();
    const nonce = 'an-old-nonce';
    mock.setNonce(nonce);
    const old = await sealValue(
      JSON.stringify({
        j: 'jti-old-0123456789ab',
        n: await sha256Hex(nonce),
        r: '/',
        t: Date.now() - 11 * 60_000,
      }),
      env.SESSION_HMAC_KEY,
      'grub-radar siwa state v1',
    );
    for (const cookie of [undefined, `__Host-grub_siwa=${old}`]) {
      const res = await postCallback({ code: 'c', state: old }, cookie);
      expect(res.headers.get('location')).toBe('/?signin=failed');
    }
    expect(mock.calls).toHaveLength(0);
    expect(
      await env.DB.prepare('SELECT * FROM auth_states_used WHERE jti = ?')
        .bind('jti-old-0123456789ab')
        .first(),
    ).toBeNull();
  });

  it.each([
    ['without the cookie, twice', () => undefined, () => undefined],
    ['with the cookie, then without', (s: string) => `__Host-grub_siwa=${s}`, () => undefined],
    // a browser that kept the cookie (or an attacker holding both)
    [
      'with the cookie, twice',
      (s: string) => `__Host-grub_siwa=${s}`,
      (s: string) => `__Host-grub_siwa=${s}`,
    ],
  ])('refuses a replay of the same state: %s', async (_label, firstCookie, secondCookie) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = appleAnswers();
    const start = await startSignIn();
    mock.setNonce(start.nonce);
    const first = await followHandoff(
      await postCallback({ code: 'c', state: start.state }, firstCookie(start.state)),
    );
    expect(first.headers.get('location')).toBe('/');
    const replay = await postCallback(
      { code: 'c.other', state: start.state },
      secondCookie(start.state),
    );
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('/?signin=failed');
    expect(setCookieLine(replay, '__Host-grub_signin')).toBeUndefined();
    expect(mock.calls).toHaveLength(1);
  });

  it('Apple’s `error` path checks the state but writes no row; a burst of them grows nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn();
    const cancel = { error: 'user_cancelled_authorize', state: start.state };
    const first = await postCallback(cancel);
    expect(first.headers.get('location')).toBe('/?signin=cancelled');
    expect(first.headers.get('server-timing')).toContain('d1;desc="0 round trips"');
    expect(await countRows('auth_states_used')).toBe(0);
    // a burst: valid state, forged state, other errors; none of them writes
    for (let i = 0; i < 20; i++) {
      await postCallback({
        ...cancel,
        error: i % 2 ? 'user_cancelled_authorize' : 'invalid_request',
      });
      await postCallback({ error: 'user_cancelled_authorize', state: `forged-${String(i)}` });
    }
    expect(await countRows('auth_states_used')).toBe(0);
    // and a fake `error` can't burn a leaked state: Apple's real answer still signs in
    const mock = appleAnswers();
    mock.setNonce(start.nonce);
    const real = await followHandoff(await postCallback({ code: 'c', state: start.state }));
    expect(real.headers.get('location')).toBe('/');
    expect(await countRows('auth_states_used')).toBe(1);
  });

  it('a state without a code or error is refused and writes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn();
    const res = await postCallback({ state: start.state });
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(await countRows('auth_states_used')).toBe(0);
  });

  it('the code path still spends the state once (single use)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = appleAnswers();
    const start = await startSignIn();
    mock.setNonce(start.nonce);
    expect((await postCallback({ code: 'c', state: start.state })).status).toBe(200);
    expect(await countRows('auth_states_used')).toBe(1);
    const again = await postCallback({ code: 'c2', state: start.state });
    expect(again.headers.get('location')).toBe('/?signin=failed');
    expect(await countRows('auth_states_used')).toBe(1);
  });

  it('is braked per client IP (CALLBACK_LIMITER), before the body is read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const limit = vi.spyOn(env.CALLBACK_LIMITER, 'limit').mockResolvedValue({ success: false });
    const start = await startSignIn();
    const res = await call('/auth/callback', {
      method: 'POST',
      cookie: start.cookie,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': '203.0.113.7',
      },
      body: new URLSearchParams({ code: 'c', state: start.state }).toString(),
    });
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(limit).toHaveBeenCalledWith({ key: 'callback:203.0.113.7' });
    expect(await countRows('auth_states_used')).toBe(0);
    // the state wasn't touched: once the brake lifts, it still works
    limit.mockResolvedValue({ success: true });
    const mock = appleAnswers();
    mock.setNonce(start.nonce);
    const ok = await followHandoff(
      await postCallback({ code: 'c', state: start.state }, start.cookie),
    );
    expect(ok.headers.get('location')).toBe('/');
  });

  it('in production every callback is braked, even without CF-Connecting-IP', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const limit = vi.spyOn(env.CALLBACK_LIMITER, 'limit').mockResolvedValue({ success: false });
    const res = await app.request(
      'https://grub.test/auth/callback',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'state=x',
      },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(limit).toHaveBeenCalledWith({ key: 'callback:unknown' });
  });

  it('the hourly cron sweeps spent states that can no longer be valid', async () => {
    const old = Date.now() - 12 * 60_000;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO auth_states_used VALUES (?, ?)').bind(
        'jti-expired-000000000',
        new Date(old).toISOString(),
      ),
      env.DB.prepare('INSERT INTO auth_states_used VALUES (?, ?)').bind(
        'jti-live-000000000000',
        new Date(Date.now() + 5 * 60_000).toISOString(),
      ),
    ]);
    const ctx = createExecutionContext();
    await app.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    const left = await env.DB.prepare('SELECT jti FROM auth_states_used').all();
    expect(left.results).toEqual([{ jti: 'jti-live-000000000000' }]);
  });

  it('refuses a cookie that is present but does not match, even when both are valid states', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = appleAnswers();
    // this browser started sign-in (its cookie); the POST carries someone else's valid state
    const mine = await startSignIn();
    const theirs = await startSignIn();
    mock.setNonce(theirs.nonce);
    const res = await postCallback({ code: 'c', state: theirs.state }, mine.cookie);
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(setCookieLine(res, '__Host-grub_siwa')).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
    // and the mismatch spent neither state
    mock.setNonce(mine.nonce);
    const ok = await followHandoff(
      await postCallback({ code: 'c', state: mine.state }, mine.cookie),
    );
    expect(ok.headers.get('location')).toBe('/');
  });

  it('still checks the id_token nonce against the one sealed in the state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mock = mockApple(apple, async () =>
      tokenResponse(await apple.idToken({ nonce: 'stolen' })),
    );
    const start = await startSignIn();
    const res = await followHandoff(await postCallback({ code: 'c', state: start.state }));
    expect(mock.calls).toHaveLength(1);
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(cookieFrom(res, '__Host-grub_session')).toBeNull();
    expect(await countRows('users')).toBe(0);
  });

  it('checks the state before Apple’s `error`: a forged cancel without a cookie does nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await postCallback({ error: 'user_cancelled_authorize', state: 'forged' });
    expect(res.headers.get('location')).toBe('/?signin=failed');
  });
});

describe('POST /auth/logout', () => {
  it('ends the session server-side and clears the cookie', async () => {
    const { res } = await signIn();
    const cookie = cookieFrom(res, '__Host-grub_session')!;
    const out = await call('/auth/logout', {
      method: 'POST',
      cookie,
      headers: writeHeaders,
      body: '{}',
    });
    expect(out.status).toBe(204);
    expect(setCookieLine(out, '__Host-grub_session')).toMatch(/Max-Age=0/);
    expect(await countRows('sessions')).toBe(0);
    expect((await call('/api/me', { cookie })).status).toBe(401);
  });

  it('refuses a cross-site logout (CSRF)', async () => {
    const { res } = await signIn();
    const cookie = cookieFrom(res, '__Host-grub_session')!;
    const out = await call('/auth/logout', {
      method: 'POST',
      cookie,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
      body: '',
    });
    expect(out.status).toBe(403);
    expect(await countRows('sessions')).toBe(1);
  });
});

describe('POST /auth/dev-login', () => {
  const devLogin = (url: string, secret: string | undefined, envOverride: Partial<Env> = {}) =>
    app.request(
      url,
      {
        method: 'POST',
        headers: {
          ...writeHeaders,
          ...(secret !== undefined ? { 'x-dev-login-secret': secret } : {}),
        },
        body: '{}',
      },
      { ...env, ...envOverride },
    );

  it('works on localhost with the secret', async () => {
    const res = await devLogin('http://localhost:5173/auth/dev-login', env.DEV_LOGIN_SECRET);
    expect(res.status).toBe(204);
    expect(cookieFrom(res, '__Host-grub_session')).not.toBeNull();
  });

  it('`as` gives a separate dev user per label; junk labels are refused', async () => {
    const as = (body: string) =>
      app.request(
        'http://localhost/auth/dev-login',
        {
          method: 'POST',
          headers: { ...writeHeaders, 'x-dev-login-secret': env.DEV_LOGIN_SECRET ?? '' },
          body,
        },
        env,
      );
    const res = await as('{"as":"e2e-add"}');
    expect(res.status).toBe(204);
    const me = await app.request(
      'http://localhost/api/me',
      { headers: { cookie: cookieFrom(res, '__Host-grub_session')! } },
      env,
    );
    expect((await me.json<{ user: { id: string } }>()).user.id).toBe('u_dev-e2e-add');
    expect((await as('{"as":"Not OK!"}')).status).toBe(400);
    expect((await as('{"as":""}')).status).toBe(400);
  });

  it('is refused with a wrong or missing secret', async () => {
    expect((await devLogin('http://localhost/auth/dev-login', 'nope')).status).toBe(403);
    expect((await devLogin('http://localhost/auth/dev-login', undefined)).status).toBe(403);
  });

  it('does not exist on a real hostname, in production, or without DEV_LOGIN_SECRET', async () => {
    const secret = env.DEV_LOGIN_SECRET;
    expect((await devLogin('https://grub.shuaiyuan.me/auth/dev-login', secret)).status).toBe(404);
    expect(
      (await devLogin('http://localhost/auth/dev-login', secret, { ENVIRONMENT: 'production' }))
        .status,
    ).toBe(404);
    expect(
      (await devLogin('http://localhost/auth/dev-login', secret, { DEV_LOGIN_SECRET: undefined }))
        .status,
    ).toBe(404);
  });

  it.each(['test', 'staging', 'Development', ''])(
    'fails closed: ENVIRONMENT=%j is not development',
    async (environment) => {
      const res = await devLogin('http://localhost/auth/dev-login', env.DEV_LOGIN_SECRET, {
        ENVIRONMENT: environment,
      });
      expect(res.status).toBe(404);
    },
  );

  it('replaces the session this browser already had', async () => {
    const first = cookieFrom(
      await devLogin('http://localhost/auth/dev-login', env.DEV_LOGIN_SECRET),
      '__Host-grub_session',
    )!;
    const res = await app.request(
      'http://localhost/auth/dev-login',
      {
        method: 'POST',
        headers: {
          ...writeHeaders,
          'x-dev-login-secret': env.DEV_LOGIN_SECRET ?? '',
          cookie: first,
        },
        body: '{}',
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(await countRows('sessions')).toBe(1);
  });
});

/**
 * Apple's form_post with env overrides (sign-up settings). The fake code
 * carries the sub and nonce, so several of these can run at once against one
 * Apple mock.
 */
function appleBySub() {
  return mockApple(apple, async ({ form }) => {
    const [sub = '', nonce = ''] = (form.get('code') ?? '').split('|');
    return tokenResponse(await apple.idToken({ nonce, sub }));
  });
}

/** POST /auth/callback and the hand-off after it, both with `envOverride`. */
async function callbackVia(envOverride: Partial<Env>, start: { cookie: string }, body: string) {
  const config = { ...env, ...envOverride };
  const handoff = await app.request(
    'https://grub.test/auth/callback',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: start.cookie },
      body,
    },
    config,
  );
  return followHandoff(handoff, (init) =>
    app.request('https://grub.test/auth/finish', init, config),
  );
}

async function callbackWith(envOverride: Partial<Env>, sub: string) {
  const start = await startSignIn();
  return callbackVia(
    envOverride,
    start,
    new URLSearchParams({ code: `${sub}|${start.nonce}`, state: start.state }).toString(),
  );
}

describe('OWNER_APPLE_SUB (sign-up closed, owner pinned)', () => {
  beforeEach(() => {
    appleBySub();
  });
  const OWNER = '000777.the-owner.0001';
  const pinned = { SIGNUP_OPEN: 'false', OWNER_APPLE_SUB: OWNER };

  it('only the owner can create an account, even into an empty database', async () => {
    const stranger = await callbackWith(pinned, '000999.stranger.0001');
    expect(stranger.headers.get('location')).toBe('/?signin=closed');
    expect(await countRows('users')).toBe(0);
    const owner = await callbackWith(pinned, OWNER);
    expect(owner.headers.get('location')).toBe('/');
    expect(await countRows('users')).toBe(1);
    // and comes back as the same user
    await callbackWith(pinned, OWNER);
    expect(await countRows('users')).toBe(1);
  });

  it('existing accounts keep working when the pin is added later', async () => {
    await callbackWith({ SIGNUP_OPEN: 'false' }, '000111.early-user.0001');
    const res = await callbackWith(pinned, '000111.early-user.0001');
    expect(res.headers.get('location')).toBe('/');
  });
});

describe('concurrent first sign-ins (SIGNUP_OPEN=false, no pin)', () => {
  beforeEach(() => {
    appleBySub();
  });
  it('two different Apple IDs at once: exactly one account', async () => {
    const results = await Promise.all([
      callbackWith({ SIGNUP_OPEN: 'false' }, '000001.racer-a.0001'),
      callbackWith({ SIGNUP_OPEN: 'false' }, '000002.racer-b.0001'),
    ]);
    const locations = results.map((r) => r.headers.get('location')).sort();
    expect(locations).toEqual(['/', '/?signin=closed']);
    expect(await countRows('users')).toBe(1);
    expect(await countRows('auth_identities')).toBe(1);
  });
});

describe('SIGNUP_OPEN=true', () => {
  it('lets a second Apple ID create an account', async () => {
    await signIn();
    let nonce = '';
    const mock = mockApple(apple, async () =>
      tokenResponse(await apple.idToken({ nonce, sub: '000999.someone-else.0001' })),
    );
    const start = await startSignIn();
    nonce = start.nonce;
    const res = await callbackVia(
      { SIGNUP_OPEN: 'true' },
      start,
      new URLSearchParams({ code: 'c', state: start.state }).toString(),
    );
    expect(mock.calls).toHaveLength(1);
    expect(res.headers.get('location')).toBe('/');
    expect(await countRows('users')).toBe(2);
  });
});
