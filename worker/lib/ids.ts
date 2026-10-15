// ULID (https://github.com/ulid/spec), lowercased: 10 chars of time, 16 of randomness.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let tail = '';
  for (const b of rand) tail += ALPHABET.charAt(b % 32);
  return time + tail;
}

export const newUserId = () => `u_${ulid()}`;
/** Place ids double as URL slugs (/place/p-01j…), so they fit SpotSchema's id rule. */
export const newPlaceId = () => `p-${ulid()}`;
export const newVisitId = () => `v_${ulid()}`;
