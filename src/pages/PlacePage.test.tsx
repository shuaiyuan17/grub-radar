import { act, screen, within } from '@testing-library/react';
import type { SharedPlaceResponse, SharedTake } from '../contracts/shared';
import { MemorySpotRepository } from '../data/memoryRepository';
import { SEED_SPOTS } from '../data/seed';
import { fakeFriendsClient, renderAt } from '../test/render';

describe('place page', () => {
  it('shows the spot, its order list and a take-me-there link', async () => {
    renderAt('/place/lucky-thread');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Lucky Thread Noodle Bar',
    );
    expect(screen.getByText('· loved it')).toBeInTheDocument();
    expect(screen.getByText('0.3 mi')).toBeInTheDocument();
    expect(screen.getByText('near home')).toBeInTheDocument();
    const order = screen.getByRole('region', { name: 'order this' });
    expect(within(order).getAllByRole('listitem')).toHaveLength(3);
    expect(within(order).getByText('next time')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: "why it's on the list" })).toHaveTextContent(
      'found by your agent · sep 12, 2026',
    );
    expect(screen.getByRole('link', { name: /Take me to Lucky Thread/ })).toHaveAttribute(
      'href',
      'https://maps.apple.com/?daddr=47.6135,-122.3302&q=Lucky%20Thread%20Noodle%20Bar&dirflg=w',
    );
  });

  it('drives to far places and calls them a road trip', async () => {
    renderAt('/place/saltmarsh-crab');
    expect(await screen.findByText('1h 10')).toBeInTheDocument();
    expect(screen.getByText('road trip')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /driving directions/ })).toHaveAttribute(
      'href',
      expect.stringContaining('dirflg=d'),
    );
  });

  it('goes back to the list it came from', async () => {
    const { user, router } = renderAt('/?mode=coffee');
    await user.click(await screen.findByRole('link', { name: 'Fig & Fern' }));
    expect(router.state.location.pathname).toBe('/place/fig-and-fern');
    await user.click(screen.getByRole('link', { name: 'Back to the list' }));
    expect(router.state.location.search).toBe('?mode=coffee');
  });

  it('handles an unknown spot', async () => {
    renderAt('/place/nope');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      "that spot's not here",
    );
  });
});

describe('a shared place (not on your list)', () => {
  const PLACE = {
    id: 'p-shared-1',
    name: 'Ondo Dumpling House',
    address: '9 Fictional Ave',
    location: { lat: 47.62, lng: -122.33 },
  };
  const take = (id: string, name: string, extra: Partial<SharedTake> = {}): SharedTake => ({
    friend: { id, displayName: name, avatarEmoji: '🦊' },
    status: 'been',
    verdict: 'good',
    note: `${name} says the soup ones`,
    kind: 'food',
    photos: [],
    ...extra,
  });

  async function setup(
    data: SharedPlaceResponse | null,
    path = `/place/${PLACE.id}`,
    state?: unknown,
  ) {
    const friends = fakeFriendsClient();
    friends.sharedPlace.mockResolvedValue(data);
    const repository = new MemorySpotRepository(SEED_SPOTS, { places: [PLACE] });
    // with navigation state: start on the list, then go there the way a link would
    const r = renderAt(state === undefined ? path : '/', { friends, repository });
    if (state !== undefined) await act(() => r.router.navigate(path, { state }));
    return { ...r, friends };
  }

  it("shows the place and friends' takes instead of not-found", async () => {
    const { friends } = await setup({ place: PLACE, friendsTakes: [take('u_ana', 'Ana')] });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Ondo Dumpling House',
    );
    expect(friends.sharedPlace).toHaveBeenCalledWith(PLACE.id);
    expect(screen.getByText('9 Fictional Ave')).toBeInTheDocument();
    expect(screen.getByText('shared with you')).toBeInTheDocument();
    const takes = screen.getByRole('region', { name: 'friends’ verdicts' });
    expect(within(takes).getByText('Ana')).toBeInTheDocument();
    expect(within(takes).getByText('loved it')).toBeInTheDocument();
    expect(within(takes).getByText('“Ana says the soup ones”')).toBeInTheDocument();
    // a small map, said in words too
    expect(screen.getByRole('figure')).toHaveTextContent(/where it is\s+about \d+ min/);
    expect(
      screen.getByRole('button', { name: /Add Ondo Dumpling House to your radar/ }),
    ).toBeEnabled();
  });

  it('a non-friend: the place only, and a nudge', async () => {
    await setup({ place: PLACE, friendsTakes: [] });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Ondo');
    expect(screen.queryByRole('region', { name: 'friends’ verdicts' })).toBeNull();
    expect(screen.getByText(/none of your friends have a take/)).toBeInTheDocument();
  });

  it('no such place: the usual not-found', async () => {
    await setup(null);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      "that spot's not here",
    );
  });

  it('add to my radar: on your list as want, then your own page', async () => {
    const { user, repository } = await setup({
      place: PLACE,
      friendsTakes: [take('u_ana', 'Ana', { kind: 'bakery' })],
    });
    await user.click(
      await screen.findByRole('button', { name: /Add Ondo Dumpling House to your radar/ }),
    );
    expect(await screen.findByText('on your radar. been already? mark it below.')).toBeVisible();
    // your own page now: the status editor is there, the shared badge isn't
    expect(screen.queryByText('shared with you')).toBeNull();
    expect(screen.getByRole('button', { name: 'mark as been' })).toBeInTheDocument();
    const mine = await repository.get(PLACE.id);
    expect(mine).toMatchObject({ status: 'want', kind: 'bakery', name: 'Ondo Dumpling House' });
  });

  it('coming from a friend’s list: their take first, back goes to their list', async () => {
    const { router } = await setup(
      {
        place: PLACE,
        friendsTakes: [
          take('u_ana', 'Ana'),
          take('u_ben', 'Ben', { status: 'want', verdict: undefined }),
        ],
      },
      `/place/${PLACE.id}`,
      { back: '/friends/u_ben', friend: 'u_ben' },
    );
    const takes = await screen.findByRole('region', { name: 'friends’ verdicts' });
    const names = within(takes)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(names[0]).toContain('Ben');
    expect(names[1]).toContain('Ana');
    expect(await screen.findByRole('link', { name: 'back' })).toHaveAttribute(
      'href',
      '/friends/u_ben',
    );
    expect(router.state.location.state).toMatchObject({ friend: 'u_ben' });
  });

  it('your own spot never asks the shared endpoint, and has a share button', async () => {
    const { friends } = await setup(null, '/place/lucky-thread');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Lucky Thread');
    expect(friends.sharedPlace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Share Lucky Thread Noodle Bar/ })).toBeVisible();
  });

  it('share: the share sheet when there is one, else the link copied', async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    const { user } = await setup(null, '/place/lucky-thread');
    await user.click(await screen.findByRole('button', { name: /Share Lucky Thread/ }));
    expect(share).toHaveBeenCalledWith({
      title: 'grub radar',
      text: 'Lucky Thread Noodle Bar, on grub radar',
      url: `${window.location.origin}/place/lucky-thread`,
    });
    expect(await screen.findByText('sent.')).toBeVisible();
    Reflect.deleteProperty(navigator, 'share');

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(screen.getByRole('button', { name: /Share Lucky Thread/ }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/place/lucky-thread`);
    expect(await screen.findByText(/link copied/)).toBeVisible();
  });
});
