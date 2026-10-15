import { createContext, use } from 'react';
import type { SpotRepository } from '../domain/repository';
import type { Spot } from '../domain/spot';

export interface SpotsValue {
  repository: SpotRepository;
  spots: readonly Spot[];
}

export const SpotsContext = createContext<SpotsValue | null>(null);

export function useSpots(): SpotsValue {
  const ctx = use(SpotsContext);
  if (!ctx) throw new Error('useSpots must be used inside <SpotsProvider>');
  return ctx;
}
