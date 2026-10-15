import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { D1SpotRepository } from './spots';

/**
 * 0003 (unknown price, good/meh/bad verdict) against data written under 0002's
 * schema. This file's storage is its own: it throws away what the setup file
 * applied, applies 0001-0002, writes rows the way the old code did, then
 * applies the rest, exactly as `wrangler d1 migrations apply` would on prod.
 */

const before = (n: number) => env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) < n);

const all = async <T>(sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;

const AT = '2026-10-01T12:00:00.000Z';
const LATER = '2026-10-03T08:00:00.000Z';

beforeAll(async () => {
  // children first: foreign keys are on
  for (const t of [
    'invites',
    'friendships',
    'visits',
    'user_places',
    'places',
    'sessions',
    'auth_identities',
    'user_private',
    'users',
    'd1_migrations',
  ])
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  await applyD1Migrations(env.DB, before(3));
  expect(await all("SELECT name FROM d1_migrations WHERE name LIKE '0003%'")).toEqual([]);

  const place = (id: string, apple: string | null) =>
    env.DB.prepare(
      `INSERT INTO places (id, apple_place_id, name, lat, lng, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 47.6, -122.3, 'u_m', ?, ?)`,
    ).bind(id, apple, id, AT, AT);
  const entry = (
    placeId: string,
    price: string,
    version: number,
    status: 'want' | 'been',
    rating: number | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO user_places (user_id, place_id, kind, price, status, rating, version, created_at, updated_at)
       VALUES ('u_m', ?, 'food', ?, ?, ?, ?, ?, ?)`,
    ).bind(placeId, price, status, rating, version, AT, version === 1 ? AT : LATER);
  const visit = (id: string, placeId: string, rating: number | null) =>
    env.DB.prepare(
      `INSERT INTO visits (id, user_id, place_id, visited_on, rating, created_at)
       VALUES (?, 'u_m', ?, '2026-10-02', ?, ?)`,
    ).bind(id, placeId, rating, AT);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES ('u_m', 'm', ?, ?)",
    ).bind(AT, AT),
    // the live row: Serious Pie, from Apple, the old '$$' default, never edited
    place('p-serious-pie', 'IAPPLE1'),
    entry('p-serious-pie', '$$', 1, 'want', null),
    // from Apple, '$$', but edited since (someone may have picked '$$'): kept
    place('p-apple-edited', 'IAPPLE2'),
    entry('p-apple-edited', '$$', 2, 'been', 8),
    // from Apple, never edited, but not the default: someone said '$'
    place('p-apple-cheap', 'IAPPLE3'),
    entry('p-apple-cheap', '$', 1, 'been', 5),
    // typed by hand: '$$' was a choice, never touched
    place('p-manual', null),
    entry('p-manual', '$$', 1, 'been', 4),
    // every score a visit can have, plus none
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => visit(`v_${String(r)}`, 'p-apple-edited', r)),
    visit('v_none', 'p-apple-edited', null),
  ]);

  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('migration 0003: unknown price, verdicts', () => {
  it('only the untouched Apple "$$" default becomes unknown; chosen prices stay', async () => {
    expect(
      await all('SELECT place_id, price, version, updated_at FROM user_places ORDER BY place_id'),
    ).toEqual([
      { place_id: 'p-apple-cheap', price: '$', version: 1, updated_at: AT },
      { place_id: 'p-apple-edited', price: '$$', version: 2, updated_at: LATER },
      { place_id: 'p-manual', price: '$$', version: 1, updated_at: AT },
      // a correction, not an edit: version stays, so open copies in the app don't 409
      { place_id: 'p-serious-pie', price: null, version: 1, updated_at: AT },
    ]);
  });

  it('maps 1-10 to verdicts: 8-10 good, 5-7 meh, 1-4 bad, none stays none', async () => {
    expect(await all('SELECT place_id, verdict FROM user_places ORDER BY place_id')).toEqual([
      { place_id: 'p-apple-cheap', verdict: 'meh' },
      { place_id: 'p-apple-edited', verdict: 'good' },
      { place_id: 'p-manual', verdict: 'bad' },
      { place_id: 'p-serious-pie', verdict: null },
    ]);
    const visits = await all<{ id: string; verdict: string | null }>(
      'SELECT id, verdict FROM visits',
    );
    expect(Object.fromEntries(visits.map((v) => [v.id, v.verdict]))).toEqual({
      v_1: 'bad',
      v_2: 'bad',
      v_3: 'bad',
      v_4: 'bad',
      v_5: 'meh',
      v_6: 'meh',
      v_7: 'meh',
      v_8: 'good',
      v_9: 'good',
      v_10: 'good',
      v_none: null,
    });
  });

  it('the new columns are guarded: no rating left, no "$$" default, only known values', async () => {
    const cols = async (t: string) =>
      (await all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`)).map(
        (c) => c.name,
      );
    expect(await cols('user_places')).not.toContain('rating');
    expect(await cols('visits')).not.toContain('rating');
    expect(
      (
        await all<{ dflt_value: string | null; notnull: number }>(
          "SELECT dflt_value, \"notnull\" FROM pragma_table_info('user_places') WHERE name = 'price'",
        )
      )[0],
    ).toEqual({ dflt_value: null, notnull: 0 });
    const insert = (price: string | null, status: string, verdict: string | null) =>
      env.DB.prepare(
        `INSERT INTO user_places (user_id, place_id, kind, price, status, verdict, created_at, updated_at)
         VALUES ('u_m', 'p-new', 'food', ?, ?, ?, ?, ?)`,
      )
        .bind(price, status, verdict, AT, AT)
        .run();
    await env.DB.prepare(
      `INSERT INTO places (id, name, lat, lng, created_at, updated_at) VALUES ('p-new', 'n', 0, 0, ?, ?)`,
    )
      .bind(AT, AT)
      .run();
    await expect(insert('$$$$$', 'want', null)).rejects.toThrow(/CHECK/);
    await expect(insert(null, 'been', '9')).rejects.toThrow(/CHECK/);
    await expect(insert(null, 'want', 'good')).rejects.toThrow(/CHECK/);
    await insert(null, 'been', 'good');
  });

  it('indexes and cascades survive the rebuild', async () => {
    const indexes = await all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('user_places_place', 'visits_user_place', 'visits_place') ORDER BY name",
    );
    expect(indexes.map((i) => i.name)).toEqual([
      'user_places_place',
      'visits_place',
      'visits_user_place',
    ]);
    expect(await all("SELECT name FROM sqlite_master WHERE name LIKE '%_new'")).toEqual([]);
  });

  it('the app reads the migrated rows: Serious Pie has no price; verdicts come through', async () => {
    const spots = await new D1SpotRepository(env.DB, 'u_m').list();
    const pie = spots.find((s) => s.id === 'p-serious-pie');
    expect(pie).toBeDefined();
    expect(pie).not.toHaveProperty('price');
    expect(spots.find((s) => s.id === 'p-apple-edited')).toMatchObject({
      price: '$$',
      verdict: 'good',
    });
    expect(spots.find((s) => s.id === 'p-manual')).toMatchObject({ price: '$$', verdict: 'bad' });
  });

  it('deleting the user still cascades to the rebuilt tables', async () => {
    await env.DB.prepare("DELETE FROM users WHERE id = 'u_m'").run();
    expect(await all('SELECT 1 FROM user_places')).toEqual([]);
    expect(await all('SELECT 1 FROM visits')).toEqual([]);
  });
});
