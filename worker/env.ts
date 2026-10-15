/** Bindings, vars and secrets (wrangler.jsonc + `wrangler secret put` + .dev.vars). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MAPKIT_TOKEN_LIMITER: RateLimit;

  /** "production" on Cloudflare; anything else enables dev-only features. */
  ENVIRONMENT: string;
  APPLE_TEAM_ID: string;
  /** Services ID: the web Sign in with Apple client_id. */
  APPLE_CLIENT_ID: string;
  APPLE_KEY_ID: string;
  /** https://grub.shuaiyuan.me: where Apple sends people back to. */
  PUBLIC_ORIGIN: string;
  /** "true" | "false" (see wrangler.jsonc). */
  SIGNUP_OPEN: string;

  /** Secret. ES256 .p8 key as PEM (literal "\n" escapes are accepted). */
  APPLE_PRIVATE_KEY: string;
  /** Secret. HMAC key for the SIWA state cookie. */
  SESSION_HMAC_KEY: string;

  /** Dev only: enables POST /auth/dev-login. Never set in production. */
  DEV_LOGIN_SECRET?: string;
  /** Dev only: base URL of the Apple stub. Ignored in production. */
  APPLE_ENDPOINT_BASE?: string;
}

export const isProduction = (env: Env) => env.ENVIRONMENT === 'production';
