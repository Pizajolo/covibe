import { useEffect, useRef, useState } from 'react';
import { del, get, post, put } from '../api';
import { IconAlert, IconCheck, IconPlug, IconPlus, IconShield, IconTrash } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { ChipsInput, Copy, Empty, Modal, useAction, useToast } from '../components/ui';
import { go, useLive } from '../data';
import { ago } from '../format';

export interface SandboxPolicy {
  network: string[];
  allowWrite: string[];
  writeWorkspace: boolean;
}

interface Doc {
  name: string;
  description: string;
}

interface Program {
  kind: 'hook' | 'mcp' | 'lsp' | 'monitor';
  name: string;
  command: string;
  env?: string[];
}

interface SignIn {
  signedIn: boolean;
  at?: string;
  problem?: string;
  pending?: boolean;
  error?: string;
}

interface Remote {
  kind: 'mcp' | 'hook';
  name: string;
  url: string;
  env?: string[];
  /** A server covibe can sign in to, and whether it is. */
  signIn?: SignIn;
}

interface Contents {
  skills: Doc[];
  commands: Doc[];
  agents: Doc[];
  programs: Program[];
  remotes: Remote[];
  ignored: string[];
}

interface Origin {
  repo: string;
  ref?: string;
  path: string;
  commit: string;
  marketplace?: string;
}

export interface PluginRow {
  name: string;
  description: string;
  version?: string;
  origin?: Origin;
  everyone: boolean;
  policy: SandboxPolicy;
  approved: boolean;
  contents: Contents;
  updatedAt: string;
  usedBy: { team: string; agent: string }[];
}

interface SandboxStatus {
  available: boolean;
  problems: string[];
  warnings: string[];
}

export interface PluginsResponse {
  library: PluginRow[];
  sandbox: SandboxStatus;
}

interface Candidate {
  id: string;
  name: string;
  description: string;
  version?: string;
  from: string;
  installed: boolean;
  unsupported?: string;
}

interface Review {
  name: string;
  description: string;
  version?: string;
  policy: SandboxPolicy;
  contents: Contents;
  origin: Origin;
  installed: boolean;
}

type Tab = 'library' | 'anthropic';

export function Plugins({ tab: tabParam, name }: { tab?: string; name?: string }) {
  const tab: Tab = tabParam === 'anthropic' ? 'anthropic' : 'library';
  const { value, reload } = useLive(() => get<PluginsResponse>('/api/plugins'), []);
  const [adding, setAdding] = useState(false);

  if (name) return <PluginDetail name={name} sandbox={value?.sandbox} onChanged={reload} />;
  return (
    <>
      <Toolbar title="Plugins" sub="Skills, commands, hooks and MCP servers packaged for Claude Code. Whatever a plugin runs runs in the OS sandbox.">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <IconPlus /> Add from GitHub
        </button>
      </Toolbar>
      <nav className="tabs">
        {(
          [
            ['library', `Your plugins${value ? ` (${value.library.length})` : ''}`],
            ['anthropic', 'Anthropic directory'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => go('plugins', id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="content">
        <div className="page">
          {value && <SandboxBanner sandbox={value.sandbox} />}
          {tab === 'library' && <Library plugins={value?.library} onChanged={reload} onAdd={() => setAdding(true)} />}
          {tab === 'anthropic' && <Catalog onInstalled={reload} />}
        </div>
      </div>
      {adding && <FromGithub onClose={() => setAdding(false)} onInstalled={(n) => (reload(), go('plugins', 'library', n))} />}
    </>
  );
}

function SandboxBanner({ sandbox }: { sandbox: SandboxStatus }) {
  if (sandbox.available) return null;
  return (
    <div className="banner bad" style={{ marginBottom: 14 }}>
      <IconAlert />
      <span>
        The OS sandbox is not available on this computer ({sandbox.problems.join('; ')}), so members cannot use plugins that run programs (hooks or servers). Plugins with only skills,
        commands and agents still work. On Linux, install bubblewrap, socat and ripgrep.
      </span>
    </div>
  );
}

/** "3 skills · 2 hooks · MCP: db, docs": what a plugin adds, in one line. */
function summary(c: Contents): string {
  const n = (count: number, one: string) => (count ? `${count} ${one}${count === 1 ? '' : 's'}` : '');
  const servers = [...c.programs, ...c.remotes].filter((x) => x.kind === 'mcp').map((x) => x.name);
  return [
    n(c.skills.length, 'skill'),
    n(c.commands.length, 'command'),
    n(c.agents.length, 'agent'),
    n(c.programs.filter((p) => p.kind === 'hook').length + c.remotes.filter((r) => r.kind === 'hook').length, 'hook'),
    servers.length ? `MCP: ${servers.join(', ')}` : '',
    n(c.programs.filter((p) => p.kind === 'lsp').length, 'language server'),
    n(c.programs.filter((p) => p.kind === 'monitor').length, 'monitor'),
  ]
    .filter(Boolean)
    .join(' · ');
}

function SourceBadge({ origin }: { origin?: Origin }) {
  if (!origin) return <span className="pill">Local</span>;
  return (
    <span className="pill info" title={`${origin.repo}/${origin.path} @ ${origin.commit.slice(0, 7)}`}>
      GitHub · {origin.marketplace && origin.marketplace !== origin.repo ? origin.marketplace : origin.repo}
    </span>
  );
}

function UsedBy({ used = [] }: { used?: PluginRow['usedBy'] }) {
  if (!used.length) return <span className="tiny faint">Not given to anyone yet</span>;
  return (
    <span className="tiny faint" title={used.map((u) => `${u.team}/${u.agent}`).join(', ')}>
      Used by {used.slice(0, 3).map((u) => `${u.agent} (${u.team})`).join(', ')}
      {used.length > 3 ? ` +${used.length - 3}` : ''}
    </span>
  );
}

function Library({ plugins, onChanged, onAdd }: { plugins?: PluginRow[]; onChanged: () => void; onAdd: () => void }) {
  const toast = useToast();
  const [toggle] = useAction(async (p: PluginRow) => {
    await put(`/api/plugins/${p.name}/everyone`, { everyone: !p.everyone });
    toast(!p.everyone ? `${p.name} is now given to every member of every team` : `${p.name} is only given where you assign it`);
    onChanged();
  });
  if (!plugins) return <div className="faint small">Loading…</div>;
  if (!plugins.length)
    return (
      <div className="card">
        <Empty
          icon={<IconPlug />}
          title="No plugins yet"
          action={
            <div className="row">
              <button className="btn" onClick={() => go('plugins', 'anthropic')}>
                Browse Anthropic's directory
              </button>
              <button className="btn primary" onClick={onAdd}>
                <IconPlus /> Add from GitHub
              </button>
            </div>
          }
        >
          A plugin bundles skills, slash commands, agents, hooks and MCP servers. covibe shows you what a plugin runs before you install it, and runs all of it in the OS sandbox with
          only the network and folders you allow.
        </Empty>
      </div>
    );
  return (
    <div className="card">
      <div className="list">
        {plugins.map((p) => (
          <div key={p.name} className="list-row clickable" onClick={() => go('plugins', 'library', p.name)}>
            <IconPlug width={18} height={18} style={{ color: 'var(--accent)', flex: 'none' }} />
            <div className="grow col" style={{ gap: 3 }}>
              <div className="row">
                <strong className="mono">{p.name}</strong>
                {p.version && <span className="tiny faint">v{p.version}</span>}
                <SourceBadge origin={p.origin} />
                {!p.approved && (
                  <span className="pill warn">
                    <IconAlert /> Update needs your approval
                  </span>
                )}
              </div>
              <span className="small muted ellipsis">{p.description || 'No description'}</span>
              <span className="tiny faint">{summary(p.contents) || 'Nothing Claude Code would load'}</span>
              <UsedBy used={p.usedBy} />
            </div>
            <label className="check small" onClick={(e) => e.stopPropagation()} title="Give this plugin to every member of every team">
              <input type="checkbox" checked={p.everyone} onChange={() => void toggle(p)} /> Everyone
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

function Catalog({ onInstalled }: { onInstalled: () => void }) {
  const { value, error, reload } = useLive(() => get<{ source: string; commit: string; plugins: Candidate[] }>('/api/plugins/catalog'), []);
  const [query, setQuery] = useState('');
  const [reviewing, setReviewing] = useState<Candidate | null>(null);
  if (error) return <div className="banner bad"><IconAlert /> Could not load Anthropic's plugin directory from GitHub: {error}</div>;
  if (!value) return <div className="faint small">Loading Anthropic's plugin directory from GitHub…</div>;
  const q = query.trim().toLowerCase();
  const shown = value.plugins.filter((c) => !q || c.name.includes(q) || c.description.toLowerCase().includes(q));
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <p className="small muted grow">
          Listed by Anthropic at <a href="https://github.com/anthropics/claude-plugins-official" target="_blank" rel="noreferrer">github.com/anthropics/claude-plugins-official</a> (commit{' '}
          {value.commit.slice(0, 7)}). Many come from their makers' own repositories: review what each runs before installing.
        </p>
        <input className="input" style={{ maxWidth: 260 }} value={query} placeholder={`Search ${value.plugins.length} plugins`} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="grid grid-3">
        {shown.map((c) => (
          <div key={c.id} className="card card-pad col" style={{ gap: 8 }}>
            <div className="row">
              <strong className="mono grow">{c.name}</strong>
              {c.installed ? (
                <span className="pill good">
                  <IconCheck /> Installed
                </span>
              ) : c.unsupported ? (
                <span className="pill" title={c.unsupported}>
                  Not supported
                </span>
              ) : (
                <button className="btn sm" onClick={() => setReviewing(c)}>
                  Review
                </button>
              )}
            </div>
            <span className="tiny faint mono ellipsis" title={c.from}>
              {c.from}
            </span>
            <p className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {c.description}
            </p>
          </div>
        ))}
      </div>
      {reviewing && (
        <ReviewInstall
          url={value.source}
          candidate={reviewing}
          onClose={() => setReviewing(null)}
          onInstalled={() => {
            setReviewing(null);
            onInstalled();
            void reload();
          }}
        />
      )}
    </>
  );
}

function FromGithub({ onClose, onInstalled }: { onClose: () => void; onInstalled: (name: string) => void }) {
  const [url, setUrl] = useState('');
  const [found, setFound] = useState<{ repo: string; marketplace?: string; plugins: Candidate[] } | null>(null);
  const [reviewing, setReviewing] = useState<Candidate | null>(null);
  const [scan, scanning] = useAction(async () => {
    const r = await post<{ repo: string; marketplace?: string; plugins: Candidate[] }>('/api/plugins/github/scan', { url });
    setFound(r);
    if (r.plugins.length === 1 && !r.plugins[0]!.unsupported) setReviewing(r.plugins[0]!);
  });
  if (reviewing) return <ReviewInstall url={url} candidate={reviewing} onClose={onClose} onBack={found && found.plugins.length > 1 ? () => setReviewing(null) : undefined} onInstalled={(n) => (onClose(), onInstalled(n))} />;
  return (
    <Modal
      title="Add a plugin from GitHub"
      wide
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <label className="field">
        Plugin, marketplace or repository
        <div className="row">
          <input
            className="input mono"
            autoFocus
            value={url}
            placeholder="https://github.com/owner/repo or …/tree/main/plugins/my-plugin"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && url.trim() && void scan()}
          />
          <button className="btn" disabled={!url.trim() || scanning} onClick={() => void scan()}>
            {scanning ? 'Looking…' : 'Find plugins'}
          </button>
        </div>
        <span className="help">A marketplace lists several plugins; pick one to review what it runs before installing. Private repositories work if git on this computer can clone them.</span>
      </label>
      {found && (
        <div className="card" style={{ boxShadow: 'none', maxHeight: 360, overflowY: 'auto' }}>
          {found.plugins.length ? (
            <div className="list">
              {found.plugins.map((c) => (
                <div key={c.id} className="list-row">
                  <div className="grow col" style={{ gap: 2 }}>
                    <span className="row">
                      <strong className="mono">{c.name}</strong>
                      {c.installed && <span className="pill">installed: updates it</span>}
                    </span>
                    <span className="tiny faint mono">{c.from}</span>
                    <span className="small muted ellipsis">{c.unsupported ? `Cannot be installed: ${c.unsupported}` : c.description}</span>
                  </div>
                  <button className="btn sm" disabled={!!c.unsupported} onClick={() => setReviewing(c)}>
                    Review
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No plugins found">No .claude-plugin/plugin.json or marketplace.json in {found.repo} at that location.</Empty>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Shows everything a plugin adds and runs, with the sandbox it will get, before it is installed. */
function ReviewInstall({ url, candidate, onClose, onBack, onInstalled }: { url: string; candidate: Candidate; onClose: () => void; onBack?: () => void; onInstalled: (name: string) => void }) {
  const toast = useToast();
  const { value, error } = useLive(() => post<Review>('/api/plugins/github/review', { url, id: candidate.id }), [url, candidate.id]);
  const [policy, setPolicy] = useState<SandboxPolicy | null>(null);
  const current = policy ?? value?.policy ?? null;
  const [install, installing] = useAction(async () => {
    const p = await post<PluginRow>('/api/plugins/github/install', { url, id: candidate.id, policy: current });
    toast(`Installed ${p.name}`);
    onInstalled(p.name);
  });
  return (
    <Modal
      title={
        <span>
          Review <span className="mono">{candidate.name}</span>
        </span>
      }
      wide
      onClose={onClose}
      footer={
        <>
          {onBack && (
            <button className="btn" onClick={onBack}>
              Back
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value || !current || installing} onClick={() => void install()}>
            {installing ? 'Installing…' : value?.installed ? 'Update with these permissions' : 'Install with these permissions'}
          </button>
        </>
      }
    >
      {error && <div className="banner bad"><IconAlert /> {error}</div>}
      {!value && !error && <div className="faint small">Fetching {candidate.from} to see what it contains…</div>}
      {value && current && (
        <div className="col" style={{ gap: 14 }}>
          <p className="small muted">
            {value.description || 'No description.'} <span className="faint mono">({value.origin.repo}{value.origin.path ? `/${value.origin.path}` : ''} @ {value.origin.commit.slice(0, 7)})</span>
          </p>
          <ContentsView contents={value.contents} />
          {value.contents.programs.length > 0 && (
            <div className="col" style={{ gap: 8 }}>
              <h3 className="row" style={{ margin: 0 }}>
                <IconShield width={15} height={15} /> Its sandbox
              </h3>
              <PolicyEditor value={current} onChange={setPolicy} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const KIND: Record<Program['kind'], string> = { hook: 'Hook', mcp: 'MCP server', lsp: 'Language server', monitor: 'Monitor' };

function DocList({ title, docs, prefix = '' }: { title: string; docs: Doc[]; prefix?: string }) {
  if (!docs.length) return null;
  return (
    <div className="col" style={{ gap: 4 }}>
      <strong className="small">{title}</strong>
      {docs.map((d) => (
        <div key={d.name} className="small">
          <span className="mono">
            {prefix}
            {d.name}
          </span>
          {d.description && <span className="muted">: {d.description}</span>}
        </div>
      ))}
    </div>
  );
}

/** What a plugin adds (instructions Claude reads), runs (in the sandbox) and connects to (outside it). */
function ContentsView({ contents: c }: { contents: Contents }) {
  const empty = !c.skills.length && !c.commands.length && !c.agents.length && !c.programs.length && !c.remotes.length;
  return (
    <div className="col" style={{ gap: 12 }}>
      {empty && <span className="small muted">This plugin has nothing Claude Code would load.</span>}
      <DocList title="Skills" docs={c.skills} />
      <DocList title="Commands" docs={c.commands} prefix="/" />
      <DocList title="Agents" docs={c.agents} />
      {c.agents.length > 0 && <span className="tiny faint">Members can only use a plugin's agents if they have the Agent tool.</span>}
      {c.programs.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <strong className="small row">
            <IconShield width={14} height={14} /> Runs on this computer, in the sandbox
          </strong>
          {c.programs.map((p, i) => (
            <div key={i} className="col" style={{ gap: 2 }}>
              <span className="small">
                <span className="pill">{KIND[p.kind]}</span> {p.name}
              </span>
              <code className="tiny mono" style={{ wordBreak: 'break-all' }}>
                {p.command}
              </code>
              {!!p.env?.length && <span className="tiny faint">Environment variables it gets: {p.env.join(', ')}</span>}
            </div>
          ))}
        </div>
      )}
      {c.remotes.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <strong className="small row" style={{ color: 'var(--warn)' }}>
            <IconAlert width={14} height={14} /> Sends data to services outside this computer
          </strong>
          {c.remotes.map((r, i) => (
            <div key={i} className="small">
              <span className="pill">{r.kind === 'mcp' ? 'Remote MCP server' : 'HTTP hook'}</span> {r.name}: <span className="mono">{r.url}</span>
              {!!r.env?.length && <span className="tiny faint"> (uses your {r.env.join(', ')})</span>}
            </div>
          ))}
          <span className="tiny faint">These are not programs and run outside the sandbox: what members send them (tool calls, hook events) leaves this computer.</span>
        </div>
      )}
      {c.ignored.length > 0 && (
        <div className="col" style={{ gap: 2 }}>
          <strong className="small">Left out by covibe</strong>
          {c.ignored.map((x) => (
            <span key={x} className="tiny faint">
              {x}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PolicyEditor({ value, onChange }: { value: SandboxPolicy; onChange: (v: SandboxPolicy) => void }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <span className="tiny faint">
        Its hooks and servers can read the member's working folder and system files, but not your home folder (keys, tokens, other projects), and get none of your environment
        variables they do not declare. They write only to their own data folder.
      </span>
      <label className="field">
        Websites it may reach
        <ChipsInput values={value.network} placeholder="Add a domain, e.g. api.example.com or *.example.com" onChange={(network) => onChange({ ...value, network })} />
        <span className="help">Everything else is blocked. Suggested from its commands (an npx server needs the npm registry).</span>
      </label>
      <label className="field">
        Extra folders it may write
        <ChipsInput values={value.allowWrite} placeholder="Add a folder, e.g. ~/.npm" onChange={(allowWrite) => onChange({ ...value, allowWrite })} />
        <span className="help">Such as a package cache. These become readable too.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.writeWorkspace} onChange={(e) => onChange({ ...value, writeWorkspace: e.target.checked })} />
        May change files in the member's working folder (for formatter or generator hooks; never its .git or Claude Code settings)
      </label>
    </div>
  );
}

function PluginDetail({ name, sandbox, onChanged }: { name: string; sandbox?: SandboxStatus; onChanged: () => void }) {
  const toast = useToast();
  const { value, reload } = useLive(() => get<PluginRow>(`/api/plugins/${name}`), [name]);
  const [policy, setPolicy] = useState<SandboxPolicy | null>(null);
  const after = (p: PluginRow, message: string) => {
    toast(message);
    setPolicy(null);
    void reload();
    onChanged();
    return p;
  };
  const [save, saving] = useAction(async () => after(await put<PluginRow>(`/api/plugins/${name}/policy`, { policy }), 'Sandbox saved: it applies from the next turn'));
  const [approve] = useAction(async () => after(await post<PluginRow>(`/api/plugins/${name}/approve`), `${name} approved`));
  const [update, updating] = useAction(async () => {
    const p = await post<PluginRow>(`/api/plugins/${name}/update`);
    after(p, p.approved ? `Updated ${name}` : `Updated ${name}: it runs something new, so review and approve it`);
  });
  const [remove] = useAction(async () => {
    await del(`/api/plugins/${name}`);
    onChanged();
    go('plugins', 'library');
  });
  if (!value) return <Toolbar title={name} />;
  const current = policy ?? value.policy;
  return (
    <>
      <Toolbar title={<span className="mono">{name}</span>} sub={value.description}>
        {value.origin && (
          <button className="btn" disabled={updating} onClick={() => void update()} title={`Re-install from ${value.origin.repo}`}>
            {updating ? 'Updating…' : 'Update from GitHub'}
          </button>
        )}
        <button className="btn ghost danger" onClick={() => void remove()}>
          <IconTrash /> Delete
        </button>
      </Toolbar>
      <div className="content">
        <div className="page col" style={{ gap: 14 }}>
          {sandbox && value.contents.programs.length > 0 && <SandboxBanner sandbox={sandbox} />}
          {!value.approved && (
            <div className="banner warn">
              <IconAlert />
              <span className="grow">Its last update changed what it runs or where it sends data. Members do not get it until you review the list below and approve it.</span>
              <button className="btn sm primary" onClick={() => void approve()}>
                Approve
              </button>
            </div>
          )}
          <div className="row wrap" style={{ gap: 10 }}>
            <SourceBadge origin={value.origin} />
            {value.version && <span className="tiny faint">v{value.version}</span>}
            <UsedBy used={value.usedBy} />
            <span className="tiny faint">Changed {ago(value.updatedAt)}</span>
          </div>
          <div className="card card-pad">
            <ContentsView contents={value.contents} />
          </div>
          {value.contents.remotes.some((r) => r.signIn) && <SignIns plugin={name} remotes={value.contents.remotes.filter((r) => r.signIn)} onChange={() => void reload()} />}
          {value.contents.programs.length > 0 && (
            <div className="card card-pad col" style={{ gap: 10 }}>
              <div className="row">
                <h3 className="row grow" style={{ margin: 0 }}>
                  <IconShield width={15} height={15} /> Sandbox
                </h3>
                <button className="btn sm primary" disabled={!policy || saving} onClick={() => void save()}>
                  Save
                </button>
              </div>
              <PolicyEditor value={current} onChange={setPolicy} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Assign plugins: chips plus a picker of the library. */
export function PluginPicker({ value, onChange, inherited = [] }: { value: string[]; onChange: (v: string[]) => void; inherited?: { name: string; why: string }[] }) {
  const { value: plugins } = useLive(() => get<PluginsResponse>('/api/plugins'), []);
  const all = plugins?.library ?? [];
  const known = new Map(all.map((p) => [p.name, p]));
  const everyone = all.filter((p) => p.everyone).map((p) => ({ name: p.name, why: 'given to everyone' }));
  const shown = [...inherited, ...everyone].filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i && !value.includes(x.name));
  const problem = (n: string) => (!plugins ? undefined : !known.has(n) ? 'Not in your plugin library' : !known.get(n)!.approved ? 'Its update waits for your approval' : undefined);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="chips">
        {value.map((n) => (
          <span key={n} className="chip mono on" title={problem(n) ?? known.get(n)?.description}>
            {problem(n) ? <IconAlert width={12} height={12} /> : <IconPlug width={12} height={12} />}
            {n}
            <button aria-label={`Remove ${n}`} onClick={() => onChange(value.filter((x) => x !== n))}>
              ×
            </button>
          </span>
        ))}
        {shown.map((x) => (
          <span key={x.name} className="chip mono" style={{ opacity: 0.65 }} title={x.why}>
            <IconPlug width={12} height={12} /> {x.name} <span className="tiny faint">· {x.why}</span>
          </span>
        ))}
        {!value.length && !shown.length && <span className="tiny faint">No plugins</span>}
      </div>
      <select className="input" style={{ maxWidth: 360 }} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} aria-label="Add a plugin">
        <option value="">{all.length ? 'Add a plugin…' : 'No plugins installed (see Plugins in the sidebar)'}</option>
        {all
          .filter((p) => !value.includes(p.name))
          .map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}: {p.description.slice(0, 60)}
            </option>
          ))}
      </select>
    </div>
  );
}

/**
 * Sign covibe in to a plugin's remote servers (Notion's, say). The browser
 * does the sign-in; covibe keeps the tokens, and members reach the server
 * through covibe, which adds them.
 */
function SignIns({ plugin, remotes, onChange }: { plugin: string; remotes: Remote[]; onChange: () => void }) {
  const toast = useToast();
  const [login, setLogin] = useState<{ server: string; url: string; opened: boolean } | null>(null);
  const poll = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(poll.current), []);
  const path = (server: string) => `/api/plugins/${encodeURIComponent(plugin)}/sign-in/${encodeURIComponent(server)}`;

  /** Watch the sign-in until the browser finishes it (or it fails, or 10 minutes pass). */
  const watch = (server: string) => {
    window.clearInterval(poll.current);
    const end = Date.now() + 10 * 60_000;
    poll.current = window.setInterval(async () => {
      const st = await get<SignIn>(path(server)).catch(() => undefined);
      if (!st || (st.pending && Date.now() < end)) return;
      window.clearInterval(poll.current);
      setLogin(null);
      onChange();
      if (st.error) toast(`Sign-in failed: ${st.error}`, true);
      else if (st.signedIn) toast(`Signed in to ${server}`);
    }, 2000);
  };
  const [signIn, starting] = useAction(async (server: string) => {
    const res = await post<{ needed: boolean; url?: string; opened?: boolean }>(path(server));
    if (!res.needed) {
      toast(`${server} needs no sign-in`);
      return;
    }
    setLogin({ server, url: res.url!, opened: !!res.opened });
    if (res.opened) toast('Your browser opened: finish signing in there');
    watch(server);
  });
  const [signOut] = useAction(async (server: string) => {
    await del(path(server));
    toast(`Signed out of ${server}`);
    onChange();
  });

  return (
    <div className="card card-pad col" style={{ gap: 10 }}>
      <h3 style={{ margin: 0 }}>Sign-in</h3>
      <span className="tiny faint">
        Servers that need an account (such as Notion) sign in here, in your browser. covibe keeps the sign-in with its other keys, and members reach the server
        through covibe, which adds it: they never see it.
      </span>
      {remotes.map((r) => {
        const st = r.signIn!;
        const waiting = login?.server === r.name;
        return (
          <div key={r.name} className="row" style={{ gap: 10 }}>
            <div className="grow col" style={{ gap: 2 }}>
              <span className="small">
                <strong>{r.name}</strong> <span className="mono faint">{r.url}</span>
              </span>
              <span className="tiny faint" style={st.problem ? { color: 'var(--warn)' } : undefined}>
                {waiting
                  ? 'Waiting for you to finish signing in…'
                  : st.problem
                    ? st.problem
                    : st.signedIn
                      ? `Signed in ${st.at ? ago(st.at) : ''}`
                      : 'Not signed in: members cannot use it until you sign in'}
              </span>
            </div>
            {st.signedIn && !waiting && (
              <button className="btn sm ghost" onClick={() => void signOut(r.name)}>
                Sign out
              </button>
            )}
            <button className={`btn sm ${st.signedIn ? '' : 'primary'}`} disabled={starting || waiting} onClick={() => void signIn(r.name)}>
              {st.signedIn || st.problem ? 'Sign in again' : 'Sign in'}
            </button>
          </div>
        );
      })}
      {login && (
        <div className="banner info small">
          <IconAlert />
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
    </div>
  );
}
