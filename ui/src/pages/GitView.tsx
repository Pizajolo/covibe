// The project's own git checkout: where it stands, what changed, its branches
// and a graph of recent commits, with the everyday operations (commit, switch
// branch, pull, push, merge, revert, pull request).
import { useMemo, useState } from 'react';
import { desktop, get, post, type GitCommit, type GitOverview } from '../api';
import { IconArrowRight, IconBranch, IconCheck, IconPlus, IconUp } from '../components/icons';
import { Empty, Modal, useAction, useToast } from '../components/ui';
import { layoutGraph } from '../components/git-graph';
import { useLive } from '../data';
import { ago } from '../format';

export function openUrl(url: string) {
  if (desktop) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

export function useGit(projectId: string) {
  return useLive(() => get<GitOverview>(`/api/projects/${projectId}/git`), [projectId]);
}

export function GitPanel({ projectId }: { projectId: string }) {
  const { value: g, error, reload } = useGit(projectId);
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState(false);
  const [pr, setPr] = useState<string | undefined>();
  const [commit, setCommit] = useState<string | undefined>();
  const [showRuns, setShowRuns] = useState(false);
  const api = `/api/projects/${projectId}/git`;

  const [act, busy] = useAction(async (what: string, path: string, body: unknown = {}) => {
    await post(`${api}/${path}`, body);
    toast(what);
    await reload();
  });

  if (error) return <div className="banner bad" style={{ margin: 20 }}>{error}</div>;
  if (!g) return <div className="faint" style={{ padding: 20 }}>Reading the repository…</div>;
  const current = g.branches.find((b) => b.current);
  const visible = g.branches.filter((b) => showRuns || !b.run || b.current);
  const runCount = g.branches.filter((b) => b.run).length;
  const canPush = g.remotes.length > 0;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <div className="col" style={{ gap: 14, maxWidth: 1100, margin: '0 auto' }}>
        <div className="card card-pad git-head">
          <IconBranch width={16} height={16} />
          <select
            className="input"
            style={{ width: 'auto', minWidth: 180 }}
            value={g.branch ?? ''}
            disabled={busy}
            onChange={(e) => e.target.value && void act(`Switched to ${e.target.value}`, 'checkout', { branch: e.target.value })}
            aria-label="Current branch"
          >
            {g.detached && <option value="">(detached HEAD)</option>}
            {g.branches
              .filter((b) => !b.run || b.current)
              .map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
          </select>
          {current?.upstream ? (
            <span className="small muted num">
              {current.ahead || current.behind ? `${current.ahead} to push · ${current.behind} to pull` : `up to date with ${current.upstream}`}
            </span>
          ) : (
            <span className="small faint">{canPush ? 'not pushed yet' : 'no remote'}</span>
          )}
          <span className="grow" />
          <button className="btn sm" disabled={busy} onClick={() => setNewBranch(true)}>
            <IconPlus /> New branch
          </button>
          {current?.upstream && (
            <button className="btn sm" disabled={busy || !current.behind} onClick={() => void act('Pulled', 'pull')}>
              Pull
            </button>
          )}
          {canPush && current && (
            <button className="btn sm" disabled={busy} onClick={() => void act(`Pushed ${current.name}`, 'push', { branch: current.name })}>
              <IconUp /> Push
            </button>
          )}
          {g.pullRequests !== 'none' && current && current.name !== g.defaultBranch && (
            <button className="btn sm primary" disabled={busy} onClick={() => setPr(current.name)}>
              Create pull request
            </button>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Uncommitted changes</h2>
            <span className="hint">{g.files.length ? `${g.files.length} file${g.files.length > 1 ? 's' : ''}` : 'none'}</span>
          </div>
          {g.files.length ? (
            <div className="card-pad col" style={{ gap: 10 }}>
              <div className="git-files">
                {g.files.map((f) => (
                  <div key={f.path} className="row small">
                    <span className={`git-state ${f.state}`}>{f.state}</span>
                    <span className="mono ellipsis grow">{f.path}</span>
                  </div>
                ))}
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <textarea className="input grow" rows={2} placeholder="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" />
                <button
                  className="btn primary"
                  disabled={busy || !message.trim() || !g.branch}
                  onClick={() => void act('Committed', 'commit', { message }).then(() => setMessage(''))}
                  title={g.branch ? `Commit every change on ${g.branch}` : 'Switch to a branch first'}
                >
                  <IconCheck /> Commit all
                </button>
              </div>
            </div>
          ) : (
            <p className="card-pad small muted" style={{ margin: 0 }}>
              Your checkout is clean. Teams work in their own worktrees, so runs never change it; their results are on <span className="mono">covibe/…</span> branches.
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Branches</h2>
            {runCount > 0 && (
              <label className="check small right">
                <input type="checkbox" checked={showRuns} onChange={(e) => setShowRuns(e.target.checked)} /> Show {runCount} run result{runCount > 1 ? 's' : ''}
              </label>
            )}
          </div>
          <table className="table">
            <tbody>
              {visible.map((b) => (
                <tr key={b.name}>
                  <td style={{ width: '32%' }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="mono ellipsis">{b.name}</span>
                      {b.current && <span className="pill info">current</span>}
                      {b.run && <span className="pill">run result</span>}
                      {b.gone && <span className="pill warn">remote deleted</span>}
                    </span>
                  </td>
                  <td className="small muted ellipsis" title={b.subject}>
                    {b.subject} <span className="faint">· {ago(b.date)}</span>
                  </td>
                  <td className="small num faint" style={{ whiteSpace: 'nowrap' }}>
                    {b.upstream ? (b.ahead || b.behind ? `↑${b.ahead} ↓${b.behind}` : 'pushed') : 'local'}
                  </td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    {!b.current && !b.run && (
                      <button className="btn sm ghost" disabled={busy} onClick={() => void act(`Switched to ${b.name}`, 'checkout', { branch: b.name })}>
                        Switch
                      </button>
                    )}
                    {!b.current && g.branch && (
                      <button className="btn sm ghost" disabled={busy} onClick={() => void act(`Merged ${b.name} into ${g.branch}`, 'merge', { branch: b.name })} title={`Merge ${b.name} into ${g.branch}`}>
                        Merge into {g.branch}
                      </button>
                    )}
                    {canPush && (
                      <button className="btn sm ghost" disabled={busy} onClick={() => void act(`Pushed ${b.name}`, 'push', { branch: b.name })}>
                        Push
                      </button>
                    )}
                    {g.pullRequests !== 'none' && b.name !== g.defaultBranch && (
                      <button className="btn sm ghost" disabled={busy} onClick={() => setPr(b.name)}>
                        PR
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>History</h2>
            <span className="hint">newest first, every branch</span>
          </div>
          {g.commits.length ? <Graph commits={g.commits} remotes={g.remotes.map((r) => r.name)} onOpen={setCommit} /> : <Empty title="No commits yet" />}
        </div>
      </div>

      {newBranch && (
        <NewBranch
          from={g.branch}
          onClose={() => setNewBranch(false)}
          onCreate={(name) => void act(`Created and switched to ${name}`, 'checkout', { branch: name, create: true }).then(() => setNewBranch(false))}
        />
      )}
      {pr && <PrDialog projectId={projectId} branch={pr} base={g.defaultBranch} branches={g.branches.map((b) => b.name)} onClose={() => setPr(undefined)} onDone={reload} />}
      {commit && (
        <CommitDialog
          projectId={projectId}
          sha={commit}
          branch={g.branch}
          onClose={() => setCommit(undefined)}
          onRevert={(sha) => void act(`Reverted ${sha.slice(0, 7)} with a new commit`, 'revert', { sha }).then(() => setCommit(undefined))}
        />
      )}
    </div>
  );
}

// ---- the commit graph

const LANE = 14;
const ROW = 30;
const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-7)', 'var(--series-8)', 'var(--series-6)'];
const color = (lane: number) => COLORS[lane % COLORS.length];

function Graph({ commits, remotes, onOpen }: { commits: GitCommit[]; remotes: string[]; onOpen: (sha: string) => void }) {
  const kind = (ref: string) => (ref.startsWith('HEAD') ? 'head' : ref.startsWith('tag:') ? 'tag' : remotes.some((r) => ref.startsWith(`${r}/`)) ? 'remote' : '');
  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const width = Math.min(12, Math.max(...rows.map((r) => r.lanes))) * LANE + 8;
  const x = (lane: number) => 8 + lane * LANE;
  return (
    <div className="git-graph">
      {rows.map((r) => (
        <button key={r.commit.sha} className="git-row" onClick={() => onOpen(r.commit.sha)} title={`${r.commit.sha}\n${r.commit.subject}`}>
          <svg width={width} height={ROW} aria-hidden>
            {r.through.map(([a, b]) => (
              <path key={`t${a}`} d={`M${x(a)} 0 C${x(a)} ${ROW / 2} ${x(b)} ${ROW / 2} ${x(b)} ${ROW}`} stroke={color(b)} fill="none" strokeWidth={2} />
            ))}
            {r.into.map((a) => (
              <path key={`i${a}`} d={`M${x(a)} 0 C${x(a)} ${ROW / 4} ${x(r.col)} ${ROW / 4} ${x(r.col)} ${ROW / 2}`} stroke={color(a)} fill="none" strokeWidth={2} />
            ))}
            {r.out.map((b) => (
              <path key={`o${b}`} d={`M${x(r.col)} ${ROW / 2} C${x(r.col)} ${(ROW * 3) / 4} ${x(b)} ${(ROW * 3) / 4} ${x(b)} ${ROW}`} stroke={color(b)} fill="none" strokeWidth={2} />
            ))}
            <circle cx={x(r.col)} cy={ROW / 2} r={4.5} fill="var(--surface)" stroke={color(r.col)} strokeWidth={2.5} />
          </svg>
          <span className="git-subject ellipsis">
            {r.commit.refs.map((ref) => (
              <span key={ref} className={`git-ref ${kind(ref)}`}>
                {ref.replace(/^HEAD -> /, '')}
              </span>
            ))}
            {r.commit.subject}
          </span>
          <span className="tiny faint ellipsis git-meta">
            {r.commit.author} · {ago(r.commit.date)}
          </span>
          <span className="mono tiny faint">{r.commit.sha.slice(0, 7)}</span>
        </button>
      ))}
    </div>
  );
}

// ---- dialogs

export function DiffLines({ patch }: { patch: string }) {
  return (
    <div className="card diff">
      {patch.split('\n').map((l, i) => (
        <div
          key={i}
          className={l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}
        >
          {l.startsWith('diff --git') ? l.replace(/^diff --git a\/(\S+) b\/.*$/, '$1') : l || ' '}
        </div>
      ))}
    </div>
  );
}

function CommitDialog({ projectId, sha, branch, onClose, onRevert }: { projectId: string; sha: string; branch?: string; onClose: () => void; onRevert: (sha: string) => void }) {
  const { value, error } = useLive(() => get<{ header: string; patch: string; files: { path: string; additions: number; deletions: number }[] }>(`/api/projects/${projectId}/git/commits/${sha}`), [projectId, sha]);
  const [confirm, setConfirm] = useState(false);
  const [title, ...rest] = (value?.header ?? '').split('\n');
  return (
    <Modal
      wide
      title={<span className="mono">{sha.slice(0, 10)}</span>}
      onClose={onClose}
      footer={
        <>
          {branch &&
            (confirm ? (
              <>
                <span className="small muted grow">Add a commit on {branch} that undoes this one?</span>
                <button className="btn" onClick={() => setConfirm(false)}>
                  Keep it
                </button>
                <button className="btn danger" onClick={() => onRevert(sha)}>
                  Revert
                </button>
              </>
            ) : (
              <button className="btn danger" onClick={() => setConfirm(true)} title={`Undo this commit with a new commit on ${branch}`}>
                Revert this commit
              </button>
            ))}
          {!confirm && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </>
      }
    >
      {error && <div className="banner bad">{error}</div>}
      {!value ? (
        <span className="faint">Loading…</span>
      ) : (
        <>
          <pre className="git-message">{rest.slice(2).join('\n').trim() || title}</pre>
          <span className="tiny faint">
            {rest[0]} · {rest[1] ? new Date(rest[1]).toLocaleString() : ''} · {value.files.length} file{value.files.length === 1 ? '' : 's'}
          </span>
          <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
            <DiffLines patch={value.patch} />
          </div>
        </>
      )}
    </Modal>
  );
}

function NewBranch({ from, onClose, onCreate }: { from?: string; onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Modal
      title="New branch"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>
            Create and switch
          </button>
        </>
      }
    >
      <label className="field">
        Name
        <input className="input mono" autoFocus value={name} placeholder="feature/greeting" onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onCreate(name.trim())} />
        <span className="help">Starts from {from ?? 'the current commit'}; your uncommitted changes come along.</span>
      </label>
    </Modal>
  );
}

/** Push a branch and open a pull request for it (with gh, or on the forge's page). */
export function PrDialog({
  projectId,
  branch,
  base: initialBase,
  branches,
  title: initialTitle,
  body: initialBody,
  onClose,
  onDone,
}: {
  projectId: string;
  branch: string;
  base?: string;
  branches: string[];
  title?: string;
  body?: string;
  onClose: () => void;
  onDone?: () => unknown;
}) {
  const toast = useToast();
  const [base, setBase] = useState(initialBase ?? branches.find((b) => b !== branch) ?? 'main');
  const [title, setTitle] = useState(initialTitle ?? branch.replace(/^covibe\//, ''));
  const [body, setBody] = useState(initialBody ?? '');
  const [create, creating] = useAction(async () => {
    const res = await post<{ url: string; created: boolean }>(`/api/projects/${projectId}/git/pr`, { branch, base, title, body });
    toast(res.created ? 'Pull request created' : 'Pushed. Finish the pull request in your browser.');
    openUrl(res.url);
    await onDone?.();
    onClose();
  });
  return (
    <Modal
      wide
      title={
        <span className="row" style={{ gap: 8 }}>
          Pull request <span className="mono small muted">{branch}</span> <IconArrowRight width={13} height={13} /> <span className="mono small muted">{base}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={creating || !title.trim() || base === branch} onClick={() => void create()}>
            {creating ? 'Pushing…' : 'Push and create'}
          </button>
        </>
      }
    >
      <div className="grid grid-2">
        <label className="field">
          Into
          <select className="input" value={base} onChange={(e) => setBase(e.target.value)}>
            {branches
              .filter((b) => b !== branch && !b.startsWith('covibe/'))
              .map((b) => (
                <option key={b}>{b}</option>
              ))}
          </select>
        </label>
        <label className="field">
          Title
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="field">
        Description
        <textarea className="input" rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changed and why" />
      </label>
      <span className="tiny faint">The branch is pushed first. With the GitHub CLI (gh) signed in, the pull request is created right away; otherwise its page opens in your browser.</span>
    </Modal>
  );
}
