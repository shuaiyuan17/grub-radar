import { createContext, use } from 'react';
import {
  AcceptInviteResponseSchema,
  CreatedInviteSchema,
  FriendPlacesResponseSchema,
  FriendsResponseSchema,
  FriendSpotsResponseSchema,
  InvitePreviewSchema,
  InvitesResponseSchema,
  type AcceptInviteResponse,
  type CreatedInvite,
  type FriendsResponse,
  type FriendSpotsResponse,
  type FriendTake,
  type InvitePreview,
  type PendingInvite,
} from '../contracts/friends';
import { MeUserSchema, type MeUser, type PatchMe } from '../contracts/me';
import { api } from './api';

/**
 * How the app talks to /api/friends*, /api/invites* and PATCH /api/me (your
 * name and emoji, which is what friends see). Swapped for a fake in tests.
 */
export interface FriendsClient {
  /** Friends' takes on the places on your list, by place id. */
  places(): Promise<Record<string, FriendTake[]>>;
  list(): Promise<FriendsResponse>;
  invites(): Promise<PendingInvite[]>;
  createInvite(): Promise<CreatedInvite>;
  revokeInvite(id: string): Promise<void>;
  unfriend(id: string): Promise<void>;
  friendSpots(id: string): Promise<FriendSpotsResponse>;
  preview(token: string): Promise<InvitePreview>;
  accept(token: string): Promise<AcceptInviteResponse>;
  updateProfile(patch: PatchMe): Promise<MeUser>;
}

const json = async (res: Response): Promise<unknown> => res.json();

export const httpFriendsClient: FriendsClient = {
  places: async () =>
    FriendPlacesResponseSchema.parse(await json(await api('/api/friends/places'))).places,
  list: async () => FriendsResponseSchema.parse(await json(await api('/api/friends'))),
  invites: async () => InvitesResponseSchema.parse(await json(await api('/api/invites'))).invites,
  createInvite: async () =>
    CreatedInviteSchema.parse(await json(await api('/api/invites', { method: 'POST' }))),
  revokeInvite: async (id) => {
    await api(`/api/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  unfriend: async (id) => {
    await api(`/api/friends/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  friendSpots: async (id) =>
    FriendSpotsResponseSchema.parse(
      await json(await api(`/api/friends/${encodeURIComponent(id)}/spots`)),
    ),
  // the token goes in the body, never in a URL
  preview: async (token) =>
    InvitePreviewSchema.parse(
      await json(await api('/api/invites/preview', { method: 'POST', body: { token } })),
    ),
  accept: async (token) =>
    AcceptInviteResponseSchema.parse(
      await json(await api('/api/invites/accept', { method: 'POST', body: { token } })),
    ),
  updateProfile: async (patch) =>
    MeUserSchema.parse(await json(await api('/api/me', { method: 'PATCH', body: patch }))),
};

export const FriendsClientContext = createContext<FriendsClient>(httpFriendsClient);

export function useFriendsClient(): FriendsClient {
  return use(FriendsClientContext);
}

/** Friends' takes on your places, loaded once per page load (see FriendsProvider). */
export interface FriendTakesValue {
  /** By place id; empty until loaded, and when you have no friends. */
  takes: Readonly<Record<string, readonly FriendTake[]>>;
  /** Fetch again (after accepting an invite, unfriending, …). */
  refresh: () => void;
}

export const FriendTakesContext = createContext<FriendTakesValue>({
  takes: {},
  refresh: () => undefined,
});

export function useFriendTakes(): FriendTakesValue {
  return use(FriendTakesContext);
}

/** The takes on one place: who has been (with verdicts first), and who wants to go. */
export function takesFor(
  takes: FriendTakesValue['takes'],
  placeId: string,
): { been: readonly FriendTake[]; want: readonly FriendTake[] } {
  const all = takes[placeId] ?? [];
  return {
    been: all.filter((t) => t.status === 'been'),
    want: all.filter((t) => t.status === 'want'),
  };
}

/** Emoji to pick an avatar from (any single emoji is accepted by the server). */
export const AVATAR_CHOICES = [
  '🍜',
  '🥟',
  '🌮',
  '🍣',
  '🍕',
  '🥐',
  '☕',
  '🧋',
  '🍩',
  '🍔',
  '🥗',
  '🍙',
  '🌶️',
  '🍋',
  '🥑',
  '🍓',
  '🐼',
  '🦊',
  '🐸',
  '🐙',
  '🐝',
  '🐱',
  '🐶',
  '🌵',
] as const;

/** The full link for an invite: this app's origin + `/invite#<token>`. */
export const inviteUrl = (path: string, origin = window.location.origin) => `${origin}${path}`;
