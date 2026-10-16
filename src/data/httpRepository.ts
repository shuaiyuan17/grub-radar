import type { AddApplePlaceInput, AddSharedPlaceInput } from '../contracts/places';
import { SpotListSchema } from '../contracts/spots';
import type { AddNote, AddSpot, MarkBeen, SpotPatch } from '../domain/edits';
import type { WritableSpotRepository } from '../domain/repository';
import { parseSpots, SpotSchema, type Spot } from '../domain/spot';
import { api, ApiRequestError, isUnauthorized } from '../lib/api';
import type { ApplePlaceAdder, SharedPlaceAdder } from '../lib/spots';

/**
 * Your spots, from the Worker (/api/spots*). Every answer goes through the
 * same zod schema the domain uses, so a bad server response is an error in
 * the UI, not a broken card. A 401 anywhere means the session is gone.
 */
const SPOT_KEYS = new Set(Object.keys(SpotSchema.shape));
/**
 * A spot from the server, minus top-level fields this bundle doesn't know:
 * an additive server change (a new field) must not break an open older tab.
 * Everything this bundle does know is still checked strictly.
 */
function knownFields(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => SPOT_KEYS.has(k)));
}
const parseSpot = (raw: unknown): Spot => SpotSchema.parse(knownFields(raw));

/** A primed list older than this isn't handed out; list() fetches afresh. */
const PRIMED_FOR_MS = 30_000;

export class HttpSpotRepository
  implements WritableSpotRepository, ApplePlaceAdder, SharedPlaceAdder
{
  readonly #onUnauthorized: () => void;
  #primed: { at: number; list: Promise<Spot[]> } | null = null;

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
    return parseSpot(await (await this.#call(path, { method, body })).json());
  }

  /**
   * Starts GET /api/spots now, alongside GET /api/me, instead of after it: the
   * first list() within 30 s gets this answer. Signed out, it's a quick 401
   * (no database work on the server) and nothing else happens.
   */
  prime(now = Date.now()): void {
    if (this.#primed) return;
    const list = this.#fetchList();
    list.catch(() => undefined); // nobody may ask; the error goes to whoever does
    this.#primed = { at: now, list };
  }

  list(now = Date.now()): Promise<Spot[]> {
    const primed = this.#primed;
    this.#primed = null;
    if (primed && now - primed.at <= PRIMED_FOR_MS) return primed.list;
    return this.#fetchList();
  }

  async #fetchList(): Promise<Spot[]> {
    const raw: unknown = await (await this.#call('/api/spots')).json();
    // SpotListSchema: the wire shape; parseSpots: also checks ids are unique
    return parseSpots(SpotListSchema.parse(Array.isArray(raw) ? raw.map(knownFields) : raw));
  }

  async get(id: string): Promise<Spot | null> {
    try {
      return parseSpot(await (await this.#call(spotPath(id))).json());
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 404) return null;
      throw e;
    }
  }

  add(input: AddSpot): Promise<Spot> {
    return this.#spot('/api/spots', 'POST', input);
  }

  /** POST /api/spots { applePlaceId, … }: 201 new, 200 if it was already on your list. */
  addApplePlace(input: AddApplePlaceInput): Promise<Spot> {
    return this.#spot('/api/spots', 'POST', input);
  }

  /** POST /api/spots { placeId, … }: 201 new, 200 if it was already on your list. */
  addSharedPlace(input: AddSharedPlaceInput): Promise<Spot> {
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
