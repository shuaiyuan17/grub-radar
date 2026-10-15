/**
 * /api/friends* and /api/invites*: friends, by invite link only.
 *
 * Session only: a person's own browser. Agents don't reach any of this yet
 * (the `friends:read` scope is reserved for them, not wired). What a friend
 * can see is decided in SQL (worker/db/friends.ts), never filtered here.
 */
import { Hono, type Context } from 'hono';
import {
  FRIEND_LIMIT,
  InviteTokenBodySchema,
  invitePath,
  type AcceptInviteResponse,
  type CreatedInvite,
  type FriendPlacesResponse,
  type FriendsResponse,
  type FriendSpotsResponse,
  type InvitesResponse,
} from '../../src/contracts/friends';
import type { AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import {
  limitWrites,
  prefetched,
  requireSession,
  sessionUser,
  type Prefetch,
} from '../auth/principal';
import {
  acceptInvite,
  createInvite,
  friendPlacesFromResult,
  friendPlacesStatement,
  friendsFromResult,
  friendsStatement,
  friendSpots,
  listInvites,
  previewInvite,
  revokeInvite,
  unfriend,
} from '../db/friends';
import { userIdRef } from '../db/users';
import type { Env } from '../env';
import { apiError, readJson } from '../lib/http';

const write = [csrf, limitWrites] as const;

const gone = (c: Context<AppEnv>) =>
  apiError(c, 410, 'invite_gone', 'this invite link has been used, revoked or has expired');

// ---------------------------------------------------------------------------
// /api/friends

export const friends = new Hono<AppEnv>();
friends.use(requireSession);

const LIST = 'GET /api/friends';
const PLACES = 'GET /api/friends/places';

/** The hot reads, run in the session lookup's batch (see index.ts): one round trip. */
export const friendsPrefetch = (env: Env): Prefetch => ({
  key: LIST,
  statements: (scope) => [friendsStatement(env.DB, scope)],
});
export const friendPlacesPrefetch = (env: Env): Prefetch => ({
  key: PLACES,
  statements: (scope) => [friendPlacesStatement(env.DB, scope)],
});

friends.get('/', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const result =
    prefetched(c, LIST)?.[0] ?? (await friendsStatement(c.env.DB, userIdRef(userId)).all());
  const body: FriendsResponse = { friends: friendsFromResult(result), limit: FRIEND_LIMIT };
  return c.json(body);
});

/** Your friends' takes on the places on your list (avatars on cards, verdicts on the place page). */
friends.get('/places', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const result =
    prefetched(c, PLACES)?.[0] ?? (await friendPlacesStatement(c.env.DB, userIdRef(userId)).all());
  const body: FriendPlacesResponse = { places: friendPlacesFromResult(result) };
  return c.json(body);
});

/** A friend's shared list. 404 for anyone who isn't your friend (or doesn't exist). */
friends.get('/:id/spots', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const found = await friendSpots(c.env.DB, userId, c.req.param('id'));
  if (!found) return apiError(c, 404, 'not_found', 'no such friend');
  const body: FriendSpotsResponse = found;
  return c.json(body);
});

/** Unfriend: ends it for both of you. */
friends.delete('/:id', ...write, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const done = await unfriend(c.env.DB, userId, c.req.param('id'));
  return done ? c.body(null, 204) : apiError(c, 404, 'not_found', 'no such friend');
});

// ---------------------------------------------------------------------------
// /api/invites

export const invites = new Hono<AppEnv>();
invites.use(requireSession);

/** Your links that still work. */
invites.get('/', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const body: InvitesResponse = { invites: await listInvites(c.env.DB, userId) };
  return c.json(body);
});

/** A new link (201). The token is in this answer only; the server keeps its hash. */
invites.post('/', ...write, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const made = await createInvite(c.env.DB, userId);
  if (made === 'limit')
    return apiError(c, 429, 'invite_limit', 'that is a lot of invite links for one day');
  const body: CreatedInvite = { ...made, path: invitePath(made.token) };
  return c.json(body, 201);
});

/**
 * Who sent a link and what accepting it would do. A POST (with the token in
 * the body) so tokens never sit in URLs, logs or the Referer.
 */
invites.post('/preview', csrf, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const body = await readJson(c, InviteTokenBodySchema);
  if (!body.ok) return body.res;
  const preview = await previewInvite(c.env.DB, userId, body.data.token);
  return preview ? c.json(preview) : gone(c);
});

/** Accept: you and the sender are friends, both ways, now. */
invites.post('/accept', ...write, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const body = await readJson(c, InviteTokenBodySchema);
  if (!body.ok) return body.res;
  const outcome = await acceptInvite(c.env.DB, userId, body.data.token);
  switch (outcome.kind) {
    case 'accepted':
    case 'already': {
      const res: AcceptInviteResponse = {
        friend: outcome.friend,
        already: outcome.kind === 'already',
      };
      return c.json(res, outcome.kind === 'accepted' ? 201 : 200);
    }
    case 'own':
      return apiError(c, 400, 'own_invite', "that's your own invite link");
    case 'limit':
      return apiError(
        c,
        409,
        'friend_limit',
        `one of you already has ${String(FRIEND_LIMIT)} friends`,
      );
    case 'gone':
      return gone(c);
  }
});

/** Revoke one of your unused links. */
invites.delete('/:id', ...write, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const done = await revokeInvite(c.env.DB, userId, c.req.param('id'));
  return done ? c.body(null, 204) : apiError(c, 404, 'not_found', 'no such invite link');
});
