import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from '../../src/contracts/errors';

/** `{ error: { code, message } }`, the one error shape every endpoint uses. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}
