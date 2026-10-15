import {
  applyAddNote,
  applyMarkBeen,
  applyPatch,
  spotFromInput,
  SpotOpError,
  type AddNote,
  type AddSpot,
  type MarkBeen,
  type SpotPatch,
} from '../domain/edits';
import { AddApplePlaceSchema, type AddApplePlaceInput, type ApplePlace } from '../contracts/places';
import type { WritableSpotRepository } from '../domain/repository';
import { parseSpots, type Spot } from '../domain/spot';
import type { ApplePlaceAdder } from '../lib/spots';

/**
 * A writable list in memory, for tests and local experiments. Runs the same
 * domain edit functions as the Worker's D1 repository, so the UI sees the
 * same behaviour. Synchronous `snapshot()`, so no loading flash in tests.
 */
export class MemorySpotRepository implements WritableSpotRepository, ApplePlaceAdder {
  #spots: Spot[];
  #seq = 0;
  readonly #today: () => string;
  readonly #apple: readonly ApplePlace[];

  /** `applePlaces`: what "Apple Maps" knows, for addApplePlace. */
  constructor(
    input: unknown = [],
    opts: { today?: () => string; applePlaces?: readonly ApplePlace[] } = {},
  ) {
    this.#apple = opts.applePlaces ?? [];
    // versions like the server's: 1 when stored, +1 on every write
    this.#spots = parseSpots(input).map((s) => ({ ...s, version: s.version ?? 1 }));
    this.#today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  }

  snapshot(): Spot[] {
    return [...this.#spots];
  }

  list(): Promise<Spot[]> {
    return Promise.resolve(this.snapshot());
  }

  get(id: string): Promise<Spot | null> {
    return Promise.resolve(this.#spots.find((s) => s.id === id) ?? null);
  }

  add(input: AddSpot): Promise<Spot> {
    const spot = {
      ...spotFromInput(`p-mem-${String(++this.#seq)}`, input, this.#today()),
      version: 1,
    };
    this.#spots = [...this.#spots, spot];
    return Promise.resolve(spot);
  }

  /** Like the server: one entry per Apple place, the existing one comes back. */
  addApplePlace(raw: AddApplePlaceInput): Promise<Spot> {
    // `lang` only matters to Apple; spotFromInput reads the spot's own fields
    const { applePlaceId, ...input } = AddApplePlaceSchema.parse(raw);
    const mine = this.#spots.find((s) => s.applePlaceId === applePlaceId);
    if (mine) return Promise.resolve(mine);
    const place = this.#apple.find((p) => p.applePlaceId === applePlaceId);
    if (!place) return Promise.reject(new SpotOpError('not_found', 'no such place on Apple Maps'));
    const spot = {
      ...spotFromInput(
        `p-mem-${String(++this.#seq)}`,
        {
          ...input,
          name: place.name,
          location: place.location,
          kind: input.kind ?? place.kind ?? 'food',
        },
        this.#today(),
        { applePlaceId, ...(place.address ? { address: place.address } : {}) },
      ),
      version: 1,
    };
    this.#spots = [...this.#spots, spot];
    return Promise.resolve(spot);
  }

  update(id: string, patch: SpotPatch): Promise<Spot> {
    return this.#edit(id, (s) => applyPatch(s, patch, this.#today()));
  }

  markBeen(id: string, input: MarkBeen = {}): Promise<Spot> {
    return this.#edit(id, (s) => applyMarkBeen(s, input, this.#today()));
  }

  addNote(id: string, input: AddNote): Promise<Spot> {
    return this.#edit(id, (s) => applyAddNote(s, input, this.#today()));
  }

  remove(id: string): Promise<void> {
    if (!this.#spots.some((s) => s.id === id))
      return Promise.reject(new SpotOpError('not_found', 'no such spot'));
    this.#spots = this.#spots.filter((s) => s.id !== id);
    return Promise.resolve();
  }

  #edit(id: string, apply: (s: Spot) => Spot): Promise<Spot> {
    const current = this.#spots.find((s) => s.id === id);
    if (!current) return Promise.reject(new SpotOpError('not_found', 'no such spot'));
    try {
      const next = { ...apply(current), version: (current.version ?? 1) + 1 };
      this.#spots = this.#spots.map((s) => (s.id === id ? next : s));
      return Promise.resolve(next);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
