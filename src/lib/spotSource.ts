import { createContext, use } from 'react';
import type { SpotRepository } from '../domain/repository';

/**
 * Which SpotRepository the app reads from. main.tsx provides the HTTP one
 * (signed-in only); tests provide the static demo data. Nothing in the app
 * bundle imports the demo seed, so it is never shipped to anonymous visitors.
 */
export const SpotSourceContext = createContext<SpotRepository | null>(null);

export function useSpotSource(): SpotRepository {
  const repo = use(SpotSourceContext);
  if (!repo) throw new Error('useSpotSource must be used inside <SpotSourceContext>');
  return repo;
}
