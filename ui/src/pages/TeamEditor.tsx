import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { del, get, post, put, type EditOp, type TeamDetail, type TeamListing } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import { Composer } from '../components/Composer';
import { DesignChat } from '../components/DesignChat';
import { IconAlert, IconArrowLeft, IconChat, IconArrowRight, IconCheck, IconCode, IconCopy, IconFile, IconFlow, IconGear, IconLoop, IconPlay, IconPlus, IconTeam, IconTrash } from '../components/icons';
import { useConnections } from '../components/Connections';
import { ModelPicker, type ProviderChoice } from '../components/ModelPicker';
import { Toolbar } from '../components/Toolbar';
import { PluginPicker } from './Plugins';
import { SkillPicker } from './Skills';
import { Avatar, ChipsInput, Empty, Modal, useAction, useToast } from '../components/ui';
import { go, href, useData, useLive } from '../data';

type Doc = Record<string, any>;
type Edit = (ops: EditOp[]) => Promise<void>;
type Tab = 'members' | 'workflow' | 'yaml' | 'files' | 'settings' | 'chat';

const KNOWN_TOOLS: [string, string][] = [
  ['Read', 'Read files'],
  ['Grep', 'Search file contents'],
  ['Glob', 'Find files'],
  ['Edit', 'Edit files'],
  ['Write', 'Create files'],
  ['Bash', 'Run shell commands'],
  ['WebSearch', 'Search the web'],
  ['WebFetch', 'Fetch web pages'],
  ['NotebookEdit', 'Edit notebooks'],
];
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
export function TeamEditor({ teamId, tab: tabParam }: { teamId: string; tab?: string }) {
  const { refresh } = useData();
  const toast = useToast();
  const { value: team, error, setValue, reload } = useLive(() => get<TeamDetail>(`/api/teams/${teamId}`), [teamId]);
  const [goal, setGoal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tab: Tab = (['members', 'workflow', 'yaml', 'files', 'settings', 'chat'].includes(tabParam ?? '') ? tabParam : 'members') as Tab;

  const edit: Edit = useCallback(
    async (ops) => {
      try {
        const r = await post<{ yaml: string; doc: Doc; problems: string[] }>(`/api/teams/${teamId}/edit`, { ops });
        setValue((t) => (t ? { ...t, yaml: r.yaml, doc: r.doc, problems: r.problems } : t));
        void refresh();
      } catch (err) {
        toast((err as Error).message, true);
      }
    },
    [teamId, setValue, refresh, toast],
  );

  const [duplicate] = useAction(async () => {
    const t = await post<TeamListing>(`/api/teams/${teamId}/duplicate`, { name: `${team?.doc.name ?? teamId}-copy` });
    await refresh();
    go('teams', t.id);
  });
  const [remove] = useAction(async () => {
    await del(`/api/teams/${teamId}`);
    await refresh();
    go('teams');
  });

  if (error) return <><Toolbar title="Team" /><div className="content"><div className="banner bad"><IconAlert />{error}</div></div></>;
  if (!team) return <Toolbar title="Loading…" />;
  const doc = team.doc;
  const name = typeof doc.name === 'string' ? doc.name : teamId;

  return (
    <>
      <Toolbar title={name} sub={typeof doc.description === 'string' ? doc.description : team.dir}>
        {team.problems.length ? (
          <span className="pill bad">
            <IconAlert /> {team.problems.length} problem{team.problems.length > 1 ? 's' : ''}
          </span>
        ) : (
          <span className="pill good">
            <IconCheck /> Ready to run
          </span>
        )}
        <button className="btn ghost icon-btn" title="Duplicate team" onClick={() => void duplicate()}>
          <IconCopy />
        </button>
        <button className="btn ghost icon-btn" title="Delete team" onClick={() => setConfirmDelete(true)}>
          <IconTrash />
        </button>
        <button className="btn primary" disabled={!!team.problems.length} onClick={() => setGoal(true)} title={team.problems.length ? 'Fix the problems first' : ''}>
          <IconPlay /> Give it a goal
        </button>
      </Toolbar>
      <nav className="tabs">
        {(
          [
            ['chat', 'Chat', <IconChat width={14} height={14} />],
            ['members', 'Members', <IconTeam width={14} height={14} />],
            ['workflow', 'Workflow', <IconFlow width={14} height={14} />],
            ['settings', 'Team settings', <IconGear width={14} height={14} />],
            ['yaml', 'YAML', <IconCode width={14} height={14} />],
            ['files', 'Files', <IconFile width={14} height={14} />],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => go('teams', teamId, id)}>
            {icon} {label}
          </button>
        ))}
      </nav>
      <SandboxDefaultsCtx.Provider value={team.sandboxDefaults}>
      <div className="content flush">
        {team.problems.length > 0 && tab !== 'yaml' && (
          <div style={{ padding: '12px 20px 0' }}>
            <div className="banner bad">
              <IconAlert />
              <div className="problems">
                <strong>This team can't run until these are fixed:</strong>
                <ul>
                  {team.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
        {tab === 'chat' && (
          <div style={{ padding: 20, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <DesignChat teamId={teamId} height={Math.max(420, window.innerHeight - 220)} onTeam={() => void reload()} />
          </div>
        )}
        {tab === 'members' && <Members teamId={teamId} doc={doc} edit={edit} files={team.files.map((f) => f.path)} onFiles={reload} />}
        {tab === 'workflow' && <Workflow doc={doc} edit={edit} />}
        {tab === 'settings' && <TeamSettings doc={doc} edit={edit} />}
        {tab === 'yaml' && <YamlTab teamId={teamId} team={team} onSaved={reload} />}
        {tab === 'files' && <Files teamId={teamId} team={team} onChange={reload} />}
      </div>
      </SandboxDefaultsCtx.Provider>

      {goal && (
        <Modal title={`Give ${name} a goal`} onClose={() => setGoal(false)} wide>
          <div className="card" style={{ boxShadow: 'none' }}>
            <Composer fixedTeam={teamId} autoFocus onDone={() => setGoal(false)} />
          </div>
        </Modal>
      )}
      {confirmDelete && (
        <Modal
          title={`Delete ${name}?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className="btn primary" style={{ background: 'var(--bad)' }} onClick={() => void remove()}>
                Delete team
              </button>
            </>
          }
        >
          <p className="small">This deletes the team's folder with its prompts and schemas. Past runs keep their history.</p>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- small form helpers

/** A text input that commits on blur or Enter, so typing does not rewrite the file per keystroke. */
function TextField({ value, onCommit, placeholder, mono, type = 'text', multiline }: { value: string | number | undefined; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; type?: string; multiline?: boolean }) {
  const [v, setV] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setV(value === undefined ? '' : String(value));
  }, [value]);
  const commit = () => {
    if (v !== (value === undefined ? '' : String(value))) onCommit(v);
  };
  if (multiline)
    return <textarea className={`input ${mono ? 'mono' : ''}`} rows={3} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />;
  return (
    <input
      className={`input ${mono ? 'mono' : ''}`}
      type={type}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

const num = (s: string) => (s.trim() === '' ? null : Number(s));

type SandboxDefaults = TeamDetail['sandboxDefaults'];
// The engine's defaults, sent by the server, so the form shows what applies.
const SandboxDefaultsCtx = createContext<SandboxDefaults>({ network: [], allowWrite: [] });

function SandboxFields({ sandbox, onChange, hideToggle }: { sandbox: Doc | undefined; onChange: (v: Doc | null) => void; hideToggle?: boolean }) {
  const defaults = useContext(SandboxDefaultsCtx);
  const on = sandbox?.enabled !== false;
  const network: string[] = Array.isArray(sandbox?.network) ? sandbox!.network : defaults.network;
  // Show the home-relative form the user would type.
  const write: string[] = Array.isArray(sandbox?.allow_write) ? sandbox!.allow_write : defaults.allowWrite;
  const set = (patch: Doc) => onChange({ ...(sandbox ?? {}), ...patch });
  return (
    <div className="col" style={{ gap: 10 }}>
      {!hideToggle && (
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => set({ enabled: e.target.checked })} />
          Run members' shell commands in the macOS sandbox (recommended)
        </label>
      )}
      {on ? (
        <>
          <label className="field">
            Websites shell commands may reach
            <ChipsInput values={network} placeholder="Add a domain, e.g. api.example.com or *.example.com" onChange={(v) => set({ network: v })} />
            <span className="help">Package registries are allowed by default so installs work. Everything else is blocked.</span>
          </label>
          <label className="field">
            Extra folders shell commands may write
            <ChipsInput values={write} placeholder="Add a folder, e.g. ~/.gradle" onChange={(v) => set({ allow_write: v })} />
            <span className="help">Besides the member's own working copy and temp folders. Package caches are included by default.</span>
          </label>
        </>
      ) : (
        <span className="tiny" style={{ color: 'var(--warn)' }}>
          Off: shell commands can write anywhere your user can and reach any site. covibe still discards file changes outside each member's allowed paths before merging.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- members

function Members({ teamId, doc, edit, files, onFiles }: { teamId: string; doc: Doc; edit: Edit; files: string[]; onFiles: () => void }) {
  const agents: Record<string, Doc> = doc.agents && typeof doc.agents === 'object' ? doc.agents : {};
  const names = Object.keys(agents);
  const [selected, setSelected] = useState<string | undefined>(names[0]);
  const [adding, setAdding] = useState(false);
  const current = selected && agents[selected] ? selected : names[0];

  return (
    <div className="split">
      <div className="split-list">
        {names.map((n, i) => (
          <div key={n} className={`list-row clickable ${n === current ? 'selected' : ''}`} style={{ borderRadius: 8, border: 0, padding: '8px 10px' }} onClick={() => setSelected(n)}>
            <Avatar name={n} index={i} />
            <div className="col grow" style={{ gap: 0 }}>
              <strong>{n}</strong>
              <span className="tiny faint ellipsis">{agents[n]?.description ?? roleLine(agents[n] ?? {})}</span>
            </div>
          </div>
        ))}
        <button className="btn" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>
          <IconPlus /> Add member
        </button>
      </div>
      <div className="split-main">
        {current ? (
          <MemberForm key={current} teamId={teamId} name={current} index={names.indexOf(current)} agent={agents[current]!} names={names} edit={edit} files={files} onFiles={onFiles} onDeleted={() => setSelected(undefined)} teamSkills={doc.defaults?.skills} teamPlugins={doc.defaults?.plugins} teamBackend={doc.defaults?.backend} teamBrowser={doc.defaults?.browser === true} />
        ) : (
          <Empty icon={<IconTeam />} title="No members" action={<button className="btn primary" onClick={() => setAdding(true)}><IconPlus /> Add member</button>} />
        )}
      </div>
      {adding && <AddMember teamId={teamId} names={names} files={files} edit={edit} onClose={() => setAdding(false)} onAdded={(n) => (setSelected(n), onFiles())} />}
    </div>
  );
}

function roleLine(a: Doc): string {
  const tools: string[] = Array.isArray(a.tools) ? a.tools : [];
  const writes = tools.some((t) => WRITE_TOOLS.has(t));
  const model = a.backend?.type === 'connection' ? `${a.backend.model ?? '?'} on ${a.backend.connection}` : (a.model ?? 'default model');
  return `${model}${a.effort ? ` (${a.effort})` : ''}${a.backend?.account ? ` · ${a.backend.account} account` : ''} · ${writes ? (a.scope?.write ? `writes ${a.scope.write.join(', ') || 'nothing'}` : 'writes anywhere') : 'read-only'}`;
}

function MemberForm({ teamId, name, index, agent, names, edit, files, onFiles, onDeleted, teamSkills, teamPlugins, teamBackend, teamBrowser }: { teamId: string; name: string; index: number; agent: Doc; names: string[]; edit: Edit; files: string[]; onFiles: () => void; onDeleted: () => void; teamSkills?: string[]; teamPlugins?: string[]; teamBackend?: Doc; teamBrowser?: boolean }) {
  const appDefault = (Array.isArray(agent.tools) && agent.tools.includes('Bash')) || (agent.browser ?? teamBrowser) === true;
  const p = (...k: (string | number)[]) => ['agents', name, ...k];
  const tools: string[] = Array.isArray(agent.tools) ? agent.tools : [];
  const writes = tools.some((t) => WRITE_TOOLS.has(t));
  const scope: string[] | undefined = Array.isArray(agent.scope?.write) ? agent.scope.write : undefined;
  const scopeMode = scope === undefined ? 'anything' : scope.length ? 'paths' : 'nothing';
  const schemas = files.filter((f) => f.endsWith('.json') && f !== 'team.yaml');
  const backend: Doc | undefined = agent.backend;
  const [confirm, setConfirm] = useState(false);

  const setTools = (next: string[]) => {
    const ops: EditOp[] = [{ op: 'set', path: p('tools'), value: next }];
    // A write scope without write tools is invalid; drop it when the last write tool goes.
    if (!next.some((t) => WRITE_TOOLS.has(t)) && agent.scope) ops.push({ op: 'delete', path: p('scope') });
    void edit(ops);
  };

  return (
    <div className="form">
      <div className="row" style={{ gap: 12 }}>
        <Avatar name={name} index={index} size="lg" />
        <div className="col grow" style={{ gap: 4 }}>
          <h2>{name}</h2>
          <TextField value={agent.description} placeholder="What this member does, e.g. 'Builds the web UI under web/'" onCommit={(v) => void edit([{ op: 'set', path: p('description'), value: v || null }])} />
        </div>
        <button className="btn ghost danger" onClick={() => setConfirm(true)}>
          <IconTrash /> Remove
        </button>
      </div>

      <section className="form-section">
        <h3>Role and instructions</h3>
        <PromptEditor teamId={teamId} agent={agent} name={name} edit={edit} onFiles={onFiles} />
      </section>

      <section className="form-section">
        <h3>Model and thinking</h3>
        <ModelPicker
          value={{ model: agent.model, effort: agent.effort, thinking: agent.thinking }}
          inherit="Team default"
          // A member's own model (with no backend of its own) is not run on the team's provider.
          provider={backend ? providerOf(backend) : agent.model ? undefined : providerOf(teamBackend)}
          onProvider={(c) => void edit([{ op: 'set', path: p('backend'), value: providerBackend(c) }])}
          onChange={(k, v) => {
            const ops: EditOp[] = [{ op: 'set', path: p(k), value: v }];
            // Back to a Claude model: leave the provider (the team's, too, if it uses one).
            if (k === 'model' && providerOf(backend ?? teamBackend)) {
              ops.push({ op: 'set', path: p('backend'), value: v !== null && providerOf(teamBackend) ? { type: 'subscription' } : null });
            }
            void edit(ops);
          }}
        />
      </section>

      <div className="grid grid-2">
        <section className="form-section">
          <h3>Report format</h3>
          <select className="input" value={agent.output_schema ?? ''} onChange={(e) => void edit([{ op: 'set', path: p('output_schema'), value: e.target.value || null }])}>
            <option value="">Free text</option>
            {schemas.map((s) => (
              <option key={s} value={s}>
                Structured: {s}
              </option>
            ))}
          </select>
          <span className="tiny faint">Gates read fields from structured reports, e.g. <span className="mono">review.blocking_count = 0</span>.</span>
        </section>
      </div>

      <section className="form-section">
        <h3>Tools</h3>
        <div className="chips">
          {[...KNOWN_TOOLS, ...tools.filter((t) => !KNOWN_TOOLS.some(([k]) => k === t)).map((t) => [t, t] as [string, string])].map(([t, label]) => {
            const on = tools.includes(t);
            return (
              <button key={t} className={`chip ${on ? 'on' : ''}`} title={label} onClick={() => setTools(on ? tools.filter((x) => x !== t) : [...tools, t])}>
                {on ? '✓ ' : ''}
                {t}
              </button>
            );
          })}
        </div>
      </section>

      {writes && (
        <section className="form-section">
          <h3>Ponytail</h3>
          <label className="check">
            <input type="checkbox" checked={agent.ponytail === true} onChange={(e) => void edit([{ op: 'set', path: p('ponytail'), value: e.target.checked ? true : null }])} />
            Write the smallest complete change
          </label>
          <span className="tiny faint">
            Ponytail's rules: reuse what the project already has, add no features, abstractions or dependencies nobody asked for, and never cut validation, error handling, security or tests. Less code means fewer tokens and turns.
          </span>
        </section>
      )}

      <section className="form-section">
        <h3>Browser</h3>
        <div className="seg">
          <button className={agent.browser === undefined ? 'on' : ''} onClick={() => void edit([{ op: 'delete', path: p('browser') }])}>
            Team default ({teamBrowser ? 'on' : 'off'})
          </button>
          <button className={agent.browser === true ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: p('browser'), value: true }])}>
            On
          </button>
          <button className={agent.browser === false ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: p('browser'), value: false }])}>
            Off
          </button>
        </div>
        <span className="tiny faint">
          covibe's browser: it can open its dev server or the pages it builds, click through them, take screenshots and read the console. You watch it live from its desk and can take control.
        </span>
      </section>

      <section className="form-section">
        <h3>Running the app</h3>
        <div className="seg">
          <button className={agent.app === undefined ? 'on' : ''} onClick={() => void edit([{ op: 'delete', path: p('app') }])}>
            Default ({appDefault ? 'on' : 'off'})
          </button>
          <button className={agent.app === true ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: p('app'), value: true }])}>
            On
          </button>
          <button className={agent.app === false ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: p('app'), value: false }])}>
            Off
          </button>
        </div>
        <span className="tiny faint">
          The app tools: it can start the project's app (its dev server or site) in the sandbox or in Docker, read its log and stop it. It keeps running for teammates and for you (the run's App tab). On by default for members with Bash or a browser; members without Bash start it only the way the team file or the project says.
        </span>
      </section>

      <section className="form-section">
        <h3>Skills</h3>
        <SkillPicker
          value={Array.isArray(agent.skills) ? agent.skills : []}
          inherited={(Array.isArray(teamSkills) ? teamSkills : []).map((n: string) => ({ name: n, why: 'from the team' }))}
          onChange={(v) => void edit([{ op: 'set', path: p('skills'), value: v.length ? v : null }])}
        />
        <span className="tiny faint">Claude loads a skill when a task calls for it. Manage skills under Skills in the sidebar.</span>
      </section>

      <section className="form-section">
        <h3>Plugins</h3>
        <PluginPicker
          value={Array.isArray(agent.plugins) ? agent.plugins : []}
          inherited={(Array.isArray(teamPlugins) ? teamPlugins : []).map((n: string) => ({ name: n, why: 'from the team' }))}
          onChange={(v) => void edit([{ op: 'set', path: p('plugins'), value: v.length ? v : null }])}
        />
        <span className="tiny faint">Skills, commands, hooks and MCP servers from your plugin library. Their hooks and servers run in the OS sandbox with each plugin's permissions.</span>
      </section>

      <section className="form-section">
        <h3>What it may change</h3>
        {!writes ? (
          <p className="small muted">Read-only: none of its tools can change files.</p>
        ) : (
          <>
            <div className="seg">
              <button className={scopeMode === 'anything' ? 'on' : ''} onClick={() => void edit([{ op: 'delete', path: p('scope') }])}>
                Anything in the repo
              </button>
              <button className={scopeMode === 'paths' ? 'on' : ''} onClick={() => scopeMode !== 'paths' && void edit([{ op: 'set', path: p('scope'), value: { write: ['src/**'] } }])}>
                Only these paths
              </button>
              <button className={scopeMode === 'nothing' ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: p('scope'), value: { write: [] } }])}>
                Nothing
              </button>
            </div>
            {scopeMode === 'paths' && (
              <ChipsInput values={scope!} placeholder="Add a path pattern, e.g. web/** or **/*.test.ts, then press Enter" onChange={(v) => void edit([{ op: 'set', path: p('scope'), value: { write: v } }])} />
            )}
            <span className="tiny faint">Enforced by covibe: writes elsewhere are blocked, and shell changes elsewhere are thrown away before merging.</span>
          </>
        )}
      </section>

      {tools.includes('Bash') && (
        <section className="form-section">
          <h3>Sandbox for its shell commands</h3>
          <div className="seg">
            <button className={!agent.sandbox ? 'on' : ''} onClick={() => void edit([{ op: 'delete', path: p('sandbox') }])}>
              Team default
            </button>
            <button className={agent.sandbox && agent.sandbox.enabled !== false ? 'on' : ''} onClick={() => !(agent.sandbox && agent.sandbox.enabled !== false) && void edit([{ op: 'set', path: p('sandbox'), value: { enabled: true } }])}>
              Custom
            </button>
            <button className={agent.sandbox?.enabled === false ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: p('sandbox'), value: { enabled: false } }])}>
              Off
            </button>
          </div>
          {agent.sandbox && agent.sandbox.enabled !== false && <SandboxFields sandbox={agent.sandbox} hideToggle onChange={(v) => void edit([{ op: 'set', path: p('sandbox'), value: v }])} />}
          {agent.sandbox?.enabled === false && (
            <span className="tiny" style={{ color: 'var(--warn)' }}>
              Its shell commands can write anywhere your user can and reach any site. Only for members you fully trust with the goal.
            </span>
          )}
        </section>
      )}

      {names.length > 1 && (
        <section className="form-section">
          <h3>Can send messages to</h3>
          <div className="chips">
            {names
              .filter((n) => n !== name)
              .map((n) => {
                const list: string[] = Array.isArray(agent.can_message) ? agent.can_message : [];
                const on = list.includes(n);
                return (
                  <button key={n} className={`chip ${on ? 'on' : ''}`} onClick={() => void edit([{ op: 'set', path: p('can_message'), value: on ? (list.filter((x) => x !== n).length ? list.filter((x) => x !== n) : null) : [...list, n] }])}>
                    {on ? '✓ ' : ''}
                    {n}
                  </button>
                );
              })}
          </div>
          <span className="tiny faint">Messages arrive at the start of the recipient's next turn.</span>
        </section>
      )}

      {names.length > 1 && (
        <section className="form-section">
          <h3>Can ask for work</h3>
          <div className="chips">
            {names
              .filter((n) => n !== name)
              .map((n) => {
                const list: string[] = Array.isArray(agent.can_request) ? agent.can_request : [];
                const on = list.includes(n);
                return (
                  <button key={n} className={`chip ${on ? 'on' : ''}`} onClick={() => void edit([{ op: 'set', path: p('can_request'), value: on ? (list.filter((x) => x !== n).length ? list.filter((x) => x !== n) : null) : [...list, n] }])}>
                    {on ? '✓ ' : ''}
                    {n}
                  </button>
                );
              })}
          </div>
          <span className="tiny faint">
            When it wants to, {name} can ask these teammates to do something for it (say, a designer for a mockup). They work on it in a turn of their own, even if they have no workflow step, and {name} gets their reply and their changes.
          </span>
        </section>
      )}

      <div className="grid grid-2">
        <section className="form-section">
          <h3>Connection</h3>
          <BackendFields backend={backend} allowDefault onChange={(v) => void edit([{ op: 'set', path: p('backend'), value: v }])} />
          <CacheTtlField value={agent.cache_ttl} inherit="Team default" onChange={(v) => void edit([{ op: 'set', path: p('cache_ttl'), value: v }])} />
        </section>
        <section className="form-section">
          <h3>Limits</h3>
          <div className="grid grid-2" style={{ gap: 8 }}>
            <label className="field">
              Max turns
              <TextField type="number" value={agent.limits?.max_turns} placeholder="team default" onCommit={(v) => void edit([{ op: 'set', path: p('limits', 'max_turns'), value: num(v) }])} />
            </label>
            <label className="field">
              Timeout (min)
              <TextField type="number" value={agent.limits?.timeout_min} placeholder="team default" onCommit={(v) => void edit([{ op: 'set', path: p('limits', 'timeout_min'), value: num(v) }])} />
            </label>
          </div>
        </section>
      </div>

      {confirm && (
        <Modal
          title={`Remove ${name}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                style={{ background: 'var(--bad)' }}
                onClick={() => {
                  setConfirm(false);
                  void edit([{ op: 'delete', path: ['agents', name] }]).then(onDeleted);
                }}
              >
                Remove member
              </button>
            </>
          }
        >
          <p className="small">Workflow steps that use {name} will need a new member. Its prompt file is kept.</p>
        </Modal>
      )}
    </div>
  );
}

function PromptEditor({ teamId, agent, name, edit, onFiles }: { teamId: string; agent: Doc; name: string; edit: Edit; onFiles: () => void }) {
  const toast = useToast();
  const prompt: string = typeof agent.prompt === 'string' ? agent.prompt : '';
  const isFile = !!prompt && !prompt.includes('\n');
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancel = false;
    setText(null);
    setMissing(false);
    if (!isFile) {
      setText(prompt);
      setSaved(prompt);
      return;
    }
    get<{ content: string }>(`/api/teams/${teamId}/file?path=${encodeURIComponent(prompt)}`)
      .then((r) => !cancel && (setText(r.content), setSaved(r.content)))
      .catch(() => !cancel && (setText(''), setSaved(''), setMissing(true)));
    return () => {
      cancel = true;
    };
  }, [teamId, prompt, isFile]);

  const save = async () => {
    if (text === null) return;
    try {
      if (isFile) {
        await put(`/api/teams/${teamId}/file`, { path: prompt, content: text });
        onFiles();
        if (missing) await edit([]);
        setMissing(false);
      } else {
        await edit([{ op: 'set', path: ['agents', name, 'prompt'], value: text }]);
      }
      setSaved(text);
      toast('Saved');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  if (text === null) return <div className="faint small">Loading…</div>;
  const dirty = text !== saved;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="cm-wrap">
        <CodeEditor value={text} onChange={setText} language="markdown" onSave={() => void save()} minHeight={160} lineNumbers={false} placeholder="Describe the role: what it owns, how it works, what a good report looks like." />
      </div>
      <div className="row">
        <span className="tiny faint grow">
          {isFile ? <span className="mono">{prompt}</span> : 'Written inline in team.yaml'}
          {missing ? ' · file does not exist yet; saving creates it' : ''}
        </span>
        <button className="btn sm primary" disabled={!dirty && !missing} onClick={() => void save()}>
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

/** The provider model a backend uses, if it is a connection. */
function providerOf(backend: Doc | undefined): { id: string; model?: string } | undefined {
  return backend?.type === 'connection' && backend.connection ? { id: backend.connection, model: backend.model } : undefined;
}

const providerBackend = (c: ProviderChoice) => ({ type: 'connection', connection: c.id, model: c.model });

const BATCH_PROPOSALS = 5;

/** How long Claude keeps a member's prompt cache (team default or one member). */
function CacheTtlField({ value, inherit, onChange }: { value: string | undefined; inherit: string; onChange: (v: string | null) => void }) {
  return (
    <label className="field">
      Prompt cache
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{inherit}</option>
        <option value="1h">1 hour</option>
        <option value="5m">5 minutes</option>
      </select>
      <span className="help">
        How long Claude keeps a member's conversation cached. 1 hour costs more per cache write but saves re-reading the whole conversation when a member
        picks up again after a long wait (a fix round after a review, a chat later). Worth it for API-key teams with fix loops; Anthropic's API only.
      </span>
    </label>
  );
}

function BackendFields({ backend, onChange, allowDefault }: { backend: Doc | undefined; onChange: (v: Doc | null) => void; allowDefault?: boolean }) {
  const type = backend?.type ?? '';
  const info = useConnections();
  const accounts = info?.connections.filter((c) => c.kind === 'claude') ?? [];
  const providers = info?.connections.filter((c) => c.kind !== 'claude') ?? [];
  const provider = providers.find((c) => c.id === backend?.connection);
  return (
    <div className="col" style={{ gap: 8 }}>
      <select
        className="input"
        value={type}
        onChange={(e) => {
          const t = e.target.value;
          const first = providers.find((c) => c.models?.length);
          onChange(!t ? null : t === 'connection' && first ? providerBackend({ id: first.id, model: first.models![0]!.id }) : { type: t });
        }}
      >
        {allowDefault && <option value="">Team default</option>}
        <option value="subscription">Claude subscription</option>
        {(providers.length > 0 || type === 'connection') && <option value="connection">ChatGPT account or another provider (Settings → Advanced)</option>}
        <option value="api_key">API key</option>
        <option value="gateway">Gateway (LiteLLM / proxy)</option>
        <option value="bedrock">Amazon Bedrock</option>
        <option value="vertex">Google Vertex AI</option>
      </select>
      {type === 'subscription' && (accounts.length > 0 || backend?.account) && (
        <label className="field">
          Account
          <select className="input" value={backend?.account ?? ''} onChange={(e) => onChange({ ...backend, account: e.target.value || undefined })}>
            <option value="">{info?.balance ? 'Any (shared across accounts)' : 'Your login'}</option>
            {info?.balance && <option value="main">Your login only</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.account?.email ? ` (${a.account.email})` : ''}
              </option>
            ))}
            {backend?.account && backend.account !== 'main' && !accounts.some((a) => a.id === backend.account) && <option value={backend.account}>{backend.account} (not set up)</option>}
          </select>
          <span className="help">{info?.balance ? 'Sharing is on: "Any" uses whichever account has the most room.' : 'Add accounts in Settings → Advanced.'}</span>
        </label>
      )}
      {type === 'connection' && (
        <>
          <label className="field">
            {providers.some((c) => c.kind === 'codex') ? 'Account or provider' : 'Provider'}
            <select className="input" value={backend?.connection ?? ''} onChange={(e) => {
              const c = providers.find((x) => x.id === e.target.value);
              onChange({ type: 'connection', connection: e.target.value, model: c?.models?.[0]?.id });
            }}>
              {!provider && <option value={backend?.connection ?? ''}>{backend?.connection ? `${backend.connection} (not set up)` : 'Choose…'}</option>}
              {providers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Model
            <select className="input mono" value={backend?.model ?? ''} onChange={(e) => onChange({ ...backend, model: e.target.value })}>
              {!provider?.models?.some((m) => m.id === backend?.model) && <option value={backend?.model ?? ''}>{backend?.model ?? 'Choose…'}</option>}
              {(provider?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? m.id}
                </option>
              ))}
            </select>
            <span className="help">Also chosen with the model field above. Add models in Settings → Advanced.</span>
          </label>
        </>
      )}
      {type === 'gateway' && (
        <>
          <label className="field">
            Gateway URL
            <TextField mono value={backend?.base_url} placeholder="http://localhost:4000" onCommit={(v) => onChange({ ...backend, base_url: v || undefined })} />
          </label>
          <label className="field">
            Model at the gateway
            <TextField mono value={backend?.model} placeholder="e.g. cheap-coder" onCommit={(v) => onChange({ ...backend, model: v || undefined })} />
          </label>
          <label className="field">
            Token variable
            <TextField mono value={backend?.auth_token_env} placeholder="ANTHROPIC_AUTH_TOKEN" onCommit={(v) => onChange({ ...backend, auth_token_env: v || undefined })} />
          </label>
        </>
      )}
      {type === 'api_key' && (
        <label className="field">
          Key variable
          <TextField mono value={backend?.api_key_env} placeholder="ANTHROPIC_API_KEY" onCommit={(v) => onChange({ ...backend, api_key_env: v || undefined })} />
          <span className="help">The name of an environment variable, never the key itself.</span>
        </label>
      )}
      {(type === 'bedrock' || type === 'vertex') && (
        <label className="field">
          Region
          <TextField mono value={backend?.region} onCommit={(v) => onChange({ ...backend, region: v || undefined })} />
        </label>
      )}
      {type === 'vertex' && (
        <label className="field">
          Project id
          <TextField mono value={backend?.project} onCommit={(v) => onChange({ ...backend, project: v || undefined })} />
        </label>
      )}
    </div>
  );
}

const PRESETS: Record<string, { label: string; tools: string[]; scope?: string[]; prompt: string; description: string }> = {
  builder: {
    label: 'Builder — writes code',
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    description: 'Implements its tasks.',
    prompt: 'You are a software engineer on this team.\n\n- Follow the conventions you find in the codebase.\n- Implement the tasks you are given; keep changes focused.\n- Run the tests, type checker or build if there is one.\n- On a fix round, address the feedback that concerns you first.\n- Finish with a short summary of what you changed.\n',
  },
  reviewer: {
    label: 'Reviewer — reads, never edits',
    tools: ['Read', 'Grep', 'Glob'],
    description: 'Reviews the merged change.',
    prompt: 'You are the reviewer. You read the change and report problems; you never edit files.\n\n- blocking: a bug, a missing requirement, a security problem or a broken build.\n- minor: style and small improvements.\n\nDo not invent findings; an empty list is a valid review.\n',
  },
  tester: {
    label: 'Tester — writes tests only',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: ['**/tests/**', '**/*.test.*', '**/*.spec.*'],
    description: 'Adds and runs tests.',
    prompt: 'You are the tester. You may add and change test files only.\n\n- Find the project\'s test runner and conventions.\n- Write tests for the acceptance criteria you are given and run the suite.\n- Report the command you ran and the pass and fail counts.\n',
  },
  planner: {
    label: 'Planner — plans and splits work',
    tools: ['Read', 'Grep', 'Glob'],
    description: 'Plans the work and assigns tasks.',
    prompt: 'You plan the work; you do not write code.\n\nRead enough of the repository to understand it, then split the goal into a few concrete tasks with a clear owner and acceptance criteria each.\n',
  },
  researcher: {
    label: 'Researcher — reads code and the web',
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    description: 'Looks things up and explains them.',
    prompt: 'You research questions about the code and its dependencies and explain what you find, with sources.\n',
  },
};

function AddMember({ teamId, names, files, edit, onClose, onAdded }: { teamId: string; names: string[]; files: string[]; edit: Edit; onClose: () => void; onAdded: (name: string) => void }) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('builder');
  const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 64);
  const taken = names.includes(id);
  const [add, busy] = useAction(async () => {
    const p = PRESETS[preset]!;
    const promptPath = `prompts/${id}.md`;
    if (!files.includes(promptPath)) await put(`/api/teams/${teamId}/file`, { path: promptPath, content: p.prompt });
    await edit([{ op: 'set', path: ['agents', id], value: { description: p.description, prompt: promptPath, model: 'sonnet', tools: p.tools, ...(p.scope ? { scope: { write: p.scope } } : {}) } }]);
    onAdded(id);
    onClose();
  });
  return (
    <Modal
      title="Add a team member"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!id || taken || busy} onClick={() => void add()}>
            Add member
          </button>
        </>
      }
    >
      <label className="field">
        Name
        <input className="input" autoFocus value={name} placeholder="e.g. docs" onChange={(e) => setName(e.target.value)} />
        <span className="help">{taken ? 'That name is taken.' : id && id !== name ? `Will be called "${id}".` : 'Lowercase letters, digits, - and _.'}</span>
      </label>
      <div className="col">
        <span className="small muted" style={{ fontWeight: 500 }}>
          Kind of member
        </span>
        {Object.entries(PRESETS).map(([k, v]) => (
          <label key={k} className={`template ${preset === k ? 'on' : ''}`} style={{ padding: 10 }}>
            <input type="radio" checked={preset === k} onChange={() => setPreset(k)} style={{ accentColor: 'var(--accent)' }} />
            <div className="col" style={{ gap: 2 }}>
              <strong>{v.label}</strong>
              <span className="tiny faint">{v.tools.join(', ')}{v.scope ? ` · may only write ${v.scope.join(', ')}` : ''}</span>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- workflow

function Workflow({ doc, edit }: { doc: Doc; edit: Edit }) {
  const steps: Doc[] = Array.isArray(doc.workflow?.steps) ? doc.workflow.steps : [];
  const agents = Object.keys(doc.agents ?? {});
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, Math.max(0, steps.length - 1));
  const step = steps[i];
  const policy: Doc | undefined = doc.workflow?.on_gate_fail;
  const freeId = (base: string) => {
    let id = base;
    for (let n = 2; steps.some((s) => s.id === id); n++) id = `${base}-${n}`;
    return id;
  };
  const index = (n: string) => agents.indexOf(n);

  const setStep = (k: number, value: Doc) => void edit([{ op: 'set', path: ['workflow', 'steps', k], value }]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 20px 24px' }}>
      <WorkflowGraph steps={steps} agents={agents} policy={policy} selected={i} onSelect={setSel} edit={edit} freeId={freeId} />

      {step && (
        <div className="card card-pad form" style={{ maxWidth: 'none', marginTop: 8 }}>
          <div className="row">
            <h2 className="grow">Step “{step.id}”</h2>
            <button className="btn sm ghost icon-btn" title="Move earlier" disabled={i === 0} onClick={() => (void edit([{ op: 'move', path: ['workflow', 'steps'], from: i, to: i - 1 }]), setSel(i - 1))}>
              <IconArrowLeft />
            </button>
            <button className="btn sm ghost icon-btn" title="Move later" disabled={i === steps.length - 1} onClick={() => (void edit([{ op: 'move', path: ['workflow', 'steps'], from: i, to: i + 1 }]), setSel(i + 1))}>
              <IconArrowRight />
            </button>
            <button className="btn sm ghost danger" onClick={() => (void edit([{ op: 'delete', path: ['workflow', 'steps', i] }]), setSel(Math.max(0, i - 1)))}>
              <IconTrash /> Delete step
            </button>
          </div>
          <div className="grid grid-2">
            <label className="field">
              Step name
              <TextField mono value={step.id} onCommit={(v) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'id'], value: v }])} />
            </label>
            <label className="field">
              Who works on it
              <div className="seg">
                <button className={!Array.isArray(step.parallel) && !step.summary ? 'on' : ''} onClick={() => (Array.isArray(step.parallel) || step.summary) && setStep(i, { ...withoutKeys(step, ['parallel', 'summary']), agent: step.parallel?.[0]?.agent ?? agents[0] })}>
                  One member
                </button>
                <button className={Array.isArray(step.parallel) ? 'on' : ''} onClick={() => !Array.isArray(step.parallel) && setStep(i, { ...withoutKeys(step, ['agent', 'task', 'output_schema', 'summary']), parallel: [{ agent: step.agent ?? agents[0], ...(step.task ? { task: step.task } : {}) }] })}>
                  Several in parallel
                </button>
                <button className={step.summary ? 'on' : ''} title="The run's summary: written by covibe from the reports, or by a model you choose" onClick={() => !step.summary && setStep(i, { id: step.id, summary: true })}>
                  Summary
                </button>
              </div>
            </label>
          </div>

          {step.summary ? (
            <SummaryStepFields step={step} path={['workflow', 'steps', i]} teamBackend={doc.defaults?.backend} edit={edit} />
          ) : !Array.isArray(step.parallel) ? (
            <div className="grid grid-2">
              <label className="field">
                Member
                <select className="input" value={step.agent ?? ''} onChange={(e) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'agent'], value: e.target.value }])}>
                  {agents.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Task (optional)
                <TextField mono value={step.task} placeholder="e.g. plan.tasks.acceptance" onCommit={(v) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'task'], value: v || null }])} />
                <span className="help">Picks what this member gets from earlier reports. Empty = the goal only.</span>
              </label>
            </div>
          ) : (
            <div className="col">
              <span className="small muted" style={{ fontWeight: 500 }}>
                Members working in parallel
              </span>
              {step.parallel.map((b: Doc, j: number) => (
                <div key={j} className="row">
                  <select className="input" style={{ width: 180 }} value={b.agent} onChange={(e) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'parallel', j, 'agent'], value: e.target.value }])}>
                    {agents.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                  <div className="grow">
                    <TextField mono value={b.task} placeholder={`task, e.g. plan.tasks[owner = '${b.agent}']`} onCommit={(v) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'parallel', j, 'task'], value: v || null }])} />
                  </div>
                  <button className="btn sm ghost icon-btn" disabled={step.parallel.length === 1} onClick={() => void edit([{ op: 'delete', path: ['workflow', 'steps', i, 'parallel', j] }])} title="Remove">
                    <IconTrash />
                  </button>
                </div>
              ))}
              <div>
                <button className="btn sm" onClick={() => { const free = agents.find((a) => !step.parallel.some((b: Doc) => b.agent === a)); if (free) void edit([{ op: 'set', path: ['workflow', 'steps', i, 'parallel'], value: [...step.parallel, { agent: free }] }]); }}>
                  <IconPlus /> Add member to this step
                </button>
              </div>
              <span className="tiny faint">A member whose task selects nothing is skipped for that run.</span>
            </div>
          )}

          {!step.summary && (
            <>
              <label className="field">
                Extra instructions (optional)
                <TextField multiline value={step.instructions} placeholder="Anything this step should do beyond the member's role" onCommit={(v) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'instructions'], value: v || null }])} />
              </label>

              <div className="grid grid-2">
                <label className="field">
                  Gate (optional)
                  <TextField mono value={step.gate} placeholder={`e.g. ${step.id}.blocking_count = 0`} onCommit={(v) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'gate'], value: v || null }])} />
                  <span className="help">Must be true to continue. Reads the step's structured report, e.g. review.blocking_count = 0 or test.failed = 0.</span>
                </label>
                {step.gate && (
                  <div className="field">
                    When the gate fails
                    <div className="seg">
                      <button className={!step.on_gate_fail ? 'on' : ''} onClick={() => void edit([{ op: 'delete', path: ['workflow', 'steps', i, 'on_gate_fail'] }])}>
                        Team default
                      </button>
                      <button className={step.on_gate_fail ? 'on' : ''} onClick={() => !step.on_gate_fail && void edit([{ op: 'set', path: ['workflow', 'steps', i, 'on_gate_fail'], value: { goto: steps[0]?.id, max_loops: 2, then: 'escalate_to_human' } }])}>
                        Custom
                      </button>
                    </div>
                    {step.on_gate_fail ? (
                      <PolicyFields policy={step.on_gate_fail} steps={steps.slice(0, i + 1).map((s) => s.id)} onChange={(v) => void edit([{ op: 'set', path: ['workflow', 'steps', i, 'on_gate_fail'], value: v }])} />
                    ) : (
                      <span className="help">{policy ? `Back to ${policy.goto}, up to ${policy.max_loops} rounds.` : 'No team default: the run stops.'}</span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <div className="card card-pad form" style={{ maxWidth: 'none', marginTop: 14 }}>
        <h2>Fix loop (team default)</h2>
        <p className="small muted">What happens when a gate fails. The findings you choose are sent back, the team works again, and after the last round the run comes back to you.</p>
        {policy ? (
          <>
            <PolicyFields policy={policy} steps={steps.map((s) => s.id)} onChange={(v) => void edit([{ op: 'set', path: ['workflow', 'on_gate_fail'], value: v }])} />
            <div>
              <button className="btn sm ghost danger" onClick={() => void edit([{ op: 'delete', path: ['workflow', 'on_gate_fail'] }])}>
                Remove the fix loop
              </button>
            </div>
          </>
        ) : (
          <div>
            <button className="btn" onClick={() => void edit([{ op: 'set', path: ['workflow', 'on_gate_fail'], value: { goto: steps[0]?.id, max_loops: 2, feed: [], then: 'escalate_to_human' } }])}>
              <IconLoop /> Add a fix loop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

type DragItem = { kind: 'step'; index: number } | { kind: 'member'; name: string } | { kind: 'loop'; index: number };
const DRAG_TYPE = 'application/x-covibe';

/**
 * The workflow as an editable graph. Drag a step to reorder it; drag a member
 * onto a step to add it in parallel, or into a gap to make a new step; drag a
 * gated step's loop handle onto an earlier step to choose where failed work
 * goes back to. Every change is a comment-preserving edit of team.yaml.
 */
/** Who writes a summary step: covibe from the run's record (no model), or a model of the team's choice. */
function SummaryStepFields({ step, path, teamBackend, edit }: { step: Doc; path: (string | number)[]; teamBackend: Doc | undefined; edit: Edit }) {
  const at = (k: string) => [...path, k];
  // A provider's model lives in the step's backend; a Claude model in `model` (it runs on the team's login).
  const own = providerOf(step.backend);
  const withModel = !!step.model || !!own;
  return (
    <div className="col">
      <ModelPicker
        compact
        noModel="None: covibe writes it, no model"
        inherit="Team default"
        value={{ model: step.model, effort: step.effort }}
        provider={own}
        onProvider={(c) => void edit([{ op: 'set', path: at('backend'), value: providerBackend(c) }, { op: 'set', path: at('model'), value: null }])}
        onChange={(k, v) => {
          const ops: EditOp[] = [{ op: 'set', path: at(k), value: v }];
          if (k === 'model') {
            // A Claude model, or none: the step leaves the provider it had (and, with no model, what only a model uses).
            if (own) ops.push({ op: 'set', path: at('backend'), value: v !== null && providerOf(teamBackend) ? { type: 'subscription' } : null });
            if (v === null) ops.push({ op: 'set', path: at('effort'), value: null }, { op: 'set', path: at('instructions'), value: null });
          }
          void edit(ops);
        }}
      />
      {withModel ? (
        <>
          <p className="small muted">
            covibe gathers the facts (the plan, the todo list, every step's report, the files changed, the checks, the questions answered) and this model writes them up in one request, with no tools and without anyone's session. If it fails, covibe's own summary is used.
          </p>
          <label className="field">
            How to write it (optional)
            <TextField multiline value={step.instructions} placeholder="e.g. Write it as release notes for the team, in German." onCommit={(v) => void edit([{ op: 'set', path: at('instructions'), value: v || null }])} />
          </label>
        </>
      ) : (
        <p className="small muted">
          covibe writes the run's summary from what the run already has: the plan, the todo list, every step's report, the files changed, the checks, and the questions answered on the way. No model, so it costs nothing. Pick a model above to have it written up in prose.
        </p>
      )}
    </div>
  );
}

function WorkflowGraph({
  steps,
  agents,
  policy,
  selected,
  onSelect,
  edit,
  freeId,
}: {
  steps: Doc[];
  agents: string[];
  policy: Doc | undefined;
  selected: number;
  onSelect: (i: number) => void;
  edit: Edit;
  freeId: (base: string) => string;
}) {
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const [boxes, setBoxes] = useState<{ x: number; y: number; w: number; h: number }[]>([]);
  const index = (n: string) => agents.indexOf(n);
  const membersOf = (s: Doc): string[] => (Array.isArray(s.parallel) ? s.parallel.map((b: Doc) => b.agent) : s.agent ? [s.agent] : []);
  const failOf = (s: Doc): Doc | undefined => s.on_gate_fail ?? (s.gate ? policy : undefined);

  // Measure cards to draw loop-back arrows under them.
  useLayoutEffect(() => {
    const measure = () => {
      const base = wrap.current?.getBoundingClientRect();
      if (!base) return;
      setBoxes(
        cards.current.slice(0, steps.length).map((el) => {
          const r = el?.getBoundingClientRect();
          return r ? { x: r.left - base.left + (wrap.current?.scrollLeft ?? 0), y: r.top - base.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    for (const el of cards.current) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [steps]);

  const start = (item: DragItem) => (e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'move';
    setDrag(item);
  };
  const end = () => {
    setDrag(null);
    setOver(null);
  };
  const read = (e: React.DragEvent): DragItem | null => {
    try {
      return drag ?? (JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragItem);
    } catch {
      return null;
    }
  };

  // What a drop on a gap or a card would do (null = not allowed), shared by dragover and drop.
  const gapAction = (item: DragItem | null, k: number): EditOp[] | null => {
    if (!item) return null;
    if (item.kind === 'step') {
      const to = k > item.index ? k - 1 : k;
      return to === item.index ? null : [{ op: 'move', path: ['workflow', 'steps'], from: item.index, to }];
    }
    if (item.kind === 'member') return [{ op: 'insert', path: ['workflow', 'steps'], index: k, value: { id: freeId(item.name), agent: item.name } }];
    return null;
  };
  const cardAction = (item: DragItem | null, k: number): EditOp[] | null => {
    if (!item) return null;
    const s = steps[k]!;
    if (item.kind === 'member') {
      // covibe writes a summary step itself: no members to drop there.
      if (s.summary || membersOf(s).includes(item.name)) return null;
      if (Array.isArray(s.parallel)) return [{ op: 'insert', path: ['workflow', 'steps', k, 'parallel'], value: { agent: item.name } }];
      const first = { agent: s.agent, ...(s.task ? { task: s.task } : {}) };
      return [{ op: 'set', path: ['workflow', 'steps', k], value: { ...withoutKeys(s, ['agent', 'task', 'output_schema']), parallel: [first, { agent: item.name }] } }];
    }
    if (item.kind === 'loop') {
      if (k > item.index) return null; // loops only go back
      const from = steps[item.index]!;
      const current = failOf(from) ?? {};
      return [{ op: 'set', path: ['workflow', 'steps', item.index, 'on_gate_fail'], value: { goto: s.id, max_loops: current.max_loops ?? 2, ...(current.feed ? { feed: current.feed } : {}), then: current.then ?? 'escalate_to_human' } }];
    }
    return null;
  };
  const target = (key: string, action: (item: DragItem | null) => EditOp[] | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!action(drag)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== key) setOver(key);
    },
    onDragLeave: () => over === key && setOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const ops = action(read(e));
      end();
      if (ops) void edit(ops);
    },
  });
  const removeMember = (k: number, name: string) => {
    const s = steps[k]!;
    const left = (s.parallel as Doc[]).filter((b) => b.agent !== name);
    if (left.length === 1) void edit([{ op: 'set', path: ['workflow', 'steps', k], value: { ...withoutKeys(s, ['parallel']), agent: left[0]!.agent, ...(left[0]!.task ? { task: left[0]!.task } : {}) } }]);
    else void edit([{ op: 'delete', path: ['workflow', 'steps', k, 'parallel', (s.parallel as Doc[]).findIndex((b) => b.agent === name)] }]);
  };

  // Loop-back arcs: from a gated step under the cards back to its target.
  const arcs = steps
    .map((s, k) => {
      const f = failOf(s);
      const t = f ? steps.findIndex((x) => x.id === f.goto) : -1;
      return f && s.gate && t >= 0 && t <= k && boxes[k] && boxes[t] ? { k, t, f } : null;
    })
    .filter((a): a is { k: number; t: number; f: Doc } => !!a);
  const bottom = Math.max(0, ...boxes.map((b) => b.y + b.h));
  const height = bottom + 34 + arcs.length * 32;

  const gap = (k: number) => (
    <div key={`gap${k}`} className={`flow-gap ${drag && gapAction(drag, k) ? 'can' : ''} ${over === `gap${k}` ? 'over' : ''}`} {...target(`gap${k}`, (it) => gapAction(it, k))} aria-label={`Drop here to place at position ${k + 1}`}>
      <div className="flow-arrow" />
    </div>
  );

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="tiny faint">Drag a member onto a step to work in parallel, or between steps to add a step:</span>
        {agents.map((a) => (
          <span key={a} className="chip" draggable onDragStart={start({ kind: 'member', name: a })} onDragEnd={end} title={`Drag ${a}`} style={{ cursor: 'grab' }}>
            <Avatar name={a} index={index(a)} size="sm" /> {a}
          </span>
        ))}
      </div>
      <div
        className="flow"
        ref={wrap}
        style={{ minHeight: height + 8 }}
        onDragOver={(e) => {
          // Scroll the graph while dragging near its edges, so far-apart steps can be connected.
          const el = wrap.current;
          if (!el || !drag) return;
          const r = el.getBoundingClientRect();
          if (e.clientX < r.left + 60) el.scrollLeft -= 18;
          else if (e.clientX > r.right - 60) el.scrollLeft += 18;
        }}
      >
        {gap(0)}
        {steps.map((s, k) => {
          const parallel = Array.isArray(s.parallel);
          const who = membersOf(s);
          const loopTarget = drag?.kind === 'loop' && k <= drag.index;
          return [
            <div
              key={`card${k}`}
              ref={(el) => {
                cards.current[k] = el;
              }}
              className={`pipe-card ${k === selected ? 'on' : ''} ${over === `card${k}` ? 'drop-over' : ''} ${loopTarget ? 'loop-target' : ''} ${drag?.kind === 'step' && drag.index === k ? 'dragging' : ''}`}
              draggable
              onDragStart={start({ kind: 'step', index: k })}
              onDragEnd={end}
              onClick={() => onSelect(k)}
              {...target(`card${k}`, (it) => cardAction(it, k))}
              data-step={s.id}
            >
              <span className="kind">{parallel ? 'In parallel' : s.summary ? 'Summary' : 'Step'}</span>
              <strong>{s.id}</strong>
              <div className="agents">
                {who.length ? (
                  who.map((a) => (
                    <span key={a} className="agent-line">
                      <Avatar name={a} index={index(a)} size="sm" /> <span className="grow">{a}</span>
                      {parallel && (
                        <button className="x" title={`Remove ${a} from this step`} onClick={(e) => (e.stopPropagation(), removeMember(k, a))}>
                          ×
                        </button>
                      )}
                    </span>
                  ))
                ) : s.summary ? (
                  <span className="tiny faint">{s.model || s.backend?.model ? `Written up by ${s.model ?? s.backend.model}` : 'Written by covibe, no model'}</span>
                ) : (
                  <span className="tiny faint">Drop a member here</span>
                )}
              </div>
              {s.gate && <span className="gate" title={s.gate}>✓ {s.gate}</span>}
              {s.gate && (
                <span
                  className="loop-handle"
                  draggable
                  onDragStart={start({ kind: 'loop', index: k })}
                  onDragEnd={end}
                  title="Drag onto an earlier step: where work goes back to when this gate fails"
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconLoop />
                </span>
              )}
            </div>,
            gap(k + 1),
          ];
        })}
        <button className="btn flow-add" onClick={() => (void edit([{ op: 'insert', path: ['workflow', 'steps'], value: { id: freeId('step'), agent: agents[0] } }]), onSelect(steps.length))}>
          <IconPlus /> Add step
        </button>
        <svg className="flow-arcs" width="100%" height={height} aria-hidden>
          <defs>
            <marker id="loop-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--warn)" />
            </marker>
          </defs>
          {arcs.map(({ k, t, f }, n) => {
            const a = boxes[k]!;
            const b = boxes[t]!;
            const x1 = a.x + a.w / 2 + (k === t ? 18 : 0);
            const x2 = b.x + b.w / 2 - (k === t ? 18 : 0);
            const y0 = Math.max(a.y + a.h, b.y + b.h);
            const depth = y0 + 22 + n * 32;
            return (
              <g key={`${k}-${t}`}>
                <path d={`M${x1},${a.y + a.h} C${x1},${depth} ${x2},${depth} ${x2},${b.y + b.h + 4}`} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="5 4" markerEnd="url(#loop-arrow)" />
                {/* Label beside where the arc leaves its own step, so labels of arcs to the same target never collide. */}
                <text x={x1 + 6} y={a.y + a.h + 14} className="arc-label">
                  ↺ back to {steps[t]!.id}, up to {f.max_loops}×
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function withoutKeys(o: Doc, keys: string[]): Doc {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
}

function PolicyFields({ policy, steps, onChange }: { policy: Doc; steps: string[]; onChange: (v: Doc) => void }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="grid grid-3" style={{ gap: 8 }}>
        <label className="field">
          Go back to
          <select className="input" value={policy.goto ?? ''} onChange={(e) => onChange({ ...policy, goto: e.target.value })}>
            {steps.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Fix rounds
          <TextField type="number" value={policy.max_loops} onCommit={(v) => onChange({ ...policy, max_loops: Math.max(0, Math.min(20, Number(v) || 0)) })} />
        </label>
        <label className="field">
          After the last round
          <select className="input" value={policy.then ?? 'escalate_to_human'} onChange={(e) => onChange({ ...policy, then: e.target.value })}>
            <option value="escalate_to_human">Ask me</option>
            <option value="fail">Stop the run</option>
          </select>
        </label>
      </div>
      <label className="field">
        Feedback to send back
        <ChipsInput values={Array.isArray(policy.feed) ? policy.feed : []} placeholder="e.g. review.findings, then Enter" onChange={(v) => onChange({ ...policy, feed: v })} />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- team settings

function TeamSettings({ doc, edit }: { doc: Doc; edit: Edit }) {
  const d: Doc = doc.defaults ?? {};
  return (
    <div className="split-main">
      <div className="form">
        <div className="grid grid-2">
          <label className="field">
            Team name
            <TextField mono value={doc.name} onCommit={(v) => void edit([{ op: 'set', path: ['name'], value: v }])} />
            <span className="help">Lowercase letters, digits, - and _.</span>
          </label>
        </div>
        <section className="form-section">
          <h3>Model and thinking for every member</h3>
          <ModelPicker
            value={{ model: d.model, effort: d.effort, thinking: d.thinking }}
            inherit="Claude Code default"
            provider={providerOf(d.backend)}
            onProvider={(c) => void edit([{ op: 'set', path: ['defaults', 'backend'], value: providerBackend(c) }])}
            onChange={(k, v) => {
              const ops: EditOp[] = [{ op: 'set', path: ['defaults', k], value: v }];
              if (k === 'model' && providerOf(d.backend)) ops.push({ op: 'set', path: ['defaults', 'backend'], value: null });
              void edit(ops);
            }}
          />
          <span className="tiny faint">Members can override these under Members.</span>
        </section>
        <label className="field">
          Description
          <TextField value={doc.description} onCommit={(v) => void edit([{ op: 'set', path: ['description'], value: v || null }])} />
        </label>
        <section className="form-section">
          <h3>Connection for every member</h3>
          <BackendFields backend={d.backend ?? { type: 'subscription' }} onChange={(v) => void edit([{ op: 'set', path: ['defaults', 'backend'], value: v }])} />
          <CacheTtlField value={d.cache_ttl} inherit="Automatic: 1 hour on your subscription, 5 minutes on an API key" onChange={(v) => void edit([{ op: 'set', path: ['defaults', 'cache_ttl'], value: v }])} />
        </section>
        <section className="form-section">
          <h3>Where members work</h3>
          <div className="seg">
            <button className={(d.isolation ?? 'worktree') === 'worktree' ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: ['defaults', 'isolation'], value: 'worktree' }])}>
              Separate branches (recommended)
            </button>
            <button className={d.isolation === 'none' ? 'on' : ''} onClick={() => void edit([{ op: 'set', path: ['defaults', 'isolation'], value: 'none' }])}>
              Directly in my checkout
            </button>
          </div>
          <span className="tiny faint">
            {d.isolation === 'none'
              ? 'Members change your working copy directly. Only use this for read-only teams: shell commands are not limited to allowed paths in this mode.'
              : 'Each member that writes code gets its own git worktree; covibe merges their work into a branch per run. Your checkout is never touched.'}{' '}
            In a plain folder (a project without git), members always work in the folder itself; covibe records what each one changes so you can undo the run.
          </span>
        </section>
        <section className="form-section">
          <h3>Browser</h3>
          <label className="check">
            <input type="checkbox" checked={d.browser === true} onChange={(e) => void edit([{ op: 'set', path: ['defaults', 'browser'], value: e.target.checked ? true : null }])} />
            Give every member covibe's browser (members can still turn it off)
          </label>
        </section>
        <section className="form-section">
          <h3>Skills for every member</h3>
          <SkillPicker value={Array.isArray(d.skills) ? d.skills : []} onChange={(v) => void edit([{ op: 'set', path: ['defaults', 'skills'], value: v.length ? v : null }])} />
        </section>
        <section className="form-section">
          <h3>Plugins for every member</h3>
          <PluginPicker value={Array.isArray(d.plugins) ? d.plugins : []} onChange={(v) => void edit([{ op: 'set', path: ['defaults', 'plugins'], value: v.length ? v : null }])} />
        </section>
        <section className="form-section">
          <h3>Project brain</h3>
          <div className="row wrap">
            <label className="field" style={{ minWidth: 220 }}>
              Curator
              <select className="input" value={doc.brain?.curator ?? ''} onChange={(e) => void edit([{ op: 'set', path: ['brain'], value: e.target.value ? { ...doc.brain, curator: e.target.value } : null }])}>
                <option value="">Nobody: I review proposals myself</option>
                {Object.keys(doc.agents ?? {}).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            {doc.brain?.curator && (
              <label className="field" style={{ minWidth: 220 }}>
                When it reviews proposals
                <select
                  className="input"
                  value={doc.brain?.curate === 'manual' ? 'manual' : (doc.brain?.min_proposals ?? 1) > 1 ? 'batch' : 'after_run'}
                  onChange={(e) => {
                    const v = e.target.value;
                    const { curate: _c, min_proposals: _m, ...rest } = doc.brain ?? {};
                    void edit([{ op: 'set', path: ['brain'], value: { ...rest, ...(v === 'manual' ? { curate: 'manual' } : v === 'batch' ? { curate: 'after_run', min_proposals: BATCH_PROPOSALS } : {}) } }]);
                  }}
                >
                  <option value="after_run">After every run with new proposals</option>
                  <option value="batch">After a run, once {BATCH_PROPOSALS} or more are waiting</option>
                  <option value="manual">Only when I ask</option>
                </select>
                <span className="help">Each review is a session of its own; batching proposals saves tokens.</span>
              </label>
            )}
          </div>
          <span className="tiny faint">
            Every member reads the project's brain (shared notes) and can propose additions. Only the curator edits the notes; it needs the Write or Edit tool.
          </span>
        </section>
        <section className="form-section">
          <h3>Sandbox for shell commands</h3>
          <SandboxFields sandbox={d.sandbox} onChange={(v) => void edit([{ op: 'set', path: ['defaults', 'sandbox'], value: v }])} />
        </section>
        <section className="form-section">
          <h3>Limits</h3>
          <div className="grid grid-3" style={{ gap: 8 }}>
            <label className="field">
              Members at once
              <TextField type="number" value={d.max_parallel ?? 2} onCommit={(v) => void edit([{ op: 'set', path: ['defaults', 'max_parallel'], value: num(v) }])} />
              <span className="help">2–3 keeps subscription limits in check.</span>
            </label>
            <label className="field">
              Max turns per step
              <TextField type="number" value={d.limits?.max_turns ?? 40} onCommit={(v) => void edit([{ op: 'set', path: ['defaults', 'limits', 'max_turns'], value: num(v) }])} />
            </label>
            <label className="field">
              Timeout per step (min)
              <TextField type="number" value={d.limits?.timeout_min ?? 30} onCommit={(v) => void edit([{ op: 'set', path: ['defaults', 'limits', 'timeout_min'], value: num(v) }])} />
            </label>
          </div>
          <label className="field" style={{ maxWidth: 240 }}>
            Budget per step (USD, API key only)
            <TextField type="number" value={d.limits?.max_budget_usd} placeholder="no limit" onCommit={(v) => void edit([{ op: 'set', path: ['defaults', 'limits', 'max_budget_usd'], value: num(v) }])} />
          </label>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- YAML

function YamlTab({ teamId, team, onSaved }: { teamId: string; team: TeamDetail; onSaved: () => void }) {
  const toast = useToast();
  const { refresh } = useData();
  const [text, setText] = useState(team.yaml);
  const [problems, setProblems] = useState(team.problems);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setText(team.yaml);
  }, [team.yaml]);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      post<{ problems: string[] }>(`/api/teams/${teamId}/validate`, { yaml: text })
        .then((r) => setProblems(r.problems))
        .catch(() => undefined);
    }, 350);
  }, [text, teamId]);
  const dirty = text !== team.yaml;
  const save = async () => {
    try {
      await put(`/api/teams/${teamId}/file`, { path: 'team.yaml', content: text });
      toast(problems.length ? 'Saved, with problems' : 'Saved');
      onSaved();
      void refresh();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, gap: 10, minHeight: 0 }}>
      <div className="row">
        <span className="small muted grow">
          The whole team as one file. Comments and formatting are kept when you edit with the forms. Checked as you type.
        </span>
        <button className="btn" disabled={!dirty} onClick={() => setText(team.yaml)}>
          Revert
        </button>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
          Save <span className="kbd" style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}>⌘S</span>
        </button>
      </div>
      <div className="cm-wrap fill">
        <CodeEditor value={text} onChange={setText} language="yaml" onSave={() => void save()} />
      </div>
      {problems.length ? (
        <div className="banner bad">
          <IconAlert />
          <div className="problems">
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="banner good small">
          <IconCheck /> Valid
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- files

function Files({ teamId, team, onChange }: { teamId: string; team: TeamDetail; onChange: () => void }) {
  const toast = useToast();
  const files = team.files.filter((f) => f.path !== 'team.yaml');
  const [sel, setSel] = useState<string | undefined>(files[0]?.path);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [newName, setNewName] = useState<string | null>(null);

  useEffect(() => {
    if (!sel) return;
    let cancel = false;
    setText(null);
    get<{ content: string }>(`/api/teams/${teamId}/file?path=${encodeURIComponent(sel)}`)
      .then((r) => !cancel && (setText(r.content), setSaved(r.content)))
      .catch((e) => toast((e as Error).message, true));
    return () => {
      cancel = true;
    };
  }, [sel, teamId, toast]);

  const save = async () => {
    if (!sel || text === null) return;
    try {
      await put(`/api/teams/${teamId}/file`, { path: sel, content: text });
      setSaved(text);
      onChange();
      toast('Saved');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  const lang = useMemo(() => (sel?.endsWith('.md') ? 'markdown' : sel?.endsWith('.json') || sel?.endsWith('.yaml') ? 'json' : 'text'), [sel]);

  return (
    <div className="split">
      <div className="split-list">
        {files.map((f) => (
          <div key={f.path} className={`list-row clickable ${f.path === sel ? 'selected' : ''}`} style={{ borderRadius: 8, border: 0, padding: '6px 10px' }} onClick={() => setSel(f.path)}>
            <IconFile width={14} height={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
            <span className="mono ellipsis grow">{f.path}</span>
          </div>
        ))}
        {newName === null ? (
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setNewName('prompts/')}>
            <IconPlus /> New file
          </button>
        ) : (
          <div className="col" style={{ marginTop: 8 }}>
            <input
              className="input mono"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Escape') setNewName(null);
                if (e.key === 'Enter' && newName.trim()) {
                  try {
                    await put(`/api/teams/${teamId}/file`, { path: newName.trim(), content: newName.endsWith('.json') ? '{\n  "type": "object",\n  "properties": {}\n}\n' : '' });
                    onChange();
                    setSel(newName.trim());
                    setNewName(null);
                  } catch (err) {
                    toast((err as Error).message, true);
                  }
                }
              }}
            />
            <span className="tiny faint">.md for prompts, .json for report schemas. Enter to create.</span>
          </div>
        )}
      </div>
      <div className="split-main" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sel && text !== null ? (
          <>
            <div className="row">
              <span className="mono grow">{sel}</span>
              <button
                className="btn sm ghost danger"
                onClick={async () => {
                  try {
                    await del(`/api/teams/${teamId}/file?path=${encodeURIComponent(sel)}`);
                    setSel(undefined);
                    onChange();
                  } catch (err) {
                    toast((err as Error).message, true);
                  }
                }}
              >
                <IconTrash /> Delete
              </button>
              <button className="btn sm primary" disabled={text === saved} onClick={() => void save()}>
                Save
              </button>
            </div>
            <div className="cm-wrap">
              <CodeEditor value={text} onChange={setText} language={lang} onSave={() => void save()} minHeight={420} />
            </div>
          </>
        ) : (
          <Empty icon={<IconFile />} title="Prompts and report schemas">Pick a file on the left.</Empty>
        )}
      </div>
    </div>
  );
}
