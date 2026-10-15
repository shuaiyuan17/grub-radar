import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED_SPOTS } from '../../src/data/seed';
import { SpotOpError, type AddSpot } from '../../src/domain/edits';
import { parseSpots, SpotSchema } from '../../src/domain/spot';
import { D1SpotRepository } from './spots';

const SEED = parseSpots(SEED_SPOTS);
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

async function addUser(id: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, ?, 'x', 'x')",
  )
    .bind(id, id)
    .run();
}

const at = (iso: string) => () => Date.parse(iso);

beforeAll(async () => {
  await addUser('u_a');
  await addUser('u_b');
});

const MANUAL: AddSpot = {
  name: 'Night Owl Pho',
  kind: 'food',
  location: { lat: 47.61, lng: -122.33 },
  cuisine: 'pho',
  tags: ['noodles', 'Late Night '],
};

describe('D1SpotRepository', () => {
  it('round-trips every seed spot through D1 and SpotSchema unchanged', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_a');
    expect(await repo.importDemo(SEED)).toBe(SEED.length);
    expect(await repo.importDemo(SEED)).toBe(0); // idempotent
    const listed = await repo.list();
    for (const s of listed) expect(SpotSchema.parse(s)).toEqual(s);
    expect([...listed].sort(byId)).toEqual([...SEED].sort(byId));
    expect(await repo.get('lucky-thread')).toEqual(SEED.find((s) => s.id === 'lucky-thread'));
  });

  it('adds a manual spot with sensible defaults', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b', { now: at('2026-10-14T19:00:00Z') });
    const spot = await repo.add({ ...MANUAL, why: 'pho at 1am' });
    expect(spot).toMatchObject({
      name: 'Night Owl Pho',
      status: 'want',
      price: '$$',
      icon: 'bowl',
      tags: ['noodles', 'late night'],
      order: [],
      why: { text: 'pho at 1am', foundOn: '2026-10-14' },
    });
    expect(spot.id).toMatch(/^p-[0-9a-z]{26}$/);
    expect(await repo.get(spot.id)).toEqual(spot);
    expect(await repo.visitCount(spot.id)).toBe(0);
    const row = await env.DB.prepare('SELECT found_by FROM user_places WHERE place_id = ?')
      .bind(spot.id)
      .first<{ found_by: string }>();
    expect(row?.found_by).toBe('me');
  });

  it('adding as "been" records a visit; Chinese text is marked zh-Hans', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b');
    const spot = await repo.add({ ...MANUAL, name: '老张拉面', status: 'been', rating: 8 });
    expect(spot).toMatchObject({ status: 'been', rating: 8, lang: 'zh-Hans' });
    expect(await repo.visitCount(spot.id)).toBe(1);
  });

  it('mark been: status, rating, a visit each time, a dated note; rating kept if omitted', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b', { now: at('2026-10-14T19:00:00Z') });
    const { id } = await repo.add(MANUAL);
    const once = await repo.markBeen(id, { rating: 9, note: 'broth!' });
    expect(once).toMatchObject({ status: 'been', rating: 9, myNote: '— 2026-10-14: broth!' });
    const twice = await repo.markBeen(id, { on: '2026-10-20' });
    expect(twice.rating).toBe(9);
    expect(await repo.visitCount(id)).toBe(2);
    expect(await repo.get(id)).toEqual(twice);
  });

  it('add note appends dated lines and caps the total', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b', { now: at('2026-10-14T08:00:00Z') });
    const { id } = await repo.add(MANUAL);
    await repo.addNote(id, { note: 'first' });
    const spot = await repo.addNote(id, { note: 'second\nline', on: '2026-10-15' });
    expect(spot.myNote).toBe('— 2026-10-14: first\n— 2026-10-15: second line');
    for (let i = 0; i < 3; i++) await repo.addNote(id, { note: 'x'.repeat(480) });
    await expect(repo.addNote(id, { note: 'y'.repeat(480) })).rejects.toMatchObject({
      code: 'note_too_long',
    });
  });

  it('edits: back to "want" drops the rating; rating a want is refused', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b');
    const { id } = await repo.add({ ...MANUAL, status: 'been', rating: 7 });
    const want = await repo.update(id, { status: 'want' });
    expect(want.status).toBe('want');
    expect(want.rating).toBeUndefined();
    await expect(repo.update(id, { rating: 5 })).rejects.toMatchObject({
      code: 'rating_needs_been',
    });
    const edited = await repo.update(id, {
      name: 'Night Owl Phở',
      price: '$',
      location: { lat: 47.62, lng: -122.34 },
      cuisine: null,
      order: [{ dish: 'rare beef pho', tried: false }],
    });
    expect(edited).toMatchObject({ name: 'Night Owl Phở', price: '$', order: [{ tried: false }] });
    expect(edited.cuisine).toBeUndefined();
    expect(await repo.get(id)).toEqual(edited);
  });

  it("a shared place's details are only editable by whoever created it", async () => {
    // u_a imported the demo first, so u_a created the shared demo places
    const b = new D1SpotRepository(env.DB, 'u_b');
    await b.importDemo(SEED);
    await expect(b.update('lucky-thread', { name: 'Mine Now' })).rejects.toBeInstanceOf(
      SpotOpError,
    );
    // your own list entry is always yours
    const mine = await b.update('lucky-thread', { tags: ['noodles'], note: 'b was here' });
    expect(mine.note).toBe('b was here');
    const a = new D1SpotRepository(env.DB, 'u_a');
    expect((await a.get('lucky-thread'))?.note).toBe('cumin lamb, extra chili. trust.');
  });

  it('remove: the entry and its visits go; a manual place nobody else has goes too', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b');
    const { id } = await repo.add({ ...MANUAL, status: 'been' });
    await repo.remove(id);
    expect(await repo.get(id)).toBeNull();
    expect(await repo.visitCount(id)).toBe(0);
    const place = await env.DB.prepare('SELECT 1 FROM places WHERE id = ?').bind(id).first();
    expect(place).toBeNull();
    await expect(repo.remove(id)).rejects.toMatchObject({ code: 'not_found' });
    // a shared place stays for the others
    await repo.remove('lucky-thread');
    expect(await new D1SpotRepository(env.DB, 'u_a').get('lucky-thread')).not.toBeNull();
  });

  it('missing spots are not_found for every write', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b');
    for (const op of [
      () => repo.update('nope', { note: 'x' }),
      () => repo.markBeen('nope'),
      () => repo.addNote('nope', { note: 'x' }),
      () => repo.remove('nope'),
    ])
      await expect(op()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('skips (and logs) a row that no longer passes the schema instead of failing the list', async () => {
    const repo = new D1SpotRepository(env.DB, 'u_b');
    const { id } = await repo.add(MANUAL);
    await env.DB.prepare("UPDATE user_places SET tags_json = 'not json' WHERE place_id = ?")
      .bind(id)
      .run();
    const listed = await repo.list();
    expect(listed.find((s) => s.id === id)).toBeUndefined();
    expect(await repo.get(id)).toBeNull();
  });
});
