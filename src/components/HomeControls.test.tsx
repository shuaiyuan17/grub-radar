import { act, screen, within } from '@testing-library/react';
import { HOME_KEY } from '../lib/home';
import { fakeGeolocation, fakeHomeClient, renderAt } from '../test/render';

describe('home, saved to your account', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts from the demo home, with a gentle hint', async () => {
    renderAt('/');
    expect(await screen.findByText(/from a demo home in downtown seattle/)).toBeInTheDocument();
  });

  it('saves a typed lat, lng and measures from it', async () => {
    const { user, homeClient } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    const panel = screen.getByRole('region', { name: "where's home?" });
    // right outside Two Fires Taqueria
    await user.type(within(panel).getByLabelText('or type it as lat, lng'), '47.6159, -122.3106');
    await user.click(within(panel).getByRole('button', { name: 'save' }));
    expect(screen.queryByRole('region', { name: "where's home?" })).not.toBeInTheDocument();
    expect(homeClient.save).toHaveBeenCalledWith({ lat: 47.6159, lng: -122.3106 });
    expect(await screen.findByRole('status')).toHaveTextContent('home saved to your account');
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Two Fires Taqueria');
    expect(within(screen.getAllByRole('article')[0]!).getByText('1 min')).toBeInTheDocument();
    expect(screen.queryByText(/from a demo home/)).not.toBeInTheDocument();
  });

  it('rejects input that is not lat, lng', async () => {
    const { user, homeClient } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    const panel = screen.getByRole('region', { name: "where's home?" });
    const input = within(panel).getByLabelText('or type it as lat, lng');
    await user.type(input, '47.61,');
    await user.click(within(panel).getByRole('button', { name: 'save' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(/doesn't look like lat, lng/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(homeClient.save).not.toHaveBeenCalled();
  });

  it('can set home from where you are, and forget it again', async () => {
    const geo = fakeGeolocation();
    const { user, homeClient } = renderAt('/');
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    await user.click(screen.getByRole('button', { name: 'use where i am now' }));
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('home saved to your account.');
    expect(homeClient.save).toHaveBeenCalledWith({ lat: 47.6062, lng: -122.3245 });
    expect(screen.getAllByRole('article')[0]).toHaveTextContent("Mama Ko's Dumpling Window");

    await user.click(screen.getAllByRole('button', { name: 'Change your home location' })[0]!);
    await user.click(screen.getByRole('button', { name: /forget my home/ }));
    expect(homeClient.clear).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Lucky Thread Noodle Bar');
  });

  it('loads the account home on start', async () => {
    renderAt('/', { home: { lat: 47.6062, lng: -122.3245 } });
    expect((await screen.findAllByRole('article'))[0]).toHaveTextContent(
      "Mama Ko's Dumpling Window",
    );
  });
});

describe('home: races and failures', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a late "use where i am now" answer does not overwrite a typed home', async () => {
    const geo = fakeGeolocation();
    const { user, homeClient } = renderAt('/');
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
    expect(homeClient.save).toHaveBeenCalledExactlyOnceWith({ lat: 47.6159, lng: -122.3106 });
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Two Fires Taqueria');
  });

  it('a late answer after "forget my home" does not bring it back', async () => {
    const geo = fakeGeolocation();
    const { user, homeClient } = renderAt('/', { home: { lat: 47.6159, lng: -122.3106 } });
    await user.click(
      (await screen.findAllByRole('button', { name: 'Change your home location' }))[0]!,
    );
    await user.click(screen.getByRole('button', { name: 'use where i am now' }));
    await user.click(screen.getByRole('button', { name: /forget my home/ }));
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(homeClient.clear).toHaveBeenCalledOnce();
    expect(homeClient.save).not.toHaveBeenCalled();
    expect(screen.getByText(/from a demo home/)).toBeInTheDocument();
  });

  it('says so when the account could not be reached, and keeps the home for this visit', async () => {
    const { user } = renderAt('/', { homeClient: fakeHomeClient({ fail: true }) });
    await user.click((await screen.findAllByRole('button', { name: /set (your )?home/i }))[0]!);
    const panel = screen.getByRole('region', { name: "where's home?" });
    await user.type(within(panel).getByLabelText('or type it as lat, lng'), '47.6159, -122.3106');
    await user.click(within(panel).getByRole('button', { name: 'save' }));
    expect(await screen.findByRole('status')).toHaveTextContent("couldn't save that");
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Two Fires Taqueria');
  });

  it('moves an old device home (v0) to the account on first load', async () => {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: 47.6062, lng: -122.3245 }));
    const { homeClient } = renderAt('/');
    expect((await screen.findAllByRole('article'))[0]).toHaveTextContent("Mama Ko's");
    expect(await screen.findByRole('status')).toHaveTextContent('moved your home');
    expect(homeClient.save).toHaveBeenCalledExactlyOnceWith({ lat: 47.6062, lng: -122.3245 });
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
  });
});
