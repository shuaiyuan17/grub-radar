import { screen, within } from '@testing-library/react';
import { renderAt } from '../test/render';

describe('radar page', () => {
  it('gives every dot an accessible name and shows all in reach', async () => {
    renderAt('/radar');
    const radar = await screen.findByRole('group', { name: 'Places around home by travel time' });
    const dots = within(radar).getAllByRole('button');
    expect(dots).toHaveLength(13);
    expect(
      within(radar).getByRole('button', { name: 'Ondo Soup House, food, 8 min drive' }),
    ).toBeInTheDocument();
    expect(screen.getByText('13 in reach')).toBeInTheDocument();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'road trip');
  });

  it('tapping a dot shows its card', async () => {
    const { user, router } = renderAt('/radar');
    await user.click(await screen.findByRole('button', { name: /^Hilltop Smokehouse/ }));
    const card = screen.getByRole('article', { name: 'Hilltop Smokehouse' });
    expect(card).toHaveTextContent('bbq · 48 min drive');
    expect(screen.getByRole('button', { name: /^Hilltop Smokehouse/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(router.state.location.search).toBe('?sel=hilltop-smokehouse');
  });

  it('a smaller reach fades far dots and counts fewer', async () => {
    renderAt('/radar?reach=0');
    expect(await screen.findByText('6 in reach')).toBeInTheDocument();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '10 min');
    expect(
      screen.getByRole('button', { name: /^Hilltop Smokehouse.*beyond your reach$/ }),
    ).toBeInTheDocument();
  });

  it('the kind filter hides dots', async () => {
    const { user } = renderAt('/radar');
    const kinds = await screen.findByRole('group', { name: 'Show kinds' });
    await user.click(within(kinds).getByRole('button', { name: 'food' }));
    expect(within(kinds).getByRole('button', { name: 'food' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByRole('button', { name: /Lucky Thread/ })).not.toBeInTheDocument();
    expect(screen.getByText('5 in reach')).toBeInTheDocument();
  });

  it('rolling picks something in reach', async () => {
    const { user } = renderAt('/radar?reach=0&kinds=coffee');
    await user.click(await screen.findByRole('button', { name: /can't decide/ }));
    expect(screen.getByRole('article', { name: 'Little Ember Coffee' })).toBeInTheDocument();
  });
});
