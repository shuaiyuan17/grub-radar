import { screen, waitFor, within } from '@testing-library/react';
import type { ConnectedAgent, PersonalToken } from '../contracts/agents';
import { demoRepository, fakeAgentsClient, renderAt } from '../test/render';

const AGENT: ConnectedAgent = {
  id: 'g1',
  clientName: 'Claude Code',
  scopes: ['spots:read', 'spots:write'],
  createdAt: '2026-10-14T10:00:00.000Z',
  lastUsedAt: '2026-10-15T09:00:00.000Z',
};
const TOKEN: PersonalToken = {
  id: 'pat_1',
  name: 'grok bot',
  scopes: ['spots:read'],
  createdAt: '2026-10-14T10:00:00.000Z',
  lastUsedAt: null,
};

describe('/settings', () => {
  it('copies the one-line prompt for an agent (no secret in it)', async () => {
    const { user } = renderAt('/settings');
    await user.click(await screen.findByRole('button', { name: 'copy for your agent' }));
    // user-event's clipboard stands in for the browser's
    expect(await navigator.clipboard.readText()).toBe(
      `Read ${window.location.origin}/agent-setup.md and connect yourself to my grub radar.`,
    );
    expect(await screen.findByText('copied. paste it to your agent.')).toBeInTheDocument();
  });

  it('links the privacy policy and terms', async () => {
    renderAt('/settings');
    const nav = await screen.findByRole('navigation', { name: 'legal' });
    expect(within(nav).getByRole('link', { name: 'privacy policy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(within(nav).getByRole('link', { name: 'terms of service' })).toHaveAttribute(
      'href',
      '/terms',
    );
  });

  it('lists connected agents and disconnects one', async () => {
    const agents = fakeAgentsClient([AGENT]);
    const { user } = renderAt('/settings', { agents });
    const list = await screen.findByRole('region', { name: 'connected agents' });
    expect(within(list).getByText('Claude Code')).toBeInTheDocument();
    expect(within(list).getByText(/reads, adds and edits spots/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'disconnect Claude Code' }));
    expect(agents.disconnect).toHaveBeenCalledWith('g1');
    await waitFor(() => {
      expect(within(list).queryByText('Claude Code')).not.toBeInTheDocument();
    });
    expect(within(list).getByText('no agents connected yet.')).toBeInTheDocument();
  });

  it('makes a token, shows the secret once, and revokes tokens', async () => {
    const agents = fakeAgentsClient([], [TOKEN]);
    const { user } = renderAt('/settings', { agents });
    const box = await screen.findByRole('region', { name: 'personal tokens' });
    expect(within(box).getByText('grok bot')).toBeInTheDocument();
    expect(within(box).getByText(/not used yet/)).toBeInTheDocument();
    await user.type(within(box).getByLabelText(/name it/), 'my bot');
    await user.click(within(box).getByLabelText('can add and edit spots')); // off: read only
    await user.click(within(box).getByRole('button', { name: 'make a token' }));
    expect(agents.createToken).toHaveBeenCalledWith('my bot', ['spots:read']);
    const secret = await within(box).findByLabelText(/copy it now/);
    expect(secret).toHaveValue(`grub_pat_${'s'.repeat(43)}`);
    expect(within(box).getByText('my bot')).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'revoke grok bot' }));
    expect(agents.revokeToken).toHaveBeenCalledWith('pat_1');
  });

  it('in Chinese', async () => {
    localStorage.setItem('grub-radar:lang', 'zh-Hans');
    renderAt('/settings');
    expect(await screen.findByRole('button', { name: '复制给 agent' })).toBeInTheDocument();
    localStorage.clear();
  });

  it('an agent-found spot says so on its card', async () => {
    // the memory repository has no agents: give one spot a finder
    const spots = (await demoRepository().list()).map((s, i) =>
      i === 0 ? { ...s, foundBy: 'Claude Code' } : s,
    );
    renderAt('/', {
      repository: {
        list: () => Promise.resolve(spots),
        get: (id) => Promise.resolve(spots.find((s) => s.id === id) ?? null),
      },
    });
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getAllByText(/found by/).length).toBe(1);
  });
});
