import { env } from 'cloudflare:workers';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import app from '../index';
import { sha256Hex } from '../lib/crypto';
import {
  call,
  cookieFrom,
  fakeAppleKeys,
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
  const res = await postCallback(
    { code: 'c.fictional', state: start.state, ...(opts.user ? { user: opts.user } : {}) },
    start.cookie,
  );
  return { res, start, apple };
}

const countRows = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
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
    // the state cookie is single use
    expect(setCookieLine(res, '__Host-grub_siwa')).toMatch(/Max-Age=0/);

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
    const res = await postCallback({ code: 'c', state: start.state }, start.cookie);
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(cookieFrom(res, '__Host-grub_session')).toBeNull();
    expect(await countRows('users')).toBe(0);
  });

  it.each([
    [
      'no state cookie',
      (s: { cookie: string; state: string }) => ({ cookie: undefined, state: s.state }),
    ],
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
  });

  it('refuses an id_token minted for a different nonce (replayed token)', async () => {
    const mock = mockApple(apple, async () =>
      tokenResponse(await apple.idToken({ nonce: 'stolen' })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = await startSignIn();
    const res = await postCallback({ code: 'c', state: start.state }, start.cookie);
    expect(mock.calls).toHaveLength(1);
    expect(res.headers.get('location')).toBe('/?signin=failed');
    expect(await countRows('users')).toBe(0);
  });

  it('refuses an id_token for another app (wrong aud)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { res } = await signIn({ claims: { aud: 'com.example.other' } });
    expect(res.headers.get('location')).toBe('/?signin=failed');
  });

  it('a state cookie is good for one round trip: the browser drops it, a replay fails', async () => {
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
    const res = await app.request(
      'https://grub.test/auth/callback',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: start.cookie },
        body: new URLSearchParams({ code: 'c', state: start.state }).toString(),
      },
      { ...env, SIGNUP_OPEN: 'true' },
    );
    expect(mock.calls).toHaveLength(1);
    expect(res.headers.get('location')).toBe('/');
    expect(await countRows('users')).toBe(2);
  });
});
