/**
 * /privacy and /terms: public, plain HTML, no script, and linked from the
 * consent page and the docs agents read.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  CONTACT_EMAIL,
  LEGAL_UPDATED,
  OPERATOR,
  PRIVACY_PATH,
  TERMS_PATH,
} from '../../src/contracts/legal';
import { consentErrorPage, consentPage } from '../agents/consentPage';
import { CLIENT_REGISTRATION_TTL_S } from '../agents/oauth';
import { agentSetup, llmsTxt, openApi } from '../agents/docs';
import { call, ORIGIN } from '../test/helpers';
import { LEGAL_STYLE, privacyPage, termsPage } from './pages';

const PRIVACY_SECTIONS = [
  'What we collect, and why',
  'Who handles your data for us',
  'Who sees what',
  'How long we keep it, and how to delete it',
  'Security',
  'Children',
  'Changes and contact',
];
const TERMS_SECTIONS = [
  'Agreeing to these terms',
  'The service',
  'Your account',
  'Your content',
  'Acceptable use',
  'Agents and the API',
  'Third-party services',
  'Ending things',
  'Disclaimers and limitation of liability',
  'Governing law',
  'Changes and contact',
];

describe.each([
  { path: PRIVACY_PATH, title: 'Privacy Policy', sections: PRIVACY_SECTIONS },
  { path: TERMS_PATH, title: 'Terms of Service', sections: TERMS_SECTIONS },
])('$path', ({ path, title, sections }) => {
  it('is 200 HTML without a session', async () => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('set-cookie')).toBeNull();
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`Last updated: ${LEGAL_UPDATED}`);
    expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(html).toContain(OPERATOR);
    for (const s of sections) expect(html).toContain(`>${s}</h2>`);
    // both pages link to each other
    expect(html).toContain(`href="${PRIVACY_PATH}"`);
    expect(html).toContain(`href="${TERMS_PATH}"`);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${path}">`);
  });

  it('works without JavaScript: no script at all, and a CSP that allows none', async () => {
    const res = await call(path);
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    // the one inline <style> is exactly the hashed one
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(styles).toEqual([LEGAL_STYLE]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(LEGAL_STYLE));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(csp).toContain(`style-src 'sha256-${hash}'`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('a trailing slash redirects to the page', async () => {
    const res = await call(`${path}/`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(path);
  });
});

describe('what the privacy policy says', () => {
  const html = privacyPage(ORIGIN);

  it('covers the points the code backs', () => {
    for (const claim of [
      'private relay address',
      'rejects any file that still carries camera or location metadata',
      'An embedded colour profile may remain',
      'New spots are visible to your friends by default',
      'mark any spot “just me”',
      'use it only to answer your support or account deletion requests',
      'not stored in plain text',
      'we use it only to carry out that agent’s requests',
      'including photos and agent connections, within 30 days of your request',
      'never shown to friends or to agents',
      '~1 km grid square',
      'only a hash of the link’s secret',
      'only a hash of the token',
      'Apple’s Maps Server API',
      'Cloudflare Workers',
      'D1',
      'R2',
      'Workers KV',
      'don’t sell',
      'don’t use your data to train AI models',
      'at most 7 days',
      'children under 13',
    ])
      expect(html).toContain(claim);
  });

  it('states the session and token lifetimes from the code', () => {
    expect(html).toContain('expire after 30 days without use, and after 90 days at most');
    expect(html).toContain('an access token lasts 4 hours');
    expect(html).toContain('a refresh token expires after 30 days unused');
    expect(html).toContain(
      'A registration that is never used expires after 30 days (up to 90 days for registrations created on or before 15 October 2026)',
    );
  });

  it('the client registration lifetime it states is the one the OAuth server applies', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await call('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'TTL check',
        redirect_uris: ['http://127.0.0.1:43117/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(res.status).toBe(201);
    const { client_id } = await res.json<{ client_id: string }>();
    const { keys } = await env.OAUTH_KV.list({ prefix: `client:${client_id}` });
    const ttl = (keys[0]?.expiration ?? 0) - before;
    expect(ttl).toBeGreaterThanOrEqual(CLIENT_REGISTRATION_TTL_S - 5);
    expect(ttl).toBeLessThanOrEqual(CLIENT_REGISTRATION_TTL_S + 5);
  });

  it('there is no account deletion endpoint, so the page says to email us', async () => {
    // if this starts failing, DELETE /api/me exists: update the policy's deletion section
    const res = await call('/api/me', { method: 'DELETE' });
    expect([401, 404, 405]).toContain(res.status);
    expect(html).toContain('doesn’t have a delete-account button yet');
  });
});

describe('the terms', () => {
  const html = termsPage(ORIGIN);

  it('names Washington law', () => {
    expect(html).toContain('State of Washington, USA');
  });

  it('licenses content only to host and show it, keeps Apple data Apple’s, gives notice', () => {
    expect(html).toContain('You keep whatever rights you have');
    expect(html).toContain(
      'to your friends (for what you share with them) and to the agents you authorize',
    );
    expect(html).toContain('Apple Maps remains Apple’s');
    expect(html).toContain('that you authorize, or that you could reasonably have prevented');
    expect(html).toContain('reasonable notice in the app before they take effect');
  });
});

describe('links to the legal pages', () => {
  const view = {
    details: {
      clientName: 'Agent',
      clientDomain: null,
      redirectHost: 'example.com',
      redirectIsLoopback: false,
    },
    handle: 'h',
    signedInAs: '🍜 Tess',
    requested: ['spots:read'],
  } as unknown as Parameters<typeof consentPage>[1];

  it.each(['en', 'zh-Hans'] as const)('the consent page footer (%s)', (locale) => {
    for (const html of [consentPage(locale, view), consentErrorPage(locale, 'nope')]) {
      expect(html).toMatch(/<footer>[\s\S]*href="\/privacy"[\s\S]*href="\/terms"[\s\S]*<\/footer>/);
    }
  });

  it('llms.txt and agent-setup.md', async () => {
    for (const path of ['/llms.txt', '/agent-setup.md']) {
      const text = await (await call(path)).text();
      expect(text).toContain(`${ORIGIN}/privacy`);
      expect(text).toContain(`${ORIGIN}/terms`);
      expect(text).toContain(CONTACT_EMAIL);
    }
    expect(llmsTxt(ORIGIN)).toContain('## Legal');
    expect(agentSetup(ORIGIN)).toContain('## Privacy and terms');
  });

  it('openapi.json names the terms and a contact', () => {
    expect(openApi(ORIGIN)).toMatchObject({
      info: { termsOfService: `${ORIGIN}/terms`, contact: { email: CONTACT_EMAIL } },
    });
  });
});
