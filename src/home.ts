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
  const id = createHash('sha1').update(repo).digest('hex').slice(0, 10);
  return join(covibeHome(), 'worktrees', `${basename(repo)}-${id}`);
}
