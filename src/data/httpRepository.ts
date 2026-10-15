import type { SpotRepository } from '../domain/repository';
import { parseSpots, SpotSchema, type Spot } from '../domain/spot';
import { api, ApiRequestError, isUnauthorized } from '../lib/api';

/**
 * Spots from the Worker (GET /api/spots), signed-in only. Every response goes
 * through the same zod schema the static data used, so a bad server answer is
 * an error in the UI, not a broken card.
 */
export class HttpSpotRepository implements SpotRepository {
  readonly #onUnauthorized: () => void;

  constructor(onUnauthorized: () => void = () => undefined) {
    this.#onUnauthorized = onUnauthorized;
  }

  async #get(path: string): Promise<unknown> {
    try {
      return await (await api(path)).json();
    } catch (e) {
      if (isUnauthorized(e)) this.#onUnauthorized();
      throw e;
    }
  }

  async list(): Promise<Spot[]> {
    return parseSpots(await this.#get('/api/spots'));
  }

  async get(id: string): Promise<Spot | null> {
    try {
      return SpotSchema.parse(await this.#get(`/api/spots/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 404) return null;
      throw e;
    }
  }
}
