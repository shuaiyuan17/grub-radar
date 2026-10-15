/** Bindings, vars and secrets (wrangler.jsonc + `wrangler secret put` + .dev.vars). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MAPKIT_TOKEN_LIMITER: RateLimit;
  /** 60 writes/min per user (spots + home). */
  WRITE_LIMITER: RateLimit;
  /** 30 Apple Maps searches/lookups a minute per user (protects Apple's daily quota). */
  SEARCH_LIMITER: RateLimit;
  /** 30 POSTs to /auth/callback a minute per client IP. */
  CALLBACK_LIMITER: RateLimit;
  /** 20 photo uploads a minute per user (on top of WRITE_LIMITER). */
  PHOTO_UPLOAD_LIMITER: RateLimit;
  /** Photo bytes (bucket grub-radar-photos). Private: only the Worker serves them. */
  PHOTOS: R2Bucket;

  /**
   * "production" on Cloudflare. Dev-only features (dev login, the Apple stub,
   * request-origin redirects) need exactly "development": anything else,
   * including a typo or a missing value, behaves like production.
   */
  ENVIRONMENT: string;
  APPLE_TEAM_ID: string;
  /** Services ID: the web Sign in with Apple client_id. */
  APPLE_CLIENT_ID: string;
  APPLE_KEY_ID: string;
  /** https://grub.shuaiyuan.me: where Apple sends people back to. */
  PUBLIC_ORIGIN: string;
  /** "true" | "false" (see wrangler.jsonc). */
  SIGNUP_OPEN: string;
  /**
   * Optional Apple `sub` of the owner. When set and sign-up is closed, only
   * this Apple ID can create an account (replaces the first-account rule).
   */
  OWNER_APPLE_SUB?: string;
  /**
   * Secret. Comma-separated Apple `sub`s whose accounts may open /admin. Unset
   * or empty: nobody can. Everyone else gets the same 404 as any unknown path.
   */
  ADMIN_APPLE_SUBS?: string;

  /** Secret. ES256 .p8 key as PEM (literal "\n" escapes are accepted). */
  APPLE_PRIVATE_KEY: string;
  /** Secret. Root key for the sealed SIWA state, the sign-in hand-off and other HMACs. */
  SESSION_HMAC_KEY: string;

  /** Dev only: enables POST /auth/dev-login. Never set in production. */
  DEV_LOGIN_SECRET?: string;
  /** Dev only: base URL of the Apple stub. Ignored in production. */
  APPLE_ENDPOINT_BASE?: string;
  /** Dev only: base URL of an Apple Maps Server API stub. Ignored in production. */
  APPLE_MAPS_BASE?: string;
}

/** Fail closed: only an explicit "development" turns on dev-only behaviour. */
export const isDevelopment = (env: Env) => env.ENVIRONMENT === 'development';
