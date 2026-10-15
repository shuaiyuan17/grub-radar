import { useCallback, useEffect, useId, useState, type SyntheticEvent } from 'react';
import { Headline } from '../components/bits';
import { BottomNav } from '../components/controls';
import { formErrorClass, inputClass, linkButtonClass } from '../components/fieldClasses';
import { InkBox, InkButton } from '../components/fields';
import { Ink } from '../components/Ink';
import { LegalLinks } from '../components/LegalLinks';
import type { AgentScope, ConnectedAgent, PersonalToken } from '../contracts/agents';
import { TOKEN_NAME_MAX } from '../contracts/agents';
import { parseHeadline } from '../domain/headlines';
import { useT } from '../i18n/context';
import { connectPrompt, useAgentsClient } from '../lib/agents';
import { saveErrorMessage } from '../lib/errors';
import styles from './SettingsPage.module.css';
import { preventImeEnter } from '../lib/ime';

type Copied = 'copied' | 'copyFailed' | null;

async function copy(text: string): Promise<Copied> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'copyFailed';
  }
}

/** "connect your agent": one sentence to paste to an agent. No secret in it. */
function ConnectBlock() {
  const t = useT();
  const [result, setResult] = useState<Copied>(null);
  const prompt = connectPrompt(window.location.origin);
  return (
    <section className={`sk ${styles.panel} ${styles.connect}`} aria-labelledby="connect-title">
      <Ink />
      <h2 id="connect-title" className={styles.subTitle}>
        {t.agents.connectTitle}
      </h2>
      <p className={styles.muted}>{t.agents.connectHint}</p>
      <p className={`note ${styles.prompt}`} lang="en">
        {prompt}
      </p>
      <InkButton primary onClick={() => void copy(prompt).then(setResult)}>
        {t.agents.copyPrompt}
      </InkButton>
      <div aria-live="polite">
        {result && (
          <p className={result === 'copied' ? `note ${styles.done}` : formErrorClass}>
            {t.agents[result]}
          </p>
        )}
      </div>
    </section>
  );
}

const canDo = (scopes: readonly AgentScope[], t: ReturnType<typeof useT>) =>
  scopes.includes('spots:write') ? t.agents.canWrite : t.agents.canRead;

function Used({ at }: { at: string | null }) {
  const t = useT();
  return <>{at ? t.agents.lastUsed(t.formatDate(at)) : t.agents.neverUsed}</>;
}

function AgentRow({ agent, onGone }: { agent: ConnectedAgent; onGone: (id: string) => void }) {
  const t = useT();
  const client = useAgentsClient();
  const [error, setError] = useState<string | null>(null);
  return (
    <li className={styles.item}>
      <span className={styles.itemHead}>
        <bdi className={styles.name}>{agent.clientName}</bdi>
        {agent.clientDomain && (
          <span className={styles.muted}> · {t.agents.published(agent.clientDomain)}</span>
        )}
      </span>
      <span className={styles.muted}>
        {canDo(agent.scopes, t)} · {t.agents.since(t.formatDate(agent.createdAt))} ·{' '}
        <Used at={agent.lastUsedAt} />
      </span>
      <button
        type="button"
        className={linkButtonClass}
        aria-label={`${t.agents.disconnect} ${agent.clientName}`}
        onClick={() => {
          client.disconnect(agent.id).then(
            () => {
              onGone(agent.id);
            },
            (e: unknown) => {
              setError(saveErrorMessage(e, t));
            },
          );
        }}
      >
        {t.agents.disconnect}
      </button>
      {error && (
        <span role="alert" className={formErrorClass}>
          {error}
        </span>
      )}
    </li>
  );
}

function TokenRow({ token, onGone }: { token: PersonalToken; onGone: (id: string) => void }) {
  const t = useT();
  const client = useAgentsClient();
  const [error, setError] = useState<string | null>(null);
  return (
    <li className={styles.item}>
      <bdi className={styles.name}>{token.name}</bdi>
      <span className={styles.muted}>
        {canDo(token.scopes, t)} · {t.agents.since(t.formatDate(token.createdAt))} ·{' '}
        <Used at={token.lastUsedAt} />
      </span>
      <button
        type="button"
        className={linkButtonClass}
        aria-label={`${t.agents.revoke} ${token.name}`}
        onClick={() => {
          client.revokeToken(token.id).then(
            () => {
              onGone(token.id);
            },
            (e: unknown) => {
              setError(saveErrorMessage(e, t));
            },
          );
        }}
      >
        {t.agents.revoke}
      </button>
      {error && (
        <span role="alert" className={formErrorClass}>
          {error}
        </span>
      )}
    </li>
  );
}

/** Make a personal token; the secret is on screen once, then gone for good. */
function NewToken({ onMade }: { onMade: (token: PersonalToken) => void }) {
  const t = useT();
  const client = useAgentsClient();
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<Copied>(null);
  const nameId = useId();
  const secretId = useId();

  const make = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const made = await client.createToken(
        name,
        write ? ['spots:read', 'spots:write'] : ['spots:read'],
      );
      setSecret(made.secret);
      setName('');
      onMade(made.token);
    } catch (err) {
      setError(saveErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(e) => void make(e)} onKeyDown={preventImeEnter}>
      <label htmlFor={nameId} className={styles.label}>
        {t.agents.tokenName}
      </label>
      <InkBox>
        <input
          id={nameId}
          className={inputClass}
          value={name}
          maxLength={TOKEN_NAME_MAX}
          autoComplete="off"
          placeholder="grok bot"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </InkBox>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={write}
          onChange={(e) => {
            setWrite(e.target.checked);
          }}
        />
        {t.agents.allowWrite}
      </label>
      <InkButton type="submit" busy={busy} disabled={busy || !name.trim()}>
        {busy ? t.agents.makingToken : t.agents.makeToken}
      </InkButton>
      {error && (
        <p role="alert" className={formErrorClass}>
          {error}
        </p>
      )}
      {secret && (
        <div className={`enter ${styles.secretBox}`}>
          <label htmlFor={secretId} className={styles.label}>
            {t.agents.tokenReady}
          </label>
          <InkBox>
            <input
              id={secretId}
              className={`${inputClass} ${styles.secret}`}
              value={secret}
              readOnly
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
          </InkBox>
          <InkButton onClick={() => void copy(secret).then(setCopied)}>
            {t.agents.copyToken}
          </InkButton>
          <div aria-live="polite">
            {copied && (
              <p className={copied === 'copied' ? `note ${styles.done}` : formErrorClass}>
                {copied === 'copied' ? t.friends.copied : t.agents.copyFailed}
              </p>
            )}
          </div>
        </div>
      )}
    </form>
  );
}

/** /settings: connect an agent, the agents you connected, your personal tokens. */
export function SettingsPage() {
  const t = useT();
  const client = useAgentsClient();
  const [agents, setAgents] = useState<ConnectedAgent[] | null>(null);
  const [tokens, setTokens] = useState<PersonalToken[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([client.agents(), client.tokens()]).then(
      ([a, tk]) => {
        if (!live) return;
        setAgents(a);
        setTokens(tk);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const agentGone = useCallback((id: string) => {
    setAgents((a) => (a ? a.filter((x) => x.id !== id) : a));
  }, []);
  const tokenGone = useCallback((id: string) => {
    setTokens((tk) => (tk ? tk.filter((x) => x.id !== id) : tk));
  }, []);

  return (
    <main id="main" className={styles.main}>
      <Headline className={styles.title} parts={parseHeadline(t.agents.title)} />
      <p className={styles.intro}>{t.agents.intro}</p>
      {failed && (
        <p role="alert" className={formErrorClass}>
          {t.agents.loadFailed}
        </p>
      )}
      <div className={styles.layout}>
        <ConnectBlock />
        <section className={`sk ${styles.panel}`} aria-labelledby="agents-title">
          <Ink />
          <h2 id="agents-title" className={styles.subTitle}>
            {t.agents.connectedTitle}
          </h2>
          {agents?.length === 0 && <p className={styles.muted}>{t.agents.noneConnected}</p>}
          {agents && agents.length > 0 && (
            <ul className={styles.list}>
              {agents.map((a) => (
                <AgentRow key={a.id} agent={a} onGone={agentGone} />
              ))}
            </ul>
          )}
        </section>
        <section className={`sk ${styles.panel}`} aria-labelledby="tokens-title">
          <Ink />
          <h2 id="tokens-title" className={styles.subTitle}>
            {t.agents.tokensTitle}
          </h2>
          <p className={styles.muted}>{t.agents.tokensHint}</p>
          {tokens?.length === 0 && <p className={styles.muted}>{t.agents.noTokens}</p>}
          {tokens && tokens.length > 0 && (
            <ul className={styles.list}>
              {tokens.map((tk) => (
                <TokenRow key={tk.id} token={tk} onGone={tokenGone} />
              ))}
            </ul>
          )}
          <NewToken
            onMade={(tk) => {
              setTokens((all) => [...(all ?? []), tk]);
            }}
          />
        </section>
      </div>
      <LegalLinks />
      <BottomNav />
    </main>
  );
}
