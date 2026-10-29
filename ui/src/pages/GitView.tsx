// The project's own git checkout: where it stands, what changed, its branches
// (local and on the remotes), stashes, a graph of recent commits, and the
// operations people do from there. When something fails, it says why and
// what to do, with the fix one click away, and the git helper can take over.
import { useEffect, useMemo, useState } from 'react';
import { ApiError, desktop, get, post, type GitBranch, type GitCommit, type GitFile, type GitOverview, type GitProblemInfo, type GitRemoteBranch } from '../api';
import { GitHelper } from '../components/GitHelper';
import { IconAlert, IconArrowRight, IconBranch, IconCheck, IconCode, IconLoop, IconPlus, IconSparkle, IconTrash, IconUp } from '../components/icons';
import { Empty, Modal, useToast } from '../components/ui';
import { layoutGraph } from '../components/git-graph';
import { useLive } from '../data';
import { ago } from '../format';

export function openUrl(url: string) {
  if (desktop) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

export function useGit(projectId: string) {
  // The helper running a command changes the checkout: read it again.
  return useLive(() => get<GitOverview>(`/api/projects/${projectId}/git`), [projectId], (e) => e.projectId === '_library' && e.event.type === 'git.ran' && !e.event.data.auto);
}

/** A failed operation, as the Git tab explains it. */
interface Failure {
  what: string;
  message: string;
  git?: GitProblemInfo;
  retry?: () => Promise<void>;
  /** The operation that failed, to offer the matching fix. */
  op: string;
  body: Record<string, unknown>;
}

type Confirm = { title: string; text: string; action: string; danger?: boolean; run: () => void };

export function GitPanel({ projectId }: { projectId: string }) {
  const { value: g, error, reload } = useGit(projectId);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [newBranch, setNewBranch] = useState<{ from?: string } | null>(null);
  const [pr, setPr] = useState<string | undefined>();
  const [commit, setCommit] = useState<string | undefined>();
  const [diff, setDiff] = useState<string | undefined>();
  const [branchMenu, setBranchMenu] = useState<GitBranch | undefined>();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  const [helper, setHelper] = useState(false);
  const [seed, setSeed] = useState<string | undefined>();
  const [waiting, setWaiting] = useState(0);
  const api = `/api/projects/${projectId}/git`;

  /** Run an operation; a failure stays on screen with its explanation and fixes. */
  const act = async <T = unknown,>(what: string, op: string, body: Record<string, unknown> = {}, done?: (out: T) => string | void): Promise<T | undefined> => {
    setBusy(op);
    try {
      const out = await post<T>(`${api}/${op}`, body);
      setFailure(null);
      const conflicts = (out as { conflicts?: string[] } | undefined)?.conflicts;
      if (conflicts?.length) toast(`Stopped on conflicts in ${conflicts.length} file${conflicts.length > 1 ? 's' : ''}. Resolve them below.`, true);
      else toast(done?.(out as T) || what);
      return out as T;
    } catch (err) {
      const e = err as ApiError;
      setFailure({ what, message: e.message, git: e.git, op, body, retry: async () => void (await act(what, op, body, done)) });
      return undefined;
    } finally {
      setBusy(null);
      await reload();
    }
  };

  // Fetch in the background when the tab opens and the last fetch is old, so ahead/behind are real.
  const [autoFetched, setAutoFetched] = useState(false);
  useEffect(() => {
    if (!g || autoFetched || !g.remotes.length) return;
    setAutoFetched(true);
    if (g.fetchedAt && Date.now() - Date.parse(g.fetchedAt) < 5 * 60_000) return;
    void post(`${api}/fetch`)
      .then(() => reload())
      .catch((err: ApiError) => setFailure({ what: 'Fetching in the background', message: err.message, git: err.git, op: 'fetch', body: {}, retry: async () => void (await act('Fetched', 'fetch')) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, autoFetched]);

  // Proposals waiting in the helper, for the badge on its button.
  useEffect(() => {
    const look = () => void get<{ waiting: number }>(`/api/projects/${projectId}/git-helper`).then((r) => setWaiting(r.waiting)).catch(() => undefined);
    look();
    const t = window.setInterval(look, 4000);
    return () => window.clearInterval(t);
  }, [projectId]);

  const askHelper = (f?: Failure) => {
    setHelper(true);
    if (f) setSeed(`This failed in the Git tab: ${f.what.toLowerCase()}.\n\nError: ${f.message}${f.git?.command ? `\nCommand: ${f.git.command}` : ''}${f.git?.detail ? `\n\ngit said:\n${f.git.detail.slice(-3000)}` : ''}\n\nWhat happened, and how do I fix it?`);
  };

  if (error) return <div className="banner bad" style={{ margin: 20 }}>{error}</div>;
  if (!g) return <div className="faint" style={{ padding: 20 }}>Reading the repository…</div>;
  const current = g.branches.find((b) => b.current);
  const visible = g.branches.filter((b) => showRuns || !b.run || b.current);
  const runCount = g.branches.filter((b) => b.run).length;
  const remoteOnly = g.remoteBranches.filter((b) => !b.tracked);
  const hasRemote = g.remotes.length > 0;
  const diverged = !!current?.upstream && current.ahead > 0 && current.behind > 0;
  const staged = g.files.filter((f) => f.staged);
  const ask = (c: Confirm) => setConfirm(c);
  const working = !!busy;

  return (
    <div className="git-layout">
      <div style={{ flex: 1, overflowY: 'auto', padding: 20, minWidth: 0 }}>
        <div className="col" style={{ gap: 14, maxWidth: 1100, margin: '0 auto' }}>
          <div className="card card-pad git-head">
            <IconBranch width={16} height={16} />
            <select
              className="input"
              style={{ width: 'auto', minWidth: 180, maxWidth: 280 }}
              value={g.branch ?? ''}
              disabled={working}
              onChange={(e) => e.target.value && void act(`Switched to ${e.target.value}`, 'checkout', { branch: e.target.value })}
              aria-label="Current branch"
            >
              {g.detached && <option value="">(detached at {g.head?.slice(0, 7)})</option>}
              {!g.head && g.branch && !g.branches.some((b) => b.name === g.branch) && <option value={g.branch}>{g.branch} (no commits yet)</option>}
              <optgroup label="Branches">
                {g.branches
                  .filter((b) => !b.run || b.current)
                  .map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
              </optgroup>
              {remoteOnly.length > 0 && (
                <optgroup label="On the remote (switching makes a local branch)">
                  {remoteOnly.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span className="small muted num">
              {current?.upstream
                ? current.gone
                  ? `${current.upstream} was deleted on the remote`
                  : current.ahead || current.behind
                    ? `${current.ahead} to push · ${current.behind} to pull`
                    : `up to date with ${current.upstream}`
                : g.detached
                  ? 'not on a branch'
                  : hasRemote
                    ? 'not pushed yet'
                    : 'no remote'}
              {hasRemote && <span className="faint">{g.fetchedAt ? ` · fetched ${ago(g.fetchedAt)}` : ' · never fetched'}</span>}
            </span>
            <span className="grow" />
            {hasRemote && (
              <button className="btn sm" disabled={working} onClick={() => void act('Fetched from the remotes', 'fetch')} title="Get what is new on the remotes (changes nothing in your checkout)">
                <IconLoop /> {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
              </button>
            )}
            {current?.upstream && !current.gone && (
              <button
                className="btn sm"
                disabled={working || !current.behind}
                onClick={() => void act(diverged ? 'Pulled (your commits on top)' : 'Pulled', 'pull', { mode: diverged ? 'rebase' : 'ff' })}
                title={diverged ? 'Both sides have new commits: yours are replayed on top of the remote ones' : 'Bring in the commits from the remote'}
              >
                {busy === 'pull' ? 'Pulling…' : diverged ? 'Pull (rebase)' : 'Pull'}
              </button>
            )}
            {hasRemote && current && (
              <button className="btn sm" disabled={working} onClick={() => void act(`Pushed ${current.name}`, 'push', { branch: current.name })}>
                <IconUp /> {busy === 'push' ? 'Pushing…' : 'Push'}
              </button>
            )}
            <button className="btn sm" disabled={working} onClick={() => setNewBranch({})}>
              <IconPlus /> New branch
            </button>
            {g.pullRequests !== 'none' && current && current.name !== g.defaultBranch && (
              <button className="btn sm primary" disabled={working} onClick={() => setPr(current.name)}>
                Create pull request
              </button>
            )}
            <button className={`btn sm ${waiting ? 'primary' : ''}`} onClick={() => setHelper(true)} title="Ask the git helper">
              <IconSparkle /> Git helper{waiting ? <span className="badge">{waiting}</span> : null}
            </button>
          </div>

          {failure && <FailureBanner f={failure} g={g} busy={working} onClose={() => setFailure(null)} onAsk={() => askHelper(failure)} act={act} confirm={ask} />}
          {(!g.identity.name || !g.identity.email) && <IdentityForm identity={g.identity} busy={working} act={act} />}
          {g.operation && <OperationCard g={g} busy={working} act={act} confirm={ask} onDiff={setDiff} onAsk={() => { setHelper(true); setSeed(`A ${g.operation!.kind} is in progress (${g.operation!.subject}) with conflicts in: ${g.operation!.conflicts.join(', ') || 'none left'}. Please help me resolve it.`); }} />}

          <Changes
            g={g}
            busy={working}
            message={message}
            setMessage={setMessage}
            amend={amend}
            setAmend={setAmend}
            act={act}
            confirm={ask}
            onDiff={setDiff}
            onCommitted={() => {
              setMessage('');
              setAmend(false);
            }}
            staged={staged}
          />

          {g.stashes.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Stashes</h2>
                <span className="hint">changes you put aside; bring them back on any branch</span>
              </div>
              <table className="table">
                <tbody>
                  {g.stashes.map((s) => (
                    <tr key={s.ref}>
                      <td className="small ellipsis">{s.message}</td>
                      <td className="small faint" style={{ whiteSpace: 'nowrap' }}>{ago(s.date)}</td>
                      <td className="r" style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm ghost" disabled={working} onClick={() => void act('Brought the stash back and dropped it', 'stash/apply', { index: s.index, pop: true })}>
                          Pop
                        </button>
                        <button className="btn sm ghost" disabled={working} onClick={() => void act('Brought the stash back (it stays in the list)', 'stash/apply', { index: s.index, pop: false })}>
                          Apply
                        </button>
                        <button
                          className="btn sm ghost"
                          disabled={working}
                          onClick={() => ask({ title: 'Drop this stash?', text: `"${s.message}" is deleted for good, with the changes in it.`, action: 'Drop', danger: true, run: () => void act('Dropped the stash', 'stash/drop', { index: s.index }) })}
                        >
                          Drop
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h2>Branches</h2>
              <div className="right">
                {runCount > 0 && (
                  <label className="check small">
                    <input type="checkbox" checked={showRuns} onChange={(e) => setShowRuns(e.target.checked)} /> {runCount} run result{runCount > 1 ? 's' : ''}
                  </label>
                )}
                {g.remoteBranches.length > 0 && (
                  <label className="check small">
                    <input type="checkbox" checked={showRemote} onChange={(e) => setShowRemote(e.target.checked)} /> on the remote ({remoteOnly.length} not local)
                  </label>
                )}
              </div>
            </div>
            <table className="table">
              <tbody>
                {visible.map((b) => (
                  <tr key={b.name}>
                    <td style={{ width: '30%' }}>
                      <span className="row" style={{ gap: 6 }}>
                        <span className="mono ellipsis">{b.name}</span>
                        {b.current && <span className="pill info">current</span>}
                        {b.run && <span className="pill">run result</span>}
                        {b.gone && <span className="pill warn">deleted on remote</span>}
                      </span>
                    </td>
                    <td className="small muted ellipsis" title={b.subject}>
                      {b.subject} <span className="faint">· {ago(b.date)}</span>
                    </td>
                    <td className="small num faint" style={{ whiteSpace: 'nowrap' }}>
                      {b.upstream && !b.gone ? (b.ahead || b.behind ? `↑${b.ahead} ↓${b.behind}` : 'pushed') : 'local only'}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {!b.current && (
                        <button className="btn sm ghost" disabled={working} onClick={() => void act(`Switched to ${b.name}`, 'checkout', { branch: b.name })}>
                          Switch
                        </button>
                      )}
                      {!b.current && g.branch && (
                        <button className="btn sm ghost" disabled={working || !!g.operation} onClick={() => void act(`Merged ${b.name} into ${g.branch}`, 'merge', { branch: b.name })} title={`Merge ${b.name} into ${g.branch}`}>
                          Merge into {g.branch}
                        </button>
                      )}
                      {hasRemote && (
                        <button className="btn sm ghost" disabled={working} onClick={() => void act(`Pushed ${b.name}`, 'push', { branch: b.name })}>
                          Push
                        </button>
                      )}
                      {g.pullRequests !== 'none' && b.name !== g.defaultBranch && (
                        <button className="btn sm ghost" disabled={working} onClick={() => setPr(b.name)}>
                          PR
                        </button>
                      )}
                      <button className="btn sm ghost" disabled={working} onClick={() => setBranchMenu(b)} aria-label={`More for ${b.name}`} title="Rename, delete, rebase…">
                        ⋯
                      </button>
                    </td>
                  </tr>
                ))}
                {showRemote &&
                  g.remoteBranches.map((b) => (
                    <RemoteRow key={b.name} b={b} g={g} busy={working} act={act} confirm={ask} />
                  ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>History</h2>
              <span className="hint">newest first, every branch · click a commit to revert, cherry-pick, branch, tag or reset</span>
            </div>
            {g.commits.length ? <Graph commits={g.commits} remotes={g.remotes.map((r) => r.name)} onOpen={setCommit} /> : <Empty title="No commits yet" />}
          </div>

          <Remotes g={g} busy={working} act={act} confirm={ask} />
          <CommandBox projectId={projectId} onRan={reload} onAsk={(cmd, output) => { setHelper(true); setSeed(`I ran \`git ${cmd}\` and got:\n\n${output.slice(-3000)}\n\nWhat does it mean, and what should I do?`); }} />
        </div>
      </div>

      {helper && <GitHelper projectId={projectId} seed={seed} onSeeded={() => setSeed(undefined)} onClose={() => setHelper(false)} />}

      {newBranch && (
        <NewBranch
          from={newBranch.from ?? g.branch}
          onClose={() => setNewBranch(null)}
          onCreate={(name) => void act(`Created and switched to ${name}`, 'checkout', { branch: name, create: true, from: newBranch.from }).then(() => setNewBranch(null))}
        />
      )}
      {pr && <PrDialog projectId={projectId} branch={pr} base={g.defaultBranch} branches={g.branches.map((b) => b.name)} onClose={() => setPr(undefined)} onDone={reload} />}
      {commit && (
        <CommitDialog
          projectId={projectId}
          sha={commit}
          g={g}
          onClose={() => setCommit(undefined)}
          act={act}
          confirm={ask}
          onBranch={(sha) => (setCommit(undefined), setNewBranch({ from: sha }))}
        />
      )}
      {diff && <DiffDialog projectId={projectId} path={diff} onClose={() => setDiff(undefined)} />}
      {branchMenu && <BranchDialog b={branchMenu} g={g} onClose={() => setBranchMenu(undefined)} act={act} confirm={ask} />}
      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className={`btn ${confirm.danger ? 'danger' : 'primary'}`}
                autoFocus
                onClick={() => {
                  confirm.run();
                  setConfirm(null);
                }}
              >
                {confirm.action}
              </button>
            </>
          }
        >
          <p className="small" style={{ margin: 0 }}>
            {confirm.text}
          </p>
        </Modal>
      )}
    </div>
  );
}

type Act = <T = unknown>(what: string, op: string, body?: Record<string, unknown>, done?: (out: T) => string | void) => Promise<T | undefined>;

// ---- failures and the fixes that go with them

function FailureBanner({ f, g, busy, onClose, onAsk, act, confirm }: { f: Failure; g: GitOverview; busy: boolean; onClose: () => void; onAsk: () => void; act: Act; confirm: (c: Confirm) => void }) {
  const kind = f.git?.kind;
  const branch = typeof f.body.branch === 'string' ? f.body.branch : g.branch;
  const fixes: React.ReactNode[] = [];
  if (kind === 'dirty' && f.op === 'checkout')
    fixes.push(
      <button key="stash" className="btn sm primary" disabled={busy} onClick={() => void act(`Stashed your changes and switched to ${f.body.branch}`, 'checkout', { ...f.body, stash: true })}>
        Stash my changes and switch
      </button>,
    );
  else if (kind === 'dirty')
    fixes.push(
      <button key="stash" className="btn sm primary" disabled={busy} onClick={() => void act('Stashed your changes', 'stash', { message: `covibe: before ${f.what.toLowerCase()}` }).then(() => f.retry?.())}>
        Stash my changes and try again
      </button>,
    );
  if (kind === 'diverged' || (kind === 'rejected' && f.op === 'push' && !f.body.force)) {
    fixes.push(
      <button key="rebase" className="btn sm primary" disabled={busy} onClick={() => void act('Pulled with your commits on top', 'pull', { mode: 'rebase' }).then((o) => o && !(o as { conflicts: string[] }).conflicts.length && f.op === 'push' && f.retry?.())}>
        Pull with rebase{f.op === 'push' ? ', then push' : ''}
      </button>,
      <button key="merge" className="btn sm" disabled={busy} onClick={() => void act('Pulled with a merge commit', 'pull', { mode: 'merge' }).then((o) => o && !(o as { conflicts: string[] }).conflicts.length && f.op === 'push' && f.retry?.())}>
        Pull with a merge{f.op === 'push' ? ', then push' : ''}
      </button>,
    );
  }
  if (kind === 'rejected' && f.op === 'push' && !/remote rejected|protected|declined/.test(f.git?.detail ?? ''))
    fixes.push(
      <button
        key="force"
        className="btn sm danger"
        disabled={busy}
        onClick={() =>
          confirm({
            title: `Force-push ${branch}?`,
            text: `The remote's ${branch} is replaced by yours, and the commits only the remote has are gone for everyone. covibe uses --force-with-lease, so it refuses if someone pushed since your last fetch. Only do this if you rewrote your own commits (amend, rebase) on purpose.`,
            action: 'Force-push',
            danger: true,
            run: () => void act(`Force-pushed ${branch}`, 'push', { ...f.body, force: true }),
          })
        }
      >
        Force-push (with lease)…
      </button>,
    );
  if (kind === 'no_upstream' && g.branch)
    fixes.push(
      <button key="push" className="btn sm primary" disabled={busy} onClick={() => void act(`Pushed ${g.branch}`, 'push', { branch: g.branch })}>
        Push {g.branch} to connect it
      </button>,
    );
  if (kind === 'lock')
    fixes.push(
      <button key="unlock" className="btn sm" disabled={busy} onClick={() => void act('Removed the stale lock', 'unlock').then((o) => o && f.retry?.())}>
        Remove the stale lock and retry
      </button>,
    );
  if (kind === 'unmerged' && f.op === 'branch/delete')
    fixes.push(
      <button key="force" className="btn sm danger" disabled={busy} onClick={() => confirm({ title: `Delete ${f.body.branch} anyway?`, text: 'Its commits are not on any other branch and will be lost (git keeps them in the reflog for a while).', action: 'Delete', danger: true, run: () => void act(`Deleted ${f.body.branch}`, 'branch/delete', { ...f.body, force: true }) })}>
        Delete anyway…
      </button>,
    );
  if (kind === 'detached')
    fixes.push(
      <span key="detached" className="small muted">
        Pick a branch above, or use New branch to keep these commits.
      </span>,
    );
  return (
    <div className="banner bad git-failure">
      <IconAlert />
      <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
        <div>
          <strong>{f.what} failed.</strong> {f.message}.
        </div>
        {f.git?.hint && <div className="small">{f.git.hint}</div>}
        <div className="row wrap" style={{ gap: 6 }}>
          {fixes}
          {f.retry && !['identity', 'detached', 'no_remote'].includes(kind ?? '') && (
            <button className="btn sm" disabled={busy} onClick={() => void f.retry!()}>
              Try again
            </button>
          )}
          <button className="btn sm" onClick={onAsk}>
            <IconSparkle /> Ask the git helper
          </button>
          <button className="btn sm ghost" onClick={onClose}>
            Dismiss
          </button>
        </div>
        {f.git?.detail && (
          <details>
            <summary className="tiny faint">What git said{f.git.command ? ` (${f.git.command.length > 80 ? `${f.git.command.slice(0, 79)}…` : f.git.command})` : ''}</summary>
            <pre className="git-output">{f.git.detail}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function IdentityForm({ identity, busy, act }: { identity: GitOverview['identity']; busy: boolean; act: Act }) {
  const [name, setName] = useState(identity.name ?? '');
  const [email, setEmail] = useState(identity.email ?? '');
  const [global, setGlobal] = useState(true);
  return (
    <div className="banner warn">
      <IconAlert />
      <div className="col grow" style={{ gap: 8 }}>
        <div>
          <strong>git does not know who you are yet.</strong> Every commit records a name and an email; commits fail until they are set.
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <input className="input" style={{ width: 200 }} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <input className="input" style={{ width: 240 }} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
          <label className="check small">
            <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> for all my repositories
          </label>
          <button className="btn sm primary" disabled={busy || !name.trim() || !email.trim()} onClick={() => void act('Saved your name and email', 'identity', { name, email, global })}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- an operation in progress: merge, rebase, cherry-pick, revert

function OperationCard({ g, busy, act, confirm, onDiff, onAsk }: { g: GitOverview; busy: boolean; act: Act; confirm: (c: Confirm) => void; onDiff: (p: string) => void; onAsk: () => void }) {
  const op = g.operation!;
  const verb = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting', bisect: 'Bisecting', stash: 'Applying a stash' }[op.kind];
  return (
    <div className="card git-operation">
      <div className="card-head">
        <IconAlert width={15} height={15} style={{ color: 'var(--warn)' }} />
        <h2>
          {verb}: {op.subject}
        </h2>
        <span className="hint">{op.conflicts.length ? `${op.conflicts.length} conflict${op.conflicts.length > 1 ? 's' : ''} to resolve` : 'all conflicts resolved'}</span>
      </div>
      <div className="card-pad col" style={{ gap: 10 }}>
        {op.conflicts.length > 0 && (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              Both sides changed the same lines. For each file, keep one side, or edit the file in your editor (remove the {'<<<<<<<'} / {'>>>>>>>'} markers) and mark it resolved.
            </p>
            <div className="col" style={{ gap: 6 }}>
              {op.conflicts.map((p) => (
                <div key={p} className="row small git-conflict">
                  <span className="mono ellipsis grow" title={p}>
                    {p}
                  </span>
                  <button className="btn sm ghost" onClick={() => onDiff(p)}>
                    <IconCode /> View
                  </button>
                  <button className="btn sm" disabled={busy} onClick={() => void act(`Kept ${op.labels.current} for ${p}`, 'resolve', { path: p, how: 'current' })} title={`Keep the version from ${op.labels.current}`}>
                    Keep {op.labels.current}
                  </button>
                  <button className="btn sm" disabled={busy} onClick={() => void act(`Kept ${op.labels.incoming} for ${p}`, 'resolve', { path: p, how: 'incoming' })} title={`Keep the version from ${op.labels.incoming}`}>
                    Keep {op.labels.incoming}
                  </button>
                  <button className="btn sm" disabled={busy} onClick={() => void act(`Marked ${p} resolved`, 'resolve', { path: p, how: 'resolved' })} title="You edited it; take it as it is now">
                    <IconCheck /> Mark resolved
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="row wrap" style={{ gap: 6 }}>
          {op.kind !== 'stash' && op.kind !== 'bisect' && (
            <button className="btn sm primary" disabled={busy || op.conflicts.length > 0} onClick={() => void act(op.kind === 'merge' ? 'Merge committed' : `${verb} continued`, 'operation', { action: 'continue' })}>
              {op.kind === 'merge' ? 'Commit the merge' : 'Continue'}
            </button>
          )}
          {op.canSkip && (
            <button className="btn sm" disabled={busy} onClick={() => confirm({ title: 'Skip this commit?', text: 'The commit it stopped at is left out; the rest go on.', action: 'Skip', run: () => void act('Skipped the commit', 'operation', { action: 'skip' }) })}>
              Skip this commit
            </button>
          )}
          <button
            className="btn sm danger"
            disabled={busy}
            onClick={() =>
              confirm({ title: `Abort the ${op.kind}?`, text: 'Everything goes back to how it was before it started; resolutions you made here are lost.', action: 'Abort', danger: true, run: () => void act(`Aborted the ${op.kind}`, 'operation', { action: 'abort' }) })
            }
          >
            Abort
          </button>
          <button className="btn sm" onClick={onAsk}>
            <IconSparkle /> Ask the git helper to resolve it
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- uncommitted changes

function Changes({
  g,
  busy,
  message,
  setMessage,
  amend,
  setAmend,
  act,
  confirm,
  onDiff,
  onCommitted,
  staged,
}: {
  g: GitOverview;
  busy: boolean;
  message: string;
  setMessage: (m: string) => void;
  amend: boolean;
  setAmend: (a: boolean) => void;
  act: Act;
  confirm: (c: Confirm) => void;
  onDiff: (p: string) => void;
  onCommitted: () => void;
  staged: GitFile[];
}) {
  const files = g.files.filter((f) => f.state !== 'conflict');
  const lastPushed = g.branches.find((b) => b.current);
  const canUndo = !!g.head && !g.operation && g.commits.length > 1 && !(lastPushed?.upstream && lastPushed.ahead === 0);
  const commitAll = !staged.length;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Uncommitted changes</h2>
        <span className="hint">{files.length ? `${files.length} file${files.length > 1 ? 's' : ''}${staged.length ? `, ${staged.length} staged` : ''}` : 'none'}</span>
        <div className="right">
          {files.length > 0 && (
            <>
              <button className="btn sm ghost" disabled={busy} onClick={() => void act(staged.length === files.length ? 'Unstaged everything' : 'Staged everything', staged.length === files.length ? 'unstage' : 'stage', { paths: files.map((f) => f.path) })}>
                {staged.length === files.length ? 'Unstage all' : 'Stage all'}
              </button>
              <button className="btn sm ghost" disabled={busy} onClick={() => void act('Stashed your changes', 'stash', {})} title="Put the changes aside (Stashes) and get a clean checkout">
                Stash
              </button>
              <button
                className="btn sm ghost"
                disabled={busy}
                onClick={() => confirm({ title: 'Discard every change?', text: `All ${files.length} changed files go back to the last commit, and new files are deleted. This cannot be undone.`, action: 'Discard all', danger: true, run: () => void act('Discarded all changes', 'discard', { paths: files.map((f) => f.path) }) })}
              >
                Discard all
              </button>
            </>
          )}
        </div>
      </div>
      {files.length || amend ? (
        <div className="card-pad col" style={{ gap: 10 }}>
          <div className="git-files">
            {files.map((f) => (
              <div key={f.path} className="row small git-file">
                <input
                  type="checkbox"
                  checked={f.staged && !f.unstaged}
                  ref={(el) => {
                    if (el) el.indeterminate = f.staged && f.unstaged;
                  }}
                  disabled={busy}
                  onChange={() => void act(f.staged && !f.unstaged ? `Unstaged ${f.path}` : `Staged ${f.path}`, f.staged && !f.unstaged ? 'unstage' : 'stage', { paths: [f.path] })}
                  aria-label={`Stage ${f.path}`}
                  title={f.staged && !f.unstaged ? 'Staged: goes into the next commit' : 'Stage it for the next commit'}
                />
                <span className={`git-state ${f.state}`}>{f.state}</span>
                <button className="link mono ellipsis grow" onClick={() => onDiff(f.path)} title={f.from ? `${f.from} → ${f.path}` : `Show the changes in ${f.path}`}>
                  {f.path}
                </button>
                <button
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => confirm({ title: `Discard the changes to ${f.path}?`, text: f.state === 'new' ? 'The new file is deleted.' : 'It goes back to how it was in the last commit. This cannot be undone.', action: 'Discard', danger: true, run: () => void act(`Discarded ${f.path}`, 'discard', { paths: [f.path] }) })}
                  aria-label={`Discard ${f.path}`}
                  title="Discard the changes"
                >
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <textarea className="input grow" rows={2} placeholder={amend ? 'New message (empty keeps the old one)' : 'Commit message'} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" />
            <div className="col" style={{ gap: 6 }}>
              <button
                className="btn primary"
                disabled={busy || (!message.trim() && !amend) || !g.branch || !!g.operation?.conflicts.length}
                onClick={() => void act(amend ? 'Amended the last commit' : 'Committed', 'commit', { message, all: commitAll, amend }).then((o) => o && onCommitted())}
                title={g.branch ? (commitAll ? `Commit every change on ${g.branch}` : `Commit the ${staged.length} staged file(s) on ${g.branch}`) : 'Switch to a branch first'}
              >
                <IconCheck /> {amend ? 'Amend' : commitAll ? 'Commit all' : `Commit ${staged.length} staged`}
              </button>
            </div>
          </div>
          <div className="row wrap small" style={{ gap: 14 }}>
            {g.head && (
              <label className="check" title="Change the last commit instead of adding one; only for commits you have not pushed">
                <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend the last commit
              </label>
            )}
            <span className="faint">{commitAll ? 'Nothing staged: Commit takes every change.' : 'Only the checked files go into the commit.'}</span>
          </div>
        </div>
      ) : (
        <div className="card-pad row small muted" style={{ gap: 10 }}>
          <span className="grow">
            Your checkout is clean. Teams work in their own worktrees, so runs never change it; their results are on <span className="mono">covibe/…</span> branches.
          </span>
          {g.head && (
            <button className="btn sm ghost" disabled={busy} onClick={() => setAmend(true)} title="Change the message of the last commit">
              Amend last commit
            </button>
          )}
        </div>
      )}
      {canUndo && (
        <div className="card-pad tiny faint" style={{ paddingTop: 0 }}>
          <button
            className="link"
            disabled={busy}
            onClick={() => confirm({ title: 'Undo the last commit?', text: 'The commit is taken back; its changes stay here, staged, so you can change them and commit again.', action: 'Undo commit', run: () => void act('Took back the last commit; its changes are staged', 'commit/undo') })}
          >
            Undo the last commit
          </button>{' '}
          (it has not been pushed)
        </div>
      )}
    </div>
  );
}

// ---- branches

function RemoteRow({ b, g, busy, act, confirm }: { b: GitRemoteBranch; g: GitOverview; busy: boolean; act: Act; confirm: (c: Confirm) => void }) {
  return (
    <tr className="git-remote-row">
      <td>
        <span className="row" style={{ gap: 6 }}>
          <span className="mono ellipsis faint">{b.name}</span>
          <span className="pill">remote</span>
          {b.tracked && <span className="pill good">local too</span>}
        </span>
      </td>
      <td className="small muted ellipsis" title={b.subject}>
        {b.subject} <span className="faint">· {ago(b.date)}</span>
      </td>
      <td />
      <td className="r" style={{ whiteSpace: 'nowrap' }}>
        {!b.tracked && (
          <button className="btn sm ghost" disabled={busy} onClick={() => void act(`Switched to ${b.branch}`, 'checkout', { branch: b.name })} title={`Make a local ${b.branch} that tracks ${b.name}, and switch to it`}>
            Switch
          </button>
        )}
        {g.branch && (
          <button className="btn sm ghost" disabled={busy || !!g.operation} onClick={() => void act(`Merged ${b.name} into ${g.branch}`, 'merge', { branch: b.name })}>
            Merge into {g.branch}
          </button>
        )}
        <button
          className="btn sm ghost"
          disabled={busy}
          onClick={() => confirm({ title: `Delete ${b.branch} on ${b.remote}?`, text: `The branch is removed from the remote for everyone. Local branches stay.`, action: 'Delete on remote', danger: true, run: () => void act(`Deleted ${b.name}`, 'branch/delete', { branch: b.name, remote: true }) })}
          title="Delete it on the remote"
        >
          <IconTrash />
        </button>
      </td>
    </tr>
  );
}

function BranchDialog({ b, g, onClose, act, confirm }: { b: GitBranch; g: GitOverview; onClose: () => void; act: Act; confirm: (c: Confirm) => void }) {
  const [name, setName] = useState(b.name);
  return (
    <Modal title={<span className="mono">{b.name}</span>} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="col" style={{ gap: 14 }}>
        <label className="field">
          Rename
          <div className="row" style={{ gap: 6 }}>
            <input className="input mono grow" value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} />
            <button className="btn" disabled={!name.trim() || name === b.name} onClick={() => void act(`Renamed ${b.name} to ${name}`, 'branch/rename', { from: b.name, to: name }).then(onClose)}>
              Rename
            </button>
          </div>
          {b.upstream && <span className="help">The branch on the remote keeps its name; push again to create one under the new name.</span>}
        </label>
        {g.branch && !b.current && (
          <div className="row" style={{ gap: 10 }}>
            <span className="small grow">
              <strong>Rebase {g.branch} onto {b.name}</strong>
              <br />
              <span className="muted">Replay your commits on {g.branch} on top of {b.name}, for a straight history. Do not rebase commits others already pulled.</span>
            </span>
            <button className="btn" disabled={!!g.operation} onClick={() => void act(`Rebased ${g.branch} onto ${b.name}`, 'rebase', { onto: b.name }).then(onClose)}>
              Rebase
            </button>
          </div>
        )}
        <div className="row" style={{ gap: 10 }}>
          <span className="small grow">
            <strong>New branch from here</strong>
            <br />
            <span className="muted">Start a branch at {b.name}'s latest commit.</span>
          </span>
          <button className="btn" onClick={() => void act(`Created ${b.name}-copy`, 'checkout', { branch: `${b.name}-copy`, create: true, from: b.name }).then(onClose)}>
            Branch off
          </button>
        </div>
        {!b.current && (
          <div className="row" style={{ gap: 10 }}>
            <span className="small grow">
              <strong>Delete</strong>
              <br />
              <span className="muted">Only the local branch; {b.upstream ? 'the remote one stays.' : 'it was never pushed.'} Refused if its commits are on no other branch.</span>
            </span>
            <button className="btn danger" onClick={() => confirm({ title: `Delete ${b.name}?`, text: 'The local branch is deleted.', action: 'Delete', danger: true, run: () => void act(`Deleted ${b.name}`, 'branch/delete', { branch: b.name }).then(onClose) })}>
              Delete
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- remotes, tags and the command box

function Remotes({ g, busy, act, confirm }: { g: GitOverview; busy: boolean; act: Act; confirm: (c: Confirm) => void }) {
  const [adding, setAdding] = useState(!g.remotes.length);
  const [name, setName] = useState(g.remotes.length ? '' : 'origin');
  const [url, setUrl] = useState('');
  const [tag, setTag] = useState('');
  return (
    <div className="card">
      <div className="card-head">
        <h2>Remotes and tags</h2>
        <div className="right">
          {!adding && (
            <button className="btn sm ghost" onClick={() => setAdding(true)}>
              <IconPlus /> Add remote
            </button>
          )}
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 10 }}>
        {!g.remotes.length && <p className="small muted" style={{ margin: 0 }}>This repository has no remote yet. Add the URL from GitHub, GitLab or your server to push and pull.</p>}
        {g.remotes.map((r) => (
          <div key={r.name} className="row small" style={{ gap: 8 }}>
            <strong className="mono">{r.name}</strong>
            <span className="mono muted ellipsis grow" title={r.url}>
              {r.url}
            </span>
            {r.web && (
              <button className="btn sm ghost" onClick={() => openUrl(r.web!)}>
                Open
              </button>
            )}
            <button className="btn sm ghost" disabled={busy} onClick={() => confirm({ title: `Remove the remote ${r.name}?`, text: 'Only the connection in this checkout is removed; nothing on the server changes.', action: 'Remove', danger: true, run: () => void act(`Removed ${r.name}`, 'remote/remove', { name: r.name }) })}>
              Remove
            </button>
          </div>
        ))}
        {adding && (
          <div className="row wrap" style={{ gap: 6 }}>
            <input className="input mono" style={{ width: 120 }} placeholder="origin" value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="Remote name" />
            <input className="input mono grow" placeholder="git@github.com:you/app.git or https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Remote URL" />
            <button className="btn sm primary" disabled={busy || !name || !url.trim()} onClick={() => void act(`Added ${name}`, 'remote', { name, url }).then((o) => o && (setAdding(false), setUrl(''), setName('')))}>
              Add
            </button>
          </div>
        )}
        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
          <span className="small muted">Tags:</span>
          {g.tags.slice(0, 12).map((t) => (
            <span key={t.name} className="chip static mono">
              {t.name}
              {g.remotes.length > 0 && (
                <button disabled={busy} title={`Push ${t.name}`} onClick={() => void act(`Pushed ${t.name}`, 'tag/push', { name: t.name })}>
                  ↑
                </button>
              )}
              <button disabled={busy} title={`Delete ${t.name}`} onClick={() => confirm({ title: `Delete the tag ${t.name}?`, text: 'Only here; a pushed tag stays on the remote.', action: 'Delete', danger: true, run: () => void act(`Deleted ${t.name}`, 'tag/delete', { name: t.name }) })}>
                ×
              </button>
            </span>
          ))}
          {g.tags.length > 12 && <span className="small faint">+{g.tags.length - 12} more</span>}
          {g.head && (
            <>
              <input className="input mono" style={{ width: 140 }} placeholder="v1.0.0" value={tag} onChange={(e) => setTag(e.target.value.trim())} aria-label="New tag" />
              <button className="btn sm" disabled={busy || !tag} onClick={() => void act(`Tagged the current commit ${tag}`, 'tag', { name: tag }).then((o) => o !== undefined && setTag(''))}>
                Tag current commit
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CommandBox({ projectId, onRan, onAsk }: { projectId: string; onRan: () => unknown; onAsk: (command: string, output: string) => void }) {
  const [command, setCommand] = useState('');
  const [runs, setRuns] = useState<{ command: string; ok: boolean; output: string }[]>([]);
  const [running, setRunning] = useState(false);
  const runIt = async () => {
    const c = command.trim().replace(/^git\s+/, '');
    if (!c) return;
    setRunning(true);
    try {
      const r = await post<{ ok: boolean; output: string }>(`/api/projects/${projectId}/git/run`, { command: c });
      setRuns((x) => [{ command: c, ok: r.ok, output: r.output }, ...x].slice(0, 8));
      setCommand('');
    } catch (err) {
      setRuns((x) => [{ command: c, ok: false, output: (err as Error).message }, ...x].slice(0, 8));
    } finally {
      setRunning(false);
      await onRan();
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>Run a git command</h2>
        <span className="hint">anything git can do, in this checkout; it cannot ask for input (no editor, no password prompt)</span>
      </div>
      <div className="card-pad col" style={{ gap: 8 }}>
        <form
          className="row"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            void runIt();
          }}
        >
          <span className="mono muted">git</span>
          <input className="input mono grow" placeholder="log --oneline -10" value={command} onChange={(e) => setCommand(e.target.value)} aria-label="git command" />
          <button className="btn sm" disabled={running || !command.trim()}>
            {running ? 'Running…' : 'Run'}
          </button>
        </form>
        {runs.map((r, i) => (
          <details key={i} open={i === 0}>
            <summary className="small">
              <span className={r.ok ? 'faint' : 'text-bad'}>{r.ok ? '✓' : '×'}</span> <span className="mono">git {r.command}</span>
              {!r.ok && (
                <button className="link small" style={{ marginLeft: 8 }} onClick={() => onAsk(r.command, r.output)}>
                  Ask the git helper
                </button>
              )}
            </summary>
            <pre className="git-output">{r.output || '(no output)'}</pre>
          </details>
        ))}
      </div>
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
  // A file with conflicts shows as a combined diff: two columns of +/- before each line.
  const combined = patch.startsWith('diff --cc');
  const width = combined ? 2 : 1;
  const kind = (l: string) => {
    if (l.startsWith('diff --')) return 'file';
    if (l.startsWith('@@')) return 'hunk';
    const mark = l.slice(0, width);
    if (/^(<{7}|={7}|>{7})/.test(l.slice(width))) return 'hunk';
    if (l.startsWith('+++') || l.startsWith('---')) return '';
    if (mark.includes('+')) return 'add';
    if (mark.includes('-')) return 'del';
    return '';
  };
  return (
    <div className="card diff">
      {patch.split('\n').map((l, i) => (
        <div key={i} className={kind(l)}>
          {l.startsWith('diff --git') ? l.replace(/^diff --git a\/(\S+) b\/.*$/, '$1') : l.startsWith('diff --cc ') ? l.slice(10) : l || ' '}
        </div>
      ))}
    </div>
  );
}

function DiffDialog({ projectId, path, onClose }: { projectId: string; path: string; onClose: () => void }) {
  const { value, error } = useLive(() => get<{ patch: string }>(`/api/projects/${projectId}/git/diff?path=${encodeURIComponent(path)}`), [projectId, path]);
  return (
    <Modal huge title={<span className="mono">{path}</span>} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="banner bad">{error}</div>}
      {!value ? <span className="faint">Loading…</span> : value.patch.trim() ? <DiffLines patch={value.patch} /> : <span className="faint small">No changes to show (a binary file, or only its mode changed).</span>}
    </Modal>
  );
}

function CommitDialog({ projectId, sha, g, onClose, act, confirm, onBranch }: { projectId: string; sha: string; g: GitOverview; onClose: () => void; act: Act; confirm: (c: Confirm) => void; onBranch: (sha: string) => void }) {
  const { value, error } = useLive(() => get<{ header: string; patch: string; files: { path: string; additions: number; deletions: number }[] }>(`/api/projects/${projectId}/git/commits/${sha}`), [projectId, sha]);
  const [title, ...rest] = (value?.header ?? '').split('\n');
  const [tag, setTag] = useState('');
  const branch = g.branch;
  const short = sha.slice(0, 7);
  const done = (p: Promise<unknown>) => void p.then(onClose);
  return (
    <Modal
      wide
      title={<span className="mono">{sha.slice(0, 10)}</span>}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
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
          <div className="row wrap git-commit-actions" style={{ gap: 6 }}>
            {branch && (
              <>
                <button className="btn sm" disabled={!!g.operation} onClick={() => confirm({ title: `Revert ${short}?`, text: `Add a commit on ${branch} that undoes this one. History stays as it is, so this is safe on pushed commits.`, action: 'Revert', run: () => done(act(`Reverted ${short} with a new commit`, 'revert', { sha })) })}>
                  Revert
                </button>
                <button className="btn sm" disabled={!!g.operation} onClick={() => done(act(`Copied ${short} onto ${branch}`, 'cherry-pick', { sha }))} title={`Copy this commit onto ${branch}`}>
                  Cherry-pick onto {branch}
                </button>
              </>
            )}
            <button className="btn sm" onClick={() => onBranch(sha)}>
              <IconBranch /> New branch here
            </button>
            <button className="btn sm" onClick={() => done(act(`Checked out ${short} (not on a branch)`, 'checkout', { branch: sha }))} title="Look at the code as it was (detached HEAD)">
              Check out
            </button>
            {branch && (
              <button
                className="btn sm danger"
                onClick={() =>
                  confirm({
                    title: `Move ${branch} back to ${short}?`,
                    text: `${branch} will point at this commit; the commits after it leave the branch. Their changes stay in your checkout, unstaged (to throw them away instead, use the git helper or git reset --hard). Do not do this to commits you already pushed.`,
                    action: 'Reset',
                    danger: true,
                    run: () => done(act(`Moved ${branch} to ${short}; later changes are kept as uncommitted`, 'reset', { sha, mode: 'mixed' })),
                  })
                }
              >
                Reset {branch} to here…
              </button>
            )}
            <span className="row" style={{ gap: 4 }}>
              <input className="input mono" style={{ width: 110, height: 26 }} placeholder="tag" value={tag} onChange={(e) => setTag(e.target.value.trim())} aria-label="Tag name" />
              <button className="btn sm" disabled={!tag} onClick={() => done(act(`Tagged ${short} ${tag}`, 'tag', { name: tag, sha }))}>
                Tag
              </button>
            </span>
          </div>
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
  const fromSha = !!from && /^[0-9a-f]{7,40}$/.test(from);
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
        <span className="help">Starts from {fromSha ? `commit ${from!.slice(0, 7)}` : (from ?? 'the current commit')}; your uncommitted changes come along.</span>
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
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const create = async () => {
    setCreating(true);
    try {
      const res = await post<{ url: string; created: boolean }>(`/api/projects/${projectId}/git/pr`, { branch, base, title, body });
      toast(res.created ? 'Pull request created' : 'Pushed. Finish the pull request in your browser.');
      openUrl(res.url);
      await onDone?.();
      onClose();
    } catch (err) {
      setFailure(err as ApiError);
    } finally {
      setCreating(false);
    }
  };
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
      {failure && (
        <div className="banner bad small">
          <IconAlert />
          <div className="col" style={{ gap: 4 }}>
            <span>
              <strong>{failure.message}.</strong> {failure.git?.hint}
            </span>
            {failure.git?.detail && (
              <details>
                <summary className="tiny faint">What git said</summary>
                <pre className="git-output">{failure.git.detail}</pre>
              </details>
            )}
          </div>
        </div>
      )}
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
