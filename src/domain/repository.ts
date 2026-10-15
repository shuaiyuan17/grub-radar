import type { Spot, SpotInput } from './spot';

/**
 * Where spots come from. The UI only ever talks to this interface, so the v0
 * static data can be swapped for an HTTP API (Workers + D1) without touching
 * components. Async on purpose, even though v0 answers instantly.
 */
export interface SpotRepository {
  list(): Promise<Spot[]>;
  /** null when there's no spot with that id. */
  get(id: string): Promise<Spot | null>;
  /**
   * Optional, for sources that already have the data in memory (the bundled
   * seed): hand it over synchronously so the UI can skip a loading state.
   * Throws if the data is invalid.
   */
  snapshot?(): Spot[];
}

/**
 * Planned write side (not implemented in v0). Each method maps 1:1 to a
 * future MCP tool: add_spot, mark_been, add_note.
 */
export interface WritableSpotRepository extends SpotRepository {
  add(input: SpotInput): Promise<Spot>;
  markBeen(id: string, rating?: number): Promise<Spot>;
  addNote(id: string, note: string): Promise<Spot>;
}
