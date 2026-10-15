import { act, screen, within } from '@testing-library/react';
import { MemorySpotRepository } from '../data/memoryRepository';
import { parseTags } from '../lib/tags';
import { demoRepository, fakeGeolocation, renderAt } from '../test/render';

describe('a brand-new list', () => {
  it('shows a friendly empty state that leads to "add"', async () => {
    const { user, router } = renderAt('/', { repository: new MemorySpotRepository([]) });
    expect(
      await screen.findByRole('heading', { name: 'nothing on your radar yet.' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'add your first spot' }));
    expect(router.state.location.pathname).toBe('/add');
  });

  it('the radar says so too', async () => {
    renderAt('/radar', { repository: new MemorySpotRepository([]) });
    expect(await screen.findByText(/nothing on your radar yet/)).toBeInTheDocument();
  });
});

describe('add a spot', () => {
  it('adds one by hand and opens it', async () => {
    const repository = new MemorySpotRepository([]);
    const { user, router } = renderAt('/add/manual', { repository });
    await user.type(await screen.findByLabelText('name'), 'Night Owl Pho');
    await user.click(screen.getByRole('radio', { name: 'coffee' }));
    await user.click(screen.getByRole('radio', { name: 'food' }));
    await user.type(screen.getByLabelText('where is it?'), '47.6152, -122.3201');
    await user.type(screen.getByLabelText(/^cuisine/), 'pho');
    await user.click(screen.getByRole('radio', { name: '$' }));
    await user.type(screen.getByLabelText(/^cravings/), 'Noodles, late night，noodles');
    await user.click(screen.getByRole('radio', { name: 'been' }));
    await user.click(screen.getByRole('radio', { name: 'loved it' }));
    await user.type(screen.getByLabelText(/^one-liner/), 'the 1am bowl');
    await user.click(screen.getByRole('button', { name: 'add it' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: /Night Owl Pho/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/place/p-mem-1');
    expect(screen.getByText('· loved it')).toBeInTheDocument();
    expect(await repository.get('p-mem-1')).toMatchObject({
      kind: 'food',
      cuisine: 'pho',
      price: '$',
      tags: ['noodles', 'late night'],
      status: 'been',
      verdict: 'good',
      note: 'the 1am bowl',
      icon: 'bowl',
      location: { lat: 47.6152, lng: -122.3201 },
    });
  });

  it('needs a name and a place; says what is missing', async () => {
    const { user } = renderAt('/add/manual');
    await user.click(await screen.findByRole('button', { name: 'add it' }));
    expect(screen.getByText('give it a name.')).toBeInTheDocument();
    expect(screen.getByText(/where is it\? use where you are/)).toBeInTheDocument();
    expect(screen.getByLabelText('name')).toHaveAttribute('aria-invalid', 'true');
    await user.type(screen.getByLabelText('where is it?'), '47.61,');
    await user.click(screen.getByRole('button', { name: 'add it' }));
    expect(screen.getByText(/doesn't look like lat, lng/)).toBeInTheDocument();
  });

  it('"use where i am" pins the spot where you are', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/add/manual');
    await user.click(await screen.findByRole('button', { name: 'use where i am' }));
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(screen.getByLabelText('where is it?')).toHaveValue('47.6062, -122.3245');
    expect(screen.getByText('pinned at 47.6062, -122.3245')).toBeInTheDocument();
  });

  it('a blocked location says to type it instead', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/add/manual');
    await user.click(await screen.findByRole('button', { name: 'use where i am' }));
    act(() => {
      geo.deny();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('location is blocked');
  });

  it('the desktop header and the phone header both link to it', async () => {
    renderAt('/');
    const links = await screen.findAllByRole('link', { name: /add a spot/i });
    expect(links.length).toBe(2);
    for (const l of links) expect(l).toHaveAttribute('href', '/add');
  });
});

describe('edit a spot', () => {
  it('changes the details and goes back to the spot', async () => {
    const { user, router, repository } = renderAt('/place/lucky-thread');
    await user.click(await screen.findByRole('link', { name: 'Edit this spot' }));
    expect(router.state.location.pathname).toBe('/place/lucky-thread/edit');
    const name = screen.getByLabelText('name');
    expect(name).toHaveValue('Lucky Thread Noodle Bar');
    expect(screen.getByLabelText('where is it?')).toHaveValue('47.6135, -122.3302');
    await user.clear(name);
    await user.type(name, 'Lucky Thread');
    await user.click(screen.getByRole('radio', { name: '$$$' }));
    await user.click(screen.getByRole('button', { name: 'save' }));
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/place/lucky-thread');
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Lucky Thread' }),
    ).toBeInTheDocument();
    expect(await repository.get('lucky-thread')).toMatchObject({
      name: 'Lucky Thread',
      price: '$$$',
      verdict: 'good', // untouched
      location: { lat: 47.6135, lng: -122.3302 },
    });
  });

  it('after a 409, a retry never resends stale fields: the other tab’s change survives', async () => {
    const repository = demoRepository();
    const { user } = renderAt('/place/lucky-thread/edit', { repository });
    const name = await screen.findByLabelText('name');
    // another tab changes the price while this form is open
    await repository.update('lucky-thread', { price: '$$$$' });
    await user.clear(name);
    await user.type(name, 'Lucky Thread');
    await user.click(screen.getByRole('button', { name: 'save' }));
    // refused (stale version); the form catches up and says what moved
    expect(await screen.findByRole('alert')).toHaveTextContent('updated somewhere else');
    expect(await screen.findByText(/updated somewhere else just now: price/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '$$$$' })).toBeChecked();
    expect(screen.getByLabelText('name')).toHaveValue('Lucky Thread'); // your edit is kept
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Lucky Thread' }),
    ).toBeInTheDocument();
    expect(await repository.get('lucky-thread')).toMatchObject({
      name: 'Lucky Thread',
      price: '$$$$',
    });
  });

  it('an edit sends only the fields you changed', async () => {
    const repository = demoRepository();
    const update = vi.spyOn(repository, 'update');
    const { user } = renderAt('/place/lucky-thread/edit', { repository });
    await user.click(await screen.findByRole('radio', { name: '$' }));
    await user.click(screen.getByRole('button', { name: 'save' }));
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith('lucky-thread', { price: '$', version: 1 });
    });
  });

  it('price starts as "?" (not sure): a new spot gets no price, not a guessed "$$"', async () => {
    const repository = new MemorySpotRepository([]);
    const add = vi.spyOn(repository, 'add');
    const { user } = renderAt('/add/manual', { repository });
    await user.type(await screen.findByLabelText('name'), 'Serious Pie');
    expect(screen.getByRole('radio', { name: 'not sure' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '$$' })).not.toBeChecked();
    await user.type(screen.getByLabelText('where is it?'), '47.6135, -122.3302');
    await user.click(screen.getByRole('button', { name: 'add it' }));
    await vi.waitFor(() => {
      expect(add).toHaveBeenCalled();
    });
    expect(add.mock.calls[0]?.[0]).not.toHaveProperty('price');
    expect(await screen.findByText('price?')).toBeInTheDocument();
    expect((await repository.list())[0]).not.toHaveProperty('price');
  });

  it('"?" on an edit clears a price back to unknown', async () => {
    const repository = demoRepository();
    const update = vi.spyOn(repository, 'update');
    const { user } = renderAt('/place/lucky-thread/edit', { repository });
    expect(await screen.findByRole('radio', { name: '$$' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'not sure' }));
    await user.click(screen.getByRole('button', { name: 'save' }));
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith('lucky-thread', { price: null, version: 1 });
    });
    expect((await repository.get('lucky-thread'))?.price).toBeUndefined();
  });

  it('a "been" spot gets a verdict from three stamps, not a 1-10 score', async () => {
    const repository = new MemorySpotRepository([]);
    const { user } = renderAt('/add/manual', { repository });
    await user.type(await screen.findByLabelText('name'), 'X');
    await user.click(screen.getByRole('radio', { name: 'been' }));
    const stamps = screen.getByRole('group', { name: 'your verdict' });
    expect(
      within(stamps)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['loved it', 'it was fine', 'nope']);
    expect(screen.queryByRole('radio', { name: /\/10$/ })).not.toBeInTheDocument();
    await user.click(within(stamps).getByRole('radio', { name: 'nope' }));
    await user.type(screen.getByLabelText('where is it?'), '1, 2');
    await user.click(screen.getByRole('button', { name: 'add it' }));
    await vi.waitFor(async () => {
      expect((await repository.list())[0]).toMatchObject({ status: 'been', verdict: 'bad' });
    });
  });

  it('shows a server refusal in words', async () => {
    const repository = new MemorySpotRepository([]);
    const { user } = renderAt('/add/manual', { repository });
    vi.spyOn(repository, 'add').mockRejectedValue(
      Object.assign(new Error('x'), { name: 'ApiRequestError' }),
    );
    await user.type(await screen.findByLabelText('name'), 'X');
    await user.type(screen.getByLabelText('where is it?'), '1, 2');
    await user.click(screen.getByRole('button', { name: 'add it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t save that');
    expect(within(screen.getByRole('main')).getByRole('button', { name: 'add it' })).toBeEnabled();
  });
});

describe('parseTags', () => {
  it('splits on ASCII and CJK commas, lowercases, dedupes, caps at 10', () => {
    expect(parseTags(' Noodles, spicy，面、 noodles ,, ')).toEqual(['noodles', 'spicy', '面']);
    expect(parseTags(Array.from({ length: 12 }, (_, i) => `t${i}`).join(','))).toHaveLength(10);
  });
});
