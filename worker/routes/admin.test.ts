import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { AdminStatsSchema, SIGNUP_DAYS } from '../../src/contracts/admin';
import app from '../index';
import { adminSubs } from '../db/admin';
import { call, ORIGIN, send, userSession, writeHeaders } from '../test/helpers';

/**
 * /api/admin/*: the owner-only stats. vitest.config.ts sets
 * ADMIN_APPLE_SUBS="test-admin-sub, test-other-admin". To anyone else, every
 * path and method here must be indistinguishable from an unknown endpoint.
 */

let admin = '';
let person = '';
const ADMIN_EMAIL = 'owner@privaterelay.appleid.com';

async function identity(userId: string, sub: string, provider = 'apple') {
  await env.DB.prepare(
    `INSERT INTO auth_identities (provider, provider_sub, user_id, email, created_at)
     VALUES (?, ?, ?, ?, '2026-10-15T00:00:00.000Z')`,
  )
    .bind(provider, sub, userId, ADMIN_EMAIL)
    .run();
}

beforeAll(async () => {
  admin = await userSession('u_owner', 'Owner');
  await identity('u_owner', 'test-admin-sub');
  person = await userSession('u_someone', 'Someone');
  await identity('u_someone', 'someone-elses-sub');
  await env.DB.prepare(
    "UPDATE users SET created_at = ?, last_login_at = ? WHERE id IN ('u_owner', 'u_someone')",
  )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();
  // the owner has a spot and a friend, so the counts have something to count
  await send('POST', '/api/spots', admin, {
    name: 'Fictional Noodle Bar',
    kind: 'food',
    location: { lat: 47.6, lng: -122.3 },
  });
  await env.DB.prepare(
    "INSERT INTO friendships (user_id, friend_id, created_at) VALUES ('u_owner', 'u_someone', 'x'), ('u_someone', 'u_owner', 'x')",
  ).run();
});

/** What an unknown endpoint answers, to compare against. */
async function unknownEndpoint(method = 'GET', cookie?: string) {
  const res = await call('/api/definitely-not-a-thing', {
    method,
    cookie,
    ...(method === 'GET' ? {} : { headers: writeHeaders, body: '{}' }),
  });
  return shape(res);
}

/**
 * Everything a client can see of a response: status, body and every header.
 * Server-Timing's durations differ request to request, so they're blanked;
 * its metric names and descriptions (which D1 work ran) must match exactly.
 */
async function shape(res: Response) {
  const headers = Object.fromEntries(
    [...res.headers].map(([k, v]) => [
      k,
      k === 'server-timing' ? v.replace(/dur=[\d.]+/g, 'dur=_') : v,
    ]),
  );
  return { status: res.status, body: await res.text(), headers };
}

describe('the admin API is a plain 404 for everyone but admins', () => {
  const paths = ['/api/admin/stats', '/api/admin', '/api/admin/', '/api/admin/users'];
  const who = {
    'signed out': undefined,
    'a signed-in non-admin': () => person,
    'a stale cookie': () => '__Host-grub_session=stale',
  } as const;

  for (const [label, cookie] of Object.entries(who)) {
    it(`${label}: GET and POST, every path, same answer as an unknown endpoint`, async () => {
      const c = typeof cookie === 'function' ? cookie() : cookie;
      for (const method of ['GET', 'POST', 'DELETE']) {
        const expected = await unknownEndpoint(method, c);
        expect(expected.status).toBe(404);
        for (const path of paths) {
          const res = await call(path, {
            method,
            cookie: c,
            ...(method === 'GET' ? {} : { headers: writeHeaders, body: '{}' }),
          });
          // headers included: no extra D1 work may show in Server-Timing
          expect(await shape(res)).toEqual(expected);
        }
      }
    });
  }

  it('a matching sub under another provider is not an admin', async () => {
    const c = await userSession('u_impostor');
    await identity('u_impostor', 'test-admin-sub', 'dev');
    expect((await call('/api/admin/stats', { cookie: c })).status).toBe(404);
  });

  it('no ADMIN_APPLE_SUBS (or an empty one): nobody, not even the owner', async () => {
    for (const value of [undefined, '', ' , ']) {
      const res = await app.request(
        `${ORIGIN}/api/admin/stats`,
        { headers: { cookie: admin } },
        { ...env, ADMIN_APPLE_SUBS: value },
      );
      expect(res.status).toBe(404);
    }
  });

  it('parses the list: trims, drops empties', () => {
    expect(adminSubs({ ADMIN_APPLE_SUBS: ' a , ,b,' })).toEqual(['a', 'b']);
    expect(adminSubs({})).toEqual([]);
  });
});

describe('GET /api/admin/stats, as the admin', () => {
  it('totals, 30 days of sign-ups, and per-person counts', async () => {
    const res = await call('/api/admin/stats', { cookie: admin });
    expect(res.status).toBe(200);
    const stats = AdminStatsSchema.parse(await res.json());
    expect(stats.totalUsers).toBeGreaterThanOrEqual(2);
    expect(stats.signupsByDay).toHaveLength(SIGNUP_DAYS);
    const today = new Date().toISOString().slice(0, 10);
    expect(stats.signupsByDay.at(-1)).toEqual({ day: today, count: 2 });
    const owner = stats.users.find((u) => u.displayName === 'Owner');
    expect(owner).toMatchObject({ spots: 1, friends: 1, avatarEmoji: '🍜' });
    expect(stats.users.find((u) => u.displayName === 'Someone')).toMatchObject({
      spots: 0,
      friends: 1,
    });
  });

  it('a second listed sub works too', async () => {
    const c = await userSession('u_second', 'Second');
    await identity('u_second', 'test-other-admin');
    expect((await call('/api/admin/stats', { cookie: c })).status).toBe(200);
  });

  it('never carries emails, Apple subs or user ids', async () => {
    const body = await (await call('/api/admin/stats', { cookie: admin })).text();
    for (const secret of [ADMIN_EMAIL, '@', 'test-admin-sub', 'someone-elses-sub', 'u_owner']) {
      expect(body).not.toContain(secret);
    }
  });

  it('last seen comes from sessions (never earlier than the last sign-in)', async () => {
    const later = '2099-01-01T00:00:00.000Z';
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE user_id = 'u_someone'")
      .bind(later)
      .run();
    const stats = AdminStatsSchema.parse(
      await (await call('/api/admin/stats', { cookie: admin })).json(),
    );
    expect(stats.users.find((u) => u.displayName === 'Someone')?.lastSeenAt).toBe(later);
  });
});
