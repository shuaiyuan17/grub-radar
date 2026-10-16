import { render, screen, waitFor, within } from '@testing-library/react';
import { FriendAvatars } from '../components/FriendAvatars';
import type { FriendTake, InvitePreview } from '../contracts/friends';
import { ApiRequestError } from '../lib/api';
import { ADMIN_MESSAGES } from '../i18n/adminMessages';
import { fakeFriendsClient, renderAt } from '../test/render';

const person = (n: number) => ({
  id: `u_${String(n)}`,
  displayName: `Pal ${String(n)}`,
  avatarEmoji: '🐼',
});
const take = (n: number, extra: Partial<FriendTake> = {}): FriendTake => ({
  friend: person(n),
  status: 'been',
  ...extra,
});

describe('friend avatars', () => {
  it('shows up to three faces, then +N, under one accessible name', () => {
    render(<FriendAvatars people={[1, 2, 3, 4, 5].map(person)} />);
    const stack = screen.getByRole('img', { name: /Friends who’ve been here: Pal 1, Pal 2/ });
    expect(stack).toHaveTextContent('🐼🐼🐼+2');
  });

  it('never says +1: four friends are four faces', () => {
    render(<FriendAvatars people={[1, 2, 3, 4].map(person)} />);
    expect(screen.getByRole('img')).toHaveTextContent('🐼🐼🐼🐼');
  });

  it('nothing for nobody', () => {
    const { container } = render(<FriendAvatars people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('friends on cards and the place page', () => {
  const takes = {
    'lucky-thread': [
      take(1, { verdict: 'good', note: 'the chili oil!' }),
      take(2, { verdict: 'meh' }),
      take(3, { status: 'want' }),
    ],
  };

  it("a card shows the faces of friends who've been (not those who only want to)", async () => {
    renderAt('/', { friends: fakeFriendsClient(takes) });
    const card = (await screen.findByRole('link', { name: 'Lucky Thread Noodle Bar' })).closest(
      'article',
    );
    if (!card) throw new Error('no card');
    const faces = await within(card).findByRole('img', { name: /Friends who’ve been here/ });
    expect(faces).toHaveAccessibleName('Friends who’ve been here: Pal 1, Pal 2');
  });

  it("the place page shows friends' verdicts and one-liners, and who wants to go", async () => {
    renderAt('/place/lucky-thread', { friends: fakeFriendsClient(takes) });
    const box = await screen.findByRole('region', { name: 'friends’ verdicts' });
    expect(within(box).getByText('Pal 1')).toBeInTheDocument();
    expect(within(box).getByText('loved it')).toBeInTheDocument();
    expect(within(box).getByText('“the chili oil!”')).toBeInTheDocument();
    expect(within(box).getByText('it was fine')).toBeInTheDocument();
    expect(within(box).getByRole('img', { name: /Pal 3/ })).toBeInTheDocument();
  });

  it('no friends there: no section', async () => {
    renderAt('/place/mama-kos');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'friends’ verdicts' })).toBeNull();
  });

  it('a spot can be made private ("just me") from its page', async () => {
    const { user, repository } = renderAt('/place/lucky-thread');
    const group = await screen.findByRole('group', { name: 'who sees this spot' });
    expect(within(group).getByRole('radio', { name: 'friends' })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: 'just me' }));
    await waitFor(async () => {
      expect((await repository.get('lucky-thread'))?.visibility).toBe('private');
    });
    expect(await screen.findByText('only you see this spot.')).toBeInTheDocument();
  });
});

describe('the friends page', () => {
  it('lists friends, makes an invite link and copies it, revokes a pending one', async () => {
    const friends = fakeFriendsClient();
    friends.list.mockResolvedValue({
      friends: [{ ...person(7), since: '2026-10-15T00:00:00.000Z' }],
      limit: 200,
    });
    const { user } = renderAt('/friends', { friends });
    expect(await screen.findByText('Pal 7')).toBeInTheDocument();
    expect(screen.getByText(/1 of 200/)).toBeInTheDocument();
    expect(screen.getByText('no links waiting.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'invite a friend' }));
    const link = await screen.findByRole('textbox', { name: 'your invite link' });
    expect(link).toHaveValue(`${window.location.origin}/invite#${'T'.repeat(43)}`);
    // no Web Share in jsdom: it falls back to the clipboard
    expect(await screen.findByText('copied. paste it to them.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(
      `${window.location.origin}/invite#${'T'.repeat(43)}`,
    );

    const revoke = screen.getByRole('button', { name: /Revoke the link made/ });
    await user.click(revoke);
    expect(friends.revokeInvite).toHaveBeenCalledWith('inv_1');
    expect(await screen.findByText('no links waiting.')).toBeInTheDocument();
  });

  it('unfriends after a confirm', async () => {
    const friends = fakeFriendsClient();
    friends.list.mockResolvedValue({
      friends: [{ ...person(7), since: '2026-10-15T00:00:00.000Z' }],
      limit: 200,
    });
    const { user } = renderAt('/friends', { friends });
    await user.click(await screen.findByRole('button', { name: 'unfriend' }));
    await user.click(screen.getByRole('button', { name: 'yes, unfriend' }));
    expect(friends.unfriend).toHaveBeenCalledWith('u_7');
    expect(await screen.findByText(/no friends here yet/)).toBeInTheDocument();
  });

  it('edits your name and emoji (what friends see)', async () => {
    const friends = fakeFriendsClient();
    const { user } = renderAt('/friends', { friends });
    const name = await screen.findByLabelText('your name');
    await user.clear(name);
    await user.type(name, 'Tess');
    await user.click(screen.getByRole('radio', { name: 'Use 🐸' }));
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(friends.updateProfile).toHaveBeenCalledWith({ displayName: 'Tess', avatarEmoji: '🐸' });
    expect(await screen.findByText('saved. that’s how friends see you.')).toBeInTheDocument();
  });
});

describe('an invite link', () => {
  const token = 'A'.repeat(43);
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('keeps the token across sign-in in this tab, out of the address bar, no Referer', async () => {
    // signed out on /invite#token: the wall keeps it, and asks for no Referer
    const wall = renderAt(`/invite#${token}`, { auth: { status: 'signed-out' } });
    await screen.findByText('someone sent you an invite. sign in to accept it.');
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute(
      'content',
      'no-referrer',
    );
    // Sign in with Apple's returnTo is the route alone
    await wall.user.click(screen.getByRole('button', { name: /Sign in with Apple/ }));
    expect(wall.client.signInUrl).toHaveBeenCalledWith('/invite');
    wall.unmount();
    expect(document.querySelector('meta[name="referrer"]')).toBeNull();

    // back from Apple at /invite (no fragment): the kept token is used
    const friends = fakeFriendsClient();
    friends.preview.mockResolvedValue({
      from: { displayName: 'Mo', avatarEmoji: '🦊' },
      state: 'open',
    });
    const { router } = renderAt('/invite', { friends });
    expect(await screen.findByText('Mo wants to be friends on grub radar.')).toBeInTheDocument();
    expect(friends.preview).toHaveBeenCalledWith(token);
    expect(router.state.location.hash).toBe('');
  });

  it('a fragment is taken out of the address bar once kept', async () => {
    const friends = fakeFriendsClient();
    friends.preview.mockResolvedValue({
      from: { displayName: 'Mo', avatarEmoji: '🦊' },
      state: 'open',
    });
    const { router } = renderAt(`/invite#${token}`, { friends });
    await screen.findByText('Mo wants to be friends on grub radar.');
    expect(router.state.location.pathname).toBe('/invite');
    expect(router.state.location.hash).toBe('');
    expect(sessionStorage.getItem('grub-radar:invite')).toBe(token);
  });

  it('says who sent it; accept makes you friends', async () => {
    const friends = fakeFriendsClient();
    friends.preview.mockResolvedValue({
      from: { displayName: 'Mo', avatarEmoji: '🦊' },
      state: 'open',
    });
    friends.accept.mockResolvedValue({
      friend: { id: 'u_mo', displayName: 'Mo', avatarEmoji: '🦊', since: 'x' },
      already: false,
    });
    const { user } = renderAt(`/invite#${token}`, { friends });
    expect(await screen.findByText('Mo wants to be friends on grub radar.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'accept' }));
    expect(friends.accept).toHaveBeenCalledWith(token);
    expect(await screen.findByText('you and Mo are friends now.')).toBeInTheDocument();
    expect(sessionStorage.getItem('grub-radar:invite')).toBeNull();
    // the cards' avatars are fetched again
    expect(friends.places).toHaveBeenCalledTimes(2);
  });

  it('your own link, and one that is used up', async () => {
    const friends = fakeFriendsClient();
    friends.preview.mockResolvedValue({
      from: { displayName: 'Tess', avatarEmoji: '🥟' },
      state: 'own',
    });
    renderAt(`/invite#${token}`, { friends });
    expect(await screen.findByText(/that’s your own link/)).toBeInTheDocument();

    const gone = fakeFriendsClient();
    gone.preview.mockRejectedValue(new ApiRequestError(410, 'invite_gone', 'gone'));
    renderAt(`/invite#${token}`, { friends: gone });
    expect(await screen.findByText(/has been used, revoked or has expired/)).toBeInTheDocument();
  });

  it('a late answer for a link this tab has left does not forget the newer one', async () => {
    const friends = fakeFriendsClient();
    let answer: (p: InvitePreview) => void = () => undefined;
    friends.preview.mockReturnValue(
      new Promise<InvitePreview>((resolve) => {
        answer = resolve;
      }),
    );
    const { unmount } = renderAt(`/invite#${token}`, { friends });
    await waitFor(() => {
      expect(friends.preview).toHaveBeenCalledWith(token);
    });
    unmount();
    const newer = 'n'.repeat(43);
    sessionStorage.setItem('grub-radar:invite', newer);
    answer({ from: { displayName: 'Tess', avatarEmoji: '🥟' }, state: 'own' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionStorage.getItem('grub-radar:invite')).toBe(newer);
  });

  it("a malformed link doesn't even ask the server", async () => {
    const friends = fakeFriendsClient();
    renderAt('/invite#nope', { friends });
    expect(await screen.findByText(/has been used, revoked or has expired/)).toBeInTheDocument();
    expect(friends.preview).not.toHaveBeenCalled();
  });

  it('signed out: the login wall says there is an invite waiting', async () => {
    renderAt(`/invite#${token}`, { auth: { status: 'signed-out' } });
    expect(
      await screen.findByText('someone sent you an invite. sign in to accept it.'),
    ).toBeInTheDocument();
  });
});

describe('a friend who hasn’t chosen a name yet: "a friend", never "you"', () => {
  const nameless = { id: 'u_nell', displayName: null, avatarEmoji: '🫥' };
  const token = 'q'.repeat(43);
  afterEach(() => {
    sessionStorage.clear();
  });

  it('avatars', () => {
    render(<FriendAvatars people={[nameless, person(1)]} />);
    const stack = screen.getByRole('img');
    expect(stack).toHaveAccessibleName('Friends who’ve been here: a friend, Pal 1');
    expect(stack.querySelector('[title="a friend"]')).not.toBeNull();
  });

  it('the friends list, its links and the unfriend question', async () => {
    const friends = fakeFriendsClient();
    friends.list.mockResolvedValue({
      friends: [{ ...nameless, since: '2026-10-15T00:00:00.000Z' }],
      limit: 200,
    });
    const { user } = renderAt('/friends', { friends });
    const row = (await screen.findByText('a friend')).closest('li');
    if (!row) throw new Error('no row');
    expect(within(row).getByRole('link', { name: 'See a friend’s spots' })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'unfriend' }));
    expect(within(row).getByText(/unfriend a friend\?/)).toBeInTheDocument();
    expect(within(row).queryByText('you')).toBeNull();
  });

  it("the place page's verdicts", async () => {
    renderAt('/place/lucky-thread', {
      friends: fakeFriendsClient({
        'lucky-thread': [{ friend: nameless, status: 'been', verdict: 'good' }],
      }),
    });
    const box = await screen.findByRole('region', { name: 'friends’ verdicts' });
    expect(within(box).getByText('a friend')).toBeInTheDocument();
  });

  it('their spots page', async () => {
    const friends = fakeFriendsClient();
    friends.friendSpots.mockResolvedValue({
      friend: { ...nameless, since: '2026-10-15T00:00:00.000Z' },
      spots: [],
    });
    renderAt('/friends/u_nell', { friends });
    expect(await screen.findByRole('heading', { name: /a friend’s spots/ })).toBeInTheDocument();
  });

  it('every card on their list opens the place, carrying where back goes', async () => {
    const friends = fakeFriendsClient();
    friends.friendSpots.mockResolvedValue({
      friend: { ...nameless, since: '2026-10-15T00:00:00.000Z' },
      spots: [
        {
          id: 'lucky-thread',
          name: 'Lucky Thread Noodle Bar',
          location: { lat: 47.6135, lng: -122.3302 },
          kind: 'food',
          status: 'been',
        },
        {
          id: 'p-not-mine',
          name: 'Ondo Dumpling House',
          location: { lat: 47.62, lng: -122.33 },
          kind: 'food',
          status: 'want',
        },
      ],
    });
    const { user, router } = renderAt('/friends/u_nell', { friends });
    const notMine = await screen.findByRole('link', { name: 'Ondo Dumpling House' });
    expect(notMine).toHaveAttribute('href', '/place/p-not-mine');
    expect(screen.getByRole('link', { name: 'Lucky Thread Noodle Bar' })).toHaveAttribute(
      'href',
      '/place/lucky-thread',
    );
    await user.click(notMine);
    expect(router.state.location.pathname).toBe('/place/p-not-mine');
    expect(router.state.location.state).toEqual({ back: '/friends/u_nell', friend: 'u_nell' });
  });

  it('an invite from them, and accepting it', async () => {
    const friends = fakeFriendsClient();
    friends.preview.mockResolvedValue({ from: nameless, state: 'open' });
    friends.accept.mockResolvedValue({
      friend: { ...nameless, since: 'x' },
      already: false,
    });
    const { user } = renderAt(`/invite#${token}`, { friends });
    expect(
      await screen.findByText('a friend wants to be friends on grub radar.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'accept' }));
    expect(await screen.findByText('you and a friend are friends now.')).toBeInTheDocument();
  });
});

describe('/admin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the ordinary not-found page when the API says 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { error: { code: 'not_found', message: 'no such endpoint' } },
            { status: 404 },
          ),
        ),
      ),
    );
    renderAt('/admin');
    expect(
      await screen.findByRole('heading', { name: 'nothing on the radar here.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/back office/)).toBeNull();
  });

  it('shows the numbers to an admin', async () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      day: `2026-09-${String(16 + i).padStart(2, '0')}`,
      count: i === 29 ? 2 : 0,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            totalUsers: 2,
            signupsByDay: days,
            users: [
              {
                displayName: null,
                avatarEmoji: '🫥',
                createdAt: '2026-10-15T11:50:00.000Z',
                lastSeenAt: '2026-10-15T12:00:00.000Z',
                spots: 0,
                friends: 1,
              },
              {
                displayName: 'Owner',
                avatarEmoji: '🍜',
                createdAt: '2026-10-15T11:48:33.000Z',
                lastSeenAt: '2026-10-15T12:00:00.000Z',
                spots: 4,
                friends: 1,
              },
            ],
          }),
        ),
      ),
    );
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'the back office' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    const [nameless, owner] = within(table).getAllByRole('rowheader');
    expect(owner).toHaveTextContent('Owner');
    // someone who hasn't chosen a name: a placeholder, never "you"
    expect(nameless).toHaveTextContent('(no name yet)');
    expect(screen.getByRole('img', { name: /Sign-ups per day .* 2 in all/ })).toBeInTheDocument();
  });

  it('has its own catalog with the same keys in both languages', () => {
    expect(Object.keys(ADMIN_MESSAGES['zh-Hans']).sort()).toEqual(
      Object.keys(ADMIN_MESSAGES.en).sort(),
    );
  });
});
