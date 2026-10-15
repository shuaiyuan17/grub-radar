import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Same SQL files as `wrangler d1 migrations apply`, so tests can't drift from prod.
// Storage is isolated per test file; this runs before each file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
