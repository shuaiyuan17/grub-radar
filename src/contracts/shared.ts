import { z } from 'zod/mini';
import { KINDS, LatLngSchema } from '../domain/spot';
import { FriendTakeSchema } from './friends';
import { PhotoSchema } from './photos';

/**
 * Wire shapes for a shared place: GET /api/places/:id/shared, what a
 * /place/:id link shows someone who doesn't have that spot on their list.
 *
 * `place` is only what the shared `places` row says a place *is* (name,
 * address, where), the same for every signed-in caller. Who created it, who
 * has it, and anyone's notes are never in it.
 *
 * `friendsTakes` is your friends' takes on it, exactly what the friends
 * section of a place page shows: decided in SQL from your own friendships,
 * only their 'friends'-visible entries. A non-friend gets `[]` whether or not
 * anyone has the place.
 */

export const SharedPlaceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  address: z.optional(z.string()),
  location: LatLngSchema,
});
export type SharedPlace = z.infer<typeof SharedPlaceSchema>;

/** A friend's take, with the kind they filed it under and their photos of it. */
export const SharedTakeSchema = z.strictObject({
  ...FriendTakeSchema.shape,
  kind: z.enum(KINDS),
  photos: z.array(PhotoSchema),
});
export type SharedTake = z.infer<typeof SharedTakeSchema>;

/** GET /api/places/:id/shared (404 not_found when there's no such place). */
export const SharedPlaceResponseSchema = z.strictObject({
  place: SharedPlaceSchema,
  friendsTakes: z.array(SharedTakeSchema),
});
export type SharedPlaceResponse = z.infer<typeof SharedPlaceResponseSchema>;

export const sharedPlacePath = (id: string) => `/api/places/${encodeURIComponent(id)}/shared`;
