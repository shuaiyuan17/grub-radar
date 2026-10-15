import { roll } from './roll';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('roll', () => {
  it('returns null for an empty pool', () => {
    expect(roll([], null, () => 0.5)).toBeNull();
  });

  it('picks by the random number', () => {
    expect(roll(items, null, () => 0)?.id).toBe('a');
    expect(roll(items, null, () => 0.5)?.id).toBe('b');
    expect(roll(items, null, () => 0.999)?.id).toBe('c');
  });

  it('never goes out of range even if random() returns 1', () => {
    expect(roll(items, null, () => 1)?.id).toBe('c');
  });

  it('does not repeat the previous pick when there is a choice', () => {
    expect(roll(items, 'a', () => 0)?.id).toBe('b');
    expect(roll(items, 'c', () => 0.99)?.id).toBe('a');
  });

  it('can repeat when there is only one option', () => {
    expect(roll([{ id: 'a' }], 'a', () => 0)?.id).toBe('a');
  });

  it('only ever picks from the pool it was given', () => {
    for (let i = 0; i < 200; i++) {
      expect(items).toContain(roll(items));
    }
  });
});
