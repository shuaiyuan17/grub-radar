import { act, screen, within } from '@testing-library/react';
import { fakeGeolocation, renderAt } from '../test/render';

const cardNames = () =>
  screen
    .getAllByRole('article')
    .map((a) => within(a).getByRole('heading', { level: 3 }).textContent);

describe('list page', () => {
  it('shows food near home, closest first', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'what are we eating tonight?',
    );
    expect(cardNames()).toEqual([
      'Lucky Thread Noodle Bar',
      'Ondo Soup House',
      'Two Fires Taqueria',
      'Brine & Bun',
      "Mama Ko's Dumpling Window",
    ]);
    expect(screen.getByText('5 spots · closest first')).toBeInTheDocument();
  });

  it('labels walk vs drive and links to Apple Maps', async () => {
    renderAt('/');
    const card = (await screen.findAllByRole('article'))[0]!;
    expect(within(card).getByText('8 min')).toBeInTheDocument();
    expect(within(card).getByText('walk')).toBeInTheDocument();
    const go = within(card).getByRole('link', { name: /Take me to Lucky Thread.*walking/ });
    expect(go).toHaveAttribute('href', expect.stringContaining('dirflg=w'));
    expect(go).toHaveAttribute('target', '_blank');
  });

  it('switches mode and updates headline, chips and URL', async () => {
    const { user, router } = renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'weekend' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      "it's the weekend. go further.",
    );
    expect(screen.getByRole('button', { name: 'weekend' })).toHaveAttribute('aria-pressed', 'true');
    expect(router.state.location.search).toBe('?mode=weekend');
    expect(screen.getByText(/by drive time/)).toBeInTheDocument();
    expect(cardNames()[0]).toBe('Harbor Night Market');
  });

  it('filters by a craving chip', async () => {
    const { user } = renderAt('/');
    const chips = await screen.findByRole('group', { name: 'Craving' });
    await user.click(within(chips).getByRole('button', { name: 'spicy' }));
    expect(cardNames()).toEqual(['Lucky Thread Noodle Bar', 'Ondo Soup House']);
    expect(within(chips).getByRole('button', { name: 'spicy' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('rolls the dice within the current filter', async () => {
    const { user } = renderAt('/?tag=tacos');
    const [dice] = await screen.findAllByRole('button', { name: /can't decide/ });
    await user.click(dice!);
    const says = screen.getAllByText('the dice says…')[0]!.parentElement!;
    expect(within(says).getByRole('link', { name: 'Two Fires Taqueria' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear the roll' })[0]!);
    expect(screen.queryByText('the dice says…')).not.toBeInTheDocument();
  });

  it('searches every spot from the URL', async () => {
    renderAt('/?q=brisket');
    expect(await screen.findByText('1 match · closest first')).toBeInTheDocument();
    expect(cardNames()).toEqual(['Hilltop Smokehouse']);
  });

  it('says so when nothing matches', async () => {
    renderAt('/?q=zzzz');
    expect(await screen.findByText('nothing matches “zzzz”.')).toBeInTheDocument();
  });

  it('measures from where i am when location is allowed', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/');
    const from = (await screen.findAllByRole('group', { name: 'Measure distances from' }))[0]!;
    await user.click(within(from).getByRole('button', { name: 'where i am' }));
    expect(geo.getCurrentPosition).toHaveBeenCalledOnce();
    expect(within(from).getByRole('button', { name: 'finding you…' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    // standing right outside Mama Ko's
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(cardNames()[0]).toBe("Mama Ko's Dumpling Window");
    expect(within(from).getByRole('button', { name: 'where i am' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('falls back to home with a note when location is denied', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'Use my current location' }));
    act(() => {
      geo.deny();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/location is blocked/);
    const from = screen.getAllByRole('group', { name: 'Measure distances from' })[0]!;
    expect(within(from).getByRole('button', { name: 'home' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(cardNames()[0]).toBe('Lucky Thread Noodle Bar');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('falls back when location times out', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'Use my current location' }));
    act(() => {
      geo.timeout();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/couldn't find you/);
  });
});
