import { act, render, screen } from '@testing-library/react';
import type { SpotRepository } from '../domain/repository';
import { useSpots } from '../lib/spots';
import { StaticSpotRepository } from '../data/staticRepository';
import { SpotsProvider } from './SpotsProvider';

function Names() {
  const { spots } = useSpots();
  return <p>{spots.map((s) => s.name).join(', ')}</p>;
}

describe('SpotsProvider', () => {
  it('serves spots from whatever repository it is given', async () => {
    const repo: SpotRepository = {
      list: () =>
        Promise.resolve([
          {
            id: 'api-spot',
            name: 'From The API',
            kind: 'food',
            cuisine: 'x',
            price: '$',
            tags: [],
            status: 'want',
            note: 'n',
            order: [],
            icon: 'bowl',
            location: { lat: 47.6, lng: -122.3 },
          },
        ]),
      get: () => Promise.resolve(null),
    };
    render(
      <SpotsProvider repository={repo}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.getByText('unfolding the map…')).toBeInTheDocument();
    expect(await screen.findByText('From The API')).toBeInTheDocument();
  });

  it('shows an error when the repository fails', async () => {
    const repo: SpotRepository = {
      list: () => Promise.reject(new Error('offline')),
      get: () => Promise.resolve(null),
    };
    render(
      <SpotsProvider repository={repo}>
        <Names />
      </SpotsProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  });
});

describe('SpotsProvider with the static repository', () => {
  it('renders immediately, with no loading state', () => {
    render(
      <SpotsProvider repository={new StaticSpotRepository()}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.queryByText('unfolding the map…')).not.toBeInTheDocument();
    expect(screen.getByText(/Lucky Thread Noodle Bar/)).toBeInTheDocument();
  });

  it('shows invalid seed data as an error instead of crashing', () => {
    render(
      <SpotsProvider repository={new StaticSpotRepository([{ id: 'Bad Id' }])}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Invalid spots data/);
  });
});

describe('SpotsProvider when the repository changes', () => {
  const spot = (id: string, name: string) => ({
    id,
    name,
    kind: 'food' as const,
    cuisine: 'x',
    price: '$' as const,
    tags: [],
    status: 'want' as const,
    note: 'n',
    order: [],
    icon: 'bowl' as const,
    location: { lat: 47.6, lng: -122.3 },
  });

  it('async -> snapshot: shows the new data right away, not a stale loading state', () => {
    const never: SpotRepository = {
      list: () => new Promise(() => undefined), // still loading
      get: () => Promise.resolve(null),
    };
    const { rerender } = render(
      <SpotsProvider repository={never}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.getByText('unfolding the map…')).toBeInTheDocument();
    rerender(
      <SpotsProvider repository={new StaticSpotRepository()}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.queryByText('unfolding the map…')).not.toBeInTheDocument();
    expect(screen.getByText(/Lucky Thread Noodle Bar/)).toBeInTheDocument();
  });

  it('snapshot -> async: loads the new repository instead of keeping the old spots', async () => {
    const api: SpotRepository = {
      list: () => Promise.resolve([spot('api-only', 'Only In The API')]),
      get: () => Promise.resolve(null),
    };
    const { rerender } = render(
      <SpotsProvider repository={new StaticSpotRepository()}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.getByText(/Lucky Thread/)).toBeInTheDocument();
    rerender(
      <SpotsProvider repository={api}>
        <Names />
      </SpotsProvider>,
    );
    expect(await screen.findByText('Only In The API')).toBeInTheDocument();
    expect(screen.queryByText(/Lucky Thread/)).not.toBeInTheDocument();
  });

  it('error -> snapshot: recovers', () => {
    const { rerender } = render(
      <SpotsProvider repository={new StaticSpotRepository([{ id: 'Bad Id' }])}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(
      <SpotsProvider repository={new StaticSpotRepository()}>
        <Names />
      </SpotsProvider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/Lucky Thread/)).toBeInTheDocument();
  });

  it('a slow old repository resolving late does not clobber the new one', async () => {
    let resolveOld: (s: ReturnType<typeof spot>[]) => void = () => undefined;
    const slow: SpotRepository = {
      list: () =>
        new Promise((r) => {
          resolveOld = r;
        }),
      get: () => Promise.resolve(null),
    };
    const { rerender } = render(
      <SpotsProvider repository={slow}>
        <Names />
      </SpotsProvider>,
    );
    rerender(
      <SpotsProvider repository={new StaticSpotRepository()}>
        <Names />
      </SpotsProvider>,
    );
    await act(async () => {
      resolveOld([spot('old', 'Stale Old Spot')]);
      await Promise.resolve();
    });
    expect(screen.queryByText('Stale Old Spot')).not.toBeInTheDocument();
    expect(screen.getByText(/Lucky Thread/)).toBeInTheDocument();
  });
});
