/**
 * Spots in D1: `places ⋈ user_places` for one user. Every statement is scoped
 * by that user's id, so a repository built for user A can't see or touch B's
 * list. Edits run the shared domain functions (src/domain/edits.ts) on the
 * current spot and write the result back, guarded by `updated_at` so two
 * writes at once can't silently lose one.
 */
import {
  applyAddNote,
  applyMarkBeen,
  applyPatch,
  changesPlace,
  spotFromInput,
  SpotOpError,
  withoutUndefined,
  type AddNote,
  type AddSpot,
  type MarkBeen,
  type SpotPatch,
} from '../../src/domain/edits';
import type { WritableSpotRepository } from '../../src/domain/repository';
import { SpotSchema, type Spot } from '../../src/domain/spot';
import { newPlaceId, newVisitId } from '../lib/ids';
import { iso, isoDate } from '../lib/time';

interface Row {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: string;
  cuisine: string;
  price: string;
  icon: string;
  hours_json: string | null;
  created_by: string | null;
  apple_place_id: string | null;
  status: string;
  rating: number | null;
  note: string;
  my_note: string | null;
  order_json: string;
  tags_json: string;
  why_text: string | null;
  why_found_on: string | null;
  lang: string | null;
  updated_at: string;
}

// explicit columns, always joined through user_places for this user
const SELECT = `SELECT p.id, p.name, p.lat, p.lng, p.kind, p.cuisine, p.price, p.icon, p.hours_json,
  p.created_by, p.apple_place_id, up.status, up.rating, up.note, up.my_note, up.order_json,
  up.tags_json, up.why_text, up.why_found_on, up.lang, up.updated_at
  FROM user_places up JOIN places p ON p.id = up.place_id
  WHERE up.user_id = ?`;

const json = (s: string | null): unknown => (s === null ? undefined : JSON.parse(s));

/** A row as a Spot, or null (logged) if it doesn't pass SpotSchema. */
function toSpot(r: Row): Spot | null {
  try {
    const candidate: Record<string, unknown> = {
      id: r.id,
      name: r.name,
      kind: r.kind,
      cuisine: r.cuisine || undefined,
      price: r.price,
      tags: json(r.tags_json),
      status: r.status,
      rating: r.rating ?? undefined,
      note: r.note || undefined,
      order: json(r.order_json),
      why: r.why_text && r.why_found_on ? { text: r.why_text, foundOn: r.why_found_on } : undefined,
      myNote: r.my_note ?? undefined,
      hours: json(r.hours_json),
      lang: r.lang ?? undefined,
      icon: r.icon,
      location: { lat: r.lat, lng: r.lng },
    };
    const parsed = SpotSchema.safeParse(withoutUndefined(candidate));
    if (parsed.success) return parsed.data;
  } catch {
    // bad JSON column: fall through
  }
  // ids only: never log notes or coordinates
  console.error('spot row failed SpotSchema', r.id);
  return null;
}

interface Loaded {
  spot: Spot;
  updatedAt: string;
  /** Only the creator of a manual place may change the place itself. */
  placeEditable: boolean;
}

const MAX_ATTEMPTS = 3;

export class D1SpotRepository implements WritableSpotRepository {
  readonly #db: D1Database;
  readonly #userId: string;
  readonly #foundBy: string;
  readonly #now: () => number;

  /**
   * @param foundBy stamped on spots this principal adds: 'me' for the person,
   *   the client name for agents (PR 5).
   */
  constructor(db: D1Database, userId: string, opts: { foundBy?: string; now?: () => number } = {}) {
    this.#db = db;
    this.#userId = userId;
    this.#foundBy = opts.foundBy ?? 'me';
    this.#now = opts.now ?? Date.now;
  }

  get userId() {
    return this.#userId;
  }

  async list(): Promise<Spot[]> {
    const { results } = await this.#db
      .prepare(`${SELECT} ORDER BY up.created_at, p.id`)
      .bind(this.#userId)
      .all<Row>();
    return results.map(toSpot).filter((s): s is Spot => s !== null);
  }

  async get(id: string): Promise<Spot | null> {
    return (await this.#load(id))?.spot ?? null;
  }

  async #load(id: string): Promise<Loaded | null> {
    const row = await this.#db
      .prepare(`${SELECT} AND up.place_id = ?`)
      .bind(this.#userId, id)
      .first<Row>();
    if (!row) return null;
    const spot = toSpot(row);
    if (!spot) return null;
    return {
      spot,
      updatedAt: row.updated_at,
      placeEditable: row.apple_place_id === null && row.created_by === this.#userId,
    };
  }

  #today() {
    return isoDate(this.#now());
  }

  async add(input: AddSpot): Promise<Spot> {
    const id = newPlaceId();
    const spot = spotFromInput(id, input, this.#today());
    const at = iso(this.#now());
    const db = this.#db;
    const stmts = [
      db
        .prepare(
          `INSERT INTO places (id, name, lat, lng, kind, cuisine, price, icon, hours_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...placeValues(spot), this.#userId, at, at),
      db
        .prepare(
          `INSERT INTO user_places (user_id, place_id, status, rating, note, my_note, order_json, tags_json,
             why_text, why_found_on, lang, found_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(this.#userId, id, ...listValues(spot), this.#foundBy, at, at),
    ];
    if (spot.status === 'been') stmts.push(this.#visit(id, this.#today(), spot.rating, null, at));
    await db.batch(stmts);
    return spot;
  }

  /**
   * Dev and tests only: put the fictional demo spots on this user's list,
   * keeping their slug ids. Places are shared by id; existing rows are left
   * alone, so it's idempotent. Returns how many spots were added.
   */
  async importDemo(spots: readonly Spot[]): Promise<number> {
    const at = iso(this.#now());
    const db = this.#db;
    const stmts = spots.flatMap((s) => [
      db
        .prepare(
          `INSERT OR IGNORE INTO places (id, name, lat, lng, kind, cuisine, price, icon, hours_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...placeValues(s), this.#userId, at, at),
      db
        .prepare(
          `INSERT OR IGNORE INTO user_places (user_id, place_id, status, rating, note, my_note, order_json, tags_json,
             why_text, why_found_on, lang, found_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?)`,
        )
        .bind(this.#userId, s.id, ...listValues(s), at, at),
    ]);
    const results = await db.batch(stmts);
    return results.filter((r, i) => i % 2 === 1 && r.meta.changes > 0).length;
  }

  update(id: string, patch: SpotPatch): Promise<Spot> {
    return this.#edit(id, (spot, today) => applyPatch(spot, patch, today));
  }

  markBeen(id: string, input: MarkBeen = {}): Promise<Spot> {
    return this.#edit(
      id,
      (spot, today) => applyMarkBeen(spot, input, today),
      (next, at) => this.#visit(id, input.on ?? this.#today(), next.rating, input.note ?? null, at),
    );
  }

  addNote(id: string, input: AddNote): Promise<Spot> {
    return this.#edit(id, (spot, today) => applyAddNote(spot, input, today));
  }

  async remove(id: string): Promise<void> {
    const db = this.#db;
    const [, removed] = await db.batch([
      db.prepare('DELETE FROM visits WHERE user_id = ? AND place_id = ?').bind(this.#userId, id),
      db
        .prepare('DELETE FROM user_places WHERE user_id = ? AND place_id = ?')
        .bind(this.#userId, id),
      // a manual place you made, that nobody else has on their list, goes too
      db
        .prepare(
          `DELETE FROM places WHERE id = ? AND created_by = ? AND apple_place_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM user_places WHERE place_id = ?)`,
        )
        .bind(id, this.#userId, id),
    ]);
    if (!removed?.meta.changes) throw new SpotOpError('not_found', 'no such spot');
  }

  /**
   * Load, apply a domain edit, write back if nobody else wrote in between
   * (updated_at guard), else retry from a fresh load.
   */
  async #edit(
    id: string,
    apply: (spot: Spot, today: string) => Spot,
    extra?: (next: Spot, at: string) => D1PreparedStatement,
  ): Promise<Spot> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const loaded = await this.#load(id);
      if (!loaded) throw new SpotOpError('not_found', 'no such spot');
      const next = apply(loaded.spot, this.#today());
      const placeChanged = changesPlace(loaded.spot, next);
      if (placeChanged && !loaded.placeEditable)
        throw new SpotOpError('not_editable', "this place's details aren't yours to change");
      const at = iso(this.#now());
      // statements after the first only run if the first one won the race
      const won = `EXISTS (SELECT 1 FROM user_places WHERE user_id = ? AND place_id = ? AND updated_at = ?)`;
      const db = this.#db;
      const stmts = [
        db
          .prepare(
            `UPDATE user_places SET status = ?, rating = ?, note = ?, my_note = ?, order_json = ?, tags_json = ?,
               why_text = ?, why_found_on = ?, lang = ?, updated_at = ?
             WHERE user_id = ? AND place_id = ? AND updated_at = ?`,
          )
          .bind(...listValues(next), at, this.#userId, id, loaded.updatedAt),
      ];
      if (placeChanged) {
        stmts.push(
          db
            .prepare(
              `UPDATE places SET name = ?, lat = ?, lng = ?, kind = ?, cuisine = ?, price = ?, icon = ?,
                 hours_json = ?, updated_at = ?
               WHERE id = ? AND created_by = ? AND apple_place_id IS NULL AND ${won}`,
            )
            .bind(...placeValues(next).slice(1), at, id, this.#userId, this.#userId, id, at),
        );
      }
      if (extra) {
        const stmt = extra(next, at);
        stmts.push(stmt);
      }
      const [first] = await db.batch(stmts);
      if (first?.meta.changes) return next;
    }
    throw new SpotOpError('conflict', 'the spot changed while saving; try again');
  }

  #visit(
    placeId: string,
    on: string,
    rating: number | undefined,
    note: string | null,
    at: string,
  ): D1PreparedStatement {
    // only if this user has the place on their list (and, after an edit, won the race)
    return this.#db
      .prepare(
        `INSERT INTO visits (id, user_id, place_id, visited_on, rating, note, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
           (SELECT 1 FROM user_places WHERE user_id = ? AND place_id = ? AND updated_at = ?)`,
      )
      .bind(
        newVisitId(),
        this.#userId,
        placeId,
        on,
        rating ?? null,
        note,
        at,
        this.#userId,
        placeId,
        at,
      );
  }

  /** How many times you've marked this place been (tests, later: "3 visits"). */
  async visitCount(placeId: string): Promise<number> {
    const row = await this.#db
      .prepare('SELECT COUNT(*) AS n FROM visits WHERE user_id = ? AND place_id = ?')
      .bind(this.#userId, placeId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}

/** id, name, lat, lng, kind, cuisine, price, icon, hours_json */
function placeValues(s: Spot) {
  return [
    s.id,
    s.name,
    s.location.lat,
    s.location.lng,
    s.kind,
    s.cuisine ?? '',
    s.price,
    s.icon,
    s.hours ? JSON.stringify(s.hours) : null,
  ] as const;
}

/** status, rating, note, my_note, order_json, tags_json, why_text, why_found_on, lang */
function listValues(s: Spot) {
  return [
    s.status,
    s.rating ?? null,
    s.note ?? '',
    s.myNote ?? null,
    JSON.stringify(s.order),
    JSON.stringify(s.tags),
    s.why?.text ?? null,
    s.why?.foundOn ?? null,
    s.lang ?? null,
  ] as const;
}
