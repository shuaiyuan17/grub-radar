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

  it('asks before moving a v0 device home to the account; yes saves it and clears the device', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const { ref, client, onSaved } = setup();
    expect(ref.current!.home).toEqual({ lat: 3, lng: 4 }); // used right away
    expect(ref.current!.homeConsent).toEqual({ lat: 3, lng: 4 });
    expect(client.save).not.toHaveBeenCalled(); // nothing leaves the device without a yes
    await act(async () => {
      ref.current!.acceptHomeConsent();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledExactlyOnceWith({ lat: 3, lng: 4 });
    expect(onSaved).toHaveBeenCalledWith({ lat: 3, lng: 4 });
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
    expect(ref.current!.homeConsent).toBeNull();
    expect(ref.current!.notice).toBe('homeMoved');
  });

  it('no keeps it on this device only, and does not ask again', () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const first = setup();
    act(() => {
      first.ref.current!.declineHomeConsent();
    });
    expect(first.client.save).not.toHaveBeenCalled();
    expect(first.ref.current!.home).toEqual({ lat: 3, lng: 4 });
    expect(localStorage.getItem(HOME_KEY)).not.toBeNull();
    const second = setup();
    expect(second.ref.current!.home).toEqual({ lat: 3, lng: 4 });
    expect(second.ref.current!.homeConsent).toBeNull();
  });

  it('a failed save keeps the device copy and the home', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const { ref } = setup({ fail: true });
    await act(async () => {
      ref.current!.acceptHomeConsent();
      await Promise.resolve();
    });
    expect(localStorage.getItem(HOME_KEY)).not.toBeNull();
    expect(ref.current!.home).toEqual({ lat: 3, lng: 4 });
    expect(ref.current!.notice).toBe('homeSyncFailed');
  });

  it('picking a new home answers the question (the old device home is not saved over it)', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const { ref, client } = setup();
    await act(async () => {
      ref.current!.setHome({ lat: 5, lng: 6 });
      await Promise.resolve();
    });
    expect(ref.current!.homeConsent).toBeNull();
    expect(client.save).toHaveBeenCalledExactlyOnceWith({ lat: 5, lng: 6 });
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
  });

  it('second device: the account already has a home, so the stale device copy is cleared', () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    localStorage.setItem('grub-radar:home-device-only', '1');
    const { ref, client } = setup({ initialHome: { lat: 1, lng: 2 } });
    expect(ref.current!.home).toEqual({ lat: 1, lng: 2 });
    expect(ref.current!.homeConsent).toBeNull();
    expect(client.save).not.toHaveBeenCalled();
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
    expect(localStorage.getItem('grub-radar:home-device-only')).toBeNull();
  });

  it('home writes go one at a time and the server ends on the latest choice', async () => {
    const order: string[] = [];
    let release: (() => void)[] = [];
    const client = {
      save: vi.fn((h: { lat: number }) => {
        order.push(`start ${String(h.lat)}`);
        return new Promise<void>((r) => {
          release.push(() => {
            order.push(`done ${String(h.lat)}`);
            r();
          });
        });
      }),
      clear: vi.fn(() => Promise.resolve()),
    };
    const ref: { current: OriginValue | null } = { current: null };
    const onSaved = vi.fn();
    render(
      <OriginProvider initialHome={null} client={client} onSaved={onSaved}>
        <Grab onValue={(v) => (ref.current = v)} />
      </OriginProvider>,
    );
    act(() => {
      ref.current!.setHome({ lat: 1, lng: 0 });
      ref.current!.setHome({ lat: 2, lng: 0 });
      ref.current!.setHome({ lat: 3, lng: 0 });
    });
    // only the first is in flight; 2 is skipped (superseded), 3 goes next
    expect(order).toEqual(['start 1']);
    await act(async () => {
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(order).toEqual(['start 1', 'done 1', 'start 3']);
    expect(ref.current!.notice).toBeNull(); // 1's outcome isn't announced: it was superseded
    await act(async () => {
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(order).toEqual(['start 1', 'done 1', 'start 3', 'done 3']);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ lat: 3, lng: 0 });
    expect(ref.current!.notice).toBe('homeSaved');
    expect(ref.current!.home).toEqual({ lat: 3, lng: 0 });
    release = [];
  });

  it('the account home wins over a device copy: nothing is moved', () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 3, lng: 4 }));
    const { ref, client } = setup({ initialHome: { lat: 1, lng: 2 } });
    expect(ref.current!.home).toEqual({ lat: 1, lng: 2 });
    expect(client.save).not.toHaveBeenCalled();
  });
});
