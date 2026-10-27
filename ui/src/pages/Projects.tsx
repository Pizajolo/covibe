import { useState } from 'react';
import { del, desktop, get, post } from '../api';
import { IconFolder, IconPlus, IconTrash } from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { Empty, Modal, RunStatusPill, useAction, useToast } from '../components/ui';
import { go, openNewProject, useData, useLive } from '../data';
import { ago, money } from '../format';

interface WorktreeInfo {
  runId: string;
  goal?: string;
  status?: 'running' | 'succeeded' | 'failed' | 'escalated';
  live: boolean;
  finishedAt?: string;
  sizeKb: number;
  worktrees: string[];
}

export const mb = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${(kb / 1024).toFixed(kb < 10240 ? 1 : 0)} MB`);

export function Projects() {
  const { overview, refresh } = useData();
  const toast = useToast();
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  const [cleaning, setCleaning] = useState<string | null>(null);

  const [add, adding] = useAction(async (p: string) => {
    await post('/api/projects', { path: p });
    await refresh();
    setTyping(false);
    setPath('');
    toast('Project added');
  });
  const [remove] = useAction(async (id: string) => {
    await del(`/api/projects/${id}`);
    await refresh();
  });

  const pick = () => openNewProject();

  const projects = overview?.projects ?? [];
  const runsFor = (id: string) => overview?.runs.filter((r) => r.projectId === id) ?? [];

  return (
    <>
      <Toolbar title="Projects" sub="Git repositories your teams work on">
        <button className="btn primary" onClick={() => void pick()} disabled={adding}>
          <IconPlus /> New project
        </button>
      </Toolbar>
      <div className="content">
        <div className="page">
          <div className="card">
            {projects.length ? (
              <div className="list">
                {projects.map((p) => {
                  const runs = runsFor(p.id);
                  return (
                    <div key={p.id} className="list-row clickable" onClick={(e) => !(e.target as HTMLElement).closest('button') && go('projects', p.id)}>
                      <IconFolder width={20} height={20} style={{ color: 'var(--accent)', flex: 'none' }} />
                      <div className="grow col" style={{ gap: 2 }}>
                        <strong>{p.name}</strong>
                        <span className="tiny faint mono ellipsis">{p.path}</span>
                      </div>
                      <span className="tiny faint num">
                        {runs.length} recent runs · {money(runs.reduce((n, r) => n + r.costUsd, 0))}
                      </span>
                      <DiskUsage projectId={p.id} onClean={() => setCleaning(p.id)} />
                      {desktop && (
                        <button className="btn sm" onClick={() => void desktop!.reveal(p.path)}>
                          Show in Finder
                        </button>
                      )}
                      <button className="btn sm ghost icon-btn" title="Remove from covibe (files are not touched)" onClick={() => void remove(p.id)}>
                        <IconTrash />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty icon={<IconFolder />} title="No projects yet" action={<button className="btn primary" onClick={() => void pick()}><IconPlus /> Add a git repository</button>}>
                A project is a git repository on this Mac. Teams work on their own branches and never touch your checkout.
              </Empty>
            )}
          </div>
          <p className="tiny faint">
            Removing a project only removes it from this list. Run history stays in the repository's <span className="mono">.covibe</span> folder, which covibe keeps out
            of git. Each run's worktrees live in <span className="mono">~/.covibe/worktrees</span> until you clean them up.
          </p>
        </div>
      </div>
      {typing && (
        <Modal
          title="Add project"
          onClose={() => setTyping(false)}
          footer={
            <>
              <button className="btn" onClick={() => setTyping(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!path.trim() || adding} onClick={() => void add(path.trim())}>
                Add
              </button>
            </>
          }
        >
          <label className="field">
            Folder path
            <input className="input mono" autoFocus placeholder="~/code/my-app" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && void add(path.trim())} />
            <span className="help">A git repository with at least one commit.</span>
          </label>
        </Modal>
      )}
      {cleaning && <Cleanup projectId={cleaning} name={projects.find((p) => p.id === cleaning)?.name ?? ''} onClose={() => setCleaning(null)} />}
    </>
  );
}

function DiskUsage({ projectId, onClean }: { projectId: string; onClean: () => void }) {
  const { value } = useLive(() => get<WorktreeInfo[]>(`/api/projects/${projectId}/worktrees`), [projectId], (e) => e.projectId === projectId && (e.event.type === 'run.finished' || e.event.type === 'workspace.cleaned'));
  if (!value) return null;
  const kb = value.reduce((n, w) => n + w.sizeKb, 0);
  return (
    <button className="btn sm" onClick={onClean} title="Worktrees of past runs on disk" disabled={!value.length}>
      {value.length ? `${mb(kb)} in ${value.length} run${value.length > 1 ? 's' : ''} · Clean up…` : 'No worktrees'}
    </button>
  );
}

function Cleanup({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const { value, reload } = useLive(() => get<WorktreeInfo[]>(`/api/projects/${projectId}/worktrees`), [projectId]);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const finished = (value ?? []).filter((w) => !w.live);
  const chosen = selected ?? new Set(finished.map((w) => w.runId));
  const freed = finished.filter((w) => chosen.has(w.runId)).reduce((n, w) => n + w.sizeKb, 0);
  const [clean, busy] = useAction(async () => {
    const res = await post<{ freedKb: number; cleaned: unknown[] }>(`/api/projects/${projectId}/cleanup`, { runIds: [...chosen] });
    toast(`Removed worktrees of ${res.cleaned.length} run${res.cleaned.length === 1 ? '' : 's'}, freed ${mb(res.freedKb)}.`);
    await reload();
    onClose();
  });
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <Modal
      title={`Clean up ${name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!chosen.size || busy} onClick={() => void clean()}>
            <IconTrash /> Remove {chosen.size} · free {mb(freed)}
          </button>
        </>
      }
    >
      <p className="small muted">
        Removes the worktrees (working copies) of finished runs. Every run's result branch and history stay, and chatting with a member later restores its worktree.
        Running runs are never touched.
      </p>
      <div className="card" style={{ boxShadow: 'none', maxHeight: 360, overflowY: 'auto' }}>
        {value === null ? (
          <div className="faint small" style={{ padding: 12 }}>
            Measuring…
          </div>
        ) : !value.length ? (
          <Empty title="Nothing to clean up" />
        ) : (
          <div className="list">
            {value.map((w) => (
              <label key={w.runId} className="list-row clickable" style={{ opacity: w.live ? 0.55 : 1 }}>
                <input type="checkbox" disabled={w.live} checked={!w.live && chosen.has(w.runId)} onChange={() => toggle(w.runId)} style={{ accentColor: 'var(--accent)' }} />
                <div className="grow col" style={{ gap: 2 }}>
                  <span className="ellipsis">{w.goal ?? w.runId}</span>
                  <span className="tiny faint">
                    {w.live ? 'running now' : w.finishedAt ? `finished ${ago(w.finishedAt)}` : 'unknown run'} · {w.worktrees.length} worktree{w.worktrees.length > 1 ? 's' : ''}
                  </span>
                </div>
                {w.status && <RunStatusPill status={w.live ? 'running' : w.status === 'running' ? 'failed' : w.status} />}
                <span className="num small" style={{ width: 70, textAlign: 'right' }}>
                  {mb(w.sizeKb)}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
