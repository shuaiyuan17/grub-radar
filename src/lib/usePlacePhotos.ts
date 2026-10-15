import { useCallback, useEffect, useState } from 'react';
import type { Photo, PlacePhotosResponse } from '../contracts/photos';
import { usePhotosClient } from './photos';

export interface PlacePhotosState {
  /** null until loaded (and when loading failed: photos are decoration, not data you need). */
  data: PlacePhotosResponse | null;
  /** Your photo, uploaded: appended in place, no refetch. */
  added: (photo: Photo) => void;
  /** Your photo, deleted or re-captioned. */
  removed: (id: string) => void;
  replaced: (photo: Photo) => void;
}

/** Your photos of a place and your friends', for the place page. */
export function usePlacePhotos(placeId: string | undefined, enabled: boolean): PlacePhotosState {
  const client = usePhotosClient();
  const [data, setData] = useState<PlacePhotosResponse | null>(null);

  useEffect(() => {
    if (!placeId || !enabled) return;
    let live = true;
    client.forPlace(placeId).then(
      (next) => {
        if (live) setData(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
      setData(null);
    };
  }, [client, placeId, enabled]);

  const added = useCallback((photo: Photo) => {
    setData((d) =>
      d
        ? {
            ...d,
            mine: [...d.mine, photo],
            usage: { ...d.usage, bytes: d.usage.bytes + photo.bytes },
          }
        : d,
    );
  }, []);
  const removed = useCallback((id: string) => {
    setData((d) => {
      if (!d) return d;
      const gone = d.mine.find((p) => p.id === id);
      return {
        ...d,
        mine: d.mine.filter((p) => p.id !== id),
        usage: { ...d.usage, bytes: d.usage.bytes - (gone?.bytes ?? 0) },
      };
    });
  }, []);
  const replaced = useCallback((photo: Photo) => {
    setData((d) => (d ? { ...d, mine: d.mine.map((p) => (p.id === photo.id ? photo : p)) } : d));
  }, []);

  return { data, added, removed, replaced };
}
