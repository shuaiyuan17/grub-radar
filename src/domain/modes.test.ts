import { StaticSpotRepository } from '../data/staticRepository';
import { chipsFor, listSpots, matchesQuery, spotsForMode } from './modes';
import type { Spot } from './spot';
import { toSpotViews } from './spotView';

const origin = { lat: 47.6101, lng: -122.3344 };
const spots = await new StaticSpotRepository().list();
const views = toSpotViews(spots, origin);
const names = (vs: { spot: Spot }[]) => vs.map((v) => v.spot.name);

describe('modes', () => {
  it('near me = food within 20 minutes, closest first', () => {
    const near = spotsForMode(views, 'near');
    expect(names(near)).toEqual([
      'Lucky Thread Noodle Bar',
      'Ondo Soup House',
      'Two Fires Taqueria',
      'Brine & Bun',
      "Mama Ko's Dumpling Window",
    ]);
  });

  it('weekend = further than 20 minutes, no coffee', () => {
    const weekend = spotsForMode(views, 'weekend');
    expect(weekend.every((v) => v.travel.minutes > 20 && v.spot.kind !== 'coffee')).toBe(true);
    expect(names(weekend)[0]).toBe('Harbor Night Market');
  });

  it('coffee = coffee and bakeries within 30 minutes', () => {
    expect(names(spotsForMode(views, 'coffee'))).toEqual([
      'Little Ember Coffee',
      'Fig & Fern',
      'Slow Wave Roasters',
    ]);
  });

  it('breaks travel-time ties by name', () => {
    const near = spotsForMode(views, 'near');
    const [a, b] = near; // both 8 min
    expect(a?.travel.minutes).toBe(b?.travel.minutes);
    expect(a!.spot.name.localeCompare(b!.spot.name)).toBeLessThan(0);
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
  it('ignores accents', () => {
    const butter = spots.find((s) => s.id === 'butter-ladder')!;
    expect(matchesQuery(butter, 'gruyere')).toBe(true);
  });
});
