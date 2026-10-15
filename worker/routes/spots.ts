/**
 * PR 1 stopgap: the demo spots, served only to signed-in people (the login
 * wall means nothing is public). PR 2 replaces this with D1SpotRepository.
 */
import { Hono } from 'hono';
import { SEED_SPOTS } from '../../src/data/seed';
import { parseSpots, type Spot } from '../../src/domain/spot';
import type { AppEnv } from '../app';
import { requireSession } from '../auth/principal';
import { apiError } from '../lib/http';

let cached: Spot[] | null = null;
const demoSpots = () => (cached ??= parseSpots(SEED_SPOTS));

export const spots = new Hono<AppEnv>();

spots.use(requireSession);

spots.get('/', (c) => c.json(demoSpots()));

spots.get('/:id', (c) => {
  const spot = demoSpots().find((s) => s.id === c.req.param('id'));
  return spot ? c.json(spot) : apiError(c, 404, 'not_found', 'no such spot');
});
