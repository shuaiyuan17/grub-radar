import { act, screen, within } from '@testing-library/react';
import { MemorySpotRepository } from '../data/memoryRepository';
import { parseTags } from '../lib/tags';
import { fakeGeolocation, renderAt } from '../test/render';

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
    const { user, router } = renderAt('/add', { repository });
    await user.type(await screen.findByLabelText('name'), 'Night Owl Pho');
    await user.click(screen.getByRole('radio', { name: 'coffee' }));
    await user.click(screen.getByRole('radio', { name: 'food' }));
    await user.type(screen.getByLabelText('where is it?'), '47.6152, -122.3201');
    await user.type(screen.getByLabelText(/^cuisine/), 'pho');
    await user.click(screen.getByRole('radio', { name: '$' }));
    await user.type(screen.getByLabelText(/^cravings/), 'Noodles, late night，noodles');
    await user.click(screen.getByRole('radio', { name: 'been' }));
    await user.click(screen.getByRole('radio', { name: '8/10' }));
    await user.type(screen.getByLabelText(/^one-liner/), 'the 1am bowl');
    await user.click(screen.getByRole('button', { name: 'add it' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: /Night Owl Pho/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/place/p-mem-1');
    expect(screen.getByText(/been here · 8\/10/)).toBeInTheDocument();
    expect(await repository.get('p-mem-1')).toMatchObject({
      kind: 'food',
      cuisine: 'pho',
      price: '$',
      tags: ['noodles', 'late night'],
      status: 'been',
      rating: 8,
      note: 'the 1am bowl',
      icon: 'bowl',
      location: { lat: 47.6152, lng: -122.3201 },
    });
  });

  it('needs a name and a place; says what is missing', async () => {
    const { user } = renderAt('/add');
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
    const { user } = renderAt('/add');
    await user.click(await screen.findByRole('button', { name: 'use where i am' }));
    act(() => {
      geo.succeed(47.6062, -122.3245);
    });
    expect(screen.getByLabelText('where is it?')).toHaveValue('47.6062, -122.3245');
    expect(screen.getByText('pinned at 47.6062, -122.3245')).toBeInTheDocument();
  });

  it('a blocked location says to type it instead', async () => {
    const geo = fakeGeolocation();
    const { user } = renderAt('/add');
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
      rating: 9, // untouched
      location: { lat: 47.6135, lng: -122.3302 },
    });
  });

  it('shows a server refusal in words', async () => {
    const repository = new MemorySpotRepository([]);
    const { user } = renderAt('/add', { repository });
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
