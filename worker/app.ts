import type { Context } from 'hono';
import type { Env } from './env';
import type { Principal } from './auth/principal';
import type { User } from './db/users';
import type { Timing } from './lib/timing';

/** A route's reads, already run in the session lookup's batch; `key` names the route. */
export interface Prefetched {
  key: string;
  results: D1Result[];
}

/** Hono generics for this Worker. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    principal: Principal;
    timing: Timing;
    /** Work that may finish after the response (see `defer`). */
    deferred: Promise<unknown>[];
    /** The signed-in person's profile, read together with the session (one query). */
    account: User | undefined;
    /**
     * Results of the route's reads, fetched in the same D1 batch as the session
     * lookup (see `resolvePrincipal`). Only ever set for a valid session.
     */
    prefetched: Prefetched | undefined;
    /**
     * The D1 binding without the per-request timing wrapper. Only for checks
     * whose cost must not show in Server-Timing (the admin gate: a non-admin's
     * 404 must look exactly like any unknown endpoint's).
     */
    untimedDB: D1Database;
  };
}

/**
 * Runs `work` without making the response wait for it (ctx.waitUntil). Where
 * there is no execution context (unit tests calling app.request), the request
 * middleware awaits it before answering instead. Failures are logged, never thrown.
 */
export function defer(c: Context<AppEnv>, work: Promise<unknown>) {
  const p = work.catch((e: unknown) => {
    console.error('deferred work failed', e instanceof Error ? `${e.name}: ${e.message}` : e);
  });
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    c.var.deferred.push(p);
  }
}

/**
 * The request's ExecutionContext, as the Workers types spell it (for handing
 * a request on to a library's fetch). Tests calling app.request() have none:
 * then a stand-in whose waitUntil defers.
 */
export function executionCtx(c: Context<AppEnv>): ExecutionContext {
  try {
    return c.executionCtx as unknown as ExecutionContext;
  } catch {
    return {
      waitUntil: (p: Promise<unknown>) => {
        defer(c, p);
      },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
  }
}
