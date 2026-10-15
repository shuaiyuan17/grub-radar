/**
 * MapKit JS authorization token: ES256 JWT, 10 minutes, with an `origin`
 * claim. The origin check is enforced by Apple against the browser's Origin
 * header, so it only stops other *websites* from using a token; anyone with
 * a token can replay it from curl until it expires. Hence: signed-in only,
 * rate-limited, short-lived.
 */
import { SignJWT } from 'jose';
import type { Env } from '../env';
import { signingKey } from '../auth/siwa';

export const MAPKIT_TOKEN_TTL_S = 600;

export async function createMapkitToken(env: Env, origin: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  return new SignJWT({ origin })
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' })
    .setIssuer(env.APPLE_TEAM_ID)
    .setIssuedAt(iat)
    .setExpirationTime(iat + MAPKIT_TOKEN_TTL_S)
    .sign(await signingKey(env.APPLE_PRIVATE_KEY));
}
