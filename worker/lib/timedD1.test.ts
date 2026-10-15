import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { describeSql, timedD1 } from './timedD1';
import { Timing } from './timing';

describe('describeSql', () => {
  it.each([
    ['SELECT a FROM sessions s JOIN users u ON 1 WHERE s.id = ?', 'SELECT sessions'],
    ['  insert into user_places (a) values (?)', 'INSERT user_places'],
    ['UPDATE users SET x = (SELECT y FROM auth_identities)', 'UPDATE users'],
    ['DELETE FROM sessions WHERE id = ?', 'DELETE sessions'],
    ['SELECT 1', 'SELECT'],
  ])('%s -> %s', (sql, label) => {
    expect(describeSql(sql)).toBe(label);
  });
});

describe('timedD1', () => {
  it('counts one round trip per statement and per batch, and behaves like D1', async () => {
    const timing = new Timing();
    const db = timedD1(env.DB, timing);
    expect(await db.prepare('SELECT 1 AS one').first()).toEqual({ one: 1 });
    expect(await db.prepare('SELECT 2 AS two').first('two')).toBe(2);
    expect(await db.prepare('SELECT 3 AS n WHERE 0').first()).toBeNull();
    const [a, b] = await db.batch([
      db.prepare('SELECT ? AS v').bind('x'),
      db.prepare('SELECT ? AS v').bind('y'),
    ]);
    expect(a?.results).toEqual([{ v: 'x' }]);
    expect(b?.results).toEqual([{ v: 'y' }]);
    expect((await db.prepare('SELECT 4 AS n').all()).results).toEqual([{ n: 4 }]);
    expect(await db.prepare('SELECT 5 AS n').raw()).toEqual([[5]]);
    expect(timing.d1.roundTrips).toBe(6);
    expect(timing.d1.statements).toBe(7);
    expect(timing.phases.map((p) => p.desc)).toEqual([
      'SELECT',
      'SELECT',
      'SELECT',
      'batch[SELECT; SELECT]',
      'SELECT',
      'SELECT',
    ]);
    expect(timing.header()).toMatch(
      /^d1_1;dur=[\d.]+;desc="SELECT", .* d1;desc="6 round trips", total;dur=[\d.]+$/,
    );
  });
});
