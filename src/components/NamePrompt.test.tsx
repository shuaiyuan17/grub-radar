import { screen, waitFor, within } from '@testing-library/react';
import type { MeResponse } from '../contracts/me';
import { ApiRequestError } from '../lib/api';
import { fakeAuthClient, fakeFriendsClient, renderAt, TEST_ME } from '../test/render';

/** An account made without Apple's name: the stand-in, not chosen. */
const UNNAMED: MeResponse = {
  ...TEST_ME,
  user: { id: 'u_new', displayName: 'you', avatarEmoji: '🍜', nameSet: false },
};
const signedIn = (me: MeResponse) => ({ status: 'signed-in' as const, me });
const dialog = () => screen.getByRole('dialog', { name: 'what should we call you?' });

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('"what should we call you?"', () => {
  it('blocks the app when the name was never chosen: an empty field, focus inside', async () => {
    renderAt('/', { auth: signedIn(UNNAMED) });
    const d = dialog();
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleDescription('your friends will see this.');
    const name = within(d).getByRole('textbox', { name: 'your name' });
    expect(name).toHaveValue('');
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    // the existing emoji picker, on the current emoji
    expect(within(d).getByRole('radio', { name: 'Use 🍜' })).toBeChecked();
    // nothing of the app behind it
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('is not there once a name is chosen', async () => {
    renderAt('/');
    expect(await screen.findAllByRole('article')).not.toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('also comes up straight after sign-in (GET /api/me says not chosen)', async () => {
    renderAt('/', { auth: undefined, client: fakeAuthClient(UNNAMED) });
    expect(
      await screen.findByRole('dialog', { name: 'what should we call you?' }),
    ).toBeInTheDocument();
  });

  it('saves name and emoji through the profile endpoint, then gets out of the way', async () => {
    const friends = fakeFriendsClient();
    friends.updateProfile.mockImplementation((patch) =>
      Promise.resolve({ ...UNNAMED.user, ...patch, nameSet: true }),
    );
    const { user } = renderAt('/', { auth: signedIn(UNNAMED), friends });
    await user.type(within(dialog()).getByRole('textbox', { name: 'your name' }), '  Nell ');
    await user.click(within(dialog()).getByRole('radio', { name: 'Use 🐸' }));
    await user.click(within(dialog()).getByRole('button', { name: 'save' }));
    // cleaned the same way the server will
    expect(friends.updateProfile).toHaveBeenCalledWith({ displayName: 'Nell', avatarEmoji: '🐸' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await screen.findAllByRole('article')).not.toHaveLength(0);
    expect(screen.getAllByRole('button', { name: /^Signed in as Nell/ }).length).toBeGreaterThan(0);
  });

  it('an empty (or invisible) name is refused here, without a request', async () => {
    const friends = fakeFriendsClient();
    const { user } = renderAt('/', { auth: signedIn(UNNAMED), friends });
    await user.click(within(dialog()).getByRole('button', { name: 'save' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('type a name first.');
    await user.type(within(dialog()).getByRole('textbox', { name: 'your name' }), '​ ');
    await user.click(within(dialog()).getByRole('button', { name: 'save' }));
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('type a name first.');
    expect(within(dialog()).getByRole('textbox', { name: 'your name' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(friends.updateProfile).not.toHaveBeenCalled();
  });

  it('a failed save says so and stays open', async () => {
    const friends = fakeFriendsClient();
    friends.updateProfile.mockRejectedValue(new ApiRequestError(400, 'bad_request', 'nope'));
    const { user } = renderAt('/', { auth: signedIn(UNNAMED), friends });
    await user.type(within(dialog()).getByRole('textbox', { name: 'your name' }), 'Nell');
    await user.click(within(dialog()).getByRole('button', { name: 'save' }));
    expect(await within(dialog()).findByRole('alert')).toBeInTheDocument();
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'save' })).toBeEnabled();
  });

  it('Esc does not dismiss it, and Tab stays inside', async () => {
    const { user } = renderAt('/', { auth: signedIn(UNNAMED) });
    const d = dialog();
    const name = within(d).getByRole('textbox', { name: 'your name' });
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    await user.keyboard('{Escape}');
    expect(dialog()).toBeInTheDocument();
    // forwards from the last stop (save) wraps to the first (the language switch)...
    within(d).getByRole('button', { name: 'save' }).focus();
    await user.tab();
    expect(d).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(within(d).getAllByRole('button')[0]);
    // ...and backwards from the first wraps to save
    await user.tab({ shift: true });
    expect(within(d).getByRole('button', { name: 'save' })).toHaveFocus();
  });

  it('speaks Chinese too', () => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
    renderAt('/', { auth: signedIn(UNNAMED) });
    const d = screen.getByRole('dialog', { name: '我们该怎么称呼你？' });
    expect(d).toHaveAccessibleDescription('你的好友会看到这个名字。');
    expect(within(d).getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('back from sign-in on an invite: the invite goes on after the name is saved', async () => {
    const token = 'k'.repeat(43);
    // what the wall kept in this tab before the trip to Apple
    sessionStorage.setItem('grub-radar:invite', token);
    const friends = fakeFriendsClient();
    friends.updateProfile.mockImplementation((patch) =>
      Promise.resolve({ ...UNNAMED.user, ...patch, nameSet: true }),
    );
    friends.preview.mockResolvedValue({
      from: { displayName: 'Mo', avatarEmoji: '🦊' },
      state: 'open',
    });
    friends.accept.mockResolvedValue({
      friend: { id: 'u_mo', displayName: 'Mo', avatarEmoji: '🦊', since: 'x' },
      already: false,
    });
    const { user, router } = renderAt('/invite', { auth: signedIn(UNNAMED), friends });
    // asked first; the invite isn't touched (nor the kept token) until then
    dialog();
    expect(friends.preview).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('grub-radar:invite')).toBe(token);

    await user.type(within(dialog()).getByRole('textbox', { name: 'your name' }), 'Nell');
    await user.click(within(dialog()).getByRole('button', { name: 'save' }));
    expect(await screen.findByText('Mo wants to be friends on grub radar.')).toBeInTheDocument();
    expect(friends.preview).toHaveBeenCalledWith(token);
    expect(router.state.location.pathname).toBe('/invite');
    await user.click(screen.getByRole('button', { name: 'accept' }));
    expect(friends.accept).toHaveBeenCalledWith(token);
    expect(await screen.findByText('you and Mo are friends now.')).toBeInTheDocument();
  });

  it('opening an invite link while already signed in but unnamed: the fragment survives', async () => {
    const token = 'f'.repeat(43);
    const friends = fakeFriendsClient();
    friends.updateProfile.mockImplementation((patch) =>
      Promise.resolve({ ...UNNAMED.user, ...patch, nameSet: true }),
    );
    friends.preview.mockResolvedValue({
      from: { displayName: 'Mo', avatarEmoji: '🦊' },
      state: 'open',
    });
    const { user } = renderAt(`/invite#${token}`, { auth: signedIn(UNNAMED), friends });
    await user.type(within(dialog()).getByRole('textbox', { name: 'your name' }), 'Nell');
    await user.click(within(dialog()).getByRole('button', { name: 'save' }));
    expect(await screen.findByText('Mo wants to be friends on grub radar.')).toBeInTheDocument();
    expect(friends.preview).toHaveBeenCalledWith(token);
  });
});
