/**
 * D1 round trips per request, read back from the Server-Timing header the
 * Worker sends in production. These are the numbers the perf PR is about:
 * every round trip to D1 is a wait we pay on each page load.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeResponseSchema } from '../../src/contracts/me';
import { resetAppleKeys } from '../auth/appleKeys';
import app from '../index';
import { createSession, SESSION_MAX_AGE_MS } from '../auth/session';
import { sha256Hex } from '../lib/crypto';
import { DAY, HOUR, iso } from '../lib/time';
import {
  call,
  cookieFrom,
  d1RoundTrips,
  fakeAppleKeys,
  followHandoff,
  mockApple,
  postCallback,
  send,
  startSignIn,
  timingNames,
  tokenResponse,
  userSession,
  writeHeaders,
} from '../test/helpers';

const apple = await fakeAppleKeys();

beforeEach(async () => {
  await resetAppleKeys(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM user_places'),
    env.DB.prepare('DELETE FROM places'),
    env.DB.prepare('DELETE FROM user_private'),
    env.DB.prepare('DELETE FROM auth_identities'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Sign in through Apple (fake), starting from `sessionCookie` if given. */
async function appleSignIn(sessionCookie?: string) {
  let nonce = '';
  mockApple(apple, async () => tokenResponse(await apple.idToken({ nonce })));
  const start = await startSignIn('/', sessionCookie);
  nonce = start.nonce;
  const handoff = await postCallback({ code: 'c', state: start.state }, start.cookie);
  const finish = await followHandoff(handoff);
  vi.restoreAllMocks();
  return { handoff, finish, cookie: cookieFrom(finish, '__Host-grub_session') ?? '' };
}

describe('D1 round trips per request', () => {
  it('sign-in: 0 on the callback, 1 on the finish (new user, returning user, replacing a session)', async () => {
    const first = await appleSignIn();
    expect(d1RoundTrips(first.handoff)).toBe(0);
    expect(d1RoundTrips(first.finish)).toBe(1);
    expect(first.finish.headers.get('location')).toBe('/');

    const again = await appleSignIn();
    expect(d1RoundTrips(again.finish)).toBe(1);

    // signing in from a browser that had a session ends that session in the same batch
    const replacing = await appleSignIn(again.cookie);
    expect(d1RoundTrips(replacing.finish)).toBe(1);
    expect((await call('/api/me', { cookie: again.cookie })).status).toBe(401);
    expect((await call('/api/me', { cookie: replacing.cookie })).status).toBe(200);
  });

  it('GET /api/me: 1 (session + profile + home + sign-up state in one batch)', async () => {
    const cookie = await userSession('u_rt', 'Rita');
    await send('PUT', '/api/me/home', cookie, { lat: 47.5, lng: -122.3 });
    const res = await call('/api/me', { cookie });
    expect(res.status).toBe(200);
    expect(d1RoundTrips(res)).toBe(1);
    // SIGNUP_OPEN=false with no pin: sign-up state comes from the data, same batch
    expect(MeResponseSchema.parse(await res.json())).toEqual({
      user: { id: 'u_rt', displayName: 'Rita', avatarEmoji: '🍜' },
      home: { lat: 47.5, lng: -122.3 },
      signupOpen: false,
    });
  });

  it('GET /api/spots: 1 (session + list in one batch)', async () => {
    const cookie = await userSession('u_rt');
    const added = await send('POST', '/api/spots', cookie, {
      name: 'Round Trip Noodles',
      kind: 'food',
      location: { lat: 47.6, lng: -122.3 },
    });
    expect(added.status).toBe(201);
    const res = await call('/api/spots', { cookie });
    expect(res.status).toBe(200);
    expect(d1RoundTrips(res)).toBe(1);
    expect((await res.json<{ name: string }[]>()).map((s) => s.name)).toEqual([
      'Round Trip Noodles',
    ]);
  });

  it('POST /auth/logout: 1 (a DELETE by the cookie hash, no lookup first)', async () => {
    const cookie = await userSession('u_rt');
    const res = await call('/auth/logout', {
      method: 'POST',
      cookie,
      headers: writeHeaders,
      body: '{}',
    });
    expect(res.status).toBe(204);
    expect(d1RoundTrips(res)).toBe(1);
    expect((await call('/api/me', { cookie })).status).toBe(401);
  });

  it('no cookie: 0', async () => {
    const res = await call('/api/spots');
    expect(res.status).toBe(401);
    expect(d1RoundTrips(res)).toBe(0);
  });

  it('a due last_seen write does not hold up the answer, and still lands', async () => {
    const { token, session } = await createSession(
      env.DB,
      await seedUser('u_seen'),
      undefined,
      Date.now() - 2 * HOUR,
    );
    const cookie = `__Host-grub_session=${token}`;
    const res = await call('/api/spots', { cookie });
    expect(res.status).toBe(200);
    expect(d1RoundTrips(res)).toBe(1); // the write runs after the response (waitUntil)
    await vi.waitFor(async () => {
      const row = await env.DB.prepare('SELECT last_seen_at FROM sessions WHERE id = ?')
        .bind(session.id)
        .first<{ last_seen_at: string }>();
      expect(Date.parse(row?.last_seen_at ?? '')).toBeGreaterThan(Date.now() - HOUR);
    });
  });
});

async function seedUser(id: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, ?, 'x', 'x')",
  )
    .bind(id, id)
    .run();
  return id;
}

describe('the reads that ride along with the session lookup', () => {
  it('give nothing for an expired session, and the cookie is cleared', async () => {
    const id = await seedUser('u_old');
    const token = 'expired-token-expired-token-expired-token-x';
    const old = Date.now() - 31 * DAY;
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(await sha256Hex(token), id, iso(old), iso(old + 30 * DAY), iso(old))
      .run();
    await env.DB.prepare(
      "INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES (?, 1, 2, 'x')",
    )
      .bind(id)
      .run();
    for (const path of ['/api/me', '/api/spots']) {
      const res = await call(path, { cookie: `__Host-grub_session=${token}` });
      expect(res.status, path).toBe(401);
      expect(await res.text()).not.toMatch(/home|lat/);
    }
  });

  it('stop at the 90-day hard limit even if expires_at says otherwise', async () => {
    const id = await seedUser('u_ancient');
    const token = 'ancient-token-ancient-token-ancient-token-x';
    const created = Date.now() - SESSION_MAX_AGE_MS - DAY;
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(await sha256Hex(token), id, iso(created), iso(Date.now() + DAY), iso(created))
      .run();
    expect((await call('/api/spots', { cookie: `__Host-grub_session=${token}` })).status).toBe(401);
  });
});

describe('Server-Timing and the structured log', () => {
  it('names the phases, and logs one record per request with no secrets in it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cookie = await userSession('u_log');
    const res = await call('/api/spots', { cookie });
    expect(timingNames(res)).toEqual(['d1_1', 'session', 'd1', 'total']);
    expect(res.headers.get('server-timing')).toMatch(
      /d1_1;dur=[\d.]+;desc="batch\[SELECT sessions; SELECT user_places\]"/,
    );
    const record = log.mock.calls
      .map((args) => args[0] as Record<string, unknown>)
      .find((r) => r.message === 'request timing' && r.path === '/api/spots');
    expect(record).toMatchObject({
      method: 'GET',
      status: 200,
      d1_round_trips: 1,
      d1_statements: 2,
      phases: { session: expect.any(Number) as unknown, d1_1: expect.any(Number) as unknown },
    });
    const token = cookie.split('=')[1] ?? '';
    expect(JSON.stringify(record)).not.toContain(token);
    expect(JSON.stringify(record)).not.toContain(await sha256Hex(token));
  });

  it('static files (the SPA) carry none of it', async () => {
    // a stand-in for the assets binding (tests may run before the SPA is built)
    const assets = { fetch: () => Promise.resolve(new Response('<!doctype html>')) };
    const res = await app.request('https://grub.test/radar', {}, { ...env, ASSETS: assets });
    expect(res.status).toBe(200);
    expect(res.headers.get('server-timing')).toBeNull();
  });
});
