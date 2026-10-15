import { screen, within } from '@testing-library/react';
import { renderAt } from '../test/render';

describe('place page', () => {
  it('shows the spot, its order list and a take-me-there link', async () => {
    renderAt('/place/lucky-thread');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Lucky Thread Noodle Bar',
    );
    expect(screen.getByText(/been here · 9\/10/)).toBeInTheDocument();
    expect(screen.getByText('0.3 mi')).toBeInTheDocument();
    expect(screen.getByText('near home')).toBeInTheDocument();
    const order = screen.getByRole('region', { name: 'order this' });
    expect(within(order).getAllByRole('listitem')).toHaveLength(3);
    expect(within(order).getByText('next time')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: "why it's on the list" })).toHaveTextContent(
      'found by your agent · sep 12, 2026',
    );
    expect(screen.getByRole('link', { name: /Take me to Lucky Thread/ })).toHaveAttribute(
      'href',
      'https://maps.apple.com/?daddr=47.6135,-122.3302&q=Lucky%20Thread%20Noodle%20Bar&dirflg=w',
    );
  });

  it('drives to far places and calls them a road trip', async () => {
    renderAt('/place/saltmarsh-crab');
    expect(await screen.findByText('1h 10')).toBeInTheDocument();
    expect(screen.getByText('road trip')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /driving directions/ })).toHaveAttribute(
      'href',
      expect.stringContaining('dirflg=d'),
    );
  });

  it('goes back to the list it came from', async () => {
    const { user, router } = renderAt('/?mode=coffee');
    await user.click(await screen.findByRole('link', { name: 'Fig & Fern' }));
    expect(router.state.location.pathname).toBe('/place/fig-and-fern');
    await user.click(screen.getByRole('link', { name: 'Back to the list' }));
    expect(router.state.location.search).toBe('?mode=coffee');
  });

  it('handles an unknown spot', async () => {
    renderAt('/place/nope');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      "that spot's not here",
    );
  });
});
