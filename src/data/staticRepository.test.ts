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

  it('validates whatever it is given', () => {
    expect(() => new StaticSpotRepository([{ id: 'x' }])).toThrow(/Invalid spots data/);
  });
});
