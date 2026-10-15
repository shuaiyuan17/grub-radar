import { useEffect } from 'react';
import { InviteTokenSchema } from '../contracts/friends';

/**
 * The invite link's token lives in the URL fragment (`/invite#<token>`), which
 * browsers never send to a server. Sign in with Apple is a full-page round
 * trip whose returnTo is only `/invite`, so the token waits here, in this
 * tab's sessionStorage, until the invite is accepted (or turns out spent).
 */
const KEY = 'grub-radar:invite';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // storage blocked: the fragment still works while it's there
  }
}

/** A valid token from `#<token>`, else null. */
export function tokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return InviteTokenSchema.safeParse(raw).success ? raw : null;
}

/** Keeps a token from the fragment (if there is one); returns the token to use. */
export function rememberInviteToken(hash: string): string | null {
  const fromHash = tokenFromHash(hash);
  const store = storage();
  if (fromHash) {
    store?.setItem(KEY, fromHash);
    return fromHash;
  }
  const saved = store?.getItem(KEY) ?? null;
  return saved && tokenFromHash(saved) ? saved : null;
}

export function forgetInviteToken(): void {
  storage()?.removeItem(KEY);
}

/**
 * While mounted: `<meta name="referrer" content="no-referrer">`, so nothing
 * fetched or followed from an invite page carries a Referer at all.
 */
export function useNoReferrer(): void {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.append(meta);
    return () => {
      meta.remove();
    };
  }, []);
}
