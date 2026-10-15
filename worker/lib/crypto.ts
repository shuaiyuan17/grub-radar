const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `bytes` of CSPRNG output, base64url. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

/** `<payload b64url>.<HMAC-SHA256 b64url>` */
export async function signValue(payload: string, secret: string): Promise<string> {
  const body = base64url(encoder.encode(payload));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(sig))}`;
}

/** The payload if the signature checks out (constant-time), else null. */
export async function verifyValue(signed: string, secret: string): Promise<string | null> {
  const dot = signed.indexOf('.');
  if (dot <= 0 || dot !== signed.lastIndexOf('.')) return null;
  const body = signed.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64url(signed.slice(dot + 1)),
      encoder.encode(body),
    );
    return ok ? new TextDecoder().decode(fromBase64url(body)) : null;
  } catch {
    return null; // malformed base64
  }
}
