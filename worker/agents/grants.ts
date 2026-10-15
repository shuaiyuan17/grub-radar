/**
 * Reading a person's OAuth grants out of the provider's KV, every page of
 * them, and deciding which ones a new authorization replaces, by the same
 * rule workers-oauth-provider applies when it revokes them (1.2.3,
 * completeAuthorization): same client, same resource, and for a client
 * identified by a metadata URL (CIMD, shared by all its installations) the
 * same redirect URI, so another installation isn't disconnected.
 */
import type { AuthRequest, GrantSummary, OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/** KV list page size (KV's own maximum). */
export const GRANT_PAGE = 1000;

/** Every grant of `userId`'s, across all pages. */
export async function allGrants(
  oauth: OAuthHelpers,
  userId: string,
  pageSize = GRANT_PAGE,
): Promise<GrantSummary[]> {
  const out: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, {
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/**
 * The raw path of a client id, as @cloudflare/workers-oauth-provider reads it
 * (its unexported `rawPath`): not `new URL().pathname`, which normalises.
 */
function rawPath(clientId: string): string {
  const schemeEnd = clientId.indexOf('://');
  if (schemeEnd === -1) return '';
  const authorityStart = schemeEnd + 3;
  const authorityEnd = clientId.slice(authorityStart).search(/[/?#]/);
  if (authorityEnd === -1) return '';
  const pathStart = authorityStart + authorityEnd;
  if (clientId[pathStart] !== '/') return '';
  const pathEnd = clientId.slice(pathStart).search(/[?#]/);
  return pathEnd === -1
    ? clientId.slice(pathStart)
    : clientId.slice(pathStart, pathStart + pathEnd);
}

/**
 * A client id that is a metadata document URL (CIMD), as opposed to a registered
 * id. Mirrors the provider's `isClientIdMetadataDocumentUrl` exactly, so a bare
 * `https://agent.example/` counts too.
 */
export const isCimdClientId = (clientId: string) => {
  try {
    return new URL(clientId).protocol === 'https:' && rawPath(clientId) !== '';
  } catch {
    return false;
  }
};

/** Does authorizing `request` replace `grant` (the provider's rule, see above)? */
export function replacedBy(grant: GrantSummary, request: AuthRequest): boolean {
  const resource = Array.isArray(grant.resource) ? grant.resource[0] : grant.resource;
  return (
    grant.clientId === request.clientId &&
    (!isCimdClientId(request.clientId) || grant.redirectUri === request.redirectUri) &&
    resource === request.resource
  );
}
