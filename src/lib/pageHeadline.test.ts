import { getPageHeadline, resetPageHeadline } from './pageHeadline';

describe('getPageHeadline', () => {
  beforeEach(() => {
    resetPageHeadline();
  });

  it('picks once per page load, then sticks', () => {
    const first = getPageHeadline(
      () => new Date(2026, 9, 12, 12),
      () => 0,
    );
    const again = getPageHeadline(
      () => new Date(2026, 9, 12, 19),
      () => 0.9,
    );
    expect(again).toBe(first);
    expect(first.slot).toBe('lunch');
  });

  it('picks again after a reset', () => {
    const a = getPageHeadline(
      () => new Date(2026, 9, 12, 12),
      () => 0,
    );
    resetPageHeadline();
    const b = getPageHeadline(
      () => new Date(2026, 9, 12, 19),
      () => 0,
    );
    expect(b).not.toBe(a);
    expect(b.slot).toBe('dinner');
  });
});
