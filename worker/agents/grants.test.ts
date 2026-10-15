/**
 * Which client ids are metadata-document URLs must match the OAuth provider's
 * own rule exactly: a mismatch makes re-authorizing one installation of a
 * CIMD client disconnect the other in D1 while the provider keeps it.
 */
import { describe, expect, it } from 'vitest';
import { isCimdClientId } from './grants';

describe('isCimdClientId (mirrors the provider)', () => {
  it.each([
    ['https://agent.example/', true],
    ['https://agent.example/client.json', true],
    ['https://agent.example/a?x=1', true],
    ['https://agent.example', false],
    ['https://agent.example?x=1', false],
    ['http://agent.example/client.json', false],
    ['3f8c1b2a-registered-id', false],
    ['not a url', false],
  ])('%s → %s', (id, expected) => {
    expect(isCimdClientId(id)).toBe(expected);
  });
});
