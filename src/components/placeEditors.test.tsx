import { screen, within } from '@testing-library/react';
import { ApiRequestError } from '../lib/api';
import { localDate } from '../lib/spots';
import { demoRepository, renderAt } from '../test/render';

const today = localDate();

describe('on the place page', () => {
  it('mark as been, with a rating and a dated note', async () => {
    const { user, repository } = renderAt('/place/mama-kos');
    await user.click(await screen.findByRole('button', { name: 'mark as been' }));
    await user.click(screen.getByRole('radio', { name: '7/10' }));
    await user.type(screen.getByLabelText('anything to remember?'), 'cash only. bring it.');
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByText(/been here · 7\/10/)).toBeInTheDocument();
    const mine = screen.getByRole('region', { name: 'my note' });
    expect(within(mine).getByText('cash only. bring it.')).toBeInTheDocument();
    expect(await repository.get('mama-kos')).toMatchObject({
      status: 'been',
      rating: 7,
      myNote: `— ${today}: cash only. bring it.`,
    });
  });

  it('change the rating, then move back to want to try', async () => {
    const { user, repository } = renderAt('/place/lucky-thread');
    await user.click(await screen.findByRole('button', { name: 'change rating' }));
    await user.click(screen.getByRole('radio', { name: '10/10' }));
    expect(await screen.findByText(/been here · 10\/10/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'move back to want to try' }));
    expect(await screen.findByRole('button', { name: 'mark as been' })).toBeInTheDocument();
    expect((await repository.get('lucky-thread'))?.rating).toBeUndefined();
  });

  it('add a note: appended under the old ones, dated', async () => {
    const { user } = renderAt('/place/lucky-thread');
    const mine = await screen.findByRole('region', { name: 'my note' });
    await user.click(within(mine).getByRole('button', { name: 'add a note' }));
    expect(within(mine).getByRole('alert')).toHaveTextContent('write something first.');
    await user.type(within(mine).getByLabelText('New note'), 'wontons were the star');
    await user.click(within(mine).getByRole('button', { name: 'add a note' }));
    const items = await within(mine).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('go at 5:30');
    expect(items[1]).toHaveTextContent('wontons were the star');
    expect(within(mine).getByLabelText('New note')).toHaveValue('');
  });

  it('order this: tick a dish, add one, remove one', async () => {
    const { user, repository } = renderAt('/place/lucky-thread');
    const order = await screen.findByRole('region', { name: 'order this' });
    const wontons = within(order).getByRole('checkbox', { name: 'chili oil wontons' });
    expect(wontons).toHaveAttribute('aria-checked', 'false');
    await user.click(wontons);
    expect(
      await within(order).findByRole('checkbox', { name: 'chili oil wontons' }),
    ).toHaveAttribute('aria-checked', 'true');
    await user.type(within(order).getByLabelText('add a dish'), 'dan dan noodles');
    await user.click(within(order).getByRole('button', { name: 'add' }));
    expect(await within(order).findByRole('checkbox', { name: 'dan dan noodles' })).toBeVisible();
    await user.click(within(order).getByRole('button', { name: 'Remove smashed cucumber' }));
    await vi.waitFor(async () => {
      expect((await repository.get('lucky-thread'))?.order).toEqual([
        { dish: 'cumin lamb biang biang', tried: true },
        { dish: 'chili oil wontons', tried: true },
        { dish: 'dan dan noodles', tried: false },
      ]);
    });
  });

  it('delete asks first, then goes back to the list without it', async () => {
    const { user, router } = renderAt('/place/lucky-thread');
    await user.click(await screen.findByRole('button', { name: 'delete' }));
    await user.click(screen.getByRole('button', { name: 'keep it' }));
    await user.click(screen.getByRole('button', { name: 'delete' }));
    expect(screen.getByText(/your notes and rating go with it/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'yes, delete' }));
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(await screen.findAllByRole('article')).not.toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Lucky Thread Noodle Bar' })).not.toBeInTheDocument();
  });

  it('a refused save is explained (by error code) and nothing changes', async () => {
    const repository = demoRepository();
    const { user } = renderAt('/place/lucky-thread', { repository });
    vi.spyOn(repository, 'addNote').mockRejectedValue(
      new ApiRequestError(400, 'note_too_long', 'capped'),
    );
    const mine = await screen.findByRole('region', { name: 'my note' });
    await user.type(within(mine).getByLabelText('New note'), 'one more');
    await user.click(within(mine).getByRole('button', { name: 'add a note' }));
    expect(await within(mine).findByRole('alert')).toHaveTextContent(
      'your notes for this spot are full.',
    );
    expect(within(mine).getByLabelText('New note')).toHaveValue('one more');
  });

  it('in Chinese too', async () => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
    renderAt('/place/mama-kos');
    expect(await screen.findByRole('button', { name: '标记去过' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '编辑这家店' })).toBeInTheDocument();
    localStorage.clear();
  });
});
