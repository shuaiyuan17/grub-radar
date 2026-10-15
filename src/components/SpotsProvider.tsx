import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StaticSpotRepository } from '../data/staticRepository';
import type { SpotRepository } from '../domain/repository';
import type { Spot } from '../domain/spot';
import { SpotsContext } from '../lib/spots';

const defaultRepository = new StaticSpotRepository();

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
 * Loads spots from the repository and hands them to the tree. Pass a
 * different repository (e.g. an HTTP one) to point the UI elsewhere.
 */
export function SpotsProvider({
  children,
  repository = defaultRepository,
}: {
  children: ReactNode;
  repository?: SpotRepository;
}) {
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

  const spots = load.state === 'ready' ? load.spots : null;
  const value = useMemo(() => (spots ? { repository, spots } : null), [repository, spots]);

  if (load.state === 'error') {
    return (
      <p role="alert" className="note" style={{ fontSize: 22, whiteSpace: 'pre-wrap' }}>
        couldn&apos;t load the spots: {load.error.message}
      </p>
    );
  }
  if (!value) {
    return (
      <p className="note" style={{ fontSize: 22 }} aria-busy="true">
        unfolding the map…
      </p>
    );
  }
  return <SpotsContext value={value}>{children}</SpotsContext>;
}
