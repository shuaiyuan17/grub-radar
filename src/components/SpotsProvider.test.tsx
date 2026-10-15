import { render, screen } from '@testing-library/react';
import type { SpotRepository } from '../domain/repository';
import { useSpots } from '../lib/spots';
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
