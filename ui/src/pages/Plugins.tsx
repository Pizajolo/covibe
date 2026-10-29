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
  /** Your own OAuth app for signing in. */
  client?: { clientId?: string; hasSecret: boolean; callbackUrl: string };
}

interface Variable {
  name: string;
  servers: string[];
  saved: boolean;
  inEnvironment: boolean;
  /** Found in what you pasted (when adding an MCP server): saved with your keys when you add it. */
  found?: boolean;
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
  variables: Variable[];
  /** You added it as an MCP server: its servers' config. */
  mcpServers?: Record<string, unknown>;
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
  const [addingMcp, setAddingMcp] = useState(false);

  if (name) return <PluginDetail name={name} sandbox={value?.sandbox} onChanged={reload} />;
  return (
    <>
      <Toolbar title="Plugins" sub="Skills, commands, hooks and MCP servers packaged for Claude Code. Whatever a plugin runs runs in the OS sandbox.">
        <button className="btn" onClick={() => setAddingMcp(true)}>
          <IconPlug /> Add MCP server
        </button>
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
          {tab === 'library' && <Library plugins={value?.library} onChanged={reload} onAdd={() => setAdding(true)} onAddMcp={() => setAddingMcp(true)} />}
          {tab === 'anthropic' && <Catalog onInstalled={reload} />}
        </div>
      </div>
      {adding && <FromGithub onClose={() => setAdding(false)} onInstalled={(n) => (reload(), go('plugins', 'library', n))} />}
      {addingMcp && <AddMcp onClose={() => setAddingMcp(false)} onAdded={(n) => (reload(), go('plugins', 'library', n))} />}
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

function SourceBadge({ origin, added }: { origin?: Origin; added?: boolean }) {
  if (added) return <span className="pill info">MCP server you added</span>;
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

function Library({ plugins, onChanged, onAdd, onAddMcp }: { plugins?: PluginRow[]; onChanged: () => void; onAdd: () => void; onAddMcp: () => void }) {
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
              <button className="btn" onClick={onAddMcp}>
                <IconPlug /> Add MCP server
              </button>
              <button className="btn primary" onClick={onAdd}>
                <IconPlus /> Add from GitHub
              </button>
            </div>
          }
        >
          A plugin bundles skills, slash commands, agents, hooks and MCP servers. covibe shows you what a plugin runs before you install it, and runs all of it in the OS sandbox with
          only the network and folders you allow. Any MCP server (ElevenLabs, Linear, your own) can be added too: paste its address, command or JSON snippet.
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
                <SourceBadge origin={p.origin} added={!!p.mcpServers} />
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
  const [editing, setEditing] = useState(false);
  if (!value) return <Toolbar title={name} />;
  const current = policy ?? value.policy;
  return (
    <>
      <Toolbar title={<span className="mono">{name}</span>} sub={value.description}>
        {value.mcpServers && (
          <button className="btn" onClick={() => setEditing(true)}>
            Change servers
          </button>
        )}
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
            <SourceBadge origin={value.origin} added={!!value.mcpServers} />
            {value.version && <span className="tiny faint">v{value.version}</span>}
            <UsedBy used={value.usedBy} />
            <span className="tiny faint">Changed {ago(value.updatedAt)}</span>
          </div>
          <div className="card card-pad">
            <ContentsView contents={value.contents} />
          </div>
          {value.variables.length > 0 && <Variables plugin={name} variables={value.variables} onChange={() => (void reload(), onChanged())} />}
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
      {editing && value.mcpServers && (
        <AddMcp
          initial={{ name, description: value.description, config: JSON.stringify({ mcpServers: value.mcpServers }, null, 2) }}
          onClose={() => setEditing(false)}
          onAdded={() => (setEditing(false), void reload(), onChanged())}
        />
      )}
    </>
  );
}

/**
 * Add any MCP server as a plugin of your own: its address, the command that
 * starts it, or the JSON snippet its maker publishes. Keys in the snippet
 * are saved with covibe's other keys, not in the plugin.
 */
function AddMcp({ initial, onClose, onAdded }: { initial?: { name: string; description: string; config: string }; onClose: () => void; onAdded: (name: string) => void }) {
  const toast = useToast();
  const [config, setConfig] = useState(initial?.config ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [header, setHeader] = useState({ name: '', value: '' });
  const [review, setReview] = useState<(Review & { mcpServers: Record<string, unknown>; variables: Variable[] }) | null>(null);
  const [policy, setPolicy] = useState<SandboxPolicy | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const isUrl = /^https?:\/\//i.test(config.trim());
  const input = () => ({ config, name: name.trim() || undefined, description: initial?.description, header: isUrl && header.name.trim() ? header : undefined });
  const [check, checking] = useAction(async () => {
    const r = await post<NonNullable<typeof review>>('/api/plugins/mcp/review', input());
    setReview(r);
    setPolicy(r.policy);
    if (!name.trim()) setName(r.name);
  });
  const [add, adding] = useAction(async () => {
    const p = await post<PluginRow>('/api/plugins/mcp/add', { ...input(), name: review!.name, policy, values });
    toast(initial ? `Saved ${p.name}` : `Added ${p.name}`);
    onAdded(p.name);
  });
  const missing = review?.variables.filter((v) => !v.saved && !v.found && !v.inEnvironment && !values[v.name]?.trim()) ?? [];

  return (
    <Modal
      title={initial ? <span>Change <span className="mono">{initial.name}</span></span> : 'Add an MCP server'}
      wide
      onClose={onClose}
      footer={
        <>
          {review && (
            <button className="btn" onClick={() => setReview(null)}>
              Back
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {review ? (
            <button className="btn primary" disabled={adding || !policy} onClick={() => void add()}>
              {adding ? 'Saving…' : review.installed ? 'Save with these permissions' : 'Add with these permissions'}
            </button>
          ) : (
            <button className="btn primary" disabled={!config.trim() || checking} onClick={() => void check()}>
              {checking ? 'Reading…' : 'Review'}
            </button>
          )}
        </>
      }
    >
      {!review ? (
        <div className="col" style={{ gap: 14 }}>
          <label className="field">
            Address, command or JSON
            <textarea
              className="input mono"
              autoFocus
              rows={initial ? 12 : 6}
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              placeholder={'https://mcp.example.com/mcp\n\nor a command:  npx -y @example/mcp-server\n\nor the JSON from its docs:  { "mcpServers": { "example": { "command": "uvx", "args": ["example-mcp"], "env": { "EXAMPLE_API_KEY": "…" } } } }'}
            />
            <span className="help">
              Most services publish one of these for Claude Code, Claude Desktop or Cursor. Paste it as it is: keys in it are taken out and saved with covibe's other keys
              (the {navigator.platform.startsWith('Mac') ? 'Keychain' : 'secrets file'}), never in the plugin.
            </span>
          </label>
          <label className="field">
            Name
            <input className="input mono" value={name} disabled={!!initial} placeholder="Taken from the server if you leave it empty" onChange={(e) => setName(e.target.value)} />
            <span className="help">What team files call it: plugins: [{name.trim() || 'name'}].</span>
          </label>
          {isUrl && (
            <div className="field">
              API key header (optional)
              <div className="row">
                <input className="input mono" style={{ maxWidth: 200 }} value={header.name} placeholder="e.g. Authorization or x-api-key" onChange={(e) => setHeader({ ...header, name: e.target.value })} />
                <input className="input mono grow" type="password" value={header.value} placeholder="Bearer sk-… or the key" onChange={(e) => setHeader({ ...header, value: e.target.value })} />
              </div>
              <span className="help">For servers that take a key instead of a sign-in. Servers that want a sign-in (OAuth) get a Sign in button once added.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="col" style={{ gap: 14 }}>
          <p className="small muted">
            <span className="mono">{review.name}</span>: {review.description}
            {review.installed && <span className="pill" style={{ marginLeft: 6 }}>replaces the one in your library</span>}
          </p>
          <ContentsView contents={review.contents} />
          {review.variables.length > 0 && (
            <div className="col" style={{ gap: 8 }}>
              <h3 style={{ margin: 0 }}>Keys and settings</h3>
              {review.variables.map((v) => (
                <label key={v.name} className="field">
                  <span className="mono">{v.name}</span>
                  <input
                    className="input mono"
                    type="password"
                    value={values[v.name] ?? ''}
                    placeholder={v.found ? 'Found in what you pasted: saved with your keys' : v.saved ? 'Saved: leave empty to keep it' : v.inEnvironment ? 'Taken from your environment unless you enter one' : 'Not set'}
                    onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
                  />
                </label>
              ))}
              {missing.length > 0 && <span className="tiny" style={{ color: 'var(--warn)' }}>Without {missing.map((v) => v.name).join(', ')} the server may not start. You can add them later on its page.</span>}
            </div>
          )}
          {review.contents.programs.length > 0 && policy && (
            <div className="col" style={{ gap: 8 }}>
              <h3 className="row" style={{ margin: 0 }}>
                <IconShield width={15} height={15} /> Its sandbox
              </h3>
              <PolicyEditor value={policy} onChange={setPolicy} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Keys and other values a plugin's servers need, kept with covibe's other keys and given only to those servers. */
function Variables({ plugin, variables, onChange }: { plugin: string; variables: Variable[]; onChange: () => void }) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [save, saving] = useAction(async (change: Record<string, string | null>) => {
    await put(`/api/plugins/${encodeURIComponent(plugin)}/variables`, { values: change });
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !(k in change))));
    toast('Saved: it applies from the next turn');
    onChange();
  });
  const edited = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
  return (
    <div className="card card-pad col" style={{ gap: 10 }}>
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>
          Keys and settings
        </h3>
        <button className="btn sm primary" disabled={!Object.keys(edited).length || saving} onClick={() => void save(edited)}>
          Save
        </button>
      </div>
      <span className="tiny faint">
        Kept with covibe's other keys. The launcher gives them only to this plugin's servers (a remote server gets them through covibe's proxy): members never see them.
      </span>
      {variables.map((v) => (
        <div key={v.name} className="row" style={{ gap: 10 }}>
          <div className="col" style={{ gap: 2, minWidth: 220 }}>
            <span className="small mono">{v.name}</span>
            <span className="tiny faint" style={!v.saved && !v.inEnvironment ? { color: 'var(--warn)' } : undefined}>
              {v.saved ? 'Saved' : v.inEnvironment ? 'From your environment' : 'Not set'} · {v.servers.join(', ')}
            </span>
          </div>
          <input
            className="input mono grow"
            type="password"
            value={values[v.name] ?? ''}
            placeholder={v.saved ? 'Enter a new value to replace it' : 'Enter a value'}
            onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && values[v.name]?.trim() && void save({ [v.name]: values[v.name]! })}
          />
          {v.saved && (
            <button className="btn sm ghost" disabled={saving} onClick={() => void save({ [v.name]: null })}>
              Remove
            </button>
          )}
        </div>
      ))}
    </div>
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
      {remotes.map((r) => r.client && <OwnClient key={`client-${r.name}`} plugin={plugin} server={r.name} client={r.client} onChange={onChange} />)}
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

/**
 * Your own OAuth app for a server that does not let covibe register itself
 * (the sign-in says so): made in the service's developer settings with
 * covibe's fixed callback address.
 */
function OwnClient({ plugin, server, client, onChange }: { plugin: string; server: string; client: NonNullable<Remote['client']>; onChange: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(!!client.clientId);
  const [id, setId] = useState(client.clientId ?? '');
  const [secret, setSecret] = useState('');
  const path = `/api/plugins/${encodeURIComponent(plugin)}/sign-in/${encodeURIComponent(server)}/client`;
  const [save, saving] = useAction(async () => {
    await put(path, { clientId: id, ...(secret ? { clientSecret: secret } : {}) });
    setSecret('');
    toast(`${server} signs in with your OAuth app now: sign in again`);
    onChange();
  });
  const [remove] = useAction(async () => {
    await del(path);
    setId('');
    toast(`${server} signs in with covibe's own registration again`);
    onChange();
  });
  if (!open)
    return (
      <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        Use your own OAuth app for {server}
      </button>
    );
  return (
    <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <strong className="small">Your own OAuth app for {server}</strong>
      <span className="tiny faint">
        For servers that do not let covibe register itself. Create an OAuth app in the service's developer settings with this callback address, then enter its client id (and
        secret, if it has one):
      </span>
      <span className="row" style={{ gap: 6 }}>
        <code className="small mono">{client.callbackUrl}</code>
        <Copy text={client.callbackUrl} label="Copy" />
      </span>
      <div className="row">
        <input className="input mono grow" value={id} placeholder="Client id" onChange={(e) => setId(e.target.value)} />
        <input className="input mono grow" type="password" value={secret} placeholder={client.hasSecret ? 'Secret saved: enter one to replace it' : 'Client secret (if any)'} onChange={(e) => setSecret(e.target.value)} />
        <button className="btn sm primary" disabled={!id.trim() || saving} onClick={() => void save()}>
          Save
        </button>
        {client.clientId && (
          <button className="btn sm ghost" onClick={() => void remove()}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
