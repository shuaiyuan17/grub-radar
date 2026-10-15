/**
 * /api/spots*: your list, read and write. Every handler builds a
 * D1SpotRepository for the calling principal's user, so nothing here can
 * reach another user's rows.
 */
import { Hono, type Context } from 'hono';
import { parseNearbyQuery, RollBodySchema } from '../../src/contracts/spots';
import { SEED_SPOTS } from '../../src/data/seed';
import {
  AddNoteSchema,
  AddSpotSchema,
  MarkBeenSchema,
  SpotOpError,
  SpotPatchSchema,
} from '../../src/domain/edits';
import { parseSpots } from '../../src/domain/spot';
import type { AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import {
  actingUser,
  limitWrites,
  prefetched,
  requireScope,
  type Prefetch,
} from '../auth/principal';
import { D1SpotRepository, listStatement, spotsFromRows } from '../db/spots';
import { isDevelopment, type Env } from '../env';
import { apiError, readJson } from '../lib/http';
import { nearby, resolveOrigin, rollSpot } from '../services/spots';

type Ctx = Context<AppEnv>;

function repoFor(c: Ctx) {
  const { userId, foundBy } = actingUser(c.var.principal);
  return new D1SpotRepository(c.env.DB, userId, { foundBy });
}

/** SpotOpError -> HTTP; anything else goes to the 500 handler. */
function opError(c: Ctx, e: unknown): Response {
  if (!(e instanceof SpotOpError)) throw e;
  switch (e.code) {
    case 'not_found':
      return apiError(c, 404, 'not_found', 'no such spot');
    case 'not_editable':
      return apiError(c, 403, 'not_editable', e.message);
    case 'conflict':
      return apiError(c, 409, 'conflict', e.message);
    case 'note_too_long':
      return apiError(c, 400, 'note_too_long', e.message);
    case 'rating_needs_been':
      return apiError(c, 400, 'rating_needs_been', e.message);
    case 'future_date':
      return apiError(c, 400, 'future_date', e.message);
    case 'list_full':
      return apiError(c, 409, 'list_full', e.message);
  }
}

const noHome = (c: Ctx) =>
  apiError(c, 400, 'no_home', 'no home saved: set one, or pass origin=lat,lng');

export const spots = new Hono<AppEnv>();

const read = requireScope('spots:read');
// writes: scope, then CSRF, then the per-user brake (so refused requests don't count)
const write = [requireScope('spots:write'), csrf, limitWrites] as const;

const LIST = 'GET /api/spots';

/** The list, read in the session lookup's batch (see index.ts): one D1 round trip. */
export const spotsPrefetch = (env: Env): Prefetch => ({
  key: LIST,
  statements: (scope) => [listStatement(env.DB, scope)],
});

spots.get('/', read, async (c) => {
  const pre = prefetched(c, LIST);
  return c.json(pre ? spotsFromRows(pre[0]) : await repoFor(c).list());
});

/** `find_nearby` */
spots.get('/nearby', read, async (c) => {
  const q = parseNearbyQuery(new URL(c.req.url).searchParams);
  if ('error' in q) return apiError(c, 400, 'bad_request', q.error);
  const { userId } = actingUser(c.var.principal);
  const origin = await resolveOrigin(c.env.DB, userId, q.origin);
  if (!origin.ok) return noHome(c);
  return c.json({ spots: await nearby(repoFor(c), origin, q) });
});

/** Dev/test only: the fictional demo spots onto your list. 404 anywhere else. */
spots.post('/import-demo', ...write, async (c) => {
  if (!isDevelopment(c.env)) return apiError(c, 404, 'not_found', 'no such endpoint');
  const added = await repoFor(c).importDemo(parseSpots(SEED_SPOTS));
  return c.json({ added });
});

spots.get('/:id', read, async (c) => {
  const spot = await repoFor(c).get(c.req.param('id'));
  return spot ? c.json(spot) : apiError(c, 404, 'not_found', 'no such spot');
});

/** `add_spot` (manual: name + location + kind; Apple places come in PR 3) */
spots.post('/', ...write, async (c) => {
  const body = await readJson(c, AddSpotSchema);
  if (!body.ok) return body.res;
  try {
    return c.json(await repoFor(c).add(body.data), 201);
  } catch (e) {
    return opError(c, e);
  }
});

spots.patch('/:id', ...write, async (c) => {
  const body = await readJson(c, SpotPatchSchema);
  if (!body.ok) return body.res;
  try {
    return c.json(await repoFor(c).update(c.req.param('id'), body.data));
  } catch (e) {
    return opError(c, e);
  }
});

/** `mark_been` */
spots.post('/:id/been', ...write, async (c) => {
  const body = await readJson(c, MarkBeenSchema);
  if (!body.ok) return body.res;
  try {
    return c.json(await repoFor(c).markBeen(c.req.param('id'), body.data));
  } catch (e) {
    return opError(c, e);
  }
});

/** `add_note` */
spots.post('/:id/notes', ...write, async (c) => {
  const body = await readJson(c, AddNoteSchema);
  if (!body.ok) return body.res;
  try {
    return c.json(await repoFor(c).addNote(c.req.param('id'), body.data));
  } catch (e) {
    return opError(c, e);
  }
});

spots.delete('/:id', ...write, async (c) => {
  try {
    await repoFor(c).remove(c.req.param('id'));
    return c.body(null, 204);
  } catch (e) {
    return opError(c, e);
  }
});

/** POST /api/roll: `roll`. A read, but POST so agents can send a body. */
export const rollRoute = new Hono<AppEnv>();

rollRoute.post('/', read, csrf, async (c) => {
  const body = await readJson(c, RollBodySchema);
  if (!body.ok) return body.res;
  const { userId } = actingUser(c.var.principal);
  const origin = await resolveOrigin(c.env.DB, userId, body.data.origin);
  if (!origin.ok) return noHome(c);
  return c.json({ spot: await rollSpot(repoFor(c), origin, body.data) });
});
