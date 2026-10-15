import { DEMO_HOME, parseHome } from './config';

describe('parseHome', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('uses the demo origin when unset', () => {
    expect(parseHome(undefined)).toEqual(DEMO_HOME);
    expect(parseHome('')).toEqual(DEMO_HOME);
  });

  it('parses "lat,lng" with spaces', () => {
    expect(parseHome(' 40.7 , -74.0 ')).toEqual({ lat: 40.7, lng: -74 });
  });

  it.each(['nope', '47.6', '47.6,-122.3,9', '91,0', '0,181', 'a,b'])('falls back on %j', (raw) => {
    expect(parseHome(raw)).toEqual(DEMO_HOME);
  });
});
