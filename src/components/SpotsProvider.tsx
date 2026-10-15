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
  const [load, setLoad] = useState<Load>(() => initialLoad(repository));

  useEffect(() => {
    if (repository.snapshot) return; // already have it
    let live = true;
    repository.list().then(
      (spots) => {
        if (live) setLoad({ state: 'ready', spots });
      },
      (error: unknown) => {
        if (live) setLoad({ state: 'error', error: asError(error) });
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
