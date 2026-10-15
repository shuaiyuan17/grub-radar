import { render, screen } from '@testing-library/react';
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
