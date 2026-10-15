import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../lib/crypto';
import { DAY, HOUR, MINUTE } from '../lib/time';
import { createSession, loadSession, SESSION_TTL_MS, uaHint } from './session';

const T0 = Date.UTC(2026, 9, 14, 22, 0);
const row = (id: string) =>
  env.DB.prepare('SELECT expires_at, last_seen_at, ua_hint FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ expires_at: string; last_seen_at: string; ua_hint: string | null }>();

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES ('u_s', 'S', 'x', 'x')",
  ).run();
});

describe('sessions', () => {
  it('stores only the SHA-256 of the token', async () => {
    const { token, session } = await createSession(env.DB, 'u_s', undefined, T0);
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(session.id).toBe(await sha256Hex(token));
    const all = await env.DB.prepare('SELECT id FROM sessions').all<{ id: string }>();
    expect(all.results.map((r) => r.id)).not.toContain(token);
  });

  it('loads a live session; unknown, oversized and missing tokens are not sessions', async () => {
    const { token } = await createSession(env.DB, 'u_s', undefined, T0);
    expect(await loadSession(env.DB, token, T0 + MINUTE)).toMatchObject({
      kind: 'ok',
      session: { userId: 'u_s' },
      refreshed: false,
    });
    expect(await loadSession(env.DB, 'nope', T0)).toEqual({ kind: 'invalid' });
    expect(await loadSession(env.DB, 'x'.repeat(200), T0)).toEqual({ kind: 'invalid' });
    expect(await loadSession(env.DB, undefined, T0)).toEqual({ kind: 'none' });
  });

  it('expires after 30 days and deletes the row', async () => {
    const { token, session } = await createSession(env.DB, 'u_s', undefined, T0);
    expect(await loadSession(env.DB, token, T0 + SESSION_TTL_MS + 1)).toEqual({ kind: 'invalid' });
    expect(await row(session.id)).toBeNull();
  });

  it('slides: with under 15 days left it extends to 30 days from now', async () => {
    const { token, session } = await createSession(env.DB, 'u_s', undefined, T0);
    // 14 days in: 16 left, no refresh
    expect(await loadSession(env.DB, token, T0 + 14 * DAY)).toMatchObject({ refreshed: false });
    const later = T0 + 16 * DAY;
    const r = await loadSession(env.DB, token, later);
    expect(r).toMatchObject({ kind: 'ok', refreshed: true });
    expect(r.kind === 'ok' && r.session.expiresAt).toBe(later + SESSION_TTL_MS);
    expect((await row(session.id))?.expires_at).toBe(
      new Date(later + SESSION_TTL_MS).toISOString(),
    );
  });

  it('writes last_seen_at at most once an hour', async () => {
    const { token, session } = await createSession(env.DB, 'u_s', undefined, T0);
    await loadSession(env.DB, token, T0 + 59 * MINUTE);
    expect((await row(session.id))?.last_seen_at).toBe(new Date(T0).toISOString());
    await loadSession(env.DB, token, T0 + HOUR);
    expect((await row(session.id))?.last_seen_at).toBe(new Date(T0 + HOUR).toISOString());
  });

  it('keeps a coarse device hint, never the raw user agent', async () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const { session } = await createSession(env.DB, 'u_s', ua, T0);
    expect((await row(session.id))?.ua_hint).toBe('Safari on iPhone');
  });
});

describe('uaHint', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Chrome on Mac',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
      'Firefox on Windows',
    ],
    ['curl/8.7.1', null],
    [undefined, null],
  ])('%s -> %s', (ua, hint) => {
    expect(uaHint(ua)).toBe(hint);
  });
});
