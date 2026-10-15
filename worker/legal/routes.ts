/**
 * GET /privacy and /terms: public, no session, no JavaScript. Listed in
 * wrangler.jsonc run_worker_first, so they never fall through to the SPA.
 */
import { Hono, type Context } from 'hono';
import { PRIVACY_PATH, TERMS_PATH } from '../../src/contracts/legal';
import type { AppEnv } from '../app';
import { publicOrigin } from '../auth/siwa';
import { legalCsp, privacyPage, termsPage } from './pages';

export const legal = new Hono<AppEnv>();

async function serve(c: Context<AppEnv>, render: (origin: string) => string) {
  c.header('Content-Security-Policy', await legalCsp());
  // the same for everyone: browsers and Cloudflare may keep it for an hour
  c.header('Cache-Control', 'public, max-age=3600');
  return c.html(render(publicOrigin(c.env, c.req.url)));
}

legal.get(PRIVACY_PATH, (c) => serve(c, privacyPage));
legal.get(TERMS_PATH, (c) => serve(c, termsPage));
// a trailing slash is the same page
legal.get(`${PRIVACY_PATH}/`, (c) => c.redirect(PRIVACY_PATH, 301));
legal.get(`${TERMS_PATH}/`, (c) => c.redirect(TERMS_PATH, 301));
