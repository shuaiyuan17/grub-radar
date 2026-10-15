import { act, screen, within } from '@testing-library/react';
import { HOME_KEY } from '../lib/home';
import { fakeGeolocation, renderAt } from '../test/render';

describe('home on this device', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts from the demo home, with a gentle hint', async () => {
    renderAt('/');
    expect(await screen.findByText(/from a demo home in downtown seattle/)).toBeInTheDocument();
  });

  it('saves a typed lat, lng and measures from it', async () => {
    const { user } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    const panel = screen.getByRole('region', { name: "where's home?" });
    // right outside Two Fires Taqueria
    await user.type(within(panel).getByLabelText('or type it as lat, lng'), '47.6159, -122.3106');
    await user.click(within(panel).getByRole('button', { name: 'save' }));
    expect(screen.queryByRole('region', { name: "where's home?" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(HOME_KEY)!)).toEqual({ lat: 47.6159, lng: -122.3106 });
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Two Fires Taqueria');
    expect(within(screen.getAllByRole('article')[0]!).getByText('1 min')).toBeInTheDocument();
    expect(screen.queryByText(/from a demo home/)).not.toBeInTheDocument();
  });

  it('rejects input that is not lat, lng', async () => {
    const { user } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    const panel = screen.getByRole('region', { name: "where's home?" });
    const input = within(panel).getByLabelText('or type it as lat, lng');
    await user.type(input, '47.61,');
    await user.click(within(panel).getByRole('button', { name: 'save' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(/doesn't look like lat, lng/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
  });

  it('can set home from where you are, and forget it again', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    await user.click(screen.getByRole('button', { name: 'use where i am now' }));
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(screen.getByRole('status')).toHaveTextContent('home saved on this device.');
    expect(screen.getAllByRole('article')[0]).toHaveTextContent("Mama Ko's Dumpling Window");

    await user.click(screen.getAllByRole('button', { name: 'Change your home location' })[0]!);
    await user.click(screen.getByRole('button', { name: /forget my home/ }));
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Lucky Thread Noodle Bar');
  });

  it('loads a saved home on start', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 47.6062, lng: -122.3245 }));
    renderAt('/');
    expect((await screen.findAllByRole('article'))[0]).toHaveTextContent(
      "Mama Ko's Dumpling Window",
    );
  });
});

describe('home: races and storage failures', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a late "use where i am now" answer does not overwrite a typed home', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    await user.click(screen.getByRole('button', { name: 'use where i am now' }));
    expect(geo.getCurrentPosition).toHaveBeenCalledOnce();

    // while that's pending, type a different home (outside Two Fires) and save
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    const panel = screen.getByRole('region', { name: "where's home?" });
    await user.type(within(panel).getByLabelText('or type it as lat, lng'), '47.6159, -122.3106');
    await user.click(within(panel).getByRole('button', { name: 'save' }));

    // now the stale geolocation answer arrives (outside Mama Ko's)
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(JSON.parse(localStorage.getItem(HOME_KEY)!)).toEqual({ lat: 47.6159, lng: -122.3106 });
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Two Fires Taqueria');
  });

  it('a late answer after "forget my home" does not bring it back', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 47.6159, lng: -122.3106 }));
    const geo = fakeGeolocation();
    const { user } = renderAt('/');
    await user.click(
      (await screen.findAllByRole('button', { name: 'Change your home location' }))[0]!,
    );
    await user.click(screen.getByRole('button', { name: 'use where i am now' }));
    await user.click(screen.getByRole('button', { name: /forget my home/ }));
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
  });

  it('says "for this visit only" when the browser will not store it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const { user } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    const panel = screen.getByRole('region', { name: "where's home?" });
    await user.type(within(panel).getByLabelText('or type it as lat, lng'), '47.6159, -122.3106');
    await user.click(within(panel).getByRole('button', { name: 'save' }));
    expect(screen.getByRole('status')).toHaveTextContent('saved for this visit only');
    expect(screen.getByRole('status')).not.toHaveTextContent('saved on this device');
    // still used for this visit
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Two Fires Taqueria');
  });
});
