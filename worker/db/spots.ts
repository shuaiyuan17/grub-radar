/**
 * Spots in D1: `places ⋈ user_places` for one user. Every statement is scoped
 * by that user's id, so a repository built for user A can't see or touch B's
 * list. `places` holds only what a place *is* (name, where); everything you
 * say about it lives on your `user_places` row.
 *
 * Edits run the shared domain functions (src/domain/edits.ts) on the current
 * spot and write the result back guarded by the row's integer `version`
 * (`WHERE version = ?`, then +1), so two writes at once can't silently lose
 * one: the loser retries from fresh data, or gets a 409 if the caller said
 * which version it edited.
 */
import { agentName, FOUND_BY_AGENT } from '../../src/contracts/agents';
import type { ApplePlace } from '../../src/contracts/places';
import {
  applyAddDish,
  applyAddNote,
  applyMarkBeen,
  applyRemoveDish,
  applyPatch,
  changesPlace,
  spotFromInput,
  SpotOpError,
  withoutUndefined,
  type AddExtras,
  type AddNote,
  type AddSpot,
  type DishInput,
  type MarkBeen,
  type SpotPatch,
} from '../../src/domain/edits';
import type { WritableSpotRepository } from '../../src/domain/repository';
import { LIMITS, SpotSchema, type Kind, type Spot, type Verdict } from '../../src/domain/spot';
import { newPlaceId, newVisitId } from '../lib/ids';
import { deleteSpotPhotosStatement, keysFromResult } from './photos';
import { userIdRef, type UserRef } from './users';
import { iso, isoDate } from '../lib/time';

interface Row {
  id: string;
  name: string;
  lat: number;
  lng: number;
  created_by: string | null;
  apple_place_id: string | null;
  address: string | null;
  kind: string;
  cuisine: string;
  price: string | null;
  icon: string;
  hours_json: string | null;
  status: string;
  verdict: string | null;
  note: string;
  my_note: string | null;
  order_json: string;
  tags_json: string;
  why_text: string | null;
  why_found_on: string | null;
  lang: string | null;
  visibility: string;
  version: number;
  found_by: string;
}

// explicit columns, always joined through user_places for this user
const SELECT = `SELECT p.id, p.name, p.lat, p.lng, p.created_by, p.apple_place_id, p.address,
  up.kind, up.cuisine, up.price, up.icon, up.hours_json, up.status, up.verdict, up.note, up.my_note,
  up.order_json, up.tags_json, up.why_text, up.why_found_on, up.lang, up.visibility, up.version,
  up.found_by
  FROM user_places up JOIN places p ON p.id = up.place_id
  WHERE up.user_id = ?`;

/**
 * The whole list for one user, oldest first. `user` is a bound id or a scalar
 * subquery (a SessionScope, when it rides along with the session lookup).
 */
export function listStatement(db: D1Database, user: UserRef): D1PreparedStatement {
  return db
    .prepare(
      `${SELECT.replace('WHERE up.user_id = ?', `WHERE up.user_id = ${user.sql}`)} ORDER BY up.created_at, p.id`,
    )
    .bind(...user.binds);
}

/** Rows of listStatement as Spots (CorruptSpotError if one doesn't validate). */
export function spotsFromRows(result: D1Result | undefined): Spot[] {
  return ((result?.results ?? []) as Row[]).map(toSpot);
}

const json = (s: string | null): unknown => (s === null ? undefined : JSON.parse(s));

/**
 * `found_by` as a Spot shows it: the agent's name for 'agent:<name>', else
 * nothing ('me', 'demo', v2's 'friend:…'). A name that wouldn't pass
 * SpotSchema (a row written under some older rule) is dropped, never fatal:
 * one odd label must not break the whole list.
 */
export function agentFoundBy(f: string | undefined): string | undefined {
  if (!f?.startsWith(FOUND_BY_AGENT)) return undefined;
  const name = f.slice(FOUND_BY_AGENT.length);
  if (name && agentName(name, '') === name) return name;
  console.error('unusable found_by dropped');
  return undefined;
}

/** What a repository may stamp: 'me', the demo import, or a well-formed 'agent:<name>'. */
function checkFoundBy(f: string): string {
  if (f === 'me' || f === 'demo' || agentFoundBy(f) !== undefined) return f;
  throw new Error('found_by must be "me" or "agent:<name>"');
}

/**
 * A saved spot that no longer passes SpotSchema. Never dropped quietly (the
 * app would treat a missing spot as deleted): logged by id, and the request
 * fails with a 500 so it gets noticed and fixed.
 */
export class CorruptSpotError extends Error {
  readonly spotId: string;
  constructor(spotId: string) {
    super(`saved spot ${spotId} failed validation`);
    this.spotId = spotId;
    this.name = 'CorruptSpotError';
  }
}

/** A row as a Spot. Throws CorruptSpotError (after logging the id) if it doesn't pass SpotSchema. */
function toSpot(r: Row): Spot {
  try {
    const parsed = SpotSchema.safeParse(
      withoutUndefined({
        id: r.id,
        name: r.name,
        kind: r.kind,
        cuisine: r.cuisine || undefined,
        price: r.price ?? undefined,
        tags: json(r.tags_json),
        status: r.status,
        verdict: r.verdict ?? undefined,
        note: r.note || undefined,
        order: json(r.order_json),
        why:
          r.why_text && r.why_found_on ? { text: r.why_text, foundOn: r.why_found_on } : undefined,
        myNote: r.my_note ?? undefined,
        hours: json(r.hours_json),
        lang: r.lang ?? undefined,
        icon: r.icon,
        location: { lat: r.lat, lng: r.lng },
        applePlaceId: r.apple_place_id ?? undefined,
        address: r.address ?? undefined,
        // absent = the default ('friends'); anything else in the column is a CHECK violation
        visibility: r.visibility === 'private' ? 'private' : undefined,
        version: r.version,
        foundBy: agentFoundBy(r.found_by),
      }),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // bad JSON column: fall through
  }
  // ids only: never log notes or coordinates
  console.error('spot row failed SpotSchema', r.id);
  throw new CorruptSpotError(r.id);
}

interface Loaded {
  spot: Spot;
  version: number;
}

const MAX_ATTEMPTS = 3;

export class D1SpotRepository implements WritableSpotRepository {
  readonly #db: D1Database;
  readonly #userId: string;
  readonly #foundBy: string;
  readonly #now: () => number;
  readonly #photosDeleted: ((keys: string[]) => void) | undefined;

  /**
   * @param foundBy stamped on spots this principal adds: 'me' for the person,
   *   the client name for agents (PR 5).
   * @param photosDeleted told the R2 keys of photos a removed spot took with
   *   it (already on the deletion outbox), so the caller can sweep them now.
   *   Without it the cron sweeps them within the hour.
   */
  constructor(
    db: D1Database,
    userId: string,
    opts: {
      foundBy?: string;
      now?: () => number;
      photosDeleted?: (keys: string[]) => void;
    } = {},
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#foundBy = checkFoundBy(opts.foundBy ?? 'me');
    this.#now = opts.now ?? Date.now;
    this.#photosDeleted = opts.photosDeleted;
  }

  async list(): Promise<Spot[]> {
    return spotsFromRows(await listStatement(this.#db, userIdRef(this.#userId)).all());
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
    return { spot: toSpot(row), version: row.version };
  }

  #today() {
    return isoDate(this.#now());
  }

  /** `cond` (SQL) holds while this user's list is below LIMITS.spots. */
  #underCap() {
    return {
      sql: `(SELECT COUNT(*) FROM user_places WHERE user_id = ?) < ${String(LIMITS.spots)}`,
      bind: [this.#userId],
    };
  }

  async add(input: AddSpot): Promise<Spot> {
    const id = newPlaceId();
    const foundBy = agentFoundBy(this.#foundBy);
    const spot = {
      ...spotFromInput(id, input, this.#today()),
      version: 1,
      ...(foundBy ? { foundBy } : {}),
    };
    const at = iso(this.#now());
    const db = this.#db;
    const cap = this.#underCap();
    const stmts = [
      // the place only if the list has room; the entry only if the place went in
      db
        .prepare(
          `INSERT INTO places (id, name, lat, lng, created_by, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${cap.sql}`,
        )
        .bind(...placeValues(spot), this.#userId, at, at, ...cap.bind),
      db
        .prepare(
          `INSERT INTO user_places (user_id, place_id, ${LIST_COLUMNS}, found_by, version, created_at, updated_at)
           SELECT ?, ?, ${LIST_MARKS}, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM places WHERE id = ?)`,
        )
        .bind(this.#userId, id, ...listValues(spot), this.#foundBy, at, at, id),
    ];
    if (spot.status === 'been')
      stmts.push(this.#visit(id, this.#today(), spot.verdict, null, at, 1));
    const [place] = await db.batch(stmts);
    if (!place?.meta.changes)
      throw new SpotOpError('list_full', `a list holds at most ${String(LIMITS.spots)} spots`);
    return spot;
  }

  /**
   * Adds a place from Apple Maps (`add_spot` with an Apple Place ID).
   * Places are global and deduped by `apple_place_id`:
   *   - already on your list: nothing is written; that spot comes back (created: false);
   *   - already in `places` (someone saved it before): that row is reused, and
   *     `resolve` (an Apple Maps call) isn't needed;
   *   - otherwise `resolve()` says what the place is, and it goes into `places`.
   * Two adds racing for the same place both end on one `places` row and one
   * entry (the inserts are ON CONFLICT DO NOTHING, read back by Apple id).
   * D1: two round trips (the look-up batch, then the write batch that also
   * reads the entry back); one if it's already on your list.
   * `input.kind` wins; else what Apple says the place is; else food.
   */
  async addApplePlace(
    applePlaceId: string,
    input: AddExtras & { kind?: Kind },
    resolve: () => Promise<ApplePlace>,
  ): Promise<{ spot: Spot; created: boolean }> {
    const db = this.#db;
    // one round trip: is it on your list (the whole row), and is the place known at all?
    const mineStmt = db
      .prepare(`${SELECT} AND p.apple_place_id = ?`)
      .bind(this.#userId, applePlaceId);
    const [mineRes, knownRes] = await db.batch([
      mineStmt,
      db
        .prepare('SELECT id, name, lat, lng, address FROM places WHERE apple_place_id = ?')
        .bind(applePlaceId),
    ]);
    const mine = (mineRes?.results as Row[] | undefined)?.[0];
    if (mine) return { spot: toSpot(mine), created: false };
    const known = (
      knownRes?.results as
        { id: string; name: string; lat: number; lng: number; address: string | null }[] | undefined
    )?.[0];
    const place: ApplePlace = known
      ? {
          applePlaceId,
          name: known.name,
          location: { lat: known.lat, lng: known.lng },
          ...(known.address ? { address: known.address } : {}),
        }
      : await resolve();
    const draft = spotFromInput(
      known?.id ?? newPlaceId(),
      {
        ...input,
        name: place.name,
        location: place.location,
        kind: input.kind ?? place.kind ?? 'food',
      },
      this.#today(),
      { applePlaceId, ...(place.address ? { address: place.address } : {}) },
    );
    const at = iso(this.#now());
    const cap = this.#underCap();
    const placeId = '(SELECT id FROM places WHERE apple_place_id = ?)';
    const stmts = [
      db
        .prepare(
          `INSERT INTO places (id, apple_place_id, name, lat, lng, address, created_by, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${cap.sql}
           ON CONFLICT (apple_place_id) DO NOTHING`,
        )
        .bind(
          draft.id,
          applePlaceId,
          draft.name,
          draft.location.lat,
          draft.location.lng,
          draft.address ?? null,
          this.#userId,
          at,
          at,
          ...cap.bind,
        ),
      db
        .prepare(
          `INSERT INTO user_places (user_id, place_id, ${LIST_COLUMNS}, found_by, version, created_at, updated_at)
           SELECT ?, ${placeId}, ${LIST_MARKS}, ?, 1, ?, ?
           WHERE ${placeId} IS NOT NULL AND ${cap.sql}
           ON CONFLICT (user_id, place_id) DO NOTHING`,
        )
        .bind(
          this.#userId,
          applePlaceId,
          ...listValues(draft),
          this.#foundBy,
          at,
          at,
          applePlaceId,
          ...cap.bind,
        ),
    ];
    if (draft.status === 'been')
      // the first visit, only alongside a new "been" entry: a racing twin that
      // got in first (maybe as "want") wins, and this add records no visit
      stmts.push(
        db
          .prepare(
            `INSERT INTO visits (id, user_id, place_id, visited_on, verdict, note, created_at)
             SELECT ?, ?, up.place_id, ?, ?, NULL, ? FROM user_places up
             WHERE up.user_id = ? AND up.place_id = ${placeId} AND up.version = 1
               AND up.status = 'been'
               AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.user_id = up.user_id AND v.place_id = up.place_id)`,
          )
          .bind(
            newVisitId(),
            this.#userId,
            this.#today(),
            draft.verdict ?? null,
            at,
            this.#userId,
            applePlaceId,
          ),
      );
    // …and the entry as it now reads, in the same round trip
    const results = await db.batch([...stmts, mineStmt]);
    const entry = results[1];
    const row = (results.at(-1)?.results as Row[] | undefined)?.[0];
    if (!row)
      throw new SpotOpError('list_full', `a list holds at most ${String(LIMITS.spots)} spots`);
    return { spot: toSpot(row), created: Boolean(entry?.meta.changes) };
  }

  /**
   * Adds a place that's already in `places` by its id: someone shared a
   * /place/:id link and you tapped "add to my radar". Nothing about the
   * place is taken from the request (name, location, address are the shared
   * row's), and nothing of anyone else's entry is read.
   *   - already on your list: nothing is written; that spot comes back (created: false);
   *   - no such place: SpotOpError not_found.
   * Racing twins end on one entry (ON CONFLICT DO NOTHING). One round trip to
   * look, one to write and read back.
   */
  async addSharedPlace(
    placeId: string,
    input: AddExtras & { kind?: Kind },
  ): Promise<{ spot: Spot; created: boolean }> {
    const db = this.#db;
    const mineStmt = db.prepare(`${SELECT} AND up.place_id = ?`).bind(this.#userId, placeId);
    const [mineRes, placeRes] = await db.batch([
      mineStmt,
      db
        .prepare('SELECT id, name, lat, lng, address, apple_place_id FROM places WHERE id = ?')
        .bind(placeId),
    ]);
    const mine = (mineRes?.results as Row[] | undefined)?.[0];
    if (mine) return { spot: toSpot(mine), created: false };
    const place = (
      placeRes?.results as
        | {
            id: string;
            name: string;
            lat: number;
            lng: number;
            address: string | null;
            apple_place_id: string | null;
          }[]
        | undefined
    )?.[0];
    if (!place) throw new SpotOpError('not_found', 'no such place');
    const draft = spotFromInput(
      place.id,
      {
        ...input,
        name: place.name,
        location: { lat: place.lat, lng: place.lng },
        kind: input.kind ?? 'food',
      },
      this.#today(),
      place.apple_place_id
        ? {
            applePlaceId: place.apple_place_id,
            ...(place.address ? { address: place.address } : {}),
          }
        : undefined,
    );
    const at = iso(this.#now());
    const cap = this.#underCap();
    const stmts = [
      db
        .prepare(
          `INSERT INTO user_places (user_id, place_id, ${LIST_COLUMNS}, found_by, version, created_at, updated_at)
           SELECT ?, ?, ${LIST_MARKS}, ?, 1, ?, ?
           WHERE EXISTS (SELECT 1 FROM places WHERE id = ?) AND ${cap.sql}
           ON CONFLICT (user_id, place_id) DO NOTHING`,
        )
        .bind(
          this.#userId,
          place.id,
          ...listValues(draft),
          this.#foundBy,
          at,
          at,
          place.id,
          ...cap.bind,
        ),
    ];
    if (draft.status === 'been')
      // the first visit, only alongside a new "been" entry (see addApplePlace)
      stmts.push(
        db
          .prepare(
            `INSERT INTO visits (id, user_id, place_id, visited_on, verdict, note, created_at)
             SELECT ?, ?, up.place_id, ?, ?, NULL, ? FROM user_places up
             WHERE up.user_id = ? AND up.place_id = ? AND up.version = 1 AND up.status = 'been'
               AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.user_id = up.user_id AND v.place_id = up.place_id)`,
          )
          .bind(
            newVisitId(),
            this.#userId,
            this.#today(),
            draft.verdict ?? null,
            at,
            this.#userId,
            place.id,
          ),
      );
    const results = await db.batch([...stmts, mineStmt]);
    const row = (results.at(-1)?.results as Row[] | undefined)?.[0];
    if (!row)
      throw new SpotOpError('list_full', `a list holds at most ${String(LIMITS.spots)} spots`);
    return { spot: toSpot(row), created: Boolean(results[0]?.meta.changes) };
  }

  /**
   * Dev and tests only: put the fictional demo spots on this user's list,
   * keeping their slug ids. Places are shared by id; existing rows are left
   * alone, so it's idempotent. Returns how many spots were added.
   */
  async importDemo(spots: readonly Spot[]): Promise<number> {
    const at = iso(this.#now());
    const db = this.#db;
    const cap = this.#underCap();
    const stmts = spots.flatMap((s) => [
      db
        .prepare(
          `INSERT OR IGNORE INTO places (id, name, lat, lng, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...placeValues(s), this.#userId, at, at),
      db
        .prepare(
          `INSERT OR IGNORE INTO user_places (user_id, place_id, ${LIST_COLUMNS}, found_by, version, created_at, updated_at)
           SELECT ?, ?, ${LIST_MARKS}, 'demo', 1, ?, ? WHERE ${cap.sql}`,
        )
        .bind(this.#userId, s.id, ...listValues(s), at, at, ...cap.bind),
    ]);
    const results = await db.batch(stmts);
    return results.filter((r, i) => i % 2 === 1 && r.meta.changes > 0).length;
  }

  /** An edit. With `patch.version`, a stale copy gets a 409 instead of overwriting. */
  update(id: string, patch: SpotPatch): Promise<Spot> {
    return this.#edit(id, (spot, today) => applyPatch(spot, patch, today), {
      expectVersion: patch.version,
      // turning a spot "been" by editing it counts as a visit, same as /been
      extra: (before, next, version, at) =>
        before.status === 'want' && next.status === 'been'
          ? this.#visit(id, this.#today(), next.verdict, null, at, version)
          : null,
    });
  }

  markBeen(id: string, input: MarkBeen = {}): Promise<Spot> {
    return this.#edit(id, (spot, today) => applyMarkBeen(spot, input, today), {
      extra: (_before, next, version, at) =>
        this.#visit(id, input.on ?? this.#today(), next.verdict, input.note ?? null, at, version),
    });
  }

  addNote(id: string, input: AddNote): Promise<Spot> {
    return this.#edit(id, (spot, today) => applyAddNote(spot, input, today));
  }

  /**
   * `add_dish`: one more dish to order. `added` is false when it was already
   * there (nothing written, the version stays).
   */
  async addDish(id: string, input: DishInput): Promise<{ spot: Spot; added: boolean }> {
    let added = false;
    const spot = await this.#edit(id, (s) => {
      const next = applyAddDish(s, input);
      added = next !== s;
      return next;
    });
    return { spot, added };
  }

  /** `remove_dish`: takes a dish off the order list (no_dish if it isn't there). */
  removeDish(id: string, input: DishInput): Promise<Spot> {
    return this.#edit(id, (spot) => applyRemoveDish(spot, input));
  }

  /** Your entry, its visits and your photos of it (rows here; bytes via the outbox). */
  async remove(id: string): Promise<void> {
    const db = this.#db;
    const [photos, , removed] = await db.batch([
      deleteSpotPhotosStatement(db, this.#userId, id),
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
    const keys = keysFromResult(photos);
    if (keys.length) this.#photosDeleted?.(keys);
  }

  /**
   * Load, apply a domain edit, write back only if the row is still at the
   * version we read (then version + 1). If someone else wrote in between:
   * a 409 when the caller pinned a version, else retry from fresh data.
   * A name/location change is written first, guarded by created_by in SQL;
   * the entry update only lands if the place now says what we wanted, so a
   * refused place edit leaves everything untouched (not_editable). An edit
   * that returns the very spot it was given writes nothing.
   */
  async #edit(
    id: string,
    apply: (spot: Spot, today: string) => Spot,
    opts: {
      expectVersion?: number;
      extra?: (before: Spot, next: Spot, version: number, at: string) => D1PreparedStatement | null;
    } = {},
  ): Promise<Spot> {
    const db = this.#db;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const loaded = await this.#load(id);
      if (!loaded) throw new SpotOpError('not_found', 'no such spot');
      if (opts.expectVersion !== undefined && opts.expectVersion !== loaded.version)
        throw new SpotOpError('conflict', 'this spot changed since you loaded it');
      const next = apply(loaded.spot, this.#today());
      // the edit handed back the spot itself: nothing changed, nothing to write
      if (next === loaded.spot) return loaded.spot;
      const version = loaded.version + 1;
      const placeChanged = changesPlace(loaded.spot, next);
      const at = iso(this.#now());

      const stmts: D1PreparedStatement[] = [];
      if (placeChanged) {
        stmts.push(
          db
            .prepare(
              `UPDATE places SET name = ?, lat = ?, lng = ?, updated_at = ?
               WHERE id = ? AND created_by = ? AND apple_place_id IS NULL
               AND EXISTS (SELECT 1 FROM user_places WHERE user_id = ? AND place_id = ? AND version = ?)`,
            )
            .bind(
              next.name,
              next.location.lat,
              next.location.lng,
              at,
              id,
              this.#userId,
              this.#userId,
              id,
              loaded.version,
            ),
        );
      }
      const placeIsAsWanted = placeChanged
        ? 'AND EXISTS (SELECT 1 FROM places WHERE id = ? AND name = ? AND lat = ? AND lng = ?)'
        : '';
      stmts.push(
        db
          .prepare(
            `UPDATE user_places SET ${LIST_COLUMNS.split(', ')
              .map((c) => `${c} = ?`)
              .join(', ')}, version = ?, updated_at = ?
             WHERE user_id = ? AND place_id = ? AND version = ? ${placeIsAsWanted}`,
          )
          .bind(
            ...listValues(next),
            version,
            at,
            this.#userId,
            id,
            loaded.version,
            ...(placeChanged ? [id, next.name, next.location.lat, next.location.lng] : []),
          ),
      );
      const extra = opts.extra?.(loaded.spot, next, version, at);
      if (extra) stmts.push(extra);

      const results = await db.batch(stmts);
      const entry = results[placeChanged ? 1 : 0];
      if (entry?.meta.changes) return { ...next, version };

      const now = await this.#load(id);
      if (!now) throw new SpotOpError('not_found', 'no such spot');
      if (now.version === loaded.version)
        // nobody else wrote, so it was the place guard that said no
        throw new SpotOpError(
          'not_editable',
          "this place's name and location aren't yours to change",
        );
      if (opts.expectVersion !== undefined)
        throw new SpotOpError('conflict', 'this spot changed since you loaded it');
    }
    throw new SpotOpError('conflict', 'the spot kept changing while saving; try again');
  }

  /** A visit row, only if this user's entry is at `version` (i.e. the edit it belongs to landed). */
  #visit(
    placeId: string,
    on: string,
    verdict: Verdict | undefined,
    note: string | null,
    at: string,
    version: number,
  ): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT INTO visits (id, user_id, place_id, visited_on, verdict, note, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
           (SELECT 1 FROM user_places WHERE user_id = ? AND place_id = ? AND version = ?)`,
      )
      .bind(
        newVisitId(),
        this.#userId,
        placeId,
        on,
        verdict ?? null,
        note,
        at,
        this.#userId,
        placeId,
        version,
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

/** id, name, lat, lng */
function placeValues(s: Spot) {
  return [s.id, s.name, s.location.lat, s.location.lng] as const;
}

const LIST_COLUMNS =
  'kind, cuisine, price, icon, hours_json, status, verdict, note, my_note, order_json, tags_json, why_text, why_found_on, lang, visibility';
const LIST_MARKS = LIST_COLUMNS.split(', ')
  .map(() => '?')
  .join(', ');

/** Values for LIST_COLUMNS, in order. */
function listValues(s: Spot) {
  return [
    s.kind,
    s.cuisine ?? '',
    s.price ?? null,
    s.icon,
    s.hours ? JSON.stringify(s.hours) : null,
    s.status,
    s.verdict ?? null,
    s.note ?? '',
    s.myNote ?? null,
    JSON.stringify(s.order),
    JSON.stringify(s.tags),
    s.why?.text ?? null,
    s.why?.foundOn ?? null,
    s.lang ?? null,
    s.visibility ?? 'friends',
  ] as const;
}
