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

/** A client id that is a metadata document URL (CIMD), as opposed to a registered id. */
export const isCimdClientId = (clientId: string) => {
  try {
    const u = new URL(clientId);
    return u.protocol === 'https:' && u.pathname.length > 1;
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
