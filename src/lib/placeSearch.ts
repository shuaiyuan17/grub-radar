import { createContext, use, useEffect, useState } from 'react';
import {
  normalizeQuery,
  PlaceSearchResponseSchema,
  roundForSearch,
  SEARCH_MAX_CHARS,
  SEARCH_MIN_CHARS,
  type ApplePlace,
  type PlaceSearchQuery,
} from '../contracts/places';
import type { Origin } from '../contracts/spots';
import type { LatLng } from '../domain/geo';
import type { DataLang } from '../domain/spot';
import { api, ApiRequestError } from './api';

/** How the app searches Apple Maps (GET /api/places/search); swapped out in tests. */
export interface PlaceSearchClient {
  search(q: PlaceSearchQuery, signal?: AbortSignal): Promise<ApplePlace[]>;
}

export const httpPlaceSearchClient: PlaceSearchClient = {
  async search(q, signal) {
    // POST: where you are goes in the body (rounded to ~1 km), never in a URL
    const near =
      q.near === undefined ? undefined : q.near === 'home' ? 'home' : roundForSearch(q.near);
    const res = await api('/api/places/search', {
      method: 'POST',
      body: { q: normalizeQuery(q.q), lang: q.lang, ...(near === undefined ? {} : { near }) },
      signal,
    });
    return PlaceSearchResponseSchema.parse(await res.json()).places;
  },
};

export const PlaceSearchClientContext = createContext<PlaceSearchClient>(httpPlaceSearchClient);
export const usePlaceSearchClient = () => use(PlaceSearchClientContext);

/** "home", or the point rounded to ~1 km (all a search needs; see roundForSearch). */
export function nearParam(near: Origin | undefined): string | undefined {
  if (near === undefined) return undefined;
  if (near === 'home') return 'home';
  const p = roundForSearch(near);
  return `${String(p.lat)},${String(p.lng)}`;
}

/**
 * Wait this long after the last keystroke before searching. Apple allows the
 * whole app 25,000 calls a day; a word typed at normal speed costs one.
 */
export const SEARCH_DEBOUNCE_MS = 350;

export type PlaceSearchState =
  /** Not enough typed yet. */
  | { status: 'idle' }
  /**
   * Waiting or asking. `places` are the previous answer, kept on screen
   * (dimmed) meanwhile: they belong to another query or place, so they must
   * not be actionable.
   */
  | { status: 'loading'; places: readonly ApplePlace[] }
  | { status: 'ready'; q: string; places: readonly ApplePlace[] }
  | { status: 'error'; code: string };

// answers this session already has: typing back to an earlier word costs nothing
const answers = new Map<string, readonly ApplePlace[]>();
const MAX_ANSWERS = 50;
function remember(key: string, places: readonly ApplePlace[]) {
  answers.delete(key);
  answers.set(key, places);
  if (answers.size > MAX_ANSWERS) {
    const oldest = answers.keys().next();
    if (!oldest.done) answers.delete(oldest.value);
  }
}
/** Tests: forget remembered answers. */
export const forgetPlaceAnswers = () => {
  answers.clear();
};

type Settled = { key: string; places: readonly ApplePlace[] } | { key: string; code: string };

/**
 * Apple Maps results for what's typed, around `near`. Debounced, at least
 * SEARCH_MIN_CHARS, an older request is cancelled when a newer one starts,
 * and answers are remembered for the session. `now()` skips the wait (Enter).
 */
export function usePlaceSearch(
  text: string,
  near: Origin | undefined,
  lang: DataLang,
  /**
   * The point the search is really around (your home's coordinates when
   * `near` is "home"). Part of the remembered-answer key, so a moved home
   * never gets the answers for the old one.
   */
  centre: LatLng,
): { state: PlaceSearchState; now: () => void } {
  const client = usePlaceSearchClient();
  const q = normalizeQuery(text).slice(0, SEARCH_MAX_CHARS);
  const around = nearParam(centre) ?? '';
  const key =
    q.length >= SEARCH_MIN_CHARS ? `${lang}|${nearParam(near) ?? ''}@${around}|${q}` : null;
  const [settled, setSettled] = useState<Settled | null>(null);
  const [last, setLast] = useState<readonly ApplePlace[]>([]);
  // Enter: search now. A counter, so pressing it again (say, after an error) retries.
  const [hurry, setHurry] = useState<{ key: string | null; n: number }>({ key: null, n: 0 });

  useEffect(() => {
    if (key === null || answers.has(key)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => {
        client.search({ q, lang, ...(near === undefined ? {} : { near }) }, ctrl.signal).then(
          (places) => {
            remember(key, places);
            setSettled({ key, places });
            setLast(places);
          },
          (e: unknown) => {
            if (ctrl.signal.aborted) return;
            setSettled({ key, code: e instanceof ApiRequestError ? e.code : 'unknown' });
          },
        );
      },
      hurry.key === key ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `near` and `q` are inside `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hurry, client]);

  let state: PlaceSearchState;
  const known = key === null ? undefined : answers.get(key);
  if (key === null) state = { status: 'idle' };
  else if (known) state = { status: 'ready', q, places: known };
  else if (settled?.key === key && 'code' in settled)
    state = { status: 'error', code: settled.code };
  else state = { status: 'loading', places: last };
  return {
    state,
    now: () => {
      setSettled(null); // a failed answer for this key gives way to "looking…"
      setHurry((h) => ({ key, n: h.n + 1 }));
    },
  };
}
