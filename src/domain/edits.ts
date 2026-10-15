import { z } from 'zod/mini';
import {
  HoursSchema,
  ICONS,
  KINDS,
  LatLngSchema,
  LIMITS,
  DishSchema,
  PRICES,
  RatingSchema,
  SpotSchema,
  STATUSES,
  TagsSchema,
  text,
  type DataLang,
  type Dish,
  type IconName,
  type Kind,
  type Spot,
} from './spot';

/**
 * The write side of the domain: what you can do to a spot, as wire-ready
 * schemas plus pure functions. The Worker's D1 repository, the in-memory one
 * (tests, dev) and the future MCP tools all run these same functions, so
 * "mark been" means the same thing everywhere.
 *
 *   add_spot  -> AddSpotSchema   + spotFromInput
 *   (edit)    -> SpotPatchSchema + applyPatch
 *   mark_been -> MarkBeenSchema  + applyMarkBeen
 *   add_note  -> AddNoteSchema   + applyAddNote
 */

/** Optional free text: trimmed; an empty string means "not set". */
const optText = (max: number) => z.optional(z.string().check(z.trim(), z.maxLength(max)));
const isoDate = z.iso.date();
/** One line of a note: newlines fold into spaces so every entry stays one line. */
const entryText = z.string().check(
  z.overwrite((s) => s.replace(/\s+/g, ' ')),
  z.trim(),
  z.minLength(1, 'note is empty'),
  z.maxLength(LIMITS.entry, 'note is too long'),
);

/** POST /api/spots and the `add_spot` tool (manual places; Apple places come in PR 3). */
export const AddSpotSchema = z
  .strictObject({
    name: text(LIMITS.name),
    kind: z.enum(KINDS),
    location: LatLngSchema,
    cuisine: optText(LIMITS.cuisine),
    price: z.optional(z.enum(PRICES)),
    tags: z.optional(TagsSchema),
    status: z.optional(z.enum(STATUSES)),
    rating: z.optional(RatingSchema),
    note: optText(LIMITS.note),
    /** Dishes to order, none tried yet. */
    order: z.optional(z.array(text(LIMITS.dish)).check(z.maxLength(LIMITS.dishes))),
    /** "why it's on the list"; dated today. */
    why: optText(LIMITS.why),
    icon: z.optional(z.enum(ICONS)),
    hours: z.optional(HoursSchema),
  })
  .check(
    z.refine((s) => s.rating === undefined || s.status === 'been', {
      message: 'only rate places you have been to',
      path: ['rating'],
    }),
  );
export type AddSpotInput = z.input<typeof AddSpotSchema>;
export type AddSpot = z.output<typeof AddSpotSchema>;

/** PATCH /api/spots/:id. `null` clears a field. */
export const SpotPatchSchema = z
  .strictObject({
    name: z.optional(text(LIMITS.name)),
    kind: z.optional(z.enum(KINDS)),
    location: z.optional(LatLngSchema),
    cuisine: z.optional(z.nullable(z.string().check(z.trim(), z.maxLength(LIMITS.cuisine)))),
    price: z.optional(z.enum(PRICES)),
    icon: z.optional(z.enum(ICONS)),
    hours: z.optional(z.nullable(HoursSchema)),
    tags: z.optional(TagsSchema),
    status: z.optional(z.enum(STATUSES)),
    rating: z.optional(z.nullable(RatingSchema)),
    note: z.optional(z.nullable(z.string().check(z.trim(), z.maxLength(LIMITS.note)))),
    myNote: z.optional(z.nullable(z.string().check(z.trim(), z.maxLength(LIMITS.myNote)))),
    /** The whole list; dishes keep their `id`, new ones may omit it. */
    order: z.optional(z.array(DishSchema).check(z.maxLength(LIMITS.dishes))),
    why: z.optional(z.nullable(z.string().check(z.trim(), z.maxLength(LIMITS.why)))),
    /**
     * The spot's `version` this edit was made from. If the spot has changed
     * since, the edit is refused (409) instead of overwriting the newer data.
     * The app always sends it; agents may leave it out (last write wins).
     */
    version: z.optional(z.int().check(z.gte(1))),
  })
  .check(
    z.refine((p) => Object.keys(p).some((k) => k !== 'version'), {
      message: 'nothing to change',
    }),
    // a patch that rates must not also move the spot back to "want"
    z.refine((p) => p.rating == null || p.status !== 'want', {
      message: 'only rate places you have been to',
      path: ['rating'],
    }),
  );
export type SpotPatchInput = z.input<typeof SpotPatchSchema>;
export type SpotPatch = z.output<typeof SpotPatchSchema>;

/** POST /api/spots/:id/been and `mark_been`. */
export const MarkBeenSchema = z.strictObject({
  rating: z.optional(RatingSchema),
  /** The day you went (your local date). Defaults to today. */
  on: z.optional(isoDate),
  /** Appended to your notes, dated `on`. */
  note: z.optional(entryText),
});
export type MarkBeenInput = z.input<typeof MarkBeenSchema>;
export type MarkBeen = z.output<typeof MarkBeenSchema>;

/** POST /api/spots/:id/notes and `add_note`: appends a dated line to `myNote`. */
export const AddNoteSchema = z.strictObject({
  note: entryText,
  on: z.optional(isoDate),
});
export type AddNoteInput = z.input<typeof AddNoteSchema>;
export type AddNote = z.output<typeof AddNoteSchema>;

export type SpotOpErrorCode =
  | 'not_found'
  | 'note_too_long'
  | 'rating_needs_been'
  | 'not_editable'
  | 'conflict'
  | 'future_date'
  | 'list_full';

/** A write that can't happen. The Worker turns `code` into an HTTP error. */
export class SpotOpError extends Error {
  readonly code: SpotOpErrorCode;
  constructor(code: SpotOpErrorCode, message: string) {
    super(message);
    this.name = 'SpotOpError';
    this.code = code;
  }
}

const DEFAULT_ICONS: Record<Kind, IconName> = { food: 'bowl', coffee: 'cup', bakery: 'croissant' };
export const defaultIcon = (kind: Kind): IconName => DEFAULT_ICONS[kind];

const HAN = /\p{Script=Han}/u;
/** The language a spot's text is written in: Chinese if any of it is, else unmarked (en). */
export function guessLang(...texts: readonly (string | undefined)[]): DataLang | undefined {
  return texts.some((t) => t !== undefined && HAN.test(t)) ? 'zh-Hans' : undefined;
}

const spotLang = (s: Draft) =>
  guessLang(
    s.name,
    s.cuisine,
    s.note,
    s.myNote,
    s.why?.text,
    ...s.tags,
    ...s.order.map((o) => o.dish),
  );

const NOTE_LINE = /^— (\d{4}-\d{2}-\d{2}): (.*)$/;

/** "— 2026-10-14: cumin lamb was even better" (always one line) */
export const noteLine = (on: string, note: string) =>
  `— ${on}: ${note.replace(/\s+/g, ' ').trim()}`;

/** `myNote` with one more dated line. Throws note_too_long past LIMITS.myNote. */
export function appendNote(myNote: string | undefined, on: string, note: string): string {
  const line = noteLine(on, note);
  const next = myNote ? `${myNote}\n${line}` : line;
  if (next.length > LIMITS.myNote)
    throw new SpotOpError('note_too_long', `notes are capped at ${LIMITS.myNote} characters`);
  return next;
}

export interface NoteEntry {
  /** ISO date for dated lines; null for free text (older notes, edits). */
  on: string | null;
  text: string;
}

/** Splits `myNote` into entries for display, newest last. */
export function parseNoteEntries(myNote: string | undefined): NoteEntry[] {
  if (!myNote) return [];
  return myNote
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = NOTE_LINE.exec(l);
      return m?.[1] && m[2] !== undefined ? { on: m[1], text: m[2] } : { on: null, text: l };
    });
}

/** A spot being built: dishes may not have ids yet (SpotSchema assigns them). */
type Draft = Omit<Spot, 'lang' | 'order'> & {
  lang?: Spot['lang'];
  order: (Omit<Dish, 'id'> & { id?: string })[];
};

/** Strips undefined keys so the result is exactly what SpotSchema emits. */
function finish(spot: Draft): Spot {
  const lang = spotLang(spot);
  return SpotSchema.parse(withoutUndefined({ ...spot, lang }));
}

/** Drops keys whose value is undefined (zod's strict optional fields want them absent). */
export function withoutUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

const orNone = (s: string | null | undefined) => (s === '' || s === null ? undefined : s);

/** A new spot from `add_spot` input. `today` stamps `why`. */
export function spotFromInput(id: string, input: AddSpot, today: string): Spot {
  const status = input.status ?? 'want';
  return finish({
    id,
    name: input.name,
    kind: input.kind,
    cuisine: orNone(input.cuisine),
    price: input.price ?? '$$',
    tags: dedupe(input.tags ?? []),
    status,
    rating: status === 'been' ? input.rating : undefined,
    note: orNone(input.note),
    order: dedupe(input.order ?? []).map((dish) => ({ dish, tried: false })),
    why: input.why ? { text: input.why, foundOn: today } : undefined,
    hours: input.hours,
    icon: input.icon ?? defaultIcon(input.kind),
    location: { lat: input.location.lat, lng: input.location.lng },
  });
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** Applies an edit. Moving back to "want" drops the rating. */
export function applyPatch(spot: Spot, patch: SpotPatch, today: string): Spot {
  if (patch.version !== undefined && spot.version !== undefined && patch.version !== spot.version)
    throw new SpotOpError('conflict', 'this spot changed since you loaded it');
  const status = patch.status ?? spot.status;
  const rating = patch.rating === undefined ? spot.rating : (patch.rating ?? undefined);
  if (patch.rating != null && status !== 'been')
    throw new SpotOpError('rating_needs_been', 'only rate places you have been to');
  const pick = <K extends keyof Spot>(k: K, v: Spot[K] | null | undefined): Spot[K] =>
    v === undefined ? spot[k] : ((v ?? undefined) as Spot[K]);
  let why = spot.why;
  if (patch.why !== undefined) {
    why = patch.why
      ? { text: patch.why, foundOn: spot.why?.text === patch.why ? spot.why.foundOn : today }
      : undefined;
  }
  return finish({
    ...spot,
    name: patch.name ?? spot.name,
    kind: patch.kind ?? spot.kind,
    location: patch.location ?? spot.location,
    cuisine: patch.cuisine === undefined ? spot.cuisine : orNone(patch.cuisine),
    price: patch.price ?? spot.price,
    icon: patch.icon ?? spot.icon,
    hours: pick('hours', patch.hours),
    tags: patch.tags ? dedupe(patch.tags) : spot.tags,
    status,
    rating: status === 'been' ? rating : undefined,
    note: patch.note === undefined ? spot.note : orNone(patch.note),
    myNote: patch.myNote === undefined ? spot.myNote : orNone(patch.myNote),
    order: patch.order ?? spot.order,
    why,
  });
}

/**
 * A dated thing (a visit, a note) can't be in the future. `today` is the
 * server's UTC date; one day of slack covers time zones ahead of UTC.
 */
export function checkNotFuture(on: string, today: string): void {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 1);
  if (on > limit.toISOString().slice(0, 10))
    throw new SpotOpError('future_date', "that date hasn't happened yet");
}

/** "been": status, an optional new rating (else the old one stays), an optional dated note. */
export function applyMarkBeen(spot: Spot, input: MarkBeen, today: string): Spot {
  const on = input.on ?? today;
  checkNotFuture(on, today);
  return finish({
    ...spot,
    status: 'been',
    rating: input.rating ?? spot.rating,
    myNote: input.note ? appendNote(spot.myNote, on, input.note) : spot.myNote,
  });
}

export function applyAddNote(spot: Spot, input: AddNote, today: string): Spot {
  if (input.on) checkNotFuture(input.on, today);
  return finish({ ...spot, myNote: appendNote(spot.myNote, input.on ?? today, input.note) });
}

/**
 * Fields that belong to the place itself (shared, in `places`): what it's
 * called and where it is. Everything else (kind, cuisine, price, tags, …) is
 * your own description, on your list entry.
 */
export const PLACE_FIELDS = ['name', 'location'] as const;

/** Did an edit change anything about the place itself (vs. your own list entry)? */
export function changesPlace(before: Spot, after: Spot): boolean {
  return PLACE_FIELDS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}
