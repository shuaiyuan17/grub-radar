/**
 * /api/places*: Apple Maps places, for adding a spot. Only ever answers a
 * search or a lookup; your list and radar never show Apple's places.
 *
 *   GET /api/places/search?q=&near=home|lat,lng&lang=   `search_places`
 *   POST /api/places/search { q, near?, lang? }          the same, location in the body
 *   GET /api/places/:applePlaceId?lang=
 *
 * Signed in (or, from PR 5, an agent with spots:read), and braked per user
 * (SEARCH_LIMITER) because every miss here spends Apple's daily quota.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import {
  parsePlaceSearchBody,
  parsePlaceSearchQuery,
  type PlaceSearchQuery,
} from '../../src/contracts/places';
import { ApplePlaceIdSchema, DATA_LANGS, type DataLang } from '../../src/domain/spot';
import type { AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import { actingUser, requireScope } from '../auth/principal';
import { apiError, readBody } from '../lib/http';
import { AppleMaps, AppleMapsError } from '../services/appleMaps';
import { resolveSearchCentre } from '../services/spots';

type Ctx = Context<AppEnv>;

/** AppleMaps for this request: cache writes finish after the response. */
export function appleMapsFor(c: Ctx): AppleMaps {
  return new AppleMaps(c.env, {
    waitUntil: (p) => {
      c.executionCtx.waitUntil(p);
    },
  });
}

/** AppleMapsError -> HTTP; anything else goes to the 500 handler. */
export function mapsError(c: Ctx, e: unknown): Response {
  if (!(e instanceof AppleMapsError)) throw e;
  if (e.kind === 'not_found') return apiError(c, 404, 'not_found', 'no such place on Apple Maps');
  c.header('Retry-After', e.kind === 'quota' ? '3600' : '30');
  return apiError(
    c,
    503,
    'maps_unavailable',
    e.kind === 'quota' ? "Apple Maps' daily quota is used up" : "Apple Maps isn't answering",
  );
}

/**
 * Per-user brake on Apple Maps calls (SEARCH_LIMITER: 30/min): the 429 to
 * send, or null to go on. Run after the auth check.
 */
export async function overSearchLimit(c: Ctx): Promise<Response | null> {
  const { userId } = actingUser(c.var.principal);
  const { success } = await c.env.SEARCH_LIMITER.limit({ key: `search:${userId}` });
  return success ? null : apiError(c, 429, 'rate_limited', 'slow down');
}

const limitSearch: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limited = await overSearchLimit(c);
  if (limited) return limited;
  await next();
};

export const places = new Hono<AppEnv>();

places.use(requireScope('spots:read'), limitSearch);

/** `search_places`: restaurants, cafés and bakeries on Apple Maps, best match first. */
async function search(c: Ctx, q: PlaceSearchQuery | { error: string }): Promise<Response> {
  if ('error' in q) return apiError(c, 400, 'bad_request', q.error);
  const { userId } = actingUser(c.var.principal);
  const centre = await resolveSearchCentre(c.env.DB, userId, q.near);
  if (!centre.ok)
    return apiError(c, 400, 'no_home', 'no home saved: set one, or pass near=lat,lng');
  try {
    const found = await appleMapsFor(c).search({
      q: q.q,
      lang: q.lang,
      ...(centre.near ? { near: centre.near } : {}),
    });
    // the centre is never echoed back: with near=home it would be your home
    return c.json({ places: found });
  } catch (e) {
    return mapsError(c, e);
  }
}

/** For agents and curl: everything in the query string. */
places.get('/search', (c) => search(c, parsePlaceSearchQuery(new URL(c.req.url).searchParams)));

/**
 * The app's form: `{ q, near?, lang? }` in a JSON body, so where you are
 * (a home kept on this device, "where i am") never lands in a URL or an
 * access log. A read, so no write brake; CSRF-checked like any POST.
 */
places.post('/search', csrf, async (c) => {
  const body = await readBody(c);
  if (!body.ok) return body.res;
  return search(c, parsePlaceSearchBody(body.data));
});

places.get('/:applePlaceId', async (c) => {
  const id = ApplePlaceIdSchema.safeParse(c.req.param('applePlaceId'));
  if (!id.success) return apiError(c, 400, 'bad_request', 'not an Apple Maps place id');
  const lang = c.req.query('lang') ?? 'en';
  if (!(DATA_LANGS as readonly string[]).includes(lang))
    return apiError(c, 400, 'bad_request', `lang is one of ${DATA_LANGS.join(', ')}`);
  try {
    return c.json(await appleMapsFor(c).place(id.data, lang as DataLang));
  } catch (e) {
    return mapsError(c, e);
  }
});
