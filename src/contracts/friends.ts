import { z } from 'zod/mini';
import { DATA_LANGS, KINDS, LatLngSchema, PRICES, STATUSES, VerdictSchema } from '../domain/spot';

/**
 * Wire shapes for friends: /api/friends* and /api/invites*.
 *
 * The friend model: the only way to become friends is an invite link. Sending
 * one is consent; whoever opens it, signs in and accepts becomes your friend,
 * both ways, at once. Either side can unfriend, for both.
 *
 * What a friend sees of you is exactly what these schemas carry, and the
 * Worker selects only these columns, in SQL: your name and emoji, and your
 * spots whose visibility is 'friends' (the place, kind, cuisine, price,
 * been/want, verdict and one-liner). Never your home, never `myNote`, never a
 * private spot, never why/order/tags.
 */

/** Most friends one person can have. */
export const FRIEND_LIMIT = 200;
/** Invite links one person can make in 24 hours. */
export const INVITES_PER_DAY = 20;
/** How long an invite link works for. */
export const INVITE_TTL_DAYS = 7;

/** An invite link's secret part: 32 random bytes, base64url (43 characters). */
export const InviteTokenSchema = z
  .string()
  .check(z.regex(/^[A-Za-z0-9_-]{43}$/, 'not an invite link'));

/**
 * Where an invite link points, in the app: `/invite#<token>`. The token rides
 * in the fragment, which browsers never send to a server: not in requests, not
 * in Referer, not in sign-in's returnTo (which is just `/invite`).
 */
export const INVITE_ROUTE = '/invite';
export const invitePath = (token: string) => `${INVITE_ROUTE}#${token}`;

/**
 * Someone's name as other people see it: null while they haven't chosen one
 * (Apple didn't send it and they haven't saved one yet). Show a placeholder
 * then, never the stand-in name their own account carries.
 */
export const PublicNameSchema = z.nullable(z.string());

/** Someone, as other people see them. */
export const PersonSchema = z.strictObject({
  id: z.string(),
  displayName: PublicNameSchema,
  avatarEmoji: z.string(),
});
export type Person = z.infer<typeof PersonSchema>;

export const FriendSchema = z.strictObject({
  ...PersonSchema.shape,
  /** When you became friends (ISO). */
  since: z.string(),
});
export type Friend = z.infer<typeof FriendSchema>;

/** GET /api/friends */
export const FriendsResponseSchema = z.strictObject({
  friends: z.array(FriendSchema),
  limit: z.number(),
});
export type FriendsResponse = z.infer<typeof FriendsResponseSchema>;

/** One of your links nobody has used yet (the link itself was shown once, at creation). */
export const PendingInviteSchema = z.strictObject({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type PendingInvite = z.infer<typeof PendingInviteSchema>;

/** GET /api/invites: your unused, unexpired, unrevoked links, newest first. */
export const InvitesResponseSchema = z.strictObject({
  invites: z.array(PendingInviteSchema),
});
export type InvitesResponse = z.infer<typeof InvitesResponseSchema>;

/** POST /api/invites (201). `token` is shown this once; only its hash is kept. */
export const CreatedInviteSchema = z.strictObject({
  ...PendingInviteSchema.shape,
  token: InviteTokenSchema,
  /** `/invite#<token>`: put the app's origin in front. */
  path: z.string(),
});
export type CreatedInvite = z.infer<typeof CreatedInviteSchema>;

/** Body of POST /api/invites/preview and /accept. The token never travels in a URL path. */
export const InviteTokenBodySchema = z.strictObject({ token: InviteTokenSchema });

/**
 * POST /api/invites/preview: who sent this link, and what accepting would do.
 *   open:    accept makes you friends
 *   own:     it's your own link
 *   friends: you're already friends (accepting changes nothing, uses nothing)
 * A link that can't be used is a 410 invite_gone instead.
 */
export const INVITE_STATES = ['open', 'own', 'friends'] as const;
export const InvitePreviewSchema = z.strictObject({
  from: z.strictObject({ displayName: PublicNameSchema, avatarEmoji: z.string() }),
  state: z.enum(INVITE_STATES),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

/** POST /api/invites/accept: 201 now friends; 200 `already` when you were before. */
export const AcceptInviteResponseSchema = z.strictObject({
  friend: FriendSchema,
  already: z.boolean(),
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;

/** A friend's take on a place that's also on your list. */
export const FriendTakeSchema = z.strictObject({
  friend: PersonSchema,
  status: z.enum(STATUSES),
  verdict: z.optional(VerdictSchema),
  /** Their one-liner. */
  note: z.optional(z.string()),
  /** The language their one-liner is in. */
  lang: z.optional(z.enum(DATA_LANGS)),
});
export type FriendTake = z.infer<typeof FriendTakeSchema>;

/** GET /api/friends/places: for each place on your list, friends who have it on theirs. */
export const FriendPlacesResponseSchema = z.strictObject({
  places: z.record(z.string(), z.array(FriendTakeSchema)),
});
export type FriendPlacesResponse = z.infer<typeof FriendPlacesResponseSchema>;

/** A spot on a friend's list, as they share it. */
export const FriendSpotSchema = z.strictObject({
  /** The place id (same as your spot's id when it's on your list too). */
  id: z.string(),
  name: z.string(),
  address: z.optional(z.string()),
  location: LatLngSchema,
  kind: z.enum(KINDS),
  cuisine: z.optional(z.string()),
  price: z.optional(z.enum(PRICES)),
  status: z.enum(STATUSES),
  verdict: z.optional(VerdictSchema),
  note: z.optional(z.string()),
  lang: z.optional(z.enum(DATA_LANGS)),
});
export type FriendSpot = z.infer<typeof FriendSpotSchema>;

/** GET /api/friends/:id/spots (404 unless you're friends). */
export const FriendSpotsResponseSchema = z.strictObject({
  friend: FriendSchema,
  spots: z.array(FriendSpotSchema),
});
export type FriendSpotsResponse = z.infer<typeof FriendSpotsResponseSchema>;
