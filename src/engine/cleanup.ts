import type { EventStore } from '../events/store.js';
import { appHub } from '../apps/manager.js';
import type { RunStatus } from '../events/types.js';
import { listRunWorktrees, removeRunWorktrees } from './workspace.js';

export interface WorktreeInfo {
  runId: string;
  goal?: string;
  status?: RunStatus;
  live: boolean;
  finishedAt?: string;
  sizeKb: number;
  worktrees: string[];
}

export interface CleanupResult {
  cleaned: { runId: string; freedKb: number }[];
  skipped: { runId: string; reason: string }[];
  freedKb: number;
}

/** A repository's run worktrees on disk, joined with what the store knows about each run. */
export async function worktreeReport(repo: string, store: EventStore): Promise<WorktreeInfo[]> {
  const runs = await listRunWorktrees(repo);
  return runs
    .map((w) => {
      const run = store.getRun(w.runId);
      return {
        runId: w.runId,
        goal: run?.goal,
        status: run?.status,
        live: run ? store.isLive(run) : false,
        finishedAt: run?.finishedAt,
        sizeKb: w.sizeKb,
        worktrees: w.worktrees,
      };
    })
    .sort((a, b) => b.runId.localeCompare(a.runId));
}

/**
 * Remove worktrees of finished runs: the given runs, or all finished more than
 * `olderThanDays` ago (0 = all finished). Live runs are never touched.
 */
export async function cleanupWorktrees(repo: string, store: EventStore, opts: { runIds?: string[]; olderThanDays?: number; dryRun?: boolean } = {}): Promise<CleanupResult> {
  const cutoff = opts.olderThanDays === undefined ? undefined : Date.now() - opts.olderThanDays * 86_400_000;
  const result: CleanupResult = { cleaned: [], skipped: [], freedKb: 0 };
  for (const w of await worktreeReport(repo, store)) {
    if (opts.runIds && !opts.runIds.includes(w.runId)) continue;
    if (w.live) {
      result.skipped.push({ runId: w.runId, reason: 'still running' });
      continue;
    }
    if (cutoff !== undefined && w.finishedAt && Date.parse(w.finishedAt) > cutoff) {
      result.skipped.push({ runId: w.runId, reason: 'finished recently' });
      continue;
    }
    if (opts.dryRun) {
      result.cleaned.push({ runId: w.runId, freedKb: w.sizeKb });
      result.freedKb += w.sizeKb;
      continue;
    }
    // An app running from the run's files would lose them.
    await appHub.stopRun(repo, w.runId, "its run's worktrees were removed to free disk space").catch(() => undefined);
    const { removed, freedKb } = await removeRunWorktrees(repo, w.runId);
    result.cleaned.push({ runId: w.runId, freedKb });
    result.freedKb += freedKb;
    if (store.getRun(w.runId)) store.append(w.runId, { type: 'workspace.cleaned', data: { removed, freed_kb: freedKb } });
  }
  return result;
}
