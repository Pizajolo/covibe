import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { del, get, post, put, type EditOp, type TeamDetail, type TeamListing } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import { Composer } from '../components/Composer';
import { IconAlert, IconArrowLeft, IconArrowRight, IconCheck, IconCode, IconCopy, IconFile, IconFlow, IconGear, IconLoop, IconPlay, IconPlus, IconTeam, IconTrash } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { Avatar, Empty, Modal, useAction, useToast } from '../components/ui';
import { go, href, useData, useLive } from '../data';

type Doc = Record<string, any>;
type Edit = (ops: EditOp[]) => Promise<void>;
type Tab = 'members' | 'workflow' | 'yaml' | 'files' | 'settings';

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
const MODELS = ['opus', 'sonnet', 'haiku'];

export function TeamEditor({ teamId, tab: tabParam }: { teamId: string; tab?: string }) {
  const { refresh } = useData();
  const toast = useToast();
  const { value: team, error, setValue, reload } = useLive(() => get<TeamDetail>(`/api/teams/${teamId}`), [teamId]);
  const [goal, setGoal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tab: Tab = (['members', 'workflow', 'yaml', 'files', 'settings'].includes(tabParam ?? '') ? tabParam : 'members') as Tab;

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
        {tab === 'members' && <Members teamId={teamId} doc={doc} edit={edit} files={team.files.map((f) => f.path)} onFiles={reload} />}
        {tab === 'workflow' && <Workflow doc={doc} edit={edit} />}
        {tab === 'settings' && <TeamSettings doc={doc} edit={edit} />}
        {tab === 'yaml' && <YamlTab teamId={teamId} team={team} onSaved={reload} />}
        {tab === 'files' && <Files teamId={teamId} team={team} onChange={reload} />}
      </div>

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

function ChipsInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [v, setV] = useState('');
  const add = () => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setV('');
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="chips">
        {values.map((x) => (
          <span key={x} className="chip mono">
            {x}
            <button aria-label={`Remove ${x}`} onClick={() => onChange(values.filter((y) => y !== x))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input className="input mono" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} onBlur={add} />
    </div>
  );
}

const num = (s: string) => (s.trim() === '' ? null : Number(s));

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
          <MemberForm key={current} teamId={teamId} name={current} index={names.indexOf(current)} agent={agents[current]!} names={names} edit={edit} files={files} onFiles={onFiles} onDeleted={() => setSelected(undefined)} />
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
  return `${a.model ?? 'default model'} · ${writes ? (a.scope?.write ? `writes ${a.scope.write.join(', ') || 'nothing'}` : 'writes anywhere') : 'read-only'}`;
}

function MemberForm({ teamId, name, index, agent, names, edit, files, onFiles, onDeleted }: { teamId: string; name: string; index: number; agent: Doc; names: string[]; edit: Edit; files: string[]; onFiles: () => void; onDeleted: () => void }) {
  const p = (...k: (string | number)[]) => ['agents', name, ...k];
  const tools: string[] = Array.isArray(agent.tools) ? agent.tools : [];
  const writes = tools.some((t) => WRITE_TOOLS.has(t));
  const scope: string[] | undefined = Array.isArray(agent.scope?.write) ? agent.scope.write : undefined;
  const scopeMode = scope === undefined ? 'anything' : scope.length ? 'paths' : 'nothing';
  const schemas = files.filter((f) => f.endsWith('.json') && f !== 'team.yaml');
  const backend: Doc | undefined = agent.backend;
  const [confirm, setConfirm] = useState(false);
  const customModel = agent.model && !MODELS.includes(agent.model);

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

      <div className="grid grid-2">
        <section className="form-section">
          <h3>Model</h3>
          <select
            className="input"
            value={customModel ? '__custom' : (agent.model ?? '')}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__custom') void edit([{ op: 'set', path: p('model'), value: 'claude-sonnet-5-5' }]);
              else void edit([{ op: 'set', path: p('model'), value: v || null }]);
            }}
          >
            <option value="">Team default</option>
            <option value="opus">Opus — strongest, for planning and hard problems</option>
            <option value="sonnet">Sonnet — balanced, good for building</option>
            <option value="haiku">Haiku — fast and cheap, for simple checks</option>
            <option value="__custom">Custom model id…</option>
          </select>
          {customModel && <TextField mono value={agent.model} onCommit={(v) => void edit([{ op: 'set', path: p('model'), value: v || null }])} />}
        </section>
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

      <div className="grid grid-2">
        <section className="form-section">
          <h3>Connection</h3>
          <BackendFields backend={backend} allowDefault onChange={(v) => void edit([{ op: 'set', path: p('backend'), value: v }])} />
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

function BackendFields({ backend, onChange, allowDefault }: { backend: Doc | undefined; onChange: (v: Doc | null) => void; allowDefault?: boolean }) {
  const type = backend?.type ?? '';
  return (
    <div className="col" style={{ gap: 8 }}>
      <select className="input" value={type} onChange={(e) => onChange(e.target.value ? { type: e.target.value } : null)}>
        {allowDefault && <option value="">Team default</option>}
        <option value="subscription">Claude subscription (claude login)</option>
        <option value="api_key">API key</option>
        <option value="gateway">Gateway (LiteLLM / proxy)</option>
        <option value="bedrock">Amazon Bedrock</option>
        <option value="vertex">Google Vertex AI</option>
      </select>
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
  const setSteps = (next: Doc[]) => void edit([{ op: 'set', path: ['workflow', 'steps'], value: next }]);
  const freeId = (base: string) => {
    let id = base;
    for (let n = 2; steps.some((s) => s.id === id); n++) id = `${base}-${n}`;
    return id;
  };
  const index = (n: string) => agents.indexOf(n);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 20px 24px' }}>
      <div className="pipeline">
        {steps.map((s, k) => {
          const parallel = Array.isArray(s.parallel);
          const who: string[] = parallel ? s.parallel.map((b: Doc) => b.agent) : [s.agent];
          const fail = s.on_gate_fail ?? (s.gate ? policy : undefined);
          return (
            <div className="pipe-step" key={k}>
              {k > 0 && <div className="pipe-arrow" />}
              <div className={`pipe-card ${k === i ? 'on' : ''}`} onClick={() => setSel(k)}>
                <span className="kind">{parallel ? 'In parallel' : 'Step'}</span>
                <strong>{s.id}</strong>
                <div className="agents">
                  {who.map((a) => (
                    <span key={a} className="agent-line">
                      <Avatar name={a ?? '?'} index={index(a)} size="sm" /> {a ?? 'no member'}
                    </span>
                  ))}
                </div>
                {s.gate && <span className="gate">✓ {s.gate}</span>}
                {s.gate && fail && (
                  <span className="loop-note">
                    <IconLoop /> on fail: back to {fail.goto}, up to {fail.max_loops}×
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="pipe-step">
          {steps.length > 0 && <div className="pipe-arrow" />}
          <button className="btn" onClick={() => (setSteps([...steps, { id: freeId('step'), agent: agents[0] }]), setSel(steps.length))}>
            <IconPlus /> Add step
          </button>
        </div>
      </div>

      {step && (
        <div className="card card-pad form" style={{ maxWidth: 'none', marginTop: 8 }}>
          <div className="row">
            <h2 className="grow">Step “{step.id}”</h2>
            <button className="btn sm ghost icon-btn" title="Move earlier" disabled={i === 0} onClick={() => { const n = [...steps]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; setSteps(n); setSel(i - 1); }}>
              <IconArrowLeft />
            </button>
            <button className="btn sm ghost icon-btn" title="Move later" disabled={i === steps.length - 1} onClick={() => { const n = [...steps]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; setSteps(n); setSel(i + 1); }}>
              <IconArrowRight />
            </button>
            <button className="btn sm ghost danger" onClick={() => (setSteps(steps.filter((_, k) => k !== i)), setSel(Math.max(0, i - 1)))}>
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
                <button className={!Array.isArray(step.parallel) ? 'on' : ''} onClick={() => Array.isArray(step.parallel) && setSteps(steps.map((s, k) => (k === i ? { ...withoutKeys(s, ['parallel']), agent: s.parallel[0]?.agent ?? agents[0] } : s)))}>
                  One member
                </button>
                <button className={Array.isArray(step.parallel) ? 'on' : ''} onClick={() => !Array.isArray(step.parallel) && setSteps(steps.map((s, k) => (k === i ? { ...withoutKeys(s, ['agent', 'task', 'output_schema']), parallel: [{ agent: s.agent ?? agents[0] }] } : s)))}>
                  Several in parallel
                </button>
              </div>
            </label>
          </div>

          {!Array.isArray(step.parallel) ? (
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
          <label className="field">
            Default model
            <select className="input" value={d.model ?? ''} onChange={(e) => void edit([{ op: 'set', path: ['defaults', 'model'], value: e.target.value || null }])}>
              <option value="">Claude Code default</option>
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Description
          <TextField value={doc.description} onCommit={(v) => void edit([{ op: 'set', path: ['description'], value: v || null }])} />
        </label>
        <section className="form-section">
          <h3>Connection for every member</h3>
          <BackendFields backend={d.backend ?? { type: 'subscription' }} onChange={(v) => void edit([{ op: 'set', path: ['defaults', 'backend'], value: v }])} />
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
              : 'Each member that writes code gets its own git worktree; covibe merges their work into a branch per run. Your checkout is never touched.'}
          </span>
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
