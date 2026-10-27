import { createHash } from 'node:crypto';
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

/** The project brain: notes every member reads and only the curator writes. */
export function brainRoot(repo: string): string {
  return join(covibeHome(), 'brains', repoKey(repo));
}
