import { z } from 'zod/mini';
import { sanitizeName } from './me';

/**
 * Wire shapes for the agent door's settings: personal API tokens
 * (/api/me/tokens) and connected OAuth agents (/api/me/agents). Both are
 * session-only: an agent can never list or mint credentials.
 */

/**
 * What an agent may be granted. `friends:read` is reserved (an agent of yours
 * reading your friends' shared spots) and not grantable yet.
 */
export const AGENT_SCOPES = ['spots:read', 'spots:write'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export const AgentScopeSchema = z.enum(AGENT_SCOPES);

/** Personal tokens start with this, so a leaked one is easy to grep for. */
export const PAT_PREFIX = 'grub_pat_';
export const TOKEN_NAME_MAX = 40;
/** Live personal tokens per person. */
export const TOKENS_MAX = 10;

const segmenter = new Intl.Segmenter();

/**
 * Names an agent may not take: they mean something else in `found_by`
 * ('me', the demo import, a friend) or look like our own prefix.
 */
export function isReservedAgentName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === 'me' || n === 'demo' || n.startsWith('friend:') || n.startsWith('agent:');
}

/**
 * An agent's name as it shows anywhere ("found by …", the consent page,
 * settings): invisible and bidi characters stripped, cut on whole graphemes
 * to at most TOKEN_NAME_MAX UTF-16 units (the same limit SpotSchema.foundBy
 * checks, so a stored name always validates). Empty or reserved -> `fallback`.
 */
export function agentName(raw: string, fallback = 'an agent'): string {
  let out = '';
  for (const { segment } of segmenter.segment(sanitizeName(raw))) {
    if (out.length + segment.length > TOKEN_NAME_MAX) break;
    out += segment;
  }
  out = out.trim();
  return out && !isReservedAgentName(out) ? out : fallback;
}

/**
 * `user_places.found_by` for a spot an agent added: 'agent:<name>', so no
 * agent name can pass for 'me', 'demo' or 'friend:…'.
 */
export const FOUND_BY_AGENT = 'agent:';
export const foundByAgent = (name: string) => `${FOUND_BY_AGENT}${agentName(name)}`;

/** POST /api/me/tokens */
export const CreateTokenSchema = z.strictObject({
  name: z.string().check(
    z.overwrite((s) => sanitizeName(s)),
    z.minLength(1, 'give it a name'),
    z.maxLength(TOKEN_NAME_MAX),
    z.refine((s) => !isReservedAgentName(s), 'that name is reserved, pick another'),
  ),
  /** spots:read is always included; add spots:write to let it add and edit. */
  scopes: z.array(AgentScopeSchema).check(z.minLength(1), z.maxLength(AGENT_SCOPES.length)),
});
export type CreateTokenInput = z.input<typeof CreateTokenSchema>;

export const PersonalTokenSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  scopes: z.array(AgentScopeSchema),
  createdAt: z.string(),
  lastUsedAt: z.nullable(z.string()),
});
export type PersonalToken = z.infer<typeof PersonalTokenSchema>;

/** GET /api/me/tokens */
export const TokensResponseSchema = z.strictObject({ tokens: z.array(PersonalTokenSchema) });

/** POST /api/me/tokens: the secret, once. Only its hash is kept. */
export const CreatedTokenSchema = z.strictObject({
  token: PersonalTokenSchema,
  secret: z.string().check(z.startsWith(PAT_PREFIX)),
});
export type CreatedToken = z.infer<typeof CreatedTokenSchema>;

/** One OAuth grant: an agent you connected through the consent page. */
export const ConnectedAgentSchema = z.strictObject({
  /** The grant id (what DELETE /api/me/agents/:id revokes). */
  id: z.string(),
  clientName: z.string(),
  /** For a client identified by a metadata URL: its domain (verified). */
  clientDomain: z.optional(z.string()),
  scopes: z.array(AgentScopeSchema),
  createdAt: z.string(),
  lastUsedAt: z.nullable(z.string()),
});
export type ConnectedAgent = z.infer<typeof ConnectedAgentSchema>;

/** GET /api/me/agents */
export const AgentsResponseSchema = z.strictObject({ agents: z.array(ConnectedAgentSchema) });

/** Only the scopes an agent can hold, deduplicated, in canonical order. */
export function agentScopes(raw: readonly string[]): AgentScope[] {
  return AGENT_SCOPES.filter((s) => raw.includes(s));
}
