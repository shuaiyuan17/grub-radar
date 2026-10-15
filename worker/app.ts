import type { Env } from './env';
import type { Principal } from './auth/principal';

/** Hono generics for this Worker. */
export interface AppEnv {
  Bindings: Env;
  Variables: { principal: Principal };
}
