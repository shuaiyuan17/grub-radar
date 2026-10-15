import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod/mini';
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

/** "verdict: only give a verdict on places you have been to" — the first problem, with its path. */
export function describeIssue(error: z.core.$ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid body';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** The JSON body, or a ready 400 response. */
export async function readBody(
  c: Context,
): Promise<{ ok: true; data: unknown } | { ok: false; res: Response }> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  if (raw === undefined)
    return { ok: false, res: apiError(c, 400, 'bad_request', 'body must be JSON') };
  return { ok: true, data: raw };
}

/** `raw` checked against `schema`: the data, or a ready 400 response saying what's wrong. */
export function parseBody<T extends z.core.$ZodType>(
  c: Context,
  schema: T,
  raw: unknown,
): { ok: true; data: z.output<T> } | { ok: false; res: Response } {
  const parsed = z.safeParse(schema, raw);
  if (!parsed.success)
    return { ok: false, res: apiError(c, 400, 'bad_request', describeIssue(parsed.error)) };
  return { ok: true, data: parsed.data };
}

/** Parses the JSON body with `schema`: the data, or a ready 400 response. */
export async function readJson<T extends z.core.$ZodType>(
  c: Context,
  schema: T,
): Promise<{ ok: true; data: z.output<T> } | { ok: false; res: Response }> {
  const body = await readBody(c);
  return body.ok ? parseBody(c, schema, body.data) : body;
}
