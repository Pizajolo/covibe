import { useEffect, useState } from 'react';
import { del, desktop, get, post, put, type RunSummary } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import { Composer } from '../components/Composer';
import { IconBranch, IconCheck, IconFile, IconFolder, IconPlus, IconRuns, IconSparkle, IconTrash, IconX } from '../components/icons';
import { GitPanel } from './GitView';
import { Markdown } from '../components/Markdown';
import { RunRow } from '../components/RunCard';
import { Toolbar } from '../components/Toolbar';
import { Empty, Modal, useAction, useToast } from '../components/ui';
import { go, useData, useLive } from '../data';
import { ago } from '../format';

interface BrainView {
  dir: string;
  notes: { path: string; title: string; size: number; updatedAt: string }[];
  proposals: {
    id: number;
    runId?: string;
    agent: string;
    title: string;
    content: string;
    reason?: string;
    status: 'pending' | 'accepted' | 'rejected';
    createdAt: string;
    decidedBy?: string;
    decisionNote?: string;
    notePath?: string;
  }[];
  log: { commit: string; author: string; date: string; message: string }[];
  curators: { teamId: string; team: string; curator: string }[];
}

type Tab = 'runs' | 'brain' | 'git';

export function ProjectPage({ projectId, tab: tabParam }: { projectId: string; tab?: string }) {
  const { overview } = useData();
  const project = overview?.projects.find((p) => p.id === projectId);
  const tab: Tab = tabParam === 'brain' || tabParam === 'git' ? tabParam : 'runs';
  const [goal, setGoal] = useState(false);
  if (!overview) return <Toolbar title="Project" />;
  if (!project)
    return (
      <>
        <Toolbar title="Project" />
        <div className="content">
          <Empty title="Project not found" />
        </div>
      </>
    );
  return (
    <>
      <Toolbar title={project.name} sub={project.path}>
        {desktop && (
          <button className="btn" onClick={() => void desktop!.reveal(project.path)}>
            <IconFolder /> Show in Finder
          </button>
        )}
        <button className="btn primary" onClick={() => setGoal(true)}>
          <IconPlus /> New goal
        </button>
      </Toolbar>
      <nav className="tabs">
        <button className={tab === 'runs' ? 'on' : ''} onClick={() => go('projects', projectId, 'runs')}>
          <IconRuns width={14} height={14} /> Runs
        </button>
        <button className={tab === 'brain' ? 'on' : ''} onClick={() => go('projects', projectId, 'brain')}>
          <IconSparkle width={14} height={14} /> Brain
        </button>
        <button className={tab === 'git' ? 'on' : ''} onClick={() => go('projects', projectId, 'git')}>
          <IconBranch width={14} height={14} /> Git
        </button>
      </nav>
      {tab === 'runs' ? <ProjectRuns projectId={projectId} /> : tab === 'git' ? <GitPanel projectId={projectId} /> : <Brain projectId={projectId} />}
      {goal && (
        <Modal title={`New goal for ${project.name}`} onClose={() => setGoal(false)} wide>
          <div className="card" style={{ boxShadow: 'none' }}>
            <Composer fixedProject={projectId} autoFocus onDone={() => setGoal(false)} />
          </div>
        </Modal>
      )}
    </>
  );
}

function ProjectRuns({ projectId }: { projectId: string }) {
  const { value: runs } = useLive(() => get<RunSummary[]>(`/api/runs?limit=200&project=${projectId}`), [projectId], (e) => e.projectId === projectId);
  return (
    <div className="content">
      <div className="page">
        <div className="card">
          {runs?.length ? (
            <div className="list">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </div>
          ) : (
            <Empty icon={<IconRuns />} title={runs ? 'No runs yet' : 'Loading…'}>
              {runs ? 'Give a team a goal for this project.' : ''}
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}

function Brain({ projectId }: { projectId: string }) {
  const toast = useToast();
  const { value: brain, reload } = useLive(
    () => get<BrainView>(`/api/projects/${projectId}/brain`),
    [projectId],
    (e) => e.projectId === projectId && /^brain\./.test(e.event.type),
  );
  const [sel, setSel] = useState<string>('README.md');
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [editing, setEditing] = useState(false);
  const [newNote, setNewNote] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<BrainView['proposals'][number] | null>(null);

  useEffect(() => {
    let cancel = false;
    setText(null);
    setEditing(false);
    get<{ content: string }>(`/api/projects/${projectId}/brain/note?path=${encodeURIComponent(sel)}`)
      .then((r) => !cancel && (setText(r.content), setSaved(r.content)))
      .catch(() => !cancel && (setText(''), setSaved('')));
    return () => {
      cancel = true;
    };
  }, [projectId, sel, brain?.log[0]?.commit]);

  const [save] = useAction(async () => {
    await put(`/api/projects/${projectId}/brain/note`, { path: sel, content: text ?? '' });
    setSaved(text ?? '');
    setEditing(false);
    toast('Saved to the brain');
    void reload();
  });
  const [remove] = useAction(async () => {
    await del(`/api/projects/${projectId}/brain/note?path=${encodeURIComponent(sel)}`);
    setSel('README.md');
    void reload();
  });
  const [create] = useAction(async (path: string) => {
    const rel = path.endsWith('.md') ? path : `${path}.md`;
    const title = rel.replace(/\.md$/, '').split('/').pop()!.replace(/[-_]/g, ' ');
    await put(`/api/projects/${projectId}/brain/note`, { path: rel, content: `# ${title[0]!.toUpperCase()}${title.slice(1)}\n\n` });
    setNewNote(null);
    await reload();
    setSel(rel);
    setEditing(true);
  });
  const [askCurator, asking] = useAction(async (teamId: string) => {
    const r = await post<{ runId: string; projectId: string }>(`/api/projects/${projectId}/brain/curate`, { team: teamId });
    toast('The curator is reviewing the proposals');
    go('runs', r.projectId, r.runId, 'activity');
  });

  if (!brain) return <div className="content faint small">Loading the brain…</div>;
  const pending = brain.proposals.filter((p) => p.status === 'pending');
  const decided = brain.proposals.filter((p) => p.status !== 'pending').slice(0, 8);

  return (
    <div className="content flush">
      <div className="split">
        <div className="split-list">
          <div className="tiny faint" style={{ padding: '2px 4px 8px' }}>
            Shared notes every member reads. Members propose; {brain.curators.length ? [...new Set(brain.curators.map((c) => `${c.curator} of ${c.team}`))].join(', ') : 'you'} and you curate.
          </div>
          {brain.notes.map((n) => (
            <div key={n.path} className={`list-row clickable ${n.path === sel ? 'selected' : ''}`} style={{ borderRadius: 8, border: 0, padding: '6px 10px' }} onClick={() => setSel(n.path)}>
              <IconFile width={14} height={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
              <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
                <span className="ellipsis small">{n.title}</span>
                <span className="tiny faint mono ellipsis">{n.path}</span>
              </div>
            </div>
          ))}
          {newNote === null ? (
            <button className="btn" style={{ marginTop: 8 }} onClick={() => setNewNote('')}>
              <IconPlus /> New note
            </button>
          ) : (
            <input
              className="input mono"
              style={{ marginTop: 8 }}
              autoFocus
              placeholder="e.g. architecture.md"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewNote(null);
                if (e.key === 'Enter' && newNote.trim()) void create(newNote.trim());
              }}
            />
          )}
          {desktop && (
            <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => void desktop!.reveal(brain.dir)}>
              Show folder in Finder
            </button>
          )}
        </div>
        <div className="split-main col" style={{ gap: 14 }}>
          {pending.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>
                  {pending.length} proposal{pending.length > 1 ? 's' : ''} waiting
                </h2>
                <div className="right">
                  {brain.curators.map((c) => (
                    <button key={c.teamId} className="btn sm" disabled={asking} onClick={() => void askCurator(c.teamId)} title={`Team ${c.team}`}>
                      Ask {c.curator} ({c.teamId}) to review
                    </button>
                  ))}
                </div>
              </div>
              <div className="list">
                {pending.map((p) => (
                  <div key={p.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                    <div className="grow col" style={{ gap: 4 }}>
                      <span>
                        <strong>{p.title}</strong> <span className="tiny faint">#{p.id} from {p.agent} · {ago(p.createdAt)}</span>
                      </span>
                      <div className="small" style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                        <Markdown text={p.content} />
                      </div>
                      {p.reason && <span className="tiny faint">Why: {p.reason}</span>}
                    </div>
                    <div className="col" style={{ gap: 6 }}>
                      <button className="btn sm primary" onClick={() => setDeciding(p)}>
                        <IconCheck /> Accept…
                      </button>
                      <DecideButton projectId={projectId} id={p.id} onDone={reload} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h2 className="mono">{sel}</h2>
              <div className="right">
                {!editing ? (
                  <button className="btn sm" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                ) : (
                  <>
                    <button className="btn sm" onClick={() => (setText(saved), setEditing(false))}>
                      Cancel
                    </button>
                    <button className="btn sm primary" disabled={text === saved} onClick={() => void save()}>
                      Save
                    </button>
                  </>
                )}
                {sel !== 'README.md' && (
                  <button className="btn sm ghost icon-btn" title="Delete note" onClick={() => void remove()}>
                    <IconTrash />
                  </button>
                )}
              </div>
            </div>
            <div className={editing ? '' : 'card-pad'}>
              {text === null ? (
                <span className="faint small">Loading…</span>
              ) : editing ? (
                <CodeEditor value={text} onChange={setText} language="markdown" onSave={() => void save()} minHeight={320} lineNumbers={false} />
              ) : (
                <Markdown text={text} />
              )}
            </div>
          </div>

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <h2>Recent decisions</h2>
              </div>
              {decided.length ? (
                <div className="list">
                  {decided.map((p) => (
                    <div key={p.id} className="list-row">
                      {p.status === 'accepted' ? <IconCheck width={14} height={14} style={{ color: 'var(--good)', flex: 'none' }} /> : <IconX width={14} height={14} style={{ color: 'var(--text-3)', flex: 'none' }} />}
                      <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                        <span className="small ellipsis">{p.title}</span>
                        <span className="tiny faint ellipsis">
                          {p.status} by {p.decidedBy}
                          {p.notePath ? ` into ${p.notePath}` : ''}
                          {p.decisionNote ? `: ${p.decisionNote}` : ''}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="card-pad small muted">No proposals decided yet.</div>
              )}
            </div>
            <div className="card">
              <div className="card-head">
                <h2>History</h2>
              </div>
              <div className="list">
                {brain.log.slice(0, 8).map((c) => (
                  <div key={c.commit} className="list-row">
                    <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                      <span className="small ellipsis">{c.message}</span>
                      <span className="tiny faint">
                        {c.author.replace('covibe/', '')} · {ago(c.date)} · <span className="mono">{c.commit.slice(0, 7)}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {deciding && <AcceptProposal projectId={projectId} proposal={deciding} notes={brain.notes.map((n) => n.path)} onClose={() => setDeciding(null)} onDone={() => (setDeciding(null), reload())} />}
    </div>
  );
}

function DecideButton({ projectId, id, onDone }: { projectId: string; id: number; onDone: () => void }) {
  const [reject, busy] = useAction(async () => {
    await post(`/api/projects/${projectId}/brain/proposals/${id}`, { decision: 'reject' });
    onDone();
  });
  return (
    <button className="btn sm" disabled={busy} onClick={() => void reject()}>
      <IconX /> Reject
    </button>
  );
}

function AcceptProposal({ projectId, proposal, notes, onClose, onDone }: { projectId: string; proposal: BrainView['proposals'][number]; notes: string[]; onClose: () => void; onDone: () => void }) {
  const slug = proposal.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
  const [target, setTarget] = useState(`${slug}.md`);
  const [accept, busy] = useAction(async () => {
    await post(`/api/projects/${projectId}/brain/proposals/${proposal.id}`, { decision: 'accept', notePath: target });
    onDone();
  });
  return (
    <Modal
      title={`Accept “${proposal.title}”`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !target.trim()} onClick={() => void accept()}>
            Add to the brain
          </button>
        </>
      }
    >
      <label className="field">
        Add it to
        <select className="input" value={notes.includes(target) ? target : '__new'} onChange={(e) => setTarget(e.target.value === '__new' ? `${slug}.md` : e.target.value)}>
          <option value="__new">A new note: {slug}.md</option>
          {notes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="help">A new note starts with the proposal's title; an existing note gets it as a new section. You can edit it afterwards.</span>
      </label>
    </Modal>
  );
}

