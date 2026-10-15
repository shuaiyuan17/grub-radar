import { SpotListSchema } from '../contracts/spots';
import type { AddNote, AddSpot, MarkBeen, SpotPatch } from '../domain/edits';
import type { WritableSpotRepository } from '../domain/repository';
import { parseSpots, SpotSchema, type Spot } from '../domain/spot';
import { api, ApiRequestError, isUnauthorized } from '../lib/api';

/**
 * Your spots, from the Worker (/api/spots*). Every answer goes through the
 * same zod schema the domain uses, so a bad server response is an error in
 * the UI, not a broken card. A 401 anywhere means the session is gone.
 */
export class HttpSpotRepository implements WritableSpotRepository {
  readonly #onUnauthorized: () => void;

  constructor(onUnauthorized: () => void = () => undefined) {
    this.#onUnauthorized = onUnauthorized;
  }

  async #call(path: string, init?: { method: string; body?: unknown }): Promise<Response> {
    try {
      return await api(path, init);
    } catch (e) {
      if (isUnauthorized(e)) this.#onUnauthorized();
      throw e;
    }
  }

  async #spot(path: string, method: string, body: unknown): Promise<Spot> {
    return SpotSchema.parse(await (await this.#call(path, { method, body })).json());
  }

  async list(): Promise<Spot[]> {
    const raw: unknown = await (await this.#call('/api/spots')).json();
    // SpotListSchema: the wire shape; parseSpots: also checks ids are unique
    return parseSpots(SpotListSchema.parse(raw));
  }

  async get(id: string): Promise<Spot | null> {
    try {
      return SpotSchema.parse(await (await this.#call(spotPath(id))).json());
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 404) return null;
      throw e;
    }
  }

  add(input: AddSpot): Promise<Spot> {
    return this.#spot('/api/spots', 'POST', input);
  }

  update(id: string, patch: SpotPatch): Promise<Spot> {
    return this.#spot(spotPath(id), 'PATCH', patch);
  }

  markBeen(id: string, input: MarkBeen = {}): Promise<Spot> {
    return this.#spot(`${spotPath(id)}/been`, 'POST', input);
  }

  addNote(id: string, input: AddNote): Promise<Spot> {
    return this.#spot(`${spotPath(id)}/notes`, 'POST', input);
  }

  async remove(id: string): Promise<void> {
    await this.#call(spotPath(id), { method: 'DELETE' });
  }
}

const spotPath = (id: string) => `/api/spots/${encodeURIComponent(id)}`;
