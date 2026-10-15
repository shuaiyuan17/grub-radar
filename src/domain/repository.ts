import type { AddNote, AddSpot, MarkBeen, SpotPatch } from './edits';
import type { Spot } from './spot';

/**
 * Where spots come from. The UI only ever talks to this interface, so the
 * data source (HTTP API, in-memory for tests) can change without touching
 * components. Async on purpose.
 */
export interface SpotRepository {
  list(): Promise<Spot[]>;
  /** null when there's no spot with that id. */
  get(id: string): Promise<Spot | null>;
  /**
   * Optional, for sources that already have the data in memory: hand it over
   * synchronously so the UI can skip a loading state. Throws if the data is
   * invalid.
   */
  snapshot?(): Spot[];
}

/**
 * The write side. Each method is one domain operation (see ./edits.ts) and
 * maps 1:1 to a REST endpoint and, for the first three, an MCP tool:
 *   add      -> POST   /api/spots            add_spot
 *   markBeen -> POST   /api/spots/:id/been   mark_been
 *   addNote  -> POST   /api/spots/:id/notes  add_note
 *   update   -> PATCH  /api/spots/:id
 *   remove   -> DELETE /api/spots/:id
 * Missing spots reject with SpotOpError('not_found').
 */
export interface WritableSpotRepository extends SpotRepository {
  add(input: AddSpot): Promise<Spot>;
  update(id: string, patch: SpotPatch): Promise<Spot>;
  markBeen(id: string, input?: MarkBeen): Promise<Spot>;
  addNote(id: string, input: AddNote): Promise<Spot>;
  remove(id: string): Promise<void>;
}

export function isWritable(repo: SpotRepository): repo is WritableSpotRepository {
  const r = repo as Partial<WritableSpotRepository>;
  return typeof r.add === 'function' && typeof r.update === 'function';
}
