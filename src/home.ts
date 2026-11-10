import { createHash } from 'node:crypto';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** covibe's own folder: teams library, settings and run worktrees. */
export function covibeHome(): string {
  return process.env.COVIBE_HOME ?? join(homedir(), '.covibe');
}

/**
 * Where a repository's run worktrees live. Outside the repository on purpose:
 * an agent working in the repo (or in its own worktree) must not find, read
 * or write other agents' worktrees by walking the tree.
 */
export function worktreesRoot(repo: string): string {
  return join(covibeHome(), 'worktrees', repoKey(repo));
}

/** A readable, collision-free folder name for a repository. */
export function repoKey(repo: string): string {
  return `${basename(repo)}-${createHash('sha1').update(repo).digest('hex').slice(0, 10)}`;
}

/**
 * Where runs in a plain folder (no git) keep their record of what changed and
 * the copies of the files as they were, so a run can be undone.
 */
export function folderRunsRoot(folder: string): string {
  return join(covibeHome(), 'folder-runs', repoKey(folder));
}

/** Where a project's running apps keep their state and logs (see apps/manager.ts). */
export function appsRoot(repo: string): string {
  return join(covibeHome(), 'apps', repoKey(repo));
}

/** The project brain: notes every member reads and only the curator writes. */
export function brainRoot(repo: string): string {
  return join(covibeHome(), 'brains', repoKey(repo));
}

/**
 * Replace a file's contents in one step: written next to it, then moved into
 * place. A stop halfway never leaves half a file, which the readers of these
 * files (connections, keys) would take for an empty one and write back.
 */
export function replaceFile(file: string, text: string, mode?: number): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? {} : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, file);
}
