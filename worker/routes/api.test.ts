import { env } from 'cloudflare:workers';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { MeResponseSchema } from '../../src/contracts/me';
import { SEED_SPOTS } from '../../src/data/seed';
import { parseSpots } from '../../src/domain/spot';
import app from '../index';
import { createSession } from '../auth/session';
import { call, devSession, setCookieLine, writeHeaders } from '../test/helpers';

let cookie = '';
// a fictional home, to prove it never leaks outside GET /api/me
const HOME = { lat: 47.123456, lng: -122.654321 };

beforeAll(async () => {
  cookie = await devSession();
  await env.DB.prepare(
    "INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES ('u_dev', ?, ?, 'x')",
  )
    .bind(HOME.lat, HOME.lng)
    .run();
});

const json = (res: Response) => res.json<Record<string, unknown>>();

describe('GET /api/health', () => {
  it('is public and touches nothing', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: expect.any(String) as unknown });
  });
});

describe('the login wall, server side: every data endpoint is 401 without a session', () => {
  it.each(['/api/me', '/api/spots', '/api/spots/lucky-thread'])('GET %s', async (path) => {
    const res = await call(path);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'sign in first' } });
  });

  it('PATCH /api/me', async () => {
    const res = await call('/api/me', {
      method: 'PATCH',
      headers: writeHeaders,
      body: '{"displayName":"x"}',
    });
    expect(res.status).toBe(401);
  });

  it('a stale cookie is cleared', async () => {
    const res = await call('/api/me', { cookie: '__Host-grub_session=stale' });
    expect(res.status).toBe(401);
    expect(setCookieLine(res, '__Host-grub_session')).toMatch(/Max-Age=0/);
  });

  it('none of the 401s carry spot data', async () => {
    for (const path of ['/api/spots', '/api/spots/lucky-thread']) {
      const body = await (await call(path)).text();
      expect(body).not.toMatch(/Lucky Thread|lucky-thread|47\.6/);
    }
  });
});

describe('GET /api/me', () => {
  it('returns the user, their (private) home and whether sign-up is open', async () => {
    const res = await call('/api/me', { cookie });
    expect(res.status).toBe(200);
    const body = MeResponseSchema.parse(await res.json());
    expect(body).toEqual({
      user: { id: 'u_dev', displayName: 'dev', avatarEmoji: '🍜' },
      home: HOME,
      signupOpen: false,
    });
  });

  it('home is null when not set', async () => {
    await env.DB.prepare(
      "UPDATE user_private SET home_lat = NULL, home_lng = NULL WHERE user_id = 'u_dev'",
    ).run();
    const body = MeResponseSchema.parse(await (await call('/api/me', { cookie })).json());
    expect(body.home).toBeNull();
    await env.DB.prepare(
      "UPDATE user_private SET home_lat = ?, home_lng = ? WHERE user_id = 'u_dev'",
    )
      .bind(HOME.lat, HOME.lng)
      .run();
  });
});

describe('PATCH /api/me', () => {
  const patch = (body: unknown, headers: Record<string, string> = writeHeaders) =>
    call('/api/me', { method: 'PATCH', cookie, headers, body: JSON.stringify(body) });

  it('changes name and emoji', async () => {
    const res = await patch({ displayName: '  Tess ', avatarEmoji: '🥟' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u_dev', displayName: 'Tess', avatarEmoji: '🥟' });
    // one at a time works too
    expect(await json(await patch({ avatarEmoji: '🇯🇵' }))).toMatchObject({
      displayName: 'Tess',
      avatarEmoji: '🇯🇵',
    });
    expect(await json(await patch({ avatarEmoji: '👩‍🍳' }))).toMatchObject({ avatarEmoji: '👩‍🍳' });
  });

  it.each([
    [{}, 'nothing to change'],
    [{ displayName: '' }, 'name is empty'],
    [{ displayName: 'x'.repeat(41) }, 'name is too long'],
    [{ avatarEmoji: 'ab' }, 'avatar must be a single emoji'],
    [{ avatarEmoji: '🍜🍜' }, 'avatar must be a single emoji'],
    [{ displayName: `a${'\u0301'.repeat(5000)}` }, 'name is too long'],
    [{ displayName: '\u200B\u3164\u2060' }, 'name is empty'],
    [{ displayName: '👨‍👩‍👧'.repeat(40) }, 'name is too long'],
    [{ home: { lat: 1, lng: 2 } }, undefined],
  ])('rejects %j', async (body, message) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    const err = await res.json<{ error: { code: string; message: string } }>();
    expect(err.error.code).toBe('bad_request');
    if (message) expect(err.error.message).toBe(message);
  });

  it('rejects malformed JSON', async () => {
    const res = await call('/api/me', {
      method: 'PATCH',
      cookie,
      headers: writeHeaders,
      body: '{',
    });
    expect(res.status).toBe(400);
  });

  it('refuses cross-site writes even with a valid session', async () => {
    const res = await patch(
      { displayName: 'pwned' },
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', 'x-grub-request': '1' },
    );
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: { code: 'csrf' } });
    const noHeader = await patch({ displayName: 'pwned' }, { 'content-type': 'application/json' });
    expect(noHeader.status).toBe(403);
  });

  it('caps request bodies at 64 KB', async () => {
    const res = await patch({ displayName: 'x'.repeat(70_000) });
    expect(res.status).toBe(413);
  });
});

describe('GET /api/spots (PR 2: your own list, from D1)', () => {
  it('the dev user starts empty; the dev-only import puts the demo spots on the list', async () => {
    expect(await (await call('/api/spots', { cookie })).json()).toEqual([]);
    const imported = await call('/api/spots/import-demo', {
      method: 'POST',
      cookie,
      headers: writeHeaders,
      body: '{}',
    });
    expect(await imported.json()).toEqual({ added: SEED_SPOTS.length });
    const spots = parseSpots(await (await call('/api/spots', { cookie })).json());
    expect(spots.map((s) => s.id).sort()).toEqual(SEED_SPOTS.map((s) => s.id).sort());
  });

  it('gets one, or a JSON 404', async () => {
    const one = await call('/api/spots/lucky-thread', { cookie });
    expect((await one.json<{ name: string }>()).name).toBe('Lucky Thread Noodle Bar');
    const none = await call('/api/spots/nope', { cookie });
    expect(none.status).toBe(404);
    expect(await json(none)).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('home never leaks', () => {
  it('appears in no response except GET /api/me', async () => {
    const paths = [
      '/api/spots',
      '/api/spots/lucky-thread',
      '/api/health',
      '/api/mapkit-token',
      '/api/nope',
    ];
    for (const path of paths) {
      const body = await (await call(path, { cookie })).text();
      expect(body, path).not.toContain(String(HOME.lat));
      expect(body, path).not.toContain(String(HOME.lng));
    }
  });
});

describe('GET /api/mapkit-token', () => {
  it('needs a session (until the signed-out map ships)', async () => {
    const res = await call('/api/mapkit-token');
    expect(res.status).toBe(401);
  });

  it('returns a 10-minute ES256 token with our origin', async () => {
    const res = await call('/api/mapkit-token', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const jwt = await res.text();
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'BQY23WRKNY', typ: 'JWT' });
    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({ iss: 'TMTJYK5V5B', origin: 'https://grub.test' });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(600);
  });

  it('outside development the origin is always the public one', async () => {
    const res = await app.request(
      'https://evil.example/api/mapkit-token',
      { headers: { cookie } },
      { ...env, ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://grub.shuaiyuan.me' },
    );
    expect(res.status).toBe(200);
    expect(decodeJwt(await res.text()).origin).toBe('https://grub.shuaiyuan.me');
  });

  it('is rate limited per user', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++)
      statuses.push((await call('/api/mapkit-token', { cookie })).status);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(20);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('one user can never see another user’s data', () => {
  // user A (the dev user, with a home) and user B (a second account)
  let bCookie = '';
  beforeAll(async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, display_name, avatar_emoji, created_at, last_login_at) VALUES ('u_b', 'Bea', '🥐', 'x', 'x')",
    ).run();
    const { token } = await createSession(env.DB, 'u_b', undefined);
    bCookie = `__Host-grub_session=${token}`;
  });

  it('B gets B, and nothing of A, from every endpoint', async () => {
    const me = MeResponseSchema.parse(await (await call('/api/me', { cookie: bCookie })).json());
    expect(me.user).toEqual({ id: 'u_b', displayName: 'Bea', avatarEmoji: '🥐' });
    expect(me.home).toBeNull();
    const paths = [
      '/api/me',
      '/api/spots',
      '/api/spots/lucky-thread',
      '/api/mapkit-token',
      '/api/nope',
    ];
    for (const path of paths) {
      const body = await (await call(path, { cookie: bCookie })).text();
      expect(body, path).not.toContain(String(HOME.lat));
      expect(body, path).not.toContain(String(HOME.lng));
      expect(body, path).not.toContain('u_dev');
    }
  });

  it("B's profile edits never touch A", async () => {
    const before = await (await call('/api/me', { cookie })).json<{ user: unknown }>();
    const res = await call('/api/me', {
      method: 'PATCH',
      cookie: bCookie,
      headers: writeHeaders,
      body: JSON.stringify({ displayName: 'Bea B', id: 'u_dev' }),
    });
    expect(res.status).toBe(400); // unknown keys (like id) are refused outright
    await call('/api/me', {
      method: 'PATCH',
      cookie: bCookie,
      headers: writeHeaders,
      body: JSON.stringify({ displayName: 'Bea B' }),
    });
    const after = await (await call('/api/me', { cookie })).json<{ user: unknown }>();
    expect(after.user).toEqual(before.user);
  });
});

describe('everything else', () => {
  it('unknown /api and /auth paths are JSON 404s', async () => {
    for (const path of ['/api/nope', '/auth/nope']) {
      const res = await call(path, { cookie });
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('sets baseline security headers and no-store on API responses', async () => {
    const res = await call('/api/me', { cookie });
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'geolocation=(self)',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
  });

  it('sends no CORS headers', async () => {
    const res = await call('/api/me', { cookie, headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await call('/api/me', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PATCH' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });
});
