import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { HOME_KEY } from '../lib/home';
import { useOrigin, type OriginValue } from '../lib/origin';
import { fakeHomeClient } from '../test/render';
import { OriginProvider } from './OriginProvider';

function Grab({ onValue }: { onValue: (v: OriginValue) => void }) {
  const value = useOrigin();
  useEffect(() => {
    onValue(value);
  });
  return null;
}

describe('OriginProvider: home lives in your account', () => {
  afterEach(() => {
    localStorage.clear();
  });

  function setup(opts: { initialHome?: { lat: number; lng: number } | null; fail?: boolean } = {}) {
    const ref: { current: OriginValue | null } = { current: null };
    const client = fakeHomeClient({ fail: opts.fail });
    const onSaved = vi.fn();
    render(
      <OriginProvider initialHome={opts.initialHome ?? null} client={client} onSaved={onSaved}>
        <Grab
          onValue={(v) => {
            ref.current = v;
          }}
        />
      </OriginProvider>,
    );
    return { ref, client, onSaved };
  }

  it('starts from the account home', () => {
    const { ref } = setup({ initialHome: { lat: 1, lng: 2 } });
    expect(ref.current!.home).toEqual({ lat: 1, lng: 2 });
    expect(ref.current!.homeIsDemo).toBe(false);
  });

  it('setHome uses it at once and saves it to the account', async () => {
    const { ref, client, onSaved } = setup();
    let ok = false;
    await act(async () => {
      ok = ref.current!.setHome({ lat: 1, lng: 2 });
      await Promise.resolve();
    });
    expect(ok).toBe(true);
    expect(client.save).toHaveBeenCalledWith({ lat: 1, lng: 2 });
    expect(onSaved).toHaveBeenCalledWith({ lat: 1, lng: 2 });
    expect(ref.current!.notice).toBe('homeSaved');
    expect(localStorage.getItem(HOME_KEY)).toBeNull(); // never on the device any more
  });

  it('a failed save keeps the home for this visit and says so', async () => {
    const { ref, onSaved } = setup({ fail: true });
    await act(async () => {
      ref.current!.setHome({ lat: 1, lng: 2 });
      await Promise.resolve();
    });
    expect(ref.current!.home).toEqual({ lat: 1, lng: 2 });
    expect(ref.current!.notice).toBe('homeSyncFailed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('refuses an invalid home and changes nothing', () => {
    const { ref, client } = setup();
    let ok = true;
    act(() => {
      ok = ref.current!.setHome({ lat: 100, lng: 0 });
    });
    expect(ok).toBe(false);
    expect(ref.current!.homeIsDemo).toBe(true);
    expect(client.save).not.toHaveBeenCalled();
  });

  it('moves a v0 device home to the account once, then removes it from the device', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const { ref, client, onSaved } = setup();
    expect(ref.current!.home).toEqual({ lat: 3, lng: 4 }); // used right away
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledExactlyOnceWith({ lat: 3, lng: 4 });
    expect(onSaved).toHaveBeenCalledWith({ lat: 3, lng: 4 });
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
    expect(ref.current!.notice).toBe('homeMoved');
  });

  it('keeps the device copy if the move fails (tries again next visit)', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const { ref } = setup({ fail: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(localStorage.getItem(HOME_KEY)).not.toBeNull();
    expect(ref.current!.home).toEqual({ lat: 3, lng: 4 });
    expect(ref.current!.notice).toBeNull();
  });

  it('the account home wins over a device copy: nothing is moved', () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const { ref, client } = setup({ initialHome: { lat: 1, lng: 2 } });
    expect(ref.current!.home).toEqual({ lat: 1, lng: 2 });
    expect(client.save).not.toHaveBeenCalled();
  });
});
