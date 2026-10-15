import { ApiErrorSchema, CSRF_HEADER } from '../contracts/errors';

/** A non-2xx answer from our API, with the server's error code when it sent one. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

/**
 * fetch() for our own API. Same-origin, cookie session; writes carry the JSON
 * content type and the CSRF header the Worker insists on.
 */
export async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    headers[CSRF_HEADER] = '1';
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body:
      init.body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => null));
    throw parsed.success
      ? new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.message)
      : new ApiRequestError(res.status, 'http', `HTTP ${res.status}`);
  }
  return res;
}

export const isUnauthorized = (e: unknown) => e instanceof ApiRequestError && e.status === 401;
