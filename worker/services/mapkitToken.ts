/**
 * MapKit JS authorization token: ES256 JWT, 30 minutes, locked to our origin.
 * Apple rejects it from any other origin (ORIGIN_CHECK_FAILURE), so handing
 * it to anonymous visitors is safe; the rate limit protects the quota.
 */
import { importPKCS8, SignJWT } from 'jose';
import type { Env } from '../env';
import { normalizePem } from '../auth/siwa';

export const MAPKIT_TOKEN_TTL_S = 1800;

export async function createMapkitToken(env: Env, origin: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const key = await importPKCS8(normalizePem(env.APPLE_PRIVATE_KEY), 'ES256');
  return new SignJWT({ origin })
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' })
    .setIssuer(env.APPLE_TEAM_ID)
    .setIssuedAt(iat)
    .setExpirationTime(iat + MAPKIT_TOKEN_TTL_S)
    .sign(key);
}
