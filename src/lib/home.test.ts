import { clearHome, HOME_KEY, loadHome, saveHome } from './home';

describe('home storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a valid home', () => {
    expect(saveHome({ lat: 40.7, lng: -74 })).toBe(true);
    expect(loadHome()).toEqual({ lat: 40.7, lng: -74 });
    clearHome();
    expect(loadHome()).toBeNull();
  });

  it.each(['not json', '{"lat":1}', '{"lat":"1","lng":2}', '{"lat":95,"lng":0}', 'null'])(
    'ignores bad stored values: %j',
    (raw) => {
      localStorage.setItem(HOME_KEY, raw);
      expect(loadHome()).toBeNull();
    },
  );

  it('refuses to save an invalid home', () => {
    expect(saveHome({ lat: Number.NaN, lng: 0 })).toBe(false);
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
  });

  it('copes without storage', () => {
    expect(loadHome(null)).toBeNull();
    expect(saveHome({ lat: 1, lng: 2 }, null)).toBe(false);
  });
});
