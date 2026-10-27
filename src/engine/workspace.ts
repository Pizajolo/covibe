import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Isolation } from '../config/types.js';
import { scopeMatcher } from './scope.js';

const exec = promisify(execFile);

export class GitError extends Error {}

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(' ')}: ${(e.stderr || e.message).trim()}`);
  }
}

export interface CollectResult {
  commit?: string;
  files: string[];
  /** Changed paths outside the write scope, discarded before merging. */
  reverted: string[];
  merged: boolean;
}

/**
 * Where agents work. In worktree mode every writing agent gets its own git
 * worktree and branch; the engine (not a model) commits each agent's work and
 * merges it into the run's integration branch, which read-only agents (manager,
 * QA) look at. In "none" mode everyone shares the repository checkout.
 */
export class Workspace {
  private agentDirs = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly repo: string,
    readonly runId: string,
    readonly isolation: Isolation,
    /** Directory read-only agents run in; the merged state of the run. */
    readonly integrationDir: string,
    /** Branch holding the merged result (worktree mode). */
    readonly branch: string | undefined,
  ) {}

  static async create(repo: string, runId: string, isolation: Isolation): Promise<Workspace> {
    if (isolation === 'none') return new Workspace(repo, runId, isolation, repo, undefined);
    const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
    await git(top, ['rev-parse', '--verify', 'HEAD']).catch(() => {
      throw new GitError(`${top} has no commits yet; worktree isolation needs at least one commit.`);
    });
    const root = join(top, '.covibe');
    mkdirSync(root, { recursive: true });
    // Keep covibe's own state (worktrees, database) out of the user's git status.
    if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), '*\n');
    const dir = join(root, 'worktrees', runId, '_integration');
    const branch = `covibe/${runId}`;
    await git(top, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
    return new Workspace(top, runId, isolation, dir, branch);
  }

  /** Reopen the workspace of an earlier run (to chat with its agents after it finished). */
  static attach(repo: string, runId: string, isolation: Isolation, branch: string | undefined): Workspace {
    if (isolation === 'none' || !branch) return new Workspace(repo, runId, 'none', repo, undefined);
    const base = join(repo, '.covibe', 'worktrees', runId);
    const ws = new Workspace(repo, runId, isolation, join(base, '_integration'), branch);
    if (existsSync(base)) {
      for (const name of readdirSync(base)) if (name !== '_integration') ws.agentDirs.set(name, join(base, name));
    }
    return ws;
  }

  /** Serialize git operations that touch shared refs. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private agentBranch(agent: string) {
    return `covibe-agents/${this.runId}/${agent}`;
  }

  /** The directory an agent works in, brought up to date with the integration branch. */
  async prepare(agent: string, writes: boolean): Promise<string> {
    if (this.isolation === 'none' || !writes) return this.integrationDir;
    return this.exclusive(async () => {
      let dir = this.agentDirs.get(agent);
      if (!dir) {
        dir = join(this.repo, '.covibe', 'worktrees', this.runId, agent);
        await git(this.repo, ['worktree', 'add', '-q', '-b', this.agentBranch(agent), dir, this.branch!]);
        this.agentDirs.set(agent, dir);
      } else {
        await git(dir, ['merge', '-q', '--no-edit', this.branch!], commitEnv('covibe'));
      }
      return dir;
    });
  }

  /**
   * Commit what an agent changed, discard anything outside its write scope,
   * and merge the result into the integration branch.
   */
  async collect(agent: string, writeScope: string[] | undefined, message: string): Promise<CollectResult> {
    const dir = this.agentDirs.get(agent);
    if (this.isolation === 'none' || !dir) return { files: [], reverted: [], merged: false };
    return this.exclusive(async () => {
      await git(dir, ['add', '-A']);
      const files = (await git(dir, ['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0').filter(Boolean);
      const inScope = scopeMatcher(writeScope);
      const reverted = files.filter((f) => !inScope(f));
      for (const f of reverted) {
        const tracked = await git(dir, ['cat-file', '-e', `HEAD:${f}`]).then(() => true, () => false);
        if (tracked) await git(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f]);
        else {
          await git(dir, ['rm', '-q', '--cached', '--', f]);
          rmSync(join(dir, f), { force: true });
        }
      }
      const kept = files.filter((f) => inScope(f));
      if (!kept.length) return { files: [], reverted, merged: false };
      await git(dir, ['commit', '-q', '-m', message], commitEnv(agent));
      const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      try {
        await git(this.integrationDir, ['merge', '-q', '--no-ff', '--no-edit', '-m', `merge ${agent}: ${message}`, this.agentBranch(agent)], commitEnv('covibe'));
      } catch (err) {
        await git(this.integrationDir, ['merge', '--abort']).catch(() => undefined);
        throw err;
      }
      return { commit, files: kept, reverted, merged: true };
    });
  }
}

function commitEnv(name: string): NodeJS.ProcessEnv {
  const id = { name: `covibe/${name}`, email: 'covibe@localhost' };
  return {
    ...process.env,
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
  };
}
