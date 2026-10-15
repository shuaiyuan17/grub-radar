/**
 * The hand-off between Apple's form_post and the slow part of signing in.
 *
 * POST /auth/callback checks the state (sealed, 10 minutes, matching the
 * state cookie when the browser sent one, single use via D1), then answers at once with a tiny
 * "signing you in…" page instead of making the person stare at a blank screen
 * while we talk to Apple and D1. That page moves itself on (meta refresh, no
 * JavaScript) to GET /auth/finish?t=…, which does the work and redirects.
 *
 * What crosses over is sealed in a cookie (AES-GCM, key derived from
 * SESSION_HMAC_KEY): the code, Apple's one-time `user` field, the nonce hash,
 * returnTo and the previous session. `__Host-`, HttpOnly, Secure, Lax, two
 * minutes. It is bound to a random `t` that only our page knows: a request to
 * /auth/finish without the matching `t` (a cross-site link, a stale tab) can
 * neither use nor clear it. /auth/finish clears it on first use, and Apple's
 * code is single use anyway.
 */
import { z } from 'zod/mini';
import type { Env } from '../env';
import { openValue, randomToken, sealValue } from '../lib/crypto';
import { MINUTE, SECOND } from '../lib/time';
import type { StatePayload } from './siwa';

export const PENDING_COOKIE = '__Host-grub_signin';
export const PENDING_MAX_AGE_S = 120;
const SEAL_INFO = 'grub-radar pending sign-in v1';
/** Apple's `user` JSON is a name and an email; anything longer isn't Apple's. */
const MAX_USER_FIELD = 2048;

const PendingPayload = z.strictObject({
  code: z.string(),
  user: z.optional(z.string()),
  nonceHash: z.string(),
  returnTo: z.string(),
  prevSession: z.optional(z.string()),
  iat: z.number(),
  /** Must come back as ?t= on /auth/finish. */
  finish: z.string(),
});
export type PendingSignIn = z.infer<typeof PendingPayload>;

export async function sealPending(
  env: Env,
  state: StatePayload,
  form: { code: string; user: string | undefined },
  now = Date.now(),
): Promise<{ cookie: string; finish: string }> {
  const finish = randomToken(24);
  const payload: PendingSignIn = {
    code: form.code,
    ...(form.user !== undefined && form.user.length <= MAX_USER_FIELD ? { user: form.user } : {}),
    nonceHash: state.nonceHash,
    returnTo: state.returnTo,
    ...(state.prevSession ? { prevSession: state.prevSession } : {}),
    iat: now,
    finish,
  };
  return {
    cookie: await sealValue(JSON.stringify(payload), env.SESSION_HMAC_KEY, SEAL_INFO),
    finish,
  };
}

/** The pending sign-in, or null if missing / tampered / expired / not for this `t`. */
export async function openPending(
  env: Env,
  cookie: string | undefined,
  finish: string | undefined,
  now = Date.now(),
): Promise<PendingSignIn | null> {
  if (!cookie || !finish || cookie.length > 4096) return null;
  const raw = await openValue(cookie, env.SESSION_HMAC_KEY, SEAL_INFO);
  if (raw === null) return null;
  let parsed: PendingSignIn;
  try {
    parsed = PendingPayload.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (now - parsed.iat > PENDING_MAX_AGE_S * SECOND || parsed.iat > now + MINUTE) return null;
  const enc = new TextEncoder();
  const a = enc.encode(parsed.finish);
  const b = enc.encode(finish);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) return null;
  return parsed;
}
