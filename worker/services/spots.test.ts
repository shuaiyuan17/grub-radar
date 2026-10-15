import { describe, expect, it } from 'vitest';
import type { ApplePlace } from '../../src/contracts/places';
import { confidentMatch, nameMatches } from './spots';

const place = (name: string): ApplePlace => ({
  applePlaceId: `I${name.length}`,
  name,
  location: { lat: 47.6, lng: -122.3 },
});

describe('nameMatches: whole words, every word', () => {
  it.each([
    ['bar', 'The Bar', true],
    ['bar', 'Barista Cafe', false],
    ['the bar', 'The Bar', true],
    ['serious pie', 'Serious Pie', true],
    ['Serious  PIE!', 'Serious Pie', true],
    ['pie serious', 'Serious Pie', true],
    ['serious pizza', 'Serious Pie', false],
    ['pho bac', 'Phở Bắc', true],
    ['mama kos', 'Mama Ko’s', true],
    ['owl', 'Night Owl Pho', true],
    ['ow', 'Night Owl Pho', false],
  ])('%j in %j: %s', (query, name, expected) => {
    expect(nameMatches(query, name)).toBe(expected);
  });

  it('CJK (no spaces between words): the whole query, anywhere in the name', () => {
    expect(nameMatches('拉面', '一乐拉面馆')).toBe(true);
    expect(nameMatches('拉 面', '一乐拉面馆')).toBe(true);
    expect(nameMatches('拉面', '一乐面馆')).toBe(false);
    expect(nameMatches('面拉', '一乐拉面馆')).toBe(false);
    expect(nameMatches('', 'anything')).toBe(false);
  });
});

describe('confidentMatch', () => {
  it('"bar" with "Barista Cafe" first is not a choice to make: null', () => {
    expect(confidentMatch('bar', [place('Barista Cafe'), place('The Bar')])).toBeNull();
  });

  it('the top result named by the words is', () => {
    const bar = place('The Bar');
    expect(confidentMatch('bar', [bar, place('Barista Cafe')])).toBe(bar);
  });

  it('a single result is, whatever its name', () => {
    const only = place('Barista Cafe');
    expect(confidentMatch('bar', [only])).toBe(only);
    expect(confidentMatch('bar', [])).toBeNull();
  });

  it('zh: the query inside the top name', () => {
    const ramen = place('一乐拉面馆');
    expect(confidentMatch('拉面', [ramen, place('兰州拉面')])).toBe(ramen);
    expect(confidentMatch('牛肉面', [ramen, place('兰州拉面')])).toBeNull();
  });
});
