import { StaticSpotRepository } from './staticRepository';

describe('StaticSpotRepository', () => {
  const repo = new StaticSpotRepository();

  it('lists the seed spots', async () => {
    const spots = await repo.list();
    expect(spots.map((s) => s.id)).toContain('lucky-thread');
  });

  it('gets one by id, or null', async () => {
    expect((await repo.get('ondo-soup'))?.name).toBe('Ondo Soup House');
    expect(await repo.get('nope')).toBeNull();
  });

  it('returns a copy, so callers cannot mutate the store', async () => {
    const a = await repo.list();
    a.pop();
    expect((await repo.list()).length).toBe(a.length + 1);
  });

  it('validates lazily: bad data rejects list() and throws from snapshot(), not on import', async () => {
    const bad = new StaticSpotRepository([{ id: 'x' }]);
    await expect(bad.list()).rejects.toThrow(/Invalid spots data/);
    expect(() => bad.snapshot()).toThrow(/Invalid spots data/);
  });

  it('snapshot() returns the same spots synchronously', async () => {
    expect(repo.snapshot()).toEqual(await repo.list());
  });
});
