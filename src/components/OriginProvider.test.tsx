import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { useOrigin, type OriginValue } from '../lib/origin';
import { OriginProvider } from './OriginProvider';

function Grab({ onValue }: { onValue: (v: OriginValue) => void }) {
  const value = useOrigin();
  useEffect(() => {
    onValue(value);
  });
  return null;
}

describe('OriginProvider.setHome contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function setup() {
    const ref: { current: OriginValue | null } = { current: null };
    render(
      <OriginProvider>
        <Grab
          onValue={(v) => {
            ref.current = v;
          }}
        />
      </OriginProvider>,
    );
    return ref;
  }

  it('returns true when stored', () => {
    const ref = setup();
    let ok = false;
    act(() => {
      ok = ref.current!.setHome({ lat: 1, lng: 2 });
    });
    expect(ok).toBe(true);
    expect(ref.current!.notice).toBe('home saved on this device.');
  });

  it('returns false (but still uses it) when storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    const ref = setup();
    let ok = true;
    act(() => {
      ok = ref.current!.setHome({ lat: 1, lng: 2 });
    });
    expect(ok).toBe(false);
    expect(ref.current!.home).toEqual({ lat: 1, lng: 2 });
    expect(ref.current!.homeIsDemo).toBe(false);
    expect(ref.current!.notice).toMatch(/for this visit only/);
  });

  it('returns false for an invalid home and changes nothing', () => {
    const ref = setup();
    let ok = true;
    act(() => {
      ok = ref.current!.setHome({ lat: 100, lng: 0 });
    });
    expect(ok).toBe(false);
    expect(ref.current!.homeIsDemo).toBe(true);
  });
});
