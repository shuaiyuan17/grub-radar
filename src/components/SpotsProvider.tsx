import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { isWritable, type SpotRepository } from '../domain/repository';
import type { Spot } from '../domain/spot';
import { useT } from '../i18n/context';
import { SpotsContext, type SpotActions } from '../lib/spots';

type Load =
  { state: 'loading' } | { state: 'ready'; spots: Spot[] } | { state: 'error'; error: Error };

/** The server's (or the domain's) error code, if the error carries one. */
function errorCode(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

/** `a` is an older copy of the same spot than `b` (by the server's version). */
const isOlder = (a: Spot, b: Spot) =>
  a.version !== undefined && b.version !== undefined && a.version < b.version;

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** Synchronous sources start ready (no loading flash); async ones start loading. */
function initialLoad(repository: SpotRepository): Load {
  if (!repository.snapshot) return { state: 'loading' };
  try {
    return { state: 'ready', spots: repository.snapshot() };
  } catch (e) {
    return { state: 'error', error: asError(e) };
  }
}

/**
 * Loads spots from the repository and hands them to the tree: the HTTP one
 * in the app, the static demo data in tests.
 */
export function SpotsProvider({
  children,
  repository,
}: {
  children: ReactNode;
  repository: SpotRepository;
}) {
  const t = useT();
  // load state belongs to one repository; when the prop changes, start over
  // from the new one (React's "adjust state on prop change" pattern)
  const [current, setCurrent] = useState(() => ({ repository, load: initialLoad(repository) }));
  let load = current.load;
  if (current.repository !== repository) {
    load = initialLoad(repository);
    setCurrent({ repository, load });
  }

  useEffect(() => {
    if (repository.snapshot) return; // synchronous: initialLoad already has it
    let live = true;
    const settle = (next: Load) => {
      if (live) setCurrent((c) => (c.repository === repository ? { repository, load: next } : c));
    };
    repository.list().then(
      (spots) => {
        settle({ state: 'ready', spots });
      },
      (error: unknown) => {
        settle({ state: 'error', error: asError(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [repository]);

  // writes go to the repository; its answer replaces (or adds, or drops) the spot here
  const actions = useMemo<SpotActions | null>(() => {
    if (!isWritable(repository)) return null;
    const apply = (change: (spots: Spot[]) => Spot[]) => {
      setCurrent((c) =>
        c.repository === repository && c.load.state === 'ready'
          ? { repository, load: { state: 'ready', spots: change(c.load.spots) } }
          : c,
      );
    };
    // a newer copy never gets replaced by an older answer that arrives late
    const accept = (spot: Spot) => {
      apply((spots) => {
        const current = spots.find((s) => s.id === spot.id);
        if (!current) return [...spots, spot];
        if (isOlder(spot, current)) return spots;
        return spots.map((s) => (s.id === spot.id ? spot : s));
      });
    };
    const drop = (id: string) => {
      apply((spots) => spots.filter((s) => s.id !== id));
    };
    /**
     * Runs a write. Its answer replaces the spot here. If the server says the
     * spot changed elsewhere (409), the fresh copy is fetched so the next try
     * starts from it; if it's gone (404), it leaves the list. Either way the
     * error still goes to the caller, which says so.
     */
    const run = async (id: string | null, write: Promise<Spot>) => {
      try {
        const spot = await write;
        accept(spot);
        return spot;
      } catch (e) {
        const code = errorCode(e);
        if (id && code === 'not_found') drop(id);
        if (id && code === 'conflict') {
          const fresh = await repository.get(id).catch(() => undefined);
          if (fresh) accept(fresh);
          else if (fresh === null) drop(id);
        }
        throw e;
      }
    };
    return {
      add: (input) => run(null, repository.add(input)),
      update: (id, patch) => run(id, repository.update(id, patch)),
      markBeen: (id, input) => run(id, repository.markBeen(id, input)),
      addNote: (id, input) => run(id, repository.addNote(id, input)),
      remove: async (id) => {
        try {
          await repository.remove(id);
        } catch (e) {
          if (errorCode(e) !== 'not_found') throw e;
          // already gone (deleted elsewhere): that's what we wanted
        }
        drop(id);
      },
    };
  }, [repository]);

  const spots = load.state === 'ready' ? load.spots : null;
  const value = useMemo(
    () => (spots ? { repository, spots, actions } : null),
    [repository, spots, actions],
  );

  if (load.state === 'error') {
    return (
      <p role="alert" className="note" style={{ fontSize: 22, whiteSpace: 'pre-wrap' }}>
        {t.loadError(load.error.message)}
      </p>
    );
  }
  if (!value) {
    return (
      <p className="note" style={{ fontSize: 22 }} aria-busy="true">
        {t.loading}
      </p>
    );
  }
  return <SpotsContext value={value}>{children}</SpotsContext>;
}
