import type { SpotRepository } from '../domain/repository';
import { parseSpots, type Spot } from '../domain/spot';
import { SEED_SPOTS } from './seed';

/** v0 repository: the demo spots bundled with the app, validated once. */
export class StaticSpotRepository implements SpotRepository {
  readonly #spots: readonly Spot[];

  constructor(input: unknown = SEED_SPOTS) {
    this.#spots = parseSpots(input);
  }

  list(): Promise<Spot[]> {
    return Promise.resolve([...this.#spots]);
  }

  get(id: string): Promise<Spot | null> {
    return Promise.resolve(this.#spots.find((s) => s.id === id) ?? null);
  }
}
