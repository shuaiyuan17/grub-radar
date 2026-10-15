import { HEADLINE_COPY } from '../copy/headlines';
import {
  defaultModeFor,
  parseHeadline,
  pickHeadline,
  seededRandom,
  slotFor,
  type Slot,
} from './headlines';

// Oct 2026: 12 = Monday ... 17 = Saturday, 18 = Sunday. Local time.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const MON = 12;
const SAT = 17;
const SUN = 18;

describe('slotFor (weekdays)', () => {
  it.each<[number, number, Slot]>([
    [4, 59, 'lateNight'],
    [5, 0, 'breakfast'],
    [10, 59, 'breakfast'],
    [11, 0, 'lunch'],
    [13, 59, 'lunch'],
    [14, 0, 'afternoon'],
    [16, 59, 'afternoon'],
    [17, 0, 'dinner'],
    [20, 59, 'dinner'],
    [21, 0, 'lateNight'],
    [0, 0, 'lateNight'],
    [2, 30, 'lateNight'],
  ])('%i:%i is %s', (h, m, slot) => {
    expect(slotFor(at(MON, h, m))).toBe(slot);
  });
});

describe('slotFor (weekends)', () => {
  it.each<[number, number, number, Slot]>([
    [SAT, 8, 59, 'breakfast'],
    [SAT, 9, 0, 'weekendDay'],
    [SAT, 12, 0, 'weekendDay'],
    [SAT, 16, 59, 'weekendDay'],
    [SAT, 17, 0, 'dinner'],
    [SUN, 9, 0, 'weekendDay'],
    [SUN, 22, 0, 'lateNight'],
  ])('day %i %i:%i is %s', (day, h, m, slot) => {
    expect(slotFor(at(day, h, m))).toBe(slot);
  });

  it('friday daytime is not the weekend', () => {
    expect(slotFor(at(16, 12))).toBe('lunch');
  });
});

describe('defaultModeFor', () => {
  it('opens weekend days in weekend mode, everything else near me', () => {
    expect(defaultModeFor('weekendDay')).toBe('weekend');
    for (const slot of ['breakfast', 'lunch', 'afternoon', 'dinner', 'lateNight'] as const) {
      expect(defaultModeFor(slot)).toBe('near');
    }
  });
});

describe('parseHeadline', () => {
  it('splits around the highlight', () => {
    expect(parseHeadline('what are we *eating* tonight?')).toEqual([
      'what are we ',
      'eating',
      ' tonight?',
    ]);
    expect(parseHeadline('*late night* bite?')).toEqual(['', 'late night', ' bite?']);
  });

  it.each(['no highlight', '*two* *highlights*', 'empty ** highlight'])('rejects %j', (line) => {
    expect(() => parseHeadline(line)).toThrow(/exactly one/);
  });
});

describe('headline copy', () => {
  it.each(Object.entries(HEADLINE_COPY))('%s has 4-6 valid lowercase variants', (_, lines) => {
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(6);
    for (const line of lines) {
      expect(() => parseHeadline(line)).not.toThrow();
      expect(line).toBe(line.toLowerCase());
    }
  });
});

describe('pickHeadline', () => {
  it('uses the slot for the date and the rng for the variant', () => {
    const h = pickHeadline(at(MON, 19), () => 0);
    expect(h).toEqual({
      slot: 'dinner',
      variant: 0,
      parts: ['what are we ', 'eating', ' tonight?'],
      defaultMode: 'near',
    });
    expect(pickHeadline(at(MON, 19), () => 0.999).variant).toBe(HEADLINE_COPY.dinner.length - 1);
    expect(pickHeadline(at(MON, 19), () => 1).variant).toBe(HEADLINE_COPY.dinner.length - 1);
  });

  it('is reproducible with a seeded rng', () => {
    const a = pickHeadline(at(MON, 12), seededRandom(42));
    const b = pickHeadline(at(MON, 12), seededRandom(42));
    expect(a).toEqual(b);
  });

  it('varies across seeds and reaches every variant', () => {
    const seen = new Set<number>();
    const rng = seededRandom(7);
    for (let i = 0; i < 200; i++) seen.add(pickHeadline(at(MON, 12), rng).variant);
    expect(seen.size).toBe(HEADLINE_COPY.lunch.length);
  });

  it('weekend daytime picks weekend copy and mode', () => {
    const h = pickHeadline(at(SAT, 11), seededRandom(1));
    expect(h.slot).toBe('weekendDay');
    expect(h.defaultMode).toBe('weekend');
    expect(HEADLINE_COPY.weekendDay).toContain(
      h.parts.join('').replace(h.parts[1], `*${h.parts[1]}*`),
    );
  });

  it('accepts custom copy', () => {
    const copy = { ...HEADLINE_COPY, dinner: ['*soup*?'] };
    expect(pickHeadline(at(MON, 19), () => 0.5, copy).parts).toEqual(['', 'soup', '?']);
  });
});

describe('seededRandom', () => {
  it('stays in [0, 1)', () => {
    const r = seededRandom(123);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
