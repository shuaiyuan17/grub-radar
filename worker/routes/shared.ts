/**
 * GET /api/places/:id/shared: a place someone shared a link to.
 *
 * Session only (agents: 403; nobody: 401), so nothing about a place reaches
 * anyone before they sign in. Every signed-in caller gets the same `place`;
 * `friendsTakes` holds only their own friends' 'friends'-visible takes,
 * decided in SQL (worker/db/sharedPlace.ts). No such place, or not a place id
 * at all: the same 404, whoever has or hasn't got it.
 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { prefetched, requireSession, sessionUser, type Prefetch } from '../auth/principal';
import {
  isPlaceId,
  sharedPlace as readSharedPlace,
  sharedPlaceFromResults,
  sharedPlaceStatements,
} from '../db/sharedPlace';
import type { Env } from '../env';
import { apiError } from '../lib/http';

const SHARED = 'GET /api/places/:id/shared';
const PATH = /^\/api\/places\/([^/]+)\/shared$/;

/** The place id in a GET /api/places/:id/shared path, if it is one. */
const placeIdIn = (path: string): string | null => {
  const id = PATH.exec(path)?.[1];
  return id && isPlaceId(id) ? id : null;
};

/** Its reads, run in the session lookup's batch (see index.ts): one D1 round trip. */
export function sharedPlacePrefetch(c: Context<AppEnv>, env: Env): Prefetch | null {
  if (c.req.method !== 'GET') return null;
  const id = placeIdIn(c.req.path);
  return id
    ? { key: SHARED, statements: (scope) => sharedPlaceStatements(env.DB, scope, id) }
    : null;
}

export const sharedPlace = new Hono<AppEnv>();

sharedPlace.get('/:id/shared', requireSession, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const id = placeIdIn(c.req.path);
  const noSuchPlace = () => apiError(c, 404, 'not_found', 'no such place');
  if (!id) return noSuchPlace();
  const pre = prefetched(c, SHARED);
  const body = pre ? sharedPlaceFromResults(pre) : await readSharedPlace(c.env.DB, userId, id);
  return body ? c.json(body) : noSuchPlace();
});
