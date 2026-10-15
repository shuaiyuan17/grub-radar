import { appleMapsUrl } from './maps';

describe('appleMapsUrl', () => {
  const to = { lat: 47.6135, lng: -122.3302 };

  it('builds a walking deep link', () => {
    expect(appleMapsUrl('Lucky Thread Noodle Bar', to, 'walk')).toBe(
      'https://maps.apple.com/?daddr=47.6135,-122.3302&q=Lucky%20Thread%20Noodle%20Bar&dirflg=w',
    );
  });

  it('builds a driving deep link and encodes awkward names', () => {
    const url = appleMapsUrl("Mama Ko's & Sons", to, 'drive');
    expect(url).toContain('dirflg=d');
    expect(new URL(url).searchParams.get('q')).toBe("Mama Ko's & Sons");
  });
});
