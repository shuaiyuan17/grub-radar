import { SEED_SPOTS } from '../data/seed';
import {
  AddNoteSchema,
  AddSpotSchema,
  appendNote,
  applyAddNote,
  applyMarkBeen,
  applyPatch,
  changesPlace,
  guessLang,
  MarkBeenSchema,
  parseNoteEntries,
  spotFromInput,
  SpotOpError,
  SpotPatchSchema,
} from './edits';
import { LIMITS, parseSpots, SpotSchema } from './spot';

const seed = parseSpots(SEED_SPOTS);
const lucky = seed.find((s) => s.id === 'lucky-thread')!;
const mamaKos = seed.find((s) => s.id === 'mama-kos')!;
const TODAY = '2026-10-14';

describe('AddSpotSchema', () => {
  const base = { name: 'Night Owl Pho', kind: 'food', location: { lat: 47.6, lng: -122.3 } };

  it('needs a name, a kind and a location; everything else is optional', () => {
    expect(AddSpotSchema.safeParse(base).success).toBe(true);
    for (const k of ['name', 'kind', 'location'] as const) {
      const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== k));
      expect(AddSpotSchema.safeParse(rest).success, k).toBe(false);
    }
  });

  it('trims, lowercases tags, and refuses unknown keys or a rating without "been"', () => {
    const parsed = AddSpotSchema.parse({ ...base, name: '  Pho  ', tags: [' Late Night '] });
    expect(parsed.name).toBe('Pho');
    expect(parsed.tags).toEqual(['late night']);
    expect(AddSpotSchema.safeParse({ ...base, id: 'x' }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, rating: 8 }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, status: 'been', rating: 8 }).success).toBe(true);
    expect(AddSpotSchema.safeParse({ ...base, status: 'been', rating: 11 }).success).toBe(false);
  });

  it('enforces the size limits', () => {
    const tooMany = Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`);
    expect(AddSpotSchema.safeParse({ ...base, tags: tooMany }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, note: 'x'.repeat(61) }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(false);
  });
});

describe('spotFromInput', () => {
  it('fills defaults: want, $$, the kind’s doodle, no empty strings', () => {
    const spot = spotFromInput(
      'p-1',
      AddSpotSchema.parse({
        name: 'Fig & Fern',
        kind: 'bakery',
        location: { lat: 1, lng: 2 },
        cuisine: '',
        note: '',
        order: ['morning bun', 'morning bun'],
        why: 'cardamom buns',
      }),
      TODAY,
    );
    expect(spot).toEqual({
      id: 'p-1',
      name: 'Fig & Fern',
      kind: 'bakery',
      price: '$$',
      tags: [],
      status: 'want',
      order: [{ dish: 'morning bun', tried: false }],
      why: { text: 'cardamom buns', foundOn: TODAY },
      icon: 'croissant',
      location: { lat: 1, lng: 2 },
    });
    expect(SpotSchema.parse(spot)).toEqual(spot);
  });

  it('marks Chinese text zh-Hans', () => {
    const spot = spotFromInput(
      'p-2',
      AddSpotSchema.parse({ name: '老张拉面', kind: 'food', location: { lat: 1, lng: 2 } }),
      TODAY,
    );
    expect(spot.lang).toBe('zh-Hans');
    expect(guessLang('Lucky Thread', undefined)).toBeUndefined();
  });
});

describe('applyPatch', () => {
  it('changes only what it names; null clears', () => {
    const next = applyPatch(lucky, SpotPatchSchema.parse({ note: null, cuisine: null }), TODAY);
    expect(next.note).toBeUndefined();
    expect(next.cuisine).toBeUndefined();
    expect(next.order).toEqual(lucky.order);
    expect(next.rating).toBe(9);
  });

  it('back to "want" drops the rating; rating a want throws', () => {
    expect(applyPatch(lucky, { status: 'want' }, TODAY).rating).toBeUndefined();
    expect(() => applyPatch(mamaKos, { rating: 5 }, TODAY)).toThrow(SpotOpError);
    expect(SpotPatchSchema.safeParse({ status: 'want', rating: 5 }).success).toBe(false);
    expect(SpotPatchSchema.safeParse({}).success).toBe(false);
  });

  it('a new "why" is dated today; the same text keeps its date', () => {
    expect(applyPatch(lucky, { why: 'new reason' }, TODAY).why).toEqual({
      text: 'new reason',
      foundOn: TODAY,
    });
    expect(applyPatch(lucky, { why: lucky.why!.text }, TODAY).why).toEqual(lucky.why);
  });

  it('knows whether an edit touched the place or only your list entry', () => {
    expect(changesPlace(lucky, applyPatch(lucky, { tags: ['x'] }, TODAY))).toBe(false);
    expect(changesPlace(lucky, applyPatch(lucky, { price: '$' }, TODAY))).toBe(true);
    expect(changesPlace(lucky, applyPatch(lucky, { location: lucky.location }, TODAY))).toBe(false);
  });
});

describe('mark been and notes', () => {
  it('mark been: status + rating; a note is appended, dated', () => {
    const been = applyMarkBeen(mamaKos, MarkBeenSchema.parse({ rating: 8, note: 'cash!' }), TODAY);
    expect(been).toMatchObject({ status: 'been', rating: 8, myNote: `— ${TODAY}: cash!` });
    // rating kept when not given again
    expect(applyMarkBeen(been, { on: '2026-10-20' }, TODAY).rating).toBe(8);
  });

  it('add note appends one line per note, newlines folded', () => {
    const once = applyAddNote(mamaKos, AddNoteSchema.parse({ note: 'a\n b' }), TODAY);
    const twice = applyAddNote(once, { note: 'c', on: '2026-10-15' }, TODAY);
    expect(twice.myNote).toBe(`— ${TODAY}: a b\n— 2026-10-15: c`);
    expect(AddNoteSchema.safeParse({ note: '   ' }).success).toBe(false);
    expect(AddNoteSchema.safeParse({ note: 'x', on: '14/10/2026' }).success).toBe(false);
  });

  it('caps the notes at LIMITS.myNote', () => {
    const almost = 'x'.repeat(LIMITS.myNote - 10);
    expect(() => appendNote(almost, TODAY, 'one more thing')).toThrow(/capped/);
  });

  it('parses entries for display, keeping free text', () => {
    expect(parseNoteEntries(`go early\n— ${TODAY}: so good\n`)).toEqual([
      { on: null, text: 'go early' },
      { on: TODAY, text: 'so good' },
    ]);
    expect(parseNoteEntries(undefined)).toEqual([]);
  });
});
