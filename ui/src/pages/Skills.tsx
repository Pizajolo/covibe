import { useEffect, useState } from 'react';
import { del, get, post, put } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import { IconAlert, IconCheck, IconFile, IconPlus, IconSparkle, IconTrash } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Toolbar } from '../components/Toolbar';
import { Empty, Modal, useAction, useToast } from '../components/ui';
import { go, useLive } from '../data';
import { ago } from '../format';

export interface SkillRow {
  name: string;
  description: string;
  source?: 'manual' | 'github';
  origin?: { repo: string; ref?: string; path: string; commit?: string };
  everyone?: boolean;
  files?: number;
  updatedAt?: string;
  usedBy: { team: string; agent: string }[];
}

export interface SkillsResponse {
  library: SkillRow[];
  builtin: SkillRow[];
}

interface Candidate {
  path: string;
  name: string;
  description: string;
  installed: boolean;
}

type Tab = 'library' | 'anthropic' | 'builtin';

export function Skills({ tab: tabParam, name }: { tab?: string; name?: string }) {
  const tab: Tab = tabParam === 'anthropic' || tabParam === 'builtin' ? tabParam : 'library';
  const { value, reload } = useLive(() => get<SkillsResponse>('/api/skills'), []);
  const [adding, setAdding] = useState<null | 'write' | 'github'>(null);

  if (name) return <SkillEditor name={name} onChanged={reload} />;
  return (
    <>
      <Toolbar title="Skills" sub="Instructions and tools Claude loads when a task needs them. Give them to team members.">
        <button className="btn" onClick={() => setAdding('github')}>
          Add from GitHub
        </button>
        <button className="btn primary" onClick={() => setAdding('write')}>
          <IconPlus /> Write a skill
        </button>
      </Toolbar>
      <nav className="tabs">
        {(
          [
            ['library', `Your library${value ? ` (${value.library.length})` : ''}`],
            ['anthropic', 'Anthropic skills'],
            ['builtin', `Built into Claude Code${value ? ` (${value.builtin.length})` : ''}`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => go('skills', id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="content">
        <div className="page">
          {tab === 'library' && <Library skills={value?.library} onChanged={reload} onAdd={() => setAdding('write')} />}
          {tab === 'anthropic' && <Catalog onInstalled={reload} />}
          {tab === 'builtin' && <Builtin skills={value?.builtin} />}
        </div>
      </div>
      {adding === 'write' && <WriteSkill onClose={() => setAdding(null)} onCreated={(n) => (reload(), go('skills', 'library', n))} />}
      {adding === 'github' && <FromGithub onClose={() => setAdding(null)} onInstalled={() => (reload(), go('skills', 'library'))} />}
    </>
  );
}

function SourceBadge({ s }: { s: SkillRow }) {
  if (s.source === 'github' && s.origin) return <span className="pill info" title={`${s.origin.repo}/${s.origin.path}`}>GitHub · {s.origin.repo}</span>;
  return <span className="pill">Written by you</span>;
}

function UsedBy({ used = [] }: { used?: SkillRow['usedBy'] }) {
  if (!used.length) return <span className="tiny faint">Not given to anyone yet</span>;
  return (
    <span className="tiny faint" title={used.map((u) => `${u.team}/${u.agent}`).join(', ')}>
      Used by {used.slice(0, 3).map((u) => `${u.agent} (${u.team})`).join(', ')}
      {used.length > 3 ? ` +${used.length - 3}` : ''}
    </span>
  );
}

function Library({ skills, onChanged, onAdd }: { skills?: SkillRow[]; onChanged: () => void; onAdd: () => void }) {
  const toast = useToast();
  const [toggle] = useAction(async (s: SkillRow) => {
    await put(`/api/skills/${s.name}/everyone`, { everyone: !s.everyone });
    toast(!s.everyone ? `${s.name} is now given to every member of every team` : `${s.name} is only given where you assign it`);
    onChanged();
  });
  if (!skills) return <div className="faint small">Loading…</div>;
  if (!skills.length)
    return (
      <div className="card">
        <Empty icon={<IconSparkle />} title="No skills yet" action={<div className="row"><button className="btn" onClick={() => go('skills', 'anthropic')}>Browse Anthropic skills</button><button className="btn primary" onClick={onAdd}><IconPlus /> Write a skill</button></div>}>
          A skill is a folder with instructions (and optional scripts) that Claude loads when a task calls for it, for example your code review checklist or how to work with PDFs.
        </Empty>
      </div>
    );
  return (
    <div className="card">
      <div className="list">
        {skills.map((s) => (
          <div key={s.name} className="list-row clickable" onClick={() => go('skills', 'library', s.name)}>
            <IconSparkle width={18} height={18} style={{ color: 'var(--accent)', flex: 'none' }} />
            <div className="grow col" style={{ gap: 3 }}>
              <div className="row">
                <strong className="mono">{s.name}</strong>
                <SourceBadge s={s} />
              </div>
              <span className="small muted ellipsis">{s.description || 'No description'}</span>
              <UsedBy used={s.usedBy} />
            </div>
            <label className="check small" onClick={(e) => e.stopPropagation()} title="Give this skill to every member of every team">
              <input type="checkbox" checked={!!s.everyone} onChange={() => void toggle(s)} /> Everyone
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

function Catalog({ onInstalled }: { onInstalled: () => void }) {
  const toast = useToast();
  const { value, error, reload } = useLive(() => get<{ source: string; commit: string; skills: Candidate[] }>('/api/skills/catalog'), []);
  const [install, busy] = useAction(async (c: Candidate) => {
    await post('/api/skills/github/install', { url: value!.source, paths: [c.path] });
    toast(`Installed ${c.name}`);
    onInstalled();
    await reload();
  });
  if (error) return <div className="banner bad"><IconAlert /> Could not load Anthropic's skills from GitHub: {error}</div>;
  if (!value) return <div className="faint small">Loading Anthropic's skills from GitHub…</div>;
  return (
    <>
      <p className="small muted">
        Published by Anthropic at <a href="https://github.com/anthropics/skills" target="_blank" rel="noreferrer">github.com/anthropics/skills</a> (commit {value.commit.slice(0, 7)}). Installing copies a skill into your library.
      </p>
      <div className="grid grid-3">
        {value.skills.map((c) => (
          <div key={c.path} className="card card-pad col" style={{ gap: 8 }}>
            <div className="row">
              <strong className="mono grow">{c.name}</strong>
              {c.installed ? (
                <span className="pill good">
                  <IconCheck /> In library
                </span>
              ) : (
                <button className="btn sm" disabled={busy} onClick={() => void install(c)}>
                  <IconPlus /> Install
                </button>
              )}
            </div>
            <p className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {c.description}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

function Builtin({ skills }: { skills?: SkillRow[] }) {
  if (!skills) return <div className="faint small">Asking Claude Code…</div>;
  if (!skills.length) return <div className="card"><Empty title="None found">Claude Code reported no built-in skills, or it is not signed in.</Empty></div>;
  return (
    <>
      <p className="small muted">These come with Claude Code on this Mac. You can give them to members by name; they cannot be edited here.</p>
      <div className="card">
        <div className="list">
          {skills.map((s) => (
            <div key={s.name} className="list-row">
              <div className="grow col" style={{ gap: 3 }}>
                <strong className="mono">{s.name}</strong>
                <span className="small muted">{s.description || 'No description'}</span>
                <UsedBy used={s.usedBy} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function WriteSkill({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('# Instructions\n\n');
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  const [create, busy] = useAction(async () => {
    await post('/api/skills', { name: id, description, body });
    onClose();
    onCreated(id);
  });
  return (
    <Modal
      title="Write a skill"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!id || !description.trim() || busy} onClick={() => void create()}>
            Create skill
          </button>
        </>
      }
    >
      <div className="grid grid-2">
        <label className="field">
          Name
          <input className="input mono" autoFocus value={name} placeholder="e.g. code-review-checklist" onChange={(e) => setName(e.target.value)} />
          <span className="help">{id && id !== name ? `Will be called "${id}".` : 'Lowercase letters, digits and -.'}</span>
        </label>
        <label className="field">
          When Claude should use it
          <input className="input" value={description} placeholder="e.g. Use when reviewing code changes in this company's repos" onChange={(e) => setDescription(e.target.value)} />
          <span className="help">Claude reads this to decide when to load the skill.</span>
        </label>
      </div>
      <label className="field">
        Instructions (Markdown)
        <div className="cm-wrap">
          <CodeEditor value={body} onChange={setBody} language="markdown" minHeight={220} lineNumbers={false} />
        </div>
        <span className="help">You can add more files (examples, scripts) after creating it.</span>
      </label>
    </Modal>
  );
}

function FromGithub({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [found, setFound] = useState<{ repo: string; skills: Candidate[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scan, scanning] = useAction(async () => {
    const r = await post<{ repo: string; skills: Candidate[] }>('/api/skills/github/scan', { url });
    setFound(r);
    setPicked(new Set(r.skills.filter((s) => !s.installed).map((s) => s.path)));
  });
  const [install, installing] = useAction(async () => {
    const r = await post<SkillRow[]>('/api/skills/github/install', { url, paths: [...picked] });
    toast(`Installed ${r.map((s) => s.name).join(', ')}`);
    onClose();
    onInstalled();
  });
  return (
    <Modal
      title="Add skills from GitHub"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked.size || installing} onClick={() => void install()}>
            Install {picked.size || ''}
          </button>
        </>
      }
    >
      <label className="field">
        Repository or folder
        <div className="row">
          <input className="input mono" autoFocus value={url} placeholder="https://github.com/owner/repo or …/tree/main/skills/my-skill" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void scan()} />
          <button className="btn" disabled={!url.trim() || scanning} onClick={() => void scan()}>
            {scanning ? 'Looking…' : 'Find skills'}
          </button>
        </div>
        <span className="help">Private repositories work if git on this Mac can clone them. Only install skills from sources you trust: they can include scripts.</span>
      </label>
      {found && (
        <div className="card" style={{ boxShadow: 'none', maxHeight: 340, overflowY: 'auto' }}>
          {found.skills.length ? (
            <div className="list">
              {found.skills.map((s) => (
                <label key={s.path} className="list-row clickable">
                  <input
                    type="checkbox"
                    checked={picked.has(s.path)}
                    onChange={() => {
                      const n = new Set(picked);
                      if (n.has(s.path)) n.delete(s.path);
                      else n.add(s.path);
                      setPicked(n);
                    }}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <div className="grow col" style={{ gap: 2 }}>
                    <span className="row">
                      <strong className="mono">{s.name}</strong>
                      {s.installed && <span className="pill">installed: updates it</span>}
                    </span>
                    <span className="tiny faint mono">{s.path || '(repository root)'}</span>
                    <span className="small muted ellipsis">{s.description}</span>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <Empty title="No skills found">No SKILL.md files in {found.repo} at that location.</Empty>
          )}
        </div>
      )}
    </Modal>
  );
}

function SkillEditor({ name, onChanged }: { name: string; onChanged: () => void }) {
  const toast = useToast();
  const { value, reload } = useLive(() => get<{ skill: SkillRow; files: { path: string; size: number }[]; skillMd: string }>(`/api/skills/${name}`), [name]);
  const [file, setFile] = useState('SKILL.md');
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [preview, setPreview] = useState(true);
  useEffect(() => {
    let cancel = false;
    setText(null);
    get<{ content: string }>(`/api/skills/${name}/file?path=${encodeURIComponent(file)}`)
      .then((r) => !cancel && (setText(r.content), setSaved(r.content)))
      .catch(() => !cancel && (setText(''), setSaved('')));
    return () => {
      cancel = true;
    };
  }, [name, file]);
  const [save] = useAction(async () => {
    await put(`/api/skills/${name}/file`, { path: file, content: text ?? '' });
    setSaved(text ?? '');
    toast('Saved');
    void reload();
    onChanged();
  });
  const [update, updating] = useAction(async () => {
    await post(`/api/skills/${name}/update`);
    toast(`Updated ${name} from GitHub`);
    void reload();
    setFile('SKILL.md');
  });
  const [remove] = useAction(async () => {
    await del(`/api/skills/${name}`);
    onChanged();
    go('skills', 'library');
  });
  if (!value) return <Toolbar title={name} />;
  const s = value.skill;
  const body = (text ?? '').replace(/^---[\s\S]*?---\r?\n?/, '');
  return (
    <>
      <Toolbar title={<span className="mono">{name}</span>} sub={s.description}>
        {s.source === 'github' && (
          <button className="btn" disabled={updating} onClick={() => void update()} title={`Re-install from ${s.origin?.repo}`}>
            {updating ? 'Updating…' : 'Update from GitHub'}
          </button>
        )}
        <button className="btn ghost danger" onClick={() => void remove()}>
          <IconTrash /> Delete
        </button>
      </Toolbar>
      <div className="content flush">
        <div className="split">
          <div className="split-list">
            <div className="col" style={{ gap: 6, padding: '4px 4px 10px' }}>
              <SourceBadge s={{ ...s, usedBy: [] }} />
              <UsedBy used={s.usedBy} />
              {s.updatedAt && <span className="tiny faint">Changed {ago(s.updatedAt)}</span>}
            </div>
            {value.files.map((f) => (
              <div key={f.path} className={`list-row clickable ${f.path === file ? 'selected' : ''}`} style={{ borderRadius: 8, border: 0, padding: '6px 10px' }} onClick={() => setFile(f.path)}>
                <IconFile width={14} height={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                <span className="mono ellipsis grow">{f.path}</span>
              </div>
            ))}
          </div>
          <div className="split-main" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="row">
              <span className="mono grow">{file}</span>
              {file === 'SKILL.md' && (
                <div className="seg">
                  <button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
                    Preview
                  </button>
                  <button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>
                    Edit
                  </button>
                </div>
              )}
              <button className="btn sm primary" disabled={text === saved} onClick={() => void save()}>
                Save
              </button>
            </div>
            {s.source === 'github' && text !== saved && <div className="banner warn small"><IconAlert /> Updating from GitHub later replaces your local edits.</div>}
            {text === null ? (
              <div className="faint small">Loading…</div>
            ) : file === 'SKILL.md' && preview ? (
              <div className="card card-pad">
                <Markdown text={body} />
              </div>
            ) : (
              <div className="cm-wrap">
                <CodeEditor value={text} onChange={setText} language={file.endsWith('.md') ? 'markdown' : 'text'} onSave={() => void save()} minHeight={420} />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Assign skills: chips plus a picker grouped by where the skills come from. */
export function SkillPicker({ value, onChange, inherited = [] }: { value: string[]; onChange: (v: string[]) => void; inherited?: { name: string; why: string }[] }) {
  const { value: skills } = useLive(() => get<SkillsResponse>('/api/skills'), []);
  const all = [...(skills?.library ?? []), ...(skills?.builtin ?? [])];
  const known = new Set(all.map((s) => s.name));
  const everyone = (skills?.library ?? []).filter((s) => s.everyone).map((s) => ({ name: s.name, why: 'given to everyone' }));
  const shown = [...inherited, ...everyone].filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i && !value.includes(x.name));
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="chips">
        {value.map((n) => (
          <span key={n} className="chip mono on" title={known.has(n) ? all.find((s) => s.name === n)?.description : 'Not in your library or built-in skills on this Mac'}>
            {!known.has(n) && skills ? <IconAlert width={12} height={12} /> : <IconSparkle width={12} height={12} />}
            {n}
            <button aria-label={`Remove ${n}`} onClick={() => onChange(value.filter((x) => x !== n))}>
              ×
            </button>
          </span>
        ))}
        {shown.map((x) => (
          <span key={x.name} className="chip mono" style={{ opacity: 0.65 }} title={x.why}>
            <IconSparkle width={12} height={12} /> {x.name} <span className="tiny faint">· {x.why}</span>
          </span>
        ))}
        {!value.length && !shown.length && <span className="tiny faint">No skills</span>}
      </div>
      <select className="input" style={{ maxWidth: 360 }} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} aria-label="Add a skill">
        <option value="">Add a skill…</option>
        {(skills?.library ?? []).length > 0 && (
          <optgroup label="Your library">
            {skills!.library.filter((s) => !value.includes(s.name)).map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}: {s.description.slice(0, 60)}
              </option>
            ))}
          </optgroup>
        )}
        {(skills?.builtin ?? []).length > 0 && (
          <optgroup label="Built into Claude Code">
            {skills!.builtin.filter((s) => !value.includes(s.name)).map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}: {s.description.slice(0, 60)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
