// Settings → Advanced: more Claude accounts, ChatGPT accounts (the sign-in
// Codex uses, through covibe's translator), model providers with an API key
// (Anthropic-compatible, or OpenAI-compatible through the same translator),
// and sharing work across the Claude accounts. Teams pick them in the model
// and connection fields.
import { useEffect, useRef, useState } from 'react';
import { del, get, post, put, type AccountInfo, type ConnectionKind, type ConnectionsInfo, type ConnectionView, type ProviderModel, type UsageReport } from '../api';
import { IconAlert, IconInfo, IconPlus, IconTrash } from './icons';
import { useUsage } from './Usage';
import { Copy, Modal, useAction, useToast } from './ui';

let cache: Promise<ConnectionsInfo> | undefined;
const listeners = new Set<(c: ConnectionsInfo) => void>();

/** Read the connections again and tell every picker. */
export function refreshConnections(): Promise<ConnectionsInfo> {
  cache = get<ConnectionsInfo>('/api/connections');
  void cache.then((c) => listeners.forEach((l) => l(c))).catch(() => undefined);
  return cache;
}

/** Accounts and providers (read once, then shared; refreshed after changes). */
export function useConnections(): ConnectionsInfo | null {
  const [value, setValue] = useState<ConnectionsInfo | null>(null);
  useEffect(() => {
    listeners.add(setValue);
    (cache ?? refreshConnections()).then(setValue).catch(() => undefined);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

export const KIND_LABEL: Record<ConnectionKind, string> = {
  claude: 'Claude account',
  anthropic: 'Anthropic-compatible',
  openai: 'OpenAI-compatible',
  codex: 'ChatGPT account',
};

const PRESETS: { key: string; label: string; kind: 'anthropic' | 'openai'; baseUrl: string; models?: string[]; help?: string }[] = [
  { key: 'deepseek', label: 'DeepSeek', kind: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'moonshot', label: 'Moonshot (Kimi)', kind: 'anthropic', baseUrl: 'https://api.moonshot.ai/anthropic' },
  { key: 'zai', label: 'Z.ai (GLM)', kind: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' },
  { key: 'anthropic', label: 'Anthropic API key', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', help: 'Pay as you go on your Anthropic Console account.' },
  { key: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { key: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'groq', label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  { key: 'ollama', label: 'Ollama (on this Mac)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', help: 'No key needed for a local Ollama.' },
  { key: 'custom', label: 'Something else…', kind: 'openai', baseUrl: '' },
];

const pct = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v * 100)}%`);

/** "5-hour 40% · weekly 12%" for one account. */
function usageLine(u: Omit<UsageReport, 'accounts' | 'balance'> | undefined): string | undefined {
  if (!u || !u.windows.length) return undefined;
  const five = u.windows.find((w) => w.window === 'five_hour');
  const week = u.windows.find((w) => w.window === 'seven_day');
  return [five && `5-hour ${pct(five.utilization)}`, week && `weekly ${pct(week.utilization)}`].filter(Boolean).join(' · ') || undefined;
}

function signedIn(info: AccountInfo | undefined): string {
  if (!info) return 'Checking…';
  if (!info.loggedIn) return 'Not signed in';
  return [info.email ?? 'Signed in', info.subscriptionType, info.organization].filter(Boolean).join(' · ');
}

export function AdvancedSettings() {
  return (
    <>
      <ClaudeAccounts />
      <ChatGptAccounts />
      <Providers />
    </>
  );
}

// ---- Claude accounts

function ClaudeAccounts() {
  const toast = useToast();
  const info = useConnections();
  const { usage, refresh } = useUsage();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [login, setLogin] = useState<{ id: string; command: string; opened: boolean } | null>(null);
  const poll = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(poll.current), []);

  const accounts = info?.connections.filter((c) => c.kind === 'claude') ?? [];

  /** Watch the account until its sign-in shows up (at most 5 minutes). */
  const watch = (id: string) => {
    window.clearInterval(poll.current);
    const end = Date.now() + 5 * 60_000;
    poll.current = window.setInterval(async () => {
      const a = await get<AccountInfo>(`/api/connections/${encodeURIComponent(id)}/account?fresh=1`).catch(() => undefined);
      if (a?.loggedIn || Date.now() > end) {
        window.clearInterval(poll.current);
        setLogin((l) => (l?.id === id ? null : l));
        await refreshConnections();
        await refresh();
        if (a?.loggedIn) toast(`Signed in${a.email ? ` as ${a.email}` : ''}`);
      }
    }, 4000);
  };

  const [signIn] = useAction(async (id: string) => {
    const res = await post<{ command: string; opened: boolean }>(`/api/connections/${encodeURIComponent(id)}/login`);
    setLogin({ id, ...res });
    if (res.opened) toast('Terminal opened: finish signing in there');
    watch(id);
  });
  const [add, adding_] = useAction(async () => {
    const c = await post<ConnectionView>('/api/connections', { kind: 'claude', label: name.trim() });
    setName('');
    setAdding(false);
    await refreshConnections();
    await signIn(c.id);
  });
  const [remove] = useAction(async (c: ConnectionView) => {
    if (!window.confirm(`Remove the Claude account "${c.label}"? covibe signs it out and forgets it. Teams that name it stop working until you change them.`)) return;
    await del(`/api/connections/${encodeURIComponent(c.id)}`);
    await refreshConnections();
    await refresh();
  });
  const [setBalance] = useAction(async (on: boolean) => {
    await put('/api/connections', { balance: on });
    await refreshConnections();
    await refresh();
    toast(on ? 'Members share work across your Claude accounts' : 'Members stay on the account their team names');
  });
  const [check] = useAction(async (id: string) => {
    const a = await get<AccountInfo>(`/api/connections/${encodeURIComponent(id)}/account?fresh=1`);
    await refreshConnections();
    toast(a.loggedIn ? `Signed in${a.email ? ` as ${a.email}` : ''}` : 'Not signed in yet', !a.loggedIn);
  });

  return (
    <div className="card">
      <div className="card-head">
        <h2>Claude accounts</h2>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        <p className="small">
          Sign in more Claude accounts and choose one per team or member (Connection → Claude subscription). Each account signs in once, in its own Claude Code
          folder; covibe never sees the password.
        </p>
        <div className="conn-list">
          <div className="conn-row">
            <div className="col grow" style={{ gap: 2 }}>
              <strong>Your login</strong>
              <span className="tiny faint">{signedIn(info?.main)}</span>
            </div>
            <span className="tiny muted num">{usageLine(usage ?? undefined) ?? ''}</span>
            <span className="pill">main</span>
          </div>
          {accounts.map((a) => {
            const u = usage?.accounts?.find((x) => x.id === a.id)?.usage;
            const waiting = login?.id === a.id;
            return (
              <div key={a.id} className="conn-row">
                <div className="col grow" style={{ gap: 2 }}>
                  <strong>
                    {a.label} <span className="tiny faint mono">{a.id}</span>
                  </strong>
                  <span className="tiny faint">{waiting ? 'Waiting for you to finish signing in…' : signedIn(a.account)}</span>
                </div>
                <span className="tiny muted num">{usageLine(u) ?? ''}</span>
                {a.account && !a.account.loggedIn && !waiting && <span className="pill warn">Not signed in</span>}
                <button className="btn sm" onClick={() => void signIn(a.id)}>
                  {a.account?.loggedIn ? 'Sign in again' : 'Sign in'}
                </button>
                {waiting && (
                  <button className="btn sm ghost" onClick={() => void check(a.id)}>
                    Check
                  </button>
                )}
                <button className="btn sm ghost danger" title="Remove account" onClick={() => void remove(a)}>
                  <IconTrash />
                </button>
              </div>
            );
          })}
        </div>
        {login && !login.opened && (
          <div className="banner info small">
            <IconInfo />
            <span className="grow col" style={{ gap: 6 }}>
              Run this in a terminal and follow the steps (it opens your browser):
              <Copy text={login.command} />
            </span>
          </div>
        )}
        {adding ? (
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              autoFocus
              placeholder="A name, e.g. Work or Personal"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && void add()}
              style={{ maxWidth: 280 }}
            />
            <button className="btn primary sm" disabled={!name.trim() || adding_} onClick={() => void add()}>
              Add and sign in
            </button>
            <button className="btn sm ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div>
            <button className="btn sm" onClick={() => setAdding(true)}>
              <IconPlus /> Add Claude account
            </button>
          </div>
        )}

        <section className="form-section" style={{ marginTop: 6 }}>
          <label className="check">
            <input type="checkbox" checked={!!info?.balance} disabled={!info} onChange={(e) => void setBalance(e.target.checked)} />
            Share work across accounts
          </label>
          <span className="help tiny faint">
            Members on the subscription that don't name an account start on whichever account has the most room in its 5-hour and weekly limits, and move to another
            account when one hits its limit (their conversation comes along). Members that name an account stay on it.
            {accounts.length === 0 ? ' Add a second account for this to do anything.' : ''}
          </span>
          {info?.balance && (
            <div className="banner warn small">
              <IconAlert />
              <span>
                Anthropic's terms limit how subscriptions may be used, and using several accounts to get around usage limits may not be allowed. Check the current
                Consumer Terms and usage policy for your plans before relying on this.
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ---- ChatGPT accounts

function ChatGptAccounts() {
  const toast = useToast();
  const info = useConnections();
  const { usage, refresh } = useUsage();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [login, setLogin] = useState<{ id: string; url: string; opened: boolean } | null>(null);
  const [editing, setEditing] = useState<ConnectionView | null>(null);
  const poll = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(poll.current), []);

  const accounts = info?.connections.filter((c) => c.kind === 'codex') ?? [];

  /** Watch the sign-in until the browser finishes it (or it fails, or 10 minutes pass). */
  const watch = (id: string) => {
    window.clearInterval(poll.current);
    const end = Date.now() + 10 * 60_000;
    poll.current = window.setInterval(async () => {
      const st = await get<{ pending: boolean; error?: string; account: AccountInfo }>(`/api/connections/${encodeURIComponent(id)}/login`).catch(() => undefined);
      if (!st || (st.pending && Date.now() < end)) return;
      window.clearInterval(poll.current);
      setLogin((l) => (l?.id === id ? null : l));
      await refreshConnections();
      await refresh();
      if (st.error) toast(`Sign-in failed: ${st.error}`, true);
      else if (st.account.loggedIn) toast(`Signed in${st.account.email ? ` as ${st.account.email}` : ''}`);
    }, 2000);
  };

  const [signIn] = useAction(async (id: string) => {
    const res = await post<{ url: string; opened: boolean }>(`/api/connections/${encodeURIComponent(id)}/login`);
    setLogin({ id, ...res });
    if (res.opened) toast('Your browser opened: finish signing in there');
    watch(id);
  });
  const [add, adding_] = useAction(async () => {
    const c = await post<ConnectionView>('/api/connections', { kind: 'codex', label: name.trim() });
    setName('');
    setAdding(false);
    await refreshConnections();
    await signIn(c.id);
  });
  const [remove] = useAction(async (c: ConnectionView) => {
    if (!window.confirm(`Remove the ChatGPT account "${c.label}"? covibe signs it out and forgets it. Teams that use its models stop working until you change them.`)) return;
    await del(`/api/connections/${encodeURIComponent(c.id)}`);
    await refreshConnections();
    await refresh();
  });

  return (
    <div className="card">
      <div className="card-head">
        <h2>ChatGPT accounts</h2>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        <p className="small">
          Sign in with ChatGPT, the way Codex does, and members can work on OpenAI's models within your ChatGPT plan's limits. They keep all of Claude Code's
          tools; covibe's translator on this Mac passes their requests to the account. Pick its models in a team's model list.
        </p>
        {accounts.length > 0 && (
          <div className="conn-list">
            {accounts.map((a) => {
              const u = usage?.accounts?.find((x) => x.id === a.id)?.usage;
              const waiting = login?.id === a.id;
              return (
                <div key={a.id} className="conn-row">
                  <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <strong>
                      {a.label} <span className="tiny faint mono">{a.id}</span>
                    </strong>
                    <span className="tiny faint">{waiting ? 'Waiting for you to finish signing in…' : signedIn(a.account)}</span>
                  </div>
                  <span className="tiny muted num">{usageLine(u) ?? ''}</span>
                  <span className="tiny muted">
                    {a.models?.length ?? 0} model{a.models?.length === 1 ? '' : 's'}
                  </span>
                  {a.account && !a.account.loggedIn && !waiting && <span className="pill warn">Not signed in</span>}
                  <button className="btn sm" onClick={() => void signIn(a.id)}>
                    {a.account?.loggedIn ? 'Sign in again' : 'Sign in'}
                  </button>
                  <button className="btn sm ghost" onClick={() => setEditing(a)}>
                    Models
                  </button>
                  <button className="btn sm ghost danger" title="Remove account" onClick={() => void remove(a)}>
                    <IconTrash />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {login && (
          <div className="banner info small">
            <IconInfo />
            <span className="grow col" style={{ gap: 6 }}>
              {login.opened ? 'Finish signing in in your browser. If it did not open, open this page:' : 'Open this page in a browser on this Mac to sign in:'}
              <span className="row" style={{ gap: 6 }}>
                <a className="btn sm" href={login.url} target="_blank" rel="noreferrer">
                  Open sign-in page
                </a>
                <Copy text={login.url} label="Copy link" />
              </span>
            </span>
          </div>
        )}
        {adding ? (
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              autoFocus
              placeholder="A name, e.g. ChatGPT Pro"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && void add()}
              style={{ maxWidth: 280 }}
            />
            <button className="btn primary sm" disabled={!name.trim() || adding_} onClick={() => void add()}>
              Add and sign in
            </button>
            <button className="btn sm ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div>
            <button className="btn sm" onClick={() => setAdding(true)}>
              <IconPlus /> Add ChatGPT account
            </button>
          </div>
        )}
        <span className="tiny faint">
          The sign-in is kept in the account's folder under covibe's home, readable only by your user (like Codex's own ~/.codex/auth.json), and never reaches a
          member. Usage counts against the plan's 5-hour and weekly limits; a member that reaches one waits for it to reset.
        </span>
        {accounts.length > 0 && (
          <div className="banner warn small">
            <IconAlert />
            <span>OpenAI's terms decide how a ChatGPT plan may be used outside OpenAI's own apps. Check the current terms for your plan before relying on this.</span>
          </div>
        )}
        {editing && <ProviderDialog existing={editing} onClose={() => setEditing(null)} />}
      </div>
    </div>
  );
}

// ---- providers

function Providers() {
  const info = useConnections();
  const [editing, setEditing] = useState<ConnectionView | 'new' | null>(null);
  const [remove] = useAction(async (c: ConnectionView) => {
    if (!window.confirm(`Remove "${c.label}" and its key? Teams that use its models stop working until you change them.`)) return;
    await del(`/api/connections/${encodeURIComponent(c.id)}`);
    await refreshConnections();
  });
  const providers = info?.connections.filter((c) => c.kind === 'anthropic' || c.kind === 'openai') ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h2>Model providers</h2>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        <p className="small">
          Add an API key for another provider and its models show up in every team's model list, next to Claude's. Members on them keep all of Claude Code's tools;
          only the model changes. Anthropic-compatible APIs are called directly; OpenAI-compatible ones go through a translator covibe runs on this Mac.
        </p>
        {providers.length > 0 && (
          <div className="conn-list">
            {providers.map((c) => (
              <div key={c.id} className="conn-row">
                <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <strong>
                    {c.label} <span className="tiny faint mono">{c.id}</span>
                  </strong>
                  <span className="tiny faint mono ellipsis">{c.baseUrl}</span>
                </div>
                <span className="tiny muted">
                  {c.models?.length ?? 0} model{c.models?.length === 1 ? '' : 's'}
                  {c.models?.some((m) => !m.price) ? ' · some without prices' : ''}
                </span>
                <span className="pill">{KIND_LABEL[c.kind]}</span>
                {!c.hasKey && <span className="pill warn">No key</span>}
                <button className="btn sm" onClick={() => setEditing(c)}>
                  Edit
                </button>
                <button className="btn sm ghost danger" title="Remove provider" onClick={() => void remove(c)}>
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
        )}
        <div>
          <button className="btn sm" onClick={() => setEditing('new')}>
            <IconPlus /> Add provider
          </button>
        </div>
        <span className="tiny faint">
          Keys are kept in {info?.secretStore === 'keychain' ? 'your macOS Keychain' : 'a file only your user can read'} and never written to team files.
        </span>
        {editing && <ProviderDialog existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </div>
    </div>
  );
}

const num = (v: string): number | undefined => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

function ProviderDialog({ existing, onClose }: { existing?: ConnectionView; onClose: () => void }) {
  const toast = useToast();
  /** A ChatGPT account: only its models (and their optional prices) are edited here. */
  const account = existing?.kind === 'codex';
  const [preset, setPreset] = useState(existing ? '' : 'deepseek');
  const first = PRESETS[0]!;
  const [label, setLabel] = useState(existing?.label ?? first.label);
  const [kind, setKind] = useState<Exclude<ConnectionKind, 'claude'>>(existing && existing.kind !== 'claude' ? existing.kind : first.kind);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? first.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ProviderModel[]>(existing?.models ?? (first.models ?? []).map((id) => ({ id })));
  const [offered, setOffered] = useState<{ id: string; name?: string; efforts?: string[] }[] | null>(null);
  const [newModel, setNewModel] = useState('');

  const choose = (key: string) => {
    const p = PRESETS.find((x) => x.key === key)!;
    setPreset(key);
    setLabel(key === 'custom' ? '' : p.label);
    setKind(p.kind);
    setBaseUrl(p.baseUrl);
    setModels((p.models ?? []).map((id) => ({ id })));
    setOffered(null);
  };
  const addModel = (id: string, name?: string, efforts?: string[]) => {
    const v = id.trim();
    if (!v || models.some((m) => m.id === v)) return;
    setModels([...models, { id: v, ...(name && name !== v ? { name } : {}), ...(efforts?.length ? { efforts } : {}) }]);
  };
  const setModel = (i: number, patch: Partial<ProviderModel>) => setModels(models.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const setPrice = (i: number, key: 'input' | 'output', v: string) => {
    const m = models[i]!;
    const price = { input: m.price?.input ?? NaN, output: m.price?.output ?? NaN, [key]: num(v) ?? NaN };
    setModel(i, { price: Number.isNaN(price.input) && Number.isNaN(price.output) ? undefined : (price as ProviderModel['price']) });
  };

  const [fetchModels, fetching] = useAction(async () => {
    const res = await post<{ models: { id: string; name?: string; efforts?: string[] }[] }>('/api/connections/models', { id: existing?.id, kind, baseUrl, apiKey: apiKey || undefined });
    setOffered(res.models);
    if (!res.models.length) toast('The provider listed no models; add them by hand', true);
  });
  const [save, saving] = useAction(async () => {
    // A price counts only with both numbers; half a price is dropped.
    const clean = models.map((m) => (m.price && Number.isFinite(m.price.input) && Number.isFinite(m.price.output) ? m : { ...m, price: undefined }));
    if (account) await put(`/api/connections/${encodeURIComponent(existing!.id)}`, { label, models: clean });
    else if (existing) await put(`/api/connections/${encodeURIComponent(existing.id)}`, { label, baseUrl, models: clean, ...(apiKey ? { apiKey } : {}) });
    else await post('/api/connections', { kind, label, baseUrl, apiKey: apiKey || undefined, models: clean });
    await refreshConnections();
    toast(existing ? 'Saved' : `${label} added: pick its models in a team`);
    onClose();
  });

  const help = PRESETS.find((p) => p.key === preset)?.help;
  return (
    <Modal
      wide
      title={account ? `${existing!.label}: models` : existing ? `Edit ${existing.label}` : 'Add a model provider'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || !label.trim() || (!account && !baseUrl.trim())} onClick={() => void save()}>
            {existing ? 'Save' : 'Add provider'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {!existing && (
          <label className="field">
            Provider
            <select className="input" value={preset} onChange={(e) => choose(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="help">Fills in the address; check it against the provider's docs.{help ? ` ${help}` : ''}</span>
          </label>
        )}
        {account ? (
          <label className="field">
            Name
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
        ) : (
          <>
            <div className="grid grid-2" style={{ gap: 12 }}>
              <label className="field">
                Name
                <input className="input" value={label} placeholder="e.g. DeepSeek" onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label className="field">
                API style
                <select className="input" value={kind} disabled={!!existing} onChange={(e) => setKind(e.target.value as 'anthropic' | 'openai')}>
                  <option value="anthropic">Anthropic-compatible (Messages API)</option>
                  <option value="openai">OpenAI-compatible (Chat Completions)</option>
                </select>
              </label>
            </div>
            <label className="field">
              Base URL
              <input className="input mono" value={baseUrl} placeholder={kind === 'openai' ? 'https://api.example.com/v1' : 'https://api.example.com/anthropic'} onChange={(e) => setBaseUrl(e.target.value)} />
              <span className="help">{kind === 'openai' ? 'The part before /chat/completions.' : 'The part before /v1/messages.'}</span>
            </label>
            <label className="field">
              API key
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={existing?.hasKey ? 'Saved; type a new one to replace it' : 'Paste the key'}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
          </>
        )}

        <section className="form-section">
          <div className="row">
            <h3 className="grow">Models</h3>
            <button className="btn sm" disabled={fetching || (!account && !baseUrl.trim())} onClick={() => void fetchModels()}>
              {fetching ? 'Asking…' : account ? 'Get the list from the account' : 'Get the list from the provider'}
            </button>
          </div>
          {offered && offered.length > 0 && (
            <div className="chips" style={{ maxHeight: 140, overflowY: 'auto' }}>
              {offered.map((m) => {
                const on = models.some((x) => x.id === m.id);
                return (
                  <button key={m.id} className={`chip mono ${on ? 'on' : ''}`} onClick={() => (on ? setModels(models.filter((x) => x.id !== m.id)) : addModel(m.id, m.name, m.efforts))}>
                    {on ? '✓ ' : '+ '}
                    {m.id}
                  </button>
                );
              })}
            </div>
          )}
          {models.length > 0 && (
            <table className="table models-table">
              <thead>
                <tr>
                  <th>Model id</th>
                  <th className="r">Input $/M</th>
                  <th className="r">Output $/M</th>
                  <th className="r">Max output</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => (
                  <tr key={m.id}>
                    <td className="mono">{m.id}</td>
                    <td className="r">
                      <input className="input num" inputMode="decimal" aria-label={`${m.id} input price`} defaultValue={m.price?.input ?? ''} onBlur={(e) => setPrice(i, 'input', e.target.value)} />
                    </td>
                    <td className="r">
                      <input className="input num" inputMode="decimal" aria-label={`${m.id} output price`} defaultValue={m.price?.output ?? ''} onBlur={(e) => setPrice(i, 'output', e.target.value)} />
                    </td>
                    <td className="r">
                      <input className="input num" inputMode="numeric" aria-label={`${m.id} max output tokens`} placeholder="—" defaultValue={m.maxOutput ?? ''} onBlur={(e) => setModel(i, { maxOutput: num(e.target.value) })} />
                    </td>
                    <td className="r">
                      <button className="btn sm ghost" title="Remove model" onClick={() => setModels(models.filter((_, j) => j !== i))}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input mono"
              placeholder="Add a model id by hand"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  addModel(newModel);
                  setNewModel('');
                }
              }}
              style={{ maxWidth: 320 }}
            />
            <button
              className="btn sm"
              disabled={!newModel.trim()}
              onClick={() => {
                addModel(newModel);
                setNewModel('');
              }}
            >
              Add
            </button>
          </div>
          <span className="help tiny faint">
            {account
              ? "A ChatGPT plan is not billed per token, so prices are optional: set OpenAI's API prices to see what the work would cost on the API (otherwise its spend shows as $0). Max output caps how long an answer may be."
              : "Prices are in US dollars per million tokens, from the provider's price list; they make the spend on Home right (without them a model's spend shows as $0). Max output caps how long an answer may be, for models that accept less than Claude Code asks for."}
          </span>
        </section>
      </div>
    </Modal>
  );
}
