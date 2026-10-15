import { createContext, use } from 'react';
import {
  AgentsResponseSchema,
  CreatedTokenSchema,
  TokensResponseSchema,
  type AgentScope,
  type ConnectedAgent,
  type CreatedToken,
  type PersonalToken,
} from '../contracts/agents';
import { api } from './api';

/** What the "connect your agent" button copies. No secret in it: the agent's first connection asks you. */
export const connectPrompt = (origin: string) =>
  `Read ${origin}/agent-setup.md and connect yourself to my grub radar.`;

/** How the app talks to /api/me/agents and /api/me/tokens. Swapped for a fake in tests. */
export interface AgentsClient {
  agents(): Promise<ConnectedAgent[]>;
  disconnect(id: string): Promise<void>;
  tokens(): Promise<PersonalToken[]>;
  createToken(name: string, scopes: AgentScope[]): Promise<CreatedToken>;
  revokeToken(id: string): Promise<void>;
}

const json = async (res: Response): Promise<unknown> => res.json();

export const httpAgentsClient: AgentsClient = {
  agents: async () => AgentsResponseSchema.parse(await json(await api('/api/me/agents'))).agents,
  disconnect: async (id) => {
    await api(`/api/me/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  tokens: async () => TokensResponseSchema.parse(await json(await api('/api/me/tokens'))).tokens,
  createToken: async (name, scopes) =>
    CreatedTokenSchema.parse(
      await json(await api('/api/me/tokens', { method: 'POST', body: { name, scopes } })),
    ),
  revokeToken: async (id) => {
    await api(`/api/me/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

export const AgentsClientContext = createContext<AgentsClient>(httpAgentsClient);

export function useAgentsClient(): AgentsClient {
  return use(AgentsClientContext);
}
