/**
 * /api/spots*: your list, read and write. Every handler builds a
 * D1SpotRepository for the calling principal's user, so nothing here can
 * reach another user's rows.
 */
import { Hono, type Context } from 'hono';
import type { z } from 'zod/mini';
import {
  AddApplePlaceSchema,
  AddByQuerySchema,
  addSpotForm,
  type AddByQueryResponse,
} from '../../src/contracts/places';
import { parseNearbyQuery, RollBodySchema } from '../../src/contracts/spots';
import { SEED_SPOTS } from '../../src/data/seed';
import {
  AddNoteSchema,
  AddSpotSchema,
  MarkBeenSchema,
  SpotOpError,
  SpotPatchSchema,
  withLegacyRating,
} from '../../src/domain/edits';
import { parseSpots } from '../../src/domain/spot';
import { defer, type AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import {
  actingUser,
  isAgent,
  limitWrites,
  prefetched,
  requireScope,
  type Prefetch,
} from '../auth/principal';
import { sweepPhotoDeletions } from '../db/photos';
import { D1SpotRepository, listStatement, spotsFromRows } from '../db/spots';
import { homeFromResult } from '../db/users';
import { isDevelopment, type Env } from '../env';
import { apiError, parseBody, readBody, readJson } from '../lib/http';
import { AppleMapsError } from '../services/appleMaps';
import {
  addSpot,
  AmbiguousMatch,
  nearby,
  resolveOrigin,
  resolveSearchCentre,
  rollSpot,
  type AddRequest,
} from '../services/spots';
import { appleMapsFor, HOME_FOR_SEARCH, mapsError, overSearchLimit } from './places';

type Ctx = Context<AppEnv>;

function repoFor(c: Ctx) {
  const { userId, foundBy } = actingUser(c.var.principal);
  return new D1SpotRepository(c.env.DB, userId, {
    foundBy,
    // a removed spot's photos: their bytes go after the response (the outbox has them)
    photosDeleted: (keys) => {
      defer(c, sweepPhotoDeletions(c.env.DB, c.env.PHOTOS, { keys }));
    },
  });
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
    case 'verdict_needs_been':
      return apiError(c, 400, 'verdict_needs_been', e.message);
    case 'future_date':
      return apiError(c, 400, 'future_date', e.message);
    case 'list_full':
      return apiError(c, 409, 'list_full', e.message);
    case 'no_match':
      return apiError(c, 404, 'no_match', e.message);
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
  const origin = await resolveOrigin(c.env.DB, userId, q.origin, { coarse: isAgent(c) });
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

/**
 * `add_spot`, three ways (see addSpotForm):
 *   { name, kind, location, … }   by hand                                    -> Spot
 *   { applePlaceId, kind?, … }    a place from Apple Maps (Apple's name,
 *                                 location and address, in English)          -> Spot
 *   { query, near?, kind?, … }    the Apple Maps match for some words, only
 *                                 if it's clear (else 409 ambiguous + candidates;
 *                                 needs near or a saved home: 400 need_location)
 *                                 -> { spot, created, resolvedFrom, alternatives }
 * 201 when added; 200 when the place was already on your list (your entry
 * comes back, nothing written). The Apple forms also count against the
 * search brake.
 */
spots.post('/', ...write, async (c) => {
  const raw = await readBody(c);
  if (!raw.ok) return raw.res;
  const body = { ...raw, data: withLegacyRating(raw.data) };
  const form = addSpotForm(body.data);
  let req: AddRequest;
  if (form === 'manual') {
    const input = parseBody(c, AddSpotSchema, body.data);
    if (!input.ok) return input.res;
    req = { form, input: input.data };
  } else {
    const limited = await overSearchLimit(c);
    if (limited) return limited;
    if (form === 'apple') {
      const input = parseBody(c, AddApplePlaceSchema, body.data);
      if (!input.ok) return input.res;
      req = { form, input: input.data };
    } else {
      const input = parseBody(c, AddByQuerySchema, body.data);
      if (!input.ok) return input.res;
      const { userId } = actingUser(c.var.principal);
      const pre = prefetched(c, HOME_FOR_SEARCH);
      const centre = await resolveSearchCentre(
        c.env.DB,
        userId,
        input.data.near,
        pre ? homeFromResult(pre[0]) : undefined,
        { coarse: isAgent(c) },
      );
      if (!centre.ok) return noHome(c);
      if (!centre.near)
        return apiError(
          c,
          400,
          'need_location',
          'adding by words needs a place to search around: pass near, or save a home',
        );
      req = { form, input: input.data, near: centre.near };
    }
  }
  try {
    const added = await addSpot(repoFor(c), appleMapsFor(c), req);
    const status = added.created ? 201 : 200;
    if (req.form !== 'query') return c.json(added.spot, status);
    const body: AddByQueryResponse = {
      spot: added.spot,
      created: added.created,
      resolvedFrom: 'apple',
      alternatives: added.alternatives ?? [],
    };
    return c.json(body, status);
  } catch (e) {
    if (e instanceof AppleMapsError) return mapsError(c, e);
    if (e instanceof AmbiguousMatch)
      return c.json(
        { error: { code: 'ambiguous', message: e.message }, candidates: e.candidates },
        409,
      );
    return opError(c, e);
  }
});

spots.patch('/:id', ...write, async (c) => {
  const body = await readWrite(c, SpotPatchSchema);
  if (!body.ok) return body.res;
  try {
    return c.json(await repoFor(c).update(c.req.param('id'), body.data));
  } catch (e) {
    return opError(c, e);
  }
});

/** A write body, with a legacy 1-10 `rating` read as a verdict (see withLegacyRating). */
async function readWrite<T extends z.core.$ZodType>(c: Ctx, schema: T) {
  const body = await readBody(c);
  return body.ok ? parseBody(c, schema, withLegacyRating(body.data)) : body;
}

/** `mark_been` */
spots.post('/:id/been', ...write, async (c) => {
  const body = await readWrite(c, MarkBeenSchema);
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
  const origin = await resolveOrigin(c.env.DB, userId, body.data.origin, {
    coarse: isAgent(c),
  });
  if (!origin.ok) return noHome(c);
  return c.json({ spot: await rollSpot(repoFor(c), origin, body.data) });
});
