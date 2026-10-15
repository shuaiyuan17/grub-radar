import { createContext, use } from 'react';
import type { LatLng } from '../domain/geo';
import { api } from './api';

/**
 * Where your home is saved: your account (user_private on the server), via
 * PUT/DELETE /api/me/home. Only ever sent in a request body, and only here.
 */
export interface HomeClient {
  save: (home: LatLng) => Promise<void>;
  clear: () => Promise<void>;
}

export const httpHomeClient: HomeClient = {
  save: async (home) => {
    await api('/api/me/home', { method: 'PUT', body: { lat: home.lat, lng: home.lng } });
  },
  clear: async () => {
    await api('/api/me/home', { method: 'DELETE' });
  },
};

export const HomeClientContext = createContext<HomeClient>(httpHomeClient);

export function useHomeClient(): HomeClient {
  return use(HomeClientContext);
}
