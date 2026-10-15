/**
 * Single use for Sign in with Apple states (migration 0006). The sealed state
 * is valid on its own for 10 minutes; this makes it valid once.
 */
import { STATE_MAX_AGE_S } from '../auth/siwa';
import { MINUTE, SECOND, iso } from '../lib/time';

/**
 * Records `jti` as spent. True the first time, false for a replay. One D1
 * round trip: the expired rows are swept in the same batch. A row outlives
 * its state (iat + 10 min, + the minute of clock slack openState allows), so
 * no replayable state ever loses its row.
 */
export async function spendState(
  db: D1Database,
  state: { jti: string; iat: number },
  now = Date.now(),
): Promise<boolean> {
  const expiresAt = iso(state.iat + STATE_MAX_AGE_S * SECOND + MINUTE);
  const [, inserted] = await db.batch([
    db.prepare('DELETE FROM auth_states_used WHERE expires_at < ?').bind(iso(now)),
    db
      .prepare(
        'INSERT INTO auth_states_used (jti, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING',
      )
      .bind(state.jti, expiresAt),
  ]);
  return inserted?.meta.changes === 1;
}
