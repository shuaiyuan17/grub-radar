import { screen, waitFor, within } from '@testing-library/react';
import { SEED_SPOTS } from '../data/seed';
import { fakeAuthClient, renderAt, TEST_ME } from '../test/render';

const assign = vi.fn();
beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('location', { assign, pathname: '/radar', search: '' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the login wall', () => {
  it('is all a signed-out visitor sees, on any URL, with no spot data', () => {
    for (const path of ['/', '/radar', '/place/lucky-thread']) {
      const { unmount, container } = renderAt(path, { auth: { status: 'signed-out' } });
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('where should we eat?');
      expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeInTheDocument();
      expect(screen.queryAllByRole('article')).toHaveLength(0);
      for (const spot of SEED_SPOTS) expect(container.textContent).not.toContain(spot.name);
      unmount();
    }
  });

  it('sends you to Apple and back to the page you asked for', async () => {
    const { user, client } = renderAt('/radar', { auth: { status: 'signed-out' } });
    await user.click(screen.getByRole('button', { name: 'Sign in with Apple' }));
    expect(client.signInUrl).toHaveBeenCalledWith('/radar');
    expect(assign).toHaveBeenCalledWith('/auth/apple/start?returnTo=%2Fradar');
  });

  it.each([
    ['cancelled', /sign-in cancelled/],
    ['closed', /invite-only/],
    ['failed', /didn’t work/],
  ])('explains ?signin=%s, and the note can be dismissed', async (result, text) => {
    const { user, router } = renderAt(`/?signin=${result}`, { auth: { status: 'signed-out' } });
    expect(screen.getByRole('status')).toHaveTextContent(text);
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(router.state.location.search).toBe('');
  });

  it('never says "already signed in" on the wall', () => {
    renderAt('/?signin=already', { auth: { status: 'signed-out' } });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('signed in, ?signin=already is a gentle, dismissible note over the app', async () => {
    const { user, router } = renderAt('/?signin=already');
    const note = screen.getByText('you’re already signed in.').closest('[role="status"]');
    expect(note).not.toBeNull();
    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
    await user.click(within(note as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('you’re already signed in.')).toBeNull();
    expect(router.state.location.search).toBe('');
  });

  it('ignores unknown ?signin values', () => {
    renderAt('/?signin=<script>', { auth: { status: 'signed-out' } });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('asks the server who you are, then shows the wall or the app', async () => {
    renderAt('/', { auth: undefined, client: fakeAuthClient(null) });
    expect(screen.getByText('checking who you are…')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Sign in with Apple' })).toBeInTheDocument();
  });

  it('signed in, the app loads', async () => {
    renderAt('/', { auth: undefined, client: fakeAuthClient(TEST_ME) });
    expect(await screen.findAllByRole('article')).not.toHaveLength(0);
  });

  it('a failing /api/me shows the wall rather than a blank page', async () => {
    const client = fakeAuthClient();
    client.me.mockRejectedValueOnce(new Error('offline'));
    renderAt('/', { auth: undefined, client });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeInTheDocument();
    });
  });
});

describe('the account menu', () => {
  it('shows who is signed in and signs out back to the wall', async () => {
    const { user, client } = renderAt('/');
    const chips = screen.getAllByRole('button', { name: 'Signed in as Tess Lau' });
    expect(chips.length).toBeGreaterThan(0);
    // desktop header chip shows the first name next to the emoji
    expect(screen.getAllByText('Tess').length).toBeGreaterThan(0);
    await user.click(chips[0]!);
    expect(chips[0]).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    expect(client.signOut).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'Sign in with Apple' })).toBeInTheDocument();
  });

  it('closes with Escape', async () => {
    const { user } = renderAt('/');
    const chip = screen.getAllByRole('button', { name: 'Signed in as Tess Lau' })[0]!;
    await user.click(chip);
    await user.keyboard('{Escape}');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'sign out' })).toBeNull();
  });
});
