import { SEED_SPOTS } from '../data/seed';
import {
  AddNoteSchema,
  AddSpotSchema,
  appendNote,
  applyAddDish,
  applyAddNote,
  applyMarkBeen,
  applyPatch,
  applyRemoveDish,
  changesPlace,
  DishInputSchema,
  guessLang,
  MarkBeenSchema,
  withLegacyRating,
  parseNoteEntries,
  spotFromInput,
  SpotOpError,
  SpotPatchSchema,
} from './edits';
import { LIMITS, parseSpots, SpotSchema, withDishIds } from './spot';

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

  it('trims, lowercases tags, and refuses unknown keys or a verdict without "been"', () => {
    const parsed = AddSpotSchema.parse({ ...base, name: '  Pho  ', tags: [' Late Night '] });
    expect(parsed.name).toBe('Pho');
    expect(parsed.tags).toEqual(['late night']);
    expect(AddSpotSchema.safeParse({ ...base, id: 'x' }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, verdict: 'good' }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, status: 'been', verdict: 'good' }).success).toBe(
      true,
    );
    expect(AddSpotSchema.safeParse({ ...base, status: 'been', verdict: 8 }).success).toBe(false);
  });

  it('enforces the size limits', () => {
    const tooMany = Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`);
    expect(AddSpotSchema.safeParse({ ...base, tags: tooMany }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, note: 'x'.repeat(61) }).success).toBe(false);
    expect(AddSpotSchema.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(false);
  });
});

describe('spotFromInput', () => {
  it('marks a place from Apple Maps with its id and address', () => {
    const spot = spotFromInput(
      'p-1',
      { name: 'Paper Kite Coffee', kind: 'coffee', location: { lat: 47.6, lng: -122.3 } },
      '2026-10-15',
      { applePlaceId: 'IF0000000000000B1', address: '9 Kite Ln, Seattle, WA 98101' },
    );
    expect(spot).toMatchObject({
      applePlaceId: 'IF0000000000000B1',
      address: '9 Kite Ln, Seattle, WA 98101',
      icon: 'cup',
      status: 'want',
    });
    expect(
      spotFromInput('p-2', { name: 'x', kind: 'food', location: { lat: 0, lng: 0 } }, '2026-10-15'),
    ).not.toHaveProperty('applePlaceId');
  });

  it('fills defaults: want, price unknown (never a guessed "$$"), the kind’s doodle, no empty strings', () => {
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
      tags: [],
      status: 'want',
      order: [{ id: 'd1', dish: 'morning bun', tried: false }],
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
    expect(next.verdict).toBe('good');
  });

  it('price: null is "not sure" (unknown); leaving it out keeps it', () => {
    expect(SpotPatchSchema.parse({ price: null }).price).toBeNull();
    const unsure = applyPatch(lucky, { price: null }, TODAY);
    expect(unsure).not.toHaveProperty('price');
    expect(applyPatch(unsure, { note: 'x' }, TODAY)).not.toHaveProperty('price');
    expect(applyPatch(lucky, { note: 'x' }, TODAY).price).toBe('$$');
  });

  it('back to "want" drops the verdict; a verdict on a want throws', () => {
    expect(applyPatch(lucky, { status: 'want' }, TODAY).verdict).toBeUndefined();
    expect(() => applyPatch(mamaKos, { verdict: 'meh' }, TODAY)).toThrow(SpotOpError);
    expect(SpotPatchSchema.safeParse({ status: 'want', verdict: 'meh' }).success).toBe(false);
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
    // kind, cuisine, price … are your own words now; only name and location are the place's
    expect(changesPlace(lucky, applyPatch(lucky, { price: '$', kind: 'coffee' }, TODAY))).toBe(
      false,
    );
    expect(changesPlace(lucky, applyPatch(lucky, { name: 'x' }, TODAY))).toBe(true);
    expect(changesPlace(lucky, applyPatch(lucky, { location: lucky.location }, TODAY))).toBe(false);
  });
});

describe('mark been and notes', () => {
  it('mark been: status + verdict; a note is appended, dated', () => {
    const been = applyMarkBeen(
      mamaKos,
      MarkBeenSchema.parse({ verdict: 'good', note: 'cash!' }),
      TODAY,
    );
    expect(been).toMatchObject({ status: 'been', verdict: 'good', myNote: `— ${TODAY}: cash!` });
    // verdict kept when not given again
    expect(applyMarkBeen(been, { on: '2026-10-12' }, TODAY).verdict).toBe('good');
    // mark_been takes a verdict, not a 1-10 score
    expect(MarkBeenSchema.safeParse({ verdict: 'meh' }).success).toBe(true);
    expect(MarkBeenSchema.safeParse({ verdict: 8 }).success).toBe(false);
    expect(MarkBeenSchema.safeParse({ rating: 8 }).success).toBe(false);
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

describe('dishes to order', () => {
  const base = { ...lucky, order: [{ id: 'd4', dish: 'Cumin Lamb', tried: true }] };
  const dish = (d: string) => DishInputSchema.parse({ dish: d });

  it('folds whitespace and caps a dish at LIMITS.dish', () => {
    expect(dish('  chili   oil\nwontons ').dish).toBe('chili oil wontons');
    expect(DishInputSchema.safeParse({ dish: '   ' }).success).toBe(false);
    expect(DishInputSchema.safeParse({ dish: 'x'.repeat(LIMITS.dish + 1) }).success).toBe(false);
  });

  it('adds a new dish untried, with a fresh id', () => {
    const next = applyAddDish(base, dish('mapo tofu'));
    expect(next.order).toEqual([
      { id: 'd4', dish: 'Cumin Lamb', tried: true },
      { id: 'd5', dish: 'mapo tofu', tried: false },
    ]);
  });

  it('a dish already there in any case or spacing changes nothing', () => {
    expect(applyAddDish(base, dish('cumin   LAMB'))).toBe(base);
  });

  it('refuses a dish past LIMITS.dishes', () => {
    const full = {
      ...lucky,
      order: Array.from({ length: LIMITS.dishes }, (_, i) => ({
        id: `d${String(i + 1)}`,
        dish: `dish ${String(i)}`,
        tried: false,
      })),
    };
    expect(() => applyAddDish(full, dish('one more'))).toThrow(
      expect.objectContaining({ code: 'dishes_full' }),
    );
    // …but a duplicate is still a quiet no-op
    expect(applyAddDish(full, dish('DISH 3'))).toBe(full);
  });

  it('removes a dish matched ignoring case and spacing; a missing one is no_dish', () => {
    expect(applyRemoveDish(base, dish(' cumin lamb ')).order).toEqual([]);
    expect(() => applyRemoveDish(base, dish('mapo tofu'))).toThrow(
      expect.objectContaining({ code: 'no_dish' }),
    );
  });

  it('add_spot drops dishes that differ only in case or spacing', () => {
    const spot = spotFromInput(
      'p-x',
      AddSpotSchema.parse({
        name: 'Pho',
        kind: 'food',
        location: { lat: 47.6, lng: -122.3 },
        order: ['Pho Tai', 'pho  tai', 'banh mi'],
      }),
      TODAY,
    );
    expect(spot.order.map((d) => d.dish)).toEqual(['Pho Tai', 'banh mi']);
  });
});

describe('guards', () => {
  it('no visits or notes in the future (one day of slack for time zones ahead of UTC)', () => {
    expect(() => applyMarkBeen(mamaKos, { on: '2026-10-15' }, TODAY)).not.toThrow();
    expect(() => applyMarkBeen(mamaKos, { on: '2026-10-16' }, TODAY)).toThrow(/hasn't happened/);
    expect(() => applyAddNote(mamaKos, { note: 'x', on: '2027-01-01' }, TODAY)).toThrow(
      SpotOpError,
    );
  });

  it('an edit pinned to an old version is a conflict', () => {
    const v3 = { ...lucky, version: 3 };
    expect(() => applyPatch(v3, { note: 'x', version: 2 }, TODAY)).toThrow(/changed since/);
    expect(applyPatch(v3, { note: 'x', version: 3 }, TODAY).note).toBe('x');
    expect(SpotPatchSchema.safeParse({ version: 3 }).success).toBe(false); // nothing to change
  });

  it('dishes get stable ids: kept, next free for new ones, duplicates renumbered', () => {
    expect(withDishIds([{ dish: 'a' }, { id: 'd5', dish: 'b' }, { id: 'd5', dish: 'c' }])).toEqual([
      { id: 'd6', dish: 'a' },
      { id: 'd5', dish: 'b' },
      { id: 'd7', dish: 'c' },
    ]);
    expect(lucky.order.map((o) => o.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('generated dish ids never leave the valid range', () => {
    const order = withDishIds([{ id: 'd999999', dish: 'a' }, { dish: 'b' }, { dish: 'c' }]);
    expect(order.map((o) => o.id)).toEqual(['d999999', 'd1', 'd2']);
    const spot = SpotSchema.parse({ ...lucky, order: order.map((o) => ({ ...o, tried: false })) });
    expect(spot.order).toHaveLength(3);
    // and a full range still finds a free one
    expect(withDishIds([{ id: 'd1' }, { id: 'd999999' }, {}])[2]?.id).toBe('d2');
  });
});

describe('withLegacyRating', () => {
  it('maps a valid legacy rating to a verdict', () => {
    expect(withLegacyRating({ rating: 9 })).toEqual({ verdict: 'good' });
    expect(withLegacyRating({ rating: 6 })).toEqual({ verdict: 'meh' });
    expect(withLegacyRating({ rating: null })).toEqual({ verdict: null });
  });

  it('lets an explicit verdict win over a valid rating', () => {
    expect(withLegacyRating({ verdict: 'bad', rating: 10 })).toEqual({ verdict: 'bad' });
  });

  it('keeps an invalid rating so the strict schema refuses it, even next to a verdict', () => {
    expect(withLegacyRating({ verdict: 'good', rating: 'not-a-number' })).toEqual({
      verdict: 'good',
      rating: 'not-a-number',
    });
    expect(withLegacyRating({ rating: 11 })).toEqual({ rating: 11 });
  });
});
