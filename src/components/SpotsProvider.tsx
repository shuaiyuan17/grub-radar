import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { isWritable, type SpotRepository } from '../domain/repository';
import type { Spot } from '../domain/spot';
import { useT } from '../i18n/context';
import { SpotsContext, type SpotActions } from '../lib/spots';

type Load =
  { state: 'loading' } | { state: 'ready'; spots: Spot[] } | { state: 'error'; error: Error };

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
    const upsert = async (write: Promise<Spot>) => {
      const spot = await write;
      apply((spots) =>
        spots.some((s) => s.id === spot.id)
          ? spots.map((s) => (s.id === spot.id ? spot : s))
          : [...spots, spot],
      );
      return spot;
    };
    return {
      add: (input) => upsert(repository.add(input)),
      update: (id, patch) => upsert(repository.update(id, patch)),
      markBeen: (id, input) => upsert(repository.markBeen(id, input)),
      addNote: (id, input) => upsert(repository.addNote(id, input)),
      remove: async (id) => {
        await repository.remove(id);
        apply((spots) => spots.filter((s) => s.id !== id));
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
