import { createContext, use } from 'react';
import type { AddNote, AddSpot, MarkBeen, SpotPatch } from '../domain/edits';
import type { SpotRepository } from '../domain/repository';
import type { Spot } from '../domain/spot';

/**
 * What the UI can do to your list. Each call goes to the repository (the
 * server), then the answer replaces the spot in memory: no optimistic UI, so
 * what you see is what was saved.
 */
export interface SpotActions {
  add(input: AddSpot): Promise<Spot>;
  update(id: string, patch: SpotPatch): Promise<Spot>;
  markBeen(id: string, input?: MarkBeen): Promise<Spot>;
  addNote(id: string, input: AddNote): Promise<Spot>;
  remove(id: string): Promise<void>;
}

export interface SpotsValue {
  repository: SpotRepository;
  spots: readonly Spot[];
  /** null for a read-only source. */
  actions: SpotActions | null;
}

export const SpotsContext = createContext<SpotsValue | null>(null);

export function useSpots(): SpotsValue {
  const ctx = use(SpotsContext);
  if (!ctx) throw new Error('useSpots must be used inside <SpotsProvider>');
  return ctx;
}

/** Your local calendar date, "2026-10-14" (notes and visits are dated in your day, not UTC's). */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
