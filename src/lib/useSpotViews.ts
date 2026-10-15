import { useMemo } from 'react';
import { toSpotViews, type SpotView } from '../domain/spotView';
import { useOrigin } from './origin';
import { useSpots } from './spots';

export function useSpotViews(): SpotView[] {
  const { origin } = useOrigin();
  const { spots } = useSpots();
  return useMemo(() => toSpotViews(spots, origin), [spots, origin]);
}
