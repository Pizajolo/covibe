// After a run: bring its result where it belongs. Merge the result branch into
// your branch, push it, or open a pull request.
import { useState } from 'react';
import { post, type RunSummary } from '../api';
import { money } from '../format';
import { PrDialog, useGit } from '../pages/GitView';
import { IconBranch, IconCheck, IconUp } from './icons';
import { Modal, useAction, useToast } from './ui';

const SEEN_KEY = 'covibe-shipped';

/** Whether the dialog already opened on its own for this run (a per-viewer convenience). */
export function askedToShip(runId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]).includes(runId);
  } catch {
    return true;
  }
}

export function markAskedToShip(runId: string) {
  try {
    const seen = (JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]).filter((id) => id !== runId).slice(-200);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, runId]));
  } catch {
    // storage unavailable: the dialog may ask again next time
  }
}

export function ShipDialog({ projectId, run, onClose }: { projectId: string; run: RunSummary; onClose: () => void }) {
  const { value: g, error, reload } = useGit(projectId);
  const toast = useToast();
  const [done, setDone] = useState<string[]>([]);
  const [pushAfter, setPushAfter] = useState(true);
  const [pr, setPr] = useState(false);
  const branch = run.branch!;
  const api = `/api/projects/${projectId}/git`;

  const [merge, merging] = useAction(async () => {
    await post(`${api}/merge`, { branch });
    const steps = [`Merged into ${g!.branch}`];
    if (pushAfter && g!.remotes.length) {
      await post(`${api}/push`, { branch: g!.branch });
      steps.push(`pushed ${g!.branch}`);
    }
    toast(steps.join(', '));
    setDone((d) => [...d, ...steps]);
    await reload();
  });
  const [push, pushing] = useAction(async () => {
    await post(`${api}/push`, { branch });
    toast(`Pushed ${branch}`);
    setDone((d) => [...d, `Pushed ${branch}`]);
    await reload();
  });

  const busy = merging || pushing;
  const result = g?.branches.find((b) => b.name === branch);
  const merged = !!g && !!g.branch && done.some((d) => d.startsWith('Merged'));
  const base = run.base && g?.branches.some((b) => b.name === run.base) ? run.base : g?.defaultBranch;
  const body = [
    run.goal,
    '',
    `Made by the ${run.team} team in covibe: ${run.filesChanged.length} file${run.filesChanged.length === 1 ? '' : 's'} changed, about ${money(run.costUsd)} of usage.`,
    ...(run.filesChanged.length ? ['', ...run.filesChanged.slice(0, 30).map((f) => `- \`${f}\``)] : []),
  ].join('\n');

  return (
    <>
      <Modal
        title="The team is done. What next?"
        onClose={onClose}
        footer={
          <button className="btn" onClick={onClose}>
            {done.length ? 'Done' : 'Later'}
          </button>
        }
      >
        <p className="small" style={{ margin: 0 }}>
          The result is committed on <span className="mono">{branch}</span> ({run.filesChanged.length} file{run.filesChanged.length === 1 ? '' : 's'} changed). Your
          checkout is untouched until you merge it.
        </p>
        {error && <div className="banner bad small">{error}</div>}
        {!g ? (
          <span className="faint small">Reading the repository…</span>
        ) : !result ? (
          <div className="banner warn small">The branch {branch} is gone, so there is nothing to ship.</div>
        ) : (
          <div className="ship-options">
            <div className="ship-option">
              <IconBranch />
              <div className="grow">
                <strong>Merge into {g.branch ?? 'your branch'}</strong>
                <div className="tiny muted">
                  A merge commit on {g.branch ?? 'the current branch'} in your checkout{g.files.length ? `; you have ${g.files.length} uncommitted change${g.files.length > 1 ? 's' : ''}, which git keeps if they do not overlap` : ''}.
                </div>
                {g.remotes.length > 0 && (
                  <label className="check tiny" style={{ marginTop: 4 }}>
                    <input type="checkbox" checked={pushAfter} onChange={(e) => setPushAfter(e.target.checked)} /> then push {g.branch}
                  </label>
                )}
              </div>
              <button className="btn primary" disabled={busy || !g.branch || merged} onClick={() => void merge()}>
                {merged ? <IconCheck /> : null} {merged ? 'Merged' : 'Merge'}
              </button>
            </div>
            {g.pullRequests !== 'none' && (
              <div className="ship-option">
                <IconUp />
                <div className="grow">
                  <strong>Open a pull request</strong>
                  <div className="tiny muted">Push {branch} and propose it into {base ?? 'your main branch'} for review.</div>
                </div>
                <button className="btn" disabled={busy} onClick={() => setPr(true)}>
                  Pull request…
                </button>
              </div>
            )}
            {g.remotes.length > 0 && (
              <div className="ship-option">
                <IconUp />
                <div className="grow">
                  <strong>Just push the branch</strong>
                  <div className="tiny muted">Put {branch} on {g.remotes[0]!.name} without merging.</div>
                </div>
                <button className="btn" disabled={busy || done.includes(`Pushed ${branch}`)} onClick={() => void push()}>
                  Push
                </button>
              </div>
            )}
            {!g.remotes.length && <span className="tiny faint">This repository has no remote, so there is nothing to push to.</span>}
          </div>
        )}
        {done.length > 0 && (
          <div className="banner good small">
            <IconCheck />
            <span>{done.join(' · ')}</span>
          </div>
        )}
        <span className="tiny faint">Everything else (commit, switch branch, revert) is in the project's Git tab.</span>
      </Modal>
      {pr && g && (
        <PrDialog
          projectId={projectId}
          branch={branch}
          base={base}
          branches={g.branches.map((b) => b.name)}
          title={run.goal.length > 72 ? `${run.goal.slice(0, 71)}…` : run.goal}
          body={body}
          onClose={() => setPr(false)}
          onDone={() => setDone((d) => [...d, 'Pull request opened'])}
        />
      )}
    </>
  );
}
