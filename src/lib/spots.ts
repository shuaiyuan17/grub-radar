import { createContext, use } from 'react';
import type { AddApplePlaceInput } from '../contracts/places';
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
  /**
   * Puts a place from Apple Maps on your list (or, if it's already there,
   * hands back your entry). null when the source can't reach Apple Maps.
   */
  addApplePlace: ((input: AddApplePlaceInput) => Promise<Spot>) | null;
}

/** A spot source that can add places from Apple Maps (the server; test doubles). */
export interface ApplePlaceAdder {
  addApplePlace(input: AddApplePlaceInput): Promise<Spot>;
}

export function canAddApplePlaces<T extends object>(repo: T): repo is T & ApplePlaceAdder {
  return typeof (repo as Partial<ApplePlaceAdder>).addApplePlace === 'function';
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
