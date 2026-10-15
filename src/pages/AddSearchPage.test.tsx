import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ApplePlace } from '../contracts/places';
import { MemorySpotRepository } from '../data/memoryRepository';
import { ApiRequestError } from '../lib/api';
import { forgetPlaceAnswers, SEARCH_DEBOUNCE_MS } from '../lib/placeSearch';
import { composeStep, ENDS, ORDERS, PINYIN } from '../test/ime';
import { fakePlaceSearch, renderAt } from '../test/render';

// fictional places around the demo home (downtown)
const PLACES: ApplePlace[] = [
  {
    applePlaceId: 'IF0000000000000A1',
    name: 'Night Owl Pho',
    address: '101 Lantern St, Seattle, WA 98101',
    location: { lat: 47.6152, lng: -122.3201 },
    category: 'Restaurant',
    kind: 'food',
  },
  {
    applePlaceId: 'IF0000000000000A2',
    name: 'Pho Real',
    address: '22 Kettle Ave, Seattle, WA 98104',
    location: { lat: 47.6101, lng: -122.3352 },
    category: 'Restaurant',
    kind: 'food',
  },
  {
    applePlaceId: 'IF0000000000000B1',
    name: 'Paper Kite Coffee',
    address: '9 Kite Ln, Seattle, WA 98101',
    location: { lat: 47.6123, lng: -122.3311 },
    category: 'Cafe',
    kind: 'coffee',
  },
];

const repo = (spots: unknown[] = []) =>
  new MemorySpotRepository(spots, { applePlaces: PLACES, today: () => '2026-10-15' });

beforeEach(() => {
  forgetPlaceAnswers();
});

/** The search's own status line (other parts of the shell have status regions too). */
const statusLine = () => within(screen.getByRole('main')).getByRole('status');

const searchBox = () =>
  screen.findByRole('searchbox', {
    name: 'Search Apple Maps for a restaurant, café or bakery',
  });

describe('add a spot from Apple Maps', () => {
  it('opens with the search box focused and a hint', async () => {
    renderAt('/add', { repository: repo() });
    expect(await searchBox()).toHaveFocus();
    expect(statusLine()).toHaveTextContent(/type a name or a craving/);
    expect(screen.getByText('looking around home')).toBeInTheDocument();
  });

  it('the empty list leads here', async () => {
    const { user, router } = renderAt('/', { repository: repo() });
    await user.click(await screen.findByRole('link', { name: 'add your first spot' }));
    expect(router.state.location.pathname).toBe('/add');
  });

  it('searches once you have typed enough, once per pause, around where you measure from', async () => {
    const search = fakePlaceSearch(PLACES);
    const { user } = renderAt('/add', { repository: repo(), placeSearch: search });
    await user.type(await searchBox(), 'p');
    await new Promise((r) => setTimeout(r, 450));
    expect(search.search).not.toHaveBeenCalled();
    await user.type(await searchBox(), 'ho');
    const list = await screen.findByRole('list', { name: 'Places on Apple Maps' });
    expect(search.search).toHaveBeenCalledTimes(1);
    // no home on the account: the demo home's point (placeSearch rounds it)
    expect(search.search.mock.calls[0]?.[0]).toMatchObject({
      q: 'pho',
      lang: 'en',
      near: { lat: expect.any(Number) as number, lng: expect.any(Number) as number },
    });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Night Owl Pho');
    expect(items[0]).toHaveTextContent('food · 101 Lantern St, Seattle, WA 98101');
    expect(items[0]).toHaveTextContent(/\d+(\.\d)? mi/);
    expect(items[0]).toHaveTextContent(/min (walk|drive)/);
    expect(statusLine()).toHaveTextContent('2 on Apple Maps · tap one to add it');
    expect(screen.getByText('places from Apple Maps')).toBeInTheDocument();
  });

  it('with a home on your account, asks the server to search around it (never sends it)', async () => {
    const search = fakePlaceSearch(PLACES);
    const { user } = renderAt('/add', {
      repository: repo(),
      placeSearch: search,
      home: { lat: 47.618421, lng: -122.321937 },
    });
    await user.type(await searchBox(), 'kite');
    await screen.findByRole('list', { name: 'Places on Apple Maps' });
    expect(search.search.mock.calls[0]?.[0]).toMatchObject({ near: 'home' });
  });

  it('one tap adds it and opens it, with Apple’s name and address', async () => {
    const repository = repo();
    const { user, router } = renderAt('/add', { repository, placeSearch: fakePlaceSearch(PLACES) });
    await user.type(await searchBox(), 'paper kite');
    await user.click(
      await screen.findByRole('button', { name: 'Add Paper Kite Coffee to your radar' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: /Paper Kite Coffee/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/place/p-mem-1');
    expect(screen.getByText('9 Kite Ln, Seattle, WA 98101')).toBeInTheDocument();
    expect(screen.getByText('on your radar. been already? mark it below.')).toBeInTheDocument();
    expect(await repository.get('p-mem-1')).toMatchObject({
      applePlaceId: 'IF0000000000000B1',
      kind: 'coffee',
      icon: 'cup',
      status: 'want',
      location: { lat: 47.6123, lng: -122.3311 },
    });
    // and then you can say you've been
    expect(screen.getByRole('button', { name: 'mark as been' })).toBeInTheDocument();
  });

  it('a place already on your list says so and opens your entry', async () => {
    const repository = repo();
    await repository.addApplePlace({ applePlaceId: 'IF0000000000000A1', note: 'the 1am bowl' });
    const add = vi.spyOn(repository, 'addApplePlace');
    const { user, router } = renderAt('/add', { repository, placeSearch: fakePlaceSearch(PLACES) });
    await user.type(await searchBox(), 'pho');
    const open = await screen.findByRole('link', {
      name: 'Open Night Owl Pho (already on your list)',
    });
    expect(screen.getAllByText('on your list')).toHaveLength(1);
    await user.click(open);
    expect(router.state.location.pathname).toBe('/place/p-mem-1');
    expect(await screen.findByText('the 1am bowl')).toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
  });

  it('says when nothing matches, and offers adding by hand with what you typed', async () => {
    const { user, router } = renderAt('/add', {
      repository: repo(),
      placeSearch: fakePlaceSearch(PLACES),
    });
    await user.type(await searchBox(), 'corner stall');
    expect(
      await screen.findByText('nothing on Apple Maps for “corner stall”.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /can’t find it\? add it by hand/ }));
    expect(router.state.location.pathname).toBe('/add/manual');
    expect(await screen.findByLabelText('name')).toHaveValue('corner stall');
  });

  it.each([
    ['maps_unavailable', /Apple Maps isn't answering right now/],
    ['rate_limited', /give it a minute/],
  ])('Apple trouble (%s) is said in words', async (code, text) => {
    const search = {
      search: vi.fn(() => Promise.reject(new ApiRequestError(503, code, 'x'))),
    };
    const { user } = renderAt('/add', { repository: repo(), placeSearch: search });
    await user.type(await searchBox(), 'pho');
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent(text);
    });
  });

  it('a failed add says so and lets you try again', async () => {
    const repository = repo();
    vi.spyOn(repository, 'addApplePlace').mockRejectedValueOnce(
      new ApiRequestError(503, 'maps_unavailable', 'x'),
    );
    const { user } = renderAt('/add', { repository, placeSearch: fakePlaceSearch(PLACES) });
    await user.type(await searchBox(), 'pho real');
    const add = await screen.findByRole('button', { name: 'Add Pho Real to your radar' });
    await user.click(add);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Apple Maps isn't answering/);
    expect(add).toBeEnabled();
  });

  it('typing back to an earlier search costs nothing', async () => {
    const search = fakePlaceSearch(PLACES);
    const { user } = renderAt('/add', { repository: repo(), placeSearch: search });
    const box = await searchBox();
    await user.type(box, 'pho');
    await screen.findByText('2 on Apple Maps · tap one to add it');
    await user.type(box, ' real');
    await screen.findByText('1 on Apple Maps · tap one to add it');
    await user.clear(box);
    await user.type(box, 'pho');
    expect(await screen.findByText('2 on Apple Maps · tap one to add it')).toBeInTheDocument();
    expect(search.search).toHaveBeenCalledTimes(2);
  });
});

describe('while a newer search loads', () => {
  it('the previous results stay visible but cannot be tapped', async () => {
    const repository = repo();
    await repository.addApplePlace({ applePlaceId: 'IF0000000000000A2' }); // Pho Real is yours
    const add = vi.spyOn(repository, 'addApplePlace');
    // "pho" answers; anything after it never does (still loading)
    const search = {
      search: vi.fn((q: { q: string }) =>
        q.q === 'pho'
          ? Promise.resolve(PLACES.filter((p) => p.name.toLowerCase().includes('pho')))
          : new Promise<ApplePlace[]>(() => undefined),
      ),
    };
    const { user, router } = renderAt('/add', { repository, placeSearch: search });
    const box = await searchBox();
    await user.type(box, 'pho');
    const owl = await screen.findByRole('button', { name: 'Add Night Owl Pho to your radar' });
    expect(owl).toBeEnabled();
    await user.type(box, ' sushi');
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('looking…');
    });
    // still on screen, but not actionable
    expect(owl).toBeDisabled();
    expect(owl).toHaveAttribute('aria-disabled', 'true');
    await user.click(owl);
    expect(add).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('link', { name: 'Open Pho Real (already on your list)' }),
    ).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/add');
  });
});

describe('editing a spot from Apple Maps', () => {
  it('keeps Apple’s name and location (not fields), the rest is yours', async () => {
    const repository = repo();
    await repository.addApplePlace({ applePlaceId: 'IF0000000000000A2' });
    const { user } = renderAt('/place/p-mem-1/edit', { repository });
    expect(await screen.findByText('Pho Real')).toBeInTheDocument();
    expect(screen.getByText('22 Kettle Ave, Seattle, WA 98104')).toBeInTheDocument();
    expect(screen.getByText('name and location come from Apple Maps.')).toBeInTheDocument();
    expect(screen.queryByLabelText('name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('where is it?')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^cuisine/), 'pho');
    await user.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByRole('heading', { level: 1, name: /Pho Real/ });
    expect(await repository.get('p-mem-1')).toMatchObject({ cuisine: 'pho', name: 'Pho Real' });
  });
});

describe('typing Chinese with a pinyin IME', () => {
  const BAOZI: ApplePlace = {
    applePlaceId: 'IF0000000000000C1',
    name: '包子铺',
    address: '3 Steam Alley, Seattle, WA 98104',
    location: { lat: 47.6098, lng: -122.3268 },
    category: 'Restaurant',
    kind: 'food',
  };
  const pause = (ms = SEARCH_DEBOUNCE_MS + 150) => new Promise((r) => setTimeout(r, ms));
  const q = (search: string) => new URLSearchParams(search).get('q');

  it.each(ORDERS)(
    '%s: the pinyin shows as you type, no search and no URL change until you pick 包子',
    async (browser) => {
      const search = fakePlaceSearch([...PLACES, BAOZI]);
      const { router } = renderAt('/add', { repository: repo(), placeSearch: search });
      const box = await searchBox();
      const navigate = vi.spyOn(router, 'navigate');
      fireEvent.compositionStart(box, { data: '' });
      for (const s of PINYIN) {
        composeStep(box, s);
        expect(box).toHaveValue(s);
      }
      // you stop to look at the candidates: nothing happens behind your back
      await pause();
      expect(box).toHaveValue('bao zi');
      expect(search.search).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(router.state.location.search).toBe('');

      ENDS[browser](box, '包子');
      expect(box).toHaveValue('包子');
      const list = await screen.findByRole('list', { name: 'Places on Apple Maps' });
      expect(within(list).getByRole('listitem')).toHaveTextContent('包子铺');
      expect(search.search).toHaveBeenCalledTimes(1);
      expect(search.search.mock.calls[0]?.[0]).toMatchObject({ q: '包子' });
      await waitFor(() => {
        expect(q(router.state.location.search)).toBe('包子');
      });
      expect(box).toHaveValue('包子');
    },
  );

  it('the URL follows the search after a pause, not on every keystroke', async () => {
    const { user, router } = renderAt('/add', {
      repository: repo(),
      placeSearch: fakePlaceSearch(PLACES),
    });
    const box = await searchBox();
    const navigate = vi.spyOn(router, 'navigate');
    await user.type(box, 'pho');
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(q(router.state.location.search)).toBe('pho');
    });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('Enter writes the URL at once', async () => {
    const { user, router } = renderAt('/add', {
      repository: repo(),
      placeSearch: fakePlaceSearch(PLACES),
    });
    await user.type(await searchBox(), 'pho{Enter}');
    expect(q(router.state.location.search)).toBe('pho');
  });

  it('a bare /add (the header link) clears the box and the search', async () => {
    const { user, router } = renderAt('/add', {
      repository: repo(),
      placeSearch: fakePlaceSearch(PLACES),
    });
    const box = await searchBox();
    await user.type(box, 'pho');
    await waitFor(() => {
      expect(q(router.state.location.search)).toBe('pho');
    });
    await act(() => router.navigate('/add'));
    expect(box).toHaveValue('');
    await pause();
    expect(router.state.location.search).toBe('');
  });

  it('a late URL write for an earlier word never overwrites what you typed since', async () => {
    const search = fakePlaceSearch(PLACES);
    const { user, router } = renderAt('/add', { repository: repo(), placeSearch: search });
    const box = await searchBox();
    // hold the first ?q= write back, as a slow router might
    const navigate = router.navigate.bind(router);
    let late: (() => Promise<void>) | undefined;
    vi.spyOn(router, 'navigate').mockImplementationOnce((...args) => {
      late = () => navigate(...args);
      return Promise.resolve();
    });
    await user.type(box, 'pho');
    await waitFor(() => {
      expect(late).toBeDefined();
    });
    // you type on before the write for "pho" lands
    await user.type(box, ' real');
    await act(() => late?.());
    expect(q(router.state.location.search)).toBe('pho');
    expect(box).toHaveValue('pho real');
    // the search and the URL catch up with what's in the box
    await screen.findByText('1 on Apple Maps · tap one to add it');
    await waitFor(() => {
      expect(q(router.state.location.search)).toBe('pho real');
    });
    expect(box).toHaveValue('pho real');
  });

  it('back/forward to another search is followed', async () => {
    const { router } = renderAt('/add?q=pho', {
      repository: repo(),
      placeSearch: fakePlaceSearch(PLACES),
    });
    const box = await searchBox();
    expect(box).toHaveValue('pho');
    await act(() => router.navigate('/add?q=kite'));
    expect(box).toHaveValue('kite');
    await act(() => router.navigate(-1));
    expect(box).toHaveValue('pho');
    await screen.findByText('2 on Apple Maps · tap one to add it');
  });
});
