import { screen, waitFor, within } from '@testing-library/react';
import type { Photo } from '../contracts/photos';
import { ApiRequestError } from '../lib/api';
import { PhotoProcessError } from '../lib/photoProcess';
import { fakeFriendsClient, fakePhotosClient, renderAt } from '../test/render';

const photo = (n: number, extra: Partial<Photo> = {}): Photo => ({
  id: `ph_${String(n).padStart(26, '0')}`,
  width: 1600,
  height: 1200,
  bytes: 200_000,
  createdAt: '2026-10-15T12:00:00.000Z',
  url: `/api/photos/ph_${String(n).padStart(26, '0')}`,
  ...extra,
});
const file = (name = 'dinner.jpg') =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

beforeAll(() => {
  // jsdom has no object URLs
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

describe('place page photos', () => {
  it('starts with the empty frame and an add button that takes several images', async () => {
    renderAt('/place/lucky-thread');
    expect(await screen.findByText('no photo yet')).toBeInTheDocument();
    const picker = screen.getByLabelText('Add photos of this spot');
    expect(picker).toHaveAttribute('type', 'file');
    expect(picker).toHaveAttribute('accept', 'image/*');
    expect(picker).toHaveAttribute('multiple');
    expect(screen.getByText(/where they were taken is wiped/)).toBeInTheDocument();
  });

  it('shrinks, uploads and shows each picked photo', async () => {
    const photos = fakePhotosClient();
    const { user } = renderAt('/place/lucky-thread', { photos });
    await user.upload(await screen.findByLabelText('Add photos of this spot'), [
      file('a.jpg'),
      file('b.heic'),
    ]);
    expect(
      await screen.findByRole('button', { name: 'Photo 2 of 2, view larger' }),
    ).toBeInTheDocument();
    expect(photos.prepare).toHaveBeenCalledTimes(2);
    expect(photos.upload).toHaveBeenCalledTimes(2);
    expect(photos.upload.mock.calls[0]?.[0]).toBe('lucky-thread');
    expect(screen.queryByText('no photo yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Photo 1 of 2, view larger' })).toBeInTheDocument();
  });

  it('says how far along an upload is', async () => {
    const photos = fakePhotosClient();
    let finish: (p: Photo) => void = () => undefined;
    photos.upload.mockImplementation((_place, _prepared, onProgress) => {
      onProgress(0.42);
      return new Promise<Photo>((resolve) => {
        finish = resolve;
      });
    });
    const { user } = renderAt('/place/lucky-thread', { photos });
    await user.upload(await screen.findByLabelText('Add photos of this spot'), file());
    expect(await screen.findByText('uploading · 42%')).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('Add photos of this spot')).toBeDisabled();
    finish(photo(1));
    expect(await screen.findByRole('button', { name: 'Photo 1 of 1, view larger' })).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText(/uploading/)).not.toBeInTheDocument();
    });
  });

  it('only takes as many as the spot has room for', async () => {
    const photos = fakePhotosClient({
      'lucky-thread': { mine: [1, 2, 3, 4, 5].map((n) => photo(n)) },
    });
    const { user } = renderAt('/place/lucky-thread', { photos });
    await screen.findByRole('button', { name: 'Photo 1 of 5, view larger' });
    await user.upload(screen.getByLabelText('Add photos of this spot'), [
      file('1.jpg'),
      file('2.jpg'),
      file('3.jpg'),
    ]);
    expect(await screen.findByRole('alert')).toHaveTextContent('6 photos here, that’s the most.');
    await screen.findByRole('button', { name: 'Photo 6 of 6, view larger' });
    expect(photos.upload).toHaveBeenCalledTimes(1);
    // full: no add button any more
    expect(screen.queryByLabelText('Add photos of this spot')).not.toBeInTheDocument();
  });

  it('a photo the browser can’t read is a friendly message, the rest still go up', async () => {
    const photos = fakePhotosClient();
    photos.prepare.mockImplementationOnce(() =>
      Promise.reject(new PhotoProcessError('unreadable', 'nope')),
    );
    const { user } = renderAt('/place/lucky-thread', { photos });
    await user.upload(await screen.findByLabelText('Add photos of this spot'), [
      file('IMG_0001.HEIC'),
      file('ok.jpg'),
    ]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'couldn’t open “IMG_0001.HEIC”. if it’s a HEIC photo',
    );
    expect(await screen.findByRole('button', { name: 'Photo 1 of 1, view larger' })).toBeVisible();
  });

  it('the server’s no is said in words', async () => {
    const photos = fakePhotosClient();
    photos.upload.mockImplementation(() =>
      Promise.reject(new ApiRequestError(409, 'storage_full', 'full')),
    );
    const { user } = renderAt('/place/lucky-thread', { photos });
    await user.upload(await screen.findByLabelText('Add photos of this spot'), file());
    expect(await screen.findByRole('alert')).toHaveTextContent('your photos fill your 200 MB.');
  });

  it('opens a photo large, captions it, and deletes it after asking', async () => {
    const photos = fakePhotosClient({ 'lucky-thread': { mine: [photo(1), photo(2)] } });
    const { user } = renderAt('/place/lucky-thread', { photos });
    await user.click(await screen.findByRole('button', { name: 'Photo 2 of 2, view larger' }));
    const viewer = screen.getByRole('dialog');
    expect(within(viewer).getByRole('heading')).toHaveTextContent('photo · 2 / 2');
    await user.click(within(viewer).getByRole('button', { name: 'previous photo' }));
    expect(within(viewer).getByRole('heading')).toHaveTextContent('photo · 1 / 2');

    await user.type(within(viewer).getByLabelText('caption'), 'hand-pulled');
    await user.click(within(viewer).getByRole('button', { name: 'save' }));
    expect(photos.caption).toHaveBeenCalledWith(photo(1).id, 'hand-pulled');

    await user.click(within(viewer).getByRole('button', { name: 'delete photo' }));
    expect(photos.remove).not.toHaveBeenCalled();
    await user.click(within(viewer).getByRole('button', { name: 'yes, delete' }));
    expect(photos.remove).toHaveBeenCalledWith(photo(1).id);
    await waitFor(() => {
      expect(within(viewer).getByRole('heading')).toHaveTextContent('photo · 1 / 1');
    });
  });

  it('shows a friend’s photos under their take, view-only', async () => {
    const friends = fakeFriendsClient({
      'lucky-thread': [
        {
          friend: { id: 'u_ana', displayName: 'Ana', avatarEmoji: '🦊' },
          status: 'been',
          verdict: 'good',
        },
      ],
    });
    const photos = fakePhotosClient({
      'lucky-thread': { friends: { u_ana: [photo(7, { caption: 'the broth' })] } },
    });
    const { user } = renderAt('/place/lucky-thread', { friends, photos });
    const takes = await screen.findByRole('region', { name: 'friends’ verdicts' });
    await user.click(
      await within(takes).findByRole('button', { name: 'Ana’s photo 1 of 1, view larger' }),
    );
    const viewer = screen.getByRole('dialog');
    expect(within(viewer).getByRole('heading')).toHaveTextContent('Ana · 1 / 1');
    expect(within(viewer).getByText('the broth')).toBeInTheDocument();
    expect(within(viewer).queryByRole('button', { name: 'delete photo' })).not.toBeInTheDocument();
    expect(within(viewer).queryByLabelText('caption')).not.toBeInTheDocument();
  });
});
