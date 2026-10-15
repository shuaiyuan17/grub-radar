import { StaticSpotRepository } from '../data/staticRepository';
import { chipsFor, listSpots, matchesQuery, normalizeSearch, spotsForMode } from './modes';
import type { Spot } from './spot';
import { byDistance, toSpotViews } from './spotView';

const origin = { lat: 47.6101, lng: -122.3344 };
const spots = await new StaticSpotRepository().list();
const views = toSpotViews(spots, origin);
const names = (vs: { spot: Spot }[]) => vs.map((v) => v.spot.name);

describe('modes', () => {
  it('near me = food within 20 minutes, closest first by actual distance', () => {
    const near = spotsForMode(views, 'near');
    // Mama Ko's is a 14 min walk but only 0.9 km away, so it comes before
    // Ondo (8 min drive, 1.6 km): "closest first" means closest.
    expect(names(near)).toEqual([
      'Lucky Thread Noodle Bar',
      "Mama Ko's Dumpling Window",
      'Ondo Soup House',
      'Two Fires Taqueria',
      'Brine & Bun',
    ]);
    const km = near.map((v) => v.travel.km);
    expect(km).toEqual([...km].sort((a, b) => a - b));
  });

  it('weekend = further than 20 minutes, no coffee', () => {
    const weekend = spotsForMode(views, 'weekend');
    expect(weekend.every((v) => v.travel.minutes > 20 && v.spot.kind !== 'coffee')).toBe(true);
    expect(names(weekend)[0]).toBe('Harbor Night Market');
  });

  it('coffee = coffee and bakeries within 30 minutes', () => {
    expect(names(spotsForMode(views, 'coffee'))).toEqual([
      'Little Ember Coffee',
      'Slow Wave Roasters', // 18 min walk, 1.1 km
      'Fig & Fern', // 8 min drive, 1.4 km
    ]);
  });

  it('breaks distance ties by name', () => {
    const twin = views.map((v) => ({ ...v, travel: { ...v.travel, km: 1 } }));
    const sorted = [...twin].sort(byDistance);
    expect(names(sorted)).toEqual(
      names(sorted)
        .slice()
        .sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe('chipsFor', () => {
  it('puts what-it-is tags before modifiers, in data order', () => {
    const near = views.filter((v) => spotsForMode(views, 'near').includes(v)).map((v) => v.spot);
    expect(chipsFor(near)).toEqual([
      'all',
      'noodles',
      'dumplings',
      'soup',
      'tacos',
      'sandwiches',
      'spicy',
      'cheap',
    ]);
  });

  it('is just "all" for nothing', () => {
    expect(chipsFor([])).toEqual(['all']);
  });
});

describe('listSpots', () => {
  it('filters by chip', () => {
    const r = listSpots(views, { mode: 'near', tag: 'spicy', q: '' });
    expect(r.tag).toBe('spicy');
    expect(names(r.items)).toEqual(['Lucky Thread Noodle Bar', 'Ondo Soup House']);
  });

  it('falls back to "all" for a chip that is not in this mode', () => {
    const r = listSpots(views, { mode: 'coffee', tag: 'bbq', q: '' });
    expect(r.tag).toBe('all');
    expect(r.items).toHaveLength(3);
  });

  it('searches across every mode and ignores chips', () => {
    const r = listSpots(views, { mode: 'coffee', tag: 'espresso', q: 'brisket' });
    expect(r.searching).toBe(true);
    expect(r.chips).toEqual([]);
    expect(names(r.items)).toEqual(['Hilltop Smokehouse']);
  });
});

describe('matchesQuery', () => {
  const lucky = spots.find((s) => s.id === 'lucky-thread')!;
  it.each(['noodle', 'CUMIN', 'cucumber', 'spicy noodles', 'chili oil', '  '])(
    'matches %j',
    (q) => {
      expect(matchesQuery(lucky, q)).toBe(true);
    },
  );
  it('needs every word', () => {
    expect(matchesQuery(lucky, 'noodles tacos')).toBe(false);
  });
  it.each(['mama kos', "Mama Ko's", 'mama ko’s', 'KO`S', 'dumpling-window', 'brine & bun'])(
    'folds apostrophes and punctuation: %j',
    (q) => {
      const hit = spots.filter((s) => matchesQuery(s, q)).map((s) => s.id);
      expect(hit.length).toBe(1);
    },
  );
  it('normalises the way it says', () => {
    expect(normalizeSearch('  Mama Ko’s — Dumpling Window!  ')).toBe('mama kos dumpling window');
    expect(normalizeSearch('Gruyère & Ham')).toBe('gruyere ham');
  });
  it('ignores accents', () => {
    const butter = spots.find((s) => s.id === 'butter-ladder')!;
    expect(matchesQuery(butter, 'gruyere')).toBe(true);
  });
});
