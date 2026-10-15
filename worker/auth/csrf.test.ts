import { describe, expect, it } from 'vitest';
import { checkCsrf } from './csrf';

const req = (method: string, headers: Record<string, string>) =>
  new Request('https://grub.test/api/me', { method, headers });
const good = { 'content-type': 'application/json', 'x-grub-request': '1' };

describe('checkCsrf', () => {
  it('lets reads through', () => {
    expect(checkCsrf(req('GET', {})).ok).toBe(true);
    expect(checkCsrf(req('HEAD', {})).ok).toBe(true);
  });

  it.each<[string, Record<string, string>, boolean, string?]>([
    ['same-origin fetch from the SPA', { ...good, 'sec-fetch-site': 'same-origin' }, true],
    ['typed-in / no initiator', { ...good, 'sec-fetch-site': 'none' }, true],
    ['old browser, same Origin', { ...good, origin: 'https://grub.test' }, true],
    ['old browser, no Origin', good, true],
    [
      'charset suffix on content-type',
      { ...good, 'content-type': 'application/json; charset=utf-8' },
      true,
    ],
    [
      'a form post (no JSON)',
      { 'content-type': 'application/x-www-form-urlencoded', 'x-grub-request': '1' },
      false,
      'content-type',
    ],
    [
      'text/plain (simple request)',
      { 'content-type': 'text/plain', 'x-grub-request': '1' },
      false,
      'content-type',
    ],
    [
      'missing custom header',
      { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      false,
      'header',
    ],
    ['custom header with the wrong value', { ...good, 'x-grub-request': 'yes' }, false, 'header'],
    ['cross-site', { ...good, 'sec-fetch-site': 'cross-site' }, false, 'site'],
    ['same-site but another subdomain', { ...good, 'sec-fetch-site': 'same-site' }, false, 'site'],
    [
      'foreign Origin without Sec-Fetch-Site',
      { ...good, origin: 'https://evil.example' },
      false,
      'origin',
    ],
    ['null Origin', { ...good, origin: 'null' }, false, 'origin'],
  ])('%s', (_label, headers, ok, why) => {
    const v = checkCsrf(req('POST', headers));
    expect(v.ok).toBe(ok);
    if (!v.ok) expect(v.why).toBe(why);
  });

  it('bearer requests skip the header/origin checks but still need JSON', () => {
    const bearer = { authorization: 'Bearer grub_pat_x', 'sec-fetch-site': 'cross-site' };
    expect(checkCsrf(req('POST', { ...bearer, 'content-type': 'application/json' })).ok).toBe(true);
    expect(checkCsrf(req('POST', bearer)).ok).toBe(false);
  });

  it('applies to every unsafe method', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(checkCsrf(req(m, { 'sec-fetch-site': 'cross-site' })).ok).toBe(false);
  });
});
