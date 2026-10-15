import { screen, within } from '@testing-library/react';
import { MemorySpotRepository } from '../data/memoryRepository';
import { renderAt } from '../test/render';

vi.mock('../i18n/fonts', () => ({ loadZhFonts: vi.fn(() => Promise.resolve()) }));

/**
 * A spot added from Apple Maps: Apple says nothing about price or cuisine, so
 * we don't either. Every place that shows them says "price?" / "cuisine?" in
 * handwriting instead of a guessed "$$" or a blank.
 */
const SERIOUS_PIE = {
  id: 'serious-pie',
  name: 'Serious Pie',
  kind: 'food',
  tags: [],
  status: 'want',
  order: [],
  icon: 'bowl',
  location: { lat: 47.6135, lng: -122.3302 },
  applePlaceId: 'IAPPLE1',
};
const repo = () => new MemorySpotRepository([SERIOUS_PIE], { today: () => '2026-10-14' });

const unknowns = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-unknown]')].map((e) => [
    e.getAttribute('data-unknown'),
    e.textContent,
  ]);

describe('unknown price and cuisine', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('a card says "food · price?": the kind stands in for cuisine, never "$$"', async () => {
    renderAt('/?q=serious', { repository: repo() });
    const card = await screen.findByRole('article', { name: 'Serious Pie' });
    expect(card).toHaveTextContent('food · price?');
    expect(card).not.toHaveTextContent('cuisine?');
    expect(card).not.toHaveTextContent('$');
    expect(unknowns(card)).toEqual([['price', 'price?']]);
  });

  it('the place page lists them as "cuisine?" and "price?"', async () => {
    renderAt('/place/serious-pie', { repository: repo() });
    const about = await screen.findByRole('list', { name: 'About this spot' });
    expect(within(about).getByText('cuisine?')).toHaveAttribute('data-unknown', 'cuisine');
    expect(within(about).getByText('price?')).toHaveAttribute('data-unknown', 'price');
    expect(about).not.toHaveTextContent('$');
  });

  it('the radar card too', async () => {
    renderAt('/radar?sel=serious-pie', { repository: repo() });
    const card = await screen.findByRole('article', { name: 'Serious Pie' });
    expect(card).toHaveTextContent(/^Serious Piefood · price\? · \d+ min walk/);
  });

  it('a card in Chinese: the kind (吃的) stands in, price is 价位？', async () => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
    renderAt('/?q=serious', { repository: repo() });
    const card = await screen.findByRole('article', { name: 'Serious Pie' });
    expect(card).toHaveTextContent('吃的');
    expect(card).not.toHaveTextContent('菜系？');
    expect(within(card).getByText('价位？')).toHaveAttribute('data-unknown', 'price');
  });

  it('in Chinese: 菜系？ and 价位？', async () => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
    renderAt('/place/serious-pie', { repository: repo() });
    expect(await screen.findByText('价位？')).toHaveAttribute('data-unknown', 'price');
    expect(screen.getByText('菜系？')).toHaveAttribute('data-unknown', 'cuisine');
  });

  it('a known price and cuisine show as themselves', async () => {
    renderAt('/?q=lucky');
    const card = await screen.findByRole('article', { name: 'Lucky Thread Noodle Bar' });
    expect(card).toHaveTextContent('hand-pulled noodles · $$');
    expect(unknowns(card)).toEqual([]);
  });
});
