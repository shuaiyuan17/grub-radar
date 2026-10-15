import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getPageHeadline, resetPageHeadline } from '../lib/pageHeadline';
import { composeStep, ENDS, ORDERS, PINYIN } from '../test/ime';
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
      "Mama Ko's Dumpling Window",
      'Ondo Soup House',
      'Two Fires Taqueria',
      'Brine & Bun',
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
    expect(screen.getByText('5 spots · closest first')).toBeInTheDocument();
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

describe('time-of-day headline', () => {
  it('opens weekend daytime in weekend mode with weekend copy', async () => {
    resetPageHeadline();
    getPageHeadline(
      'en',
      () => new Date(2026, 9, 17, 11), // Saturday 11:00
      () => 0,
    );
    const { user, router } = renderAt('/');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      "it's the weekend. go further.",
    );
    expect(screen.getByRole('button', { name: 'weekend' })).toHaveAttribute('aria-pressed', 'true');
    expect(cardNames()[0]).toBe('Harbor Night Market');
    // picking near me yourself sticks in the URL, since it's not today's default
    await user.click(screen.getByRole('button', { name: 'near me' }));
    expect(router.state.location.search).toBe('?mode=near');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'what are we eating tonight?',
    );
  });

  it('uses the slot copy, highlighting the marked words', async () => {
    resetPageHeadline();
    getPageHeadline(
      'en',
      () => new Date(2026, 9, 14, 23), // Wednesday 23:00
      () => 0,
    );
    renderAt('/');
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('late night bite?');
    expect(h1.querySelector('.hl')).toHaveTextContent('late night');
  });

  it('does not change on re-render or navigation', async () => {
    const { user } = renderAt('/');
    const h1 = await screen.findByRole('heading', { level: 1 });
    const text = h1.textContent;
    await user.click(screen.getByRole('link', { name: 'Ondo Soup House' }));
    await user.click(await screen.findByRole('link', { name: 'Back to the list' }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(text);
  });
});

describe('list URL state', () => {
  it('always writes ?mode= when you pick a mode, even the default', async () => {
    const { user, router } = renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'near me' }));
    expect(router.state.location.search).toBe('?mode=near');
  });

  it('ignores an unknown ?roll= id', async () => {
    renderAt('/?roll=no-such-spot');
    expect(await screen.findAllByRole('article')).toHaveLength(5);
    expect(screen.queryByText('the dice says…')).not.toBeInTheDocument();
  });

  it('clears ?q= when you close the phone search', async () => {
    const { user, router } = renderAt('/?q=noodle');
    const toggle = await screen.findByRole('button', { name: 'Search my spots', expanded: true });
    await user.click(toggle);
    expect(router.state.location.search).toBe('');
  });

  it('clears ?roll= when the origin changes', async () => {
    const geo = fakeGeolocation();
    const { user, router } = renderAt('/?roll=lucky-thread');
    expect(await screen.findAllByText('the dice says…')).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(router.state.location.search).toBe('');
    expect(screen.queryByText('the dice says…')).not.toBeInTheDocument();
  });

  it('staggers cards in (each card gets its index)', async () => {
    renderAt('/');
    const items = (await screen.findAllByRole('article')).map((a) => a.closest('li')!);
    expect(items[2]).toHaveClass('enter');
    expect(items[2]!.style.getPropertyValue('--i')).toBe('2');
  });
});

describe('mini radar highlight', () => {
  const miniDot = (id: string) =>
    screen
      .getByRole('img', { name: /Radar of saved places/ })
      .querySelector<HTMLElement>(`[data-spot="${id}"]`)!;
  const highlighted = () =>
    [
      ...screen
        .getByRole('img', { name: /Radar of saved places/ })
        .querySelectorAll('[aria-current="true"]'),
    ].map((el) => el.getAttribute('data-spot'));

  it('lights up the rolled spot, and clears with the roll', async () => {
    const { user } = renderAt('/?tag=tacos');
    await screen.findAllByRole('article');
    expect(highlighted()).toEqual([]);
    await user.click(screen.getAllByRole('button', { name: /can't decide/ })[0]!);
    expect(miniDot('two-fires')).toHaveAttribute('aria-current', 'true');
    expect(highlighted()).toEqual(['two-fires']);
    await user.click(screen.getAllByRole('button', { name: 'Clear the roll' })[0]!);
    expect(highlighted()).toEqual([]);
  });

  it('a rolled spot from the URL is highlighted too', async () => {
    renderAt('/?roll=ondo-soup');
    await screen.findAllByRole('article');
    expect(highlighted()).toEqual(['ondo-soup']);
  });

  it('hovering or focusing a card lights up its dot, then falls back to the roll', async () => {
    const { user } = renderAt('/?roll=ondo-soup');
    const cards = await screen.findAllByRole('article');
    const lucky = cards.find((c) => c.textContent.includes('Lucky Thread'))!;
    await user.hover(lucky);
    expect(highlighted()).toEqual(['lucky-thread']);
    await user.unhover(lucky);
    expect(highlighted()).toEqual(['ondo-soup']);

    act(() => {
      within(lucky).getByRole('link', { name: 'Lucky Thread Noodle Bar' }).focus();
    });
    expect(highlighted()).toEqual(['lucky-thread']);
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    expect(highlighted()).toEqual(['ondo-soup']);
  });
});

describe('the list search with a pinyin IME', () => {
  const q = (search: string) => new URLSearchParams(search).get('q');

  it.each(
    ORDERS.flatMap((browser) => [
      [browser, 'phone'],
      [browser, 'desktop'],
    ]),
  )('%s, %s box: ?q= changes only once 包子 is picked', async (browser, which) => {
    const { user, router } = renderAt('/');
    if (which === 'phone') {
      await user.click(await screen.findByRole('button', { name: 'Search my spots' }));
    }
    const box = await waitFor(() => {
      const el = document.getElementById(`search-${which}`);
      expect(el).not.toBeNull();
      return el!;
    });
    const navigate = vi.spyOn(router, 'navigate');
    fireEvent.compositionStart(box, { data: '' });
    for (const s of PINYIN) {
      composeStep(box, s);
      expect(box).toHaveValue(s);
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(navigate).not.toHaveBeenCalled();
    expect(q(router.state.location.search)).toBeNull();
    // the list isn't filtered by "bao zi" either
    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);

    ENDS[browser](box, '包子');
    await waitFor(() => {
      expect(q(router.state.location.search)).toBe('包子');
    });
    expect(box).toHaveValue('包子');
  });

  it('a late ?q= write for an earlier letter never overwrites what you typed since', async () => {
    const { user, router } = renderAt('/');
    const box = await waitFor(() => {
      const el = document.getElementById('search-desktop');
      expect(el).not.toBeNull();
      return el!;
    });
    const navigate = router.navigate.bind(router);
    let late: (() => Promise<void>) | undefined;
    vi.spyOn(router, 'navigate').mockImplementationOnce((...args) => {
      late = () => navigate(...args);
      return Promise.resolve();
    });
    await user.type(box, 'n');
    await user.type(box, 'oodle');
    await waitFor(() => {
      expect(q(router.state.location.search)).toBe('noodle');
    });
    // the held write for "n" lands last (React Router really cancels it; worst case here)
    await act(() => late?.());
    expect(box).toHaveValue('noodle');
    // a mode switch clears ?q=, and the box with it
    await user.click(screen.getByRole('button', { name: 'weekend' }));
    expect(box).toHaveValue('');
  });
});
