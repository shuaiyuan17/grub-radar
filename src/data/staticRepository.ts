import type { SpotRepository } from '../domain/repository';
import { parseSpots, type Spot } from '../domain/spot';
import { SEED_SPOTS } from './seed';

/**
 * v0 repository: the demo spots bundled with the app. Validated lazily on
 * first use, so a bad seed shows up as an error in the UI (via list() /
 * snapshot()) rather than crashing the bundle at import time.
 */
export class StaticSpotRepository implements SpotRepository {
  readonly #input: unknown;
  #spots: readonly Spot[] | null = null;

  constructor(input: unknown = SEED_SPOTS) {
    this.#input = input;
  }

  snapshot(): Spot[] {
    this.#spots ??= parseSpots(this.#input);
    return [...this.#spots];
  }

  list(): Promise<Spot[]> {
    try {
      return Promise.resolve(this.snapshot());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async get(id: string): Promise<Spot | null> {
    return (await this.list()).find((s) => s.id === id) ?? null;
  }
}
