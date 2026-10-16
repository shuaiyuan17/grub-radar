/**
 * A shared place (GET /api/places/:id/shared): what a /place/:id link shows a
 * signed-in person who doesn't have that spot on their list.
 *
 * Three reads, one batch (they ride along with the session lookup):
 *   1. the `places` row: name, where, address. Never `created_by`, never
 *      anything from anyone's `user_places`, so it says nothing about who has
 *      the place, or whether anyone does;
 *   2. your friends' takes on it (worker/db/friends.ts), and
 *   3. their photos of it (worker/db/photos.ts): both through your own
 *      `friendships` rows, 'friends'-visible entries only, decided in SQL.
 */
import type { SharedPlace, SharedPlaceResponse } from '../../src/contracts/shared';
import { friendTakesOnPlaceFromResult, friendTakesOnPlaceStatement } from './friends';
import { friendPhotosFromResult, friendPhotosStatement } from './photos';
import { userIdRef, type UserRef } from './users';

/** A place id as spots use them (SpotSchema's id rule); anything else is "no such place". */
const PLACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isPlaceId = (id: string) => id.length <= 100 && PLACE_ID.test(id);

interface PlaceRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
}

export function sharedPlaceStatements(
  db: D1Database,
  viewer: UserRef,
  placeId: string,
): D1PreparedStatement[] {
  return [
    db.prepare('SELECT id, name, lat, lng, address FROM places WHERE id = ?').bind(placeId),
    friendTakesOnPlaceStatement(db, viewer, placeId),
    friendPhotosStatement(db, viewer, placeId),
  ];
}

/** The answer, or null when there's no such place. */
export function sharedPlaceFromResults(results: D1Result[]): SharedPlaceResponse | null {
  const [placeRes, takesRes, photosRes] = results;
  const row = (placeRes?.results as PlaceRow[] | undefined)?.[0];
  if (!row) return null;
  const place: SharedPlace = {
    id: row.id,
    name: row.name,
    ...(row.address ? { address: row.address } : {}),
    location: { lat: row.lat, lng: row.lng },
  };
  const photos = friendPhotosFromResult(photosRes);
  const friendsTakes = friendTakesOnPlaceFromResult(takesRes).map((take) => ({
    ...take,
    photos: photos[take.friend.id] ?? [],
  }));
  return { place, friendsTakes };
}

export async function sharedPlace(
  db: D1Database,
  viewerId: string,
  placeId: string,
): Promise<SharedPlaceResponse | null> {
  return sharedPlaceFromResults(
    await db.batch(sharedPlaceStatements(db, userIdRef(viewerId), placeId)),
  );
}
