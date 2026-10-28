import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Isolation } from '../config/types.js';
import { worktreesRoot } from '../home.js';
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

  static async create(repo: string, runId: string, isolation: Isolation, base = 'HEAD'): Promise<Workspace> {
    if (isolation === 'none') return new Workspace(repo, runId, isolation, repo, undefined);
    const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
    await git(top, ['rev-parse', '--verify', 'HEAD']).catch(() => {
      throw new GitError(`${top} has no commits yet; worktree isolation needs at least one commit.`);
    });
    const dir = join(worktreesRoot(top), runId, '_integration');
    mkdirSync(join(worktreesRoot(top), runId), { recursive: true });
    const branch = `covibe/${runId}`;
    await git(top, ['rev-parse', '--verify', `${base}^{commit}`]).catch(() => {
      throw new GitError(`cannot start from "${base}": no such branch or commit`);
    });
    await git(top, ['worktree', 'add', '-q', '-b', branch, dir, base]);
    return new Workspace(top, runId, isolation, dir, branch);
  }

  /** Reopen the workspace of an earlier run (to chat with its agents after it finished). */
  static async attach(repo: string, runId: string, isolation: Isolation, branch: string | undefined): Promise<Workspace> {
    if (isolation === 'none' || !branch) return new Workspace(repo, runId, 'none', repo, undefined);
    const base = runDir(repo, runId);
    const ws = new Workspace(repo, runId, isolation, join(base, '_integration'), branch);
    // Agents are known from their branches, so a cleaned-up worktree can be restored.
    const prefix = `covibe-agents/${runId}/`;
    const branches = await git(repo, ['branch', '--list', '--format=%(refname:short)', `${prefix}*`]).catch(() => '');
    for (const b of branches.split('\n').filter(Boolean)) ws.agentDirs.set(b.slice(prefix.length), join(base, b.slice(prefix.length)));
    return ws;
  }

  /**
   * Recreate a removed worktree at its old path from its branch (after
   * cleanup), so the agent's session, which is tied to that folder, resumes.
   */
  async restore(dir: string): Promise<void> {
    if (existsSync(dir) || this.isolation === 'none') return;
    const agent = [...this.agentDirs].find(([, d]) => d === dir)?.[0];
    const branch = dir === this.integrationDir ? this.branch : agent ? this.agentBranch(agent) : undefined;
    if (!branch) throw new GitError(`${dir} is not a worktree of run ${this.runId}`);
    await this.exclusive(() => this.addExisting(dir, branch));
  }

  /** Check out an existing branch as a worktree at `dir` (caller holds the lock). */
  private async addExisting(dir: string, branch: string) {
    await git(this.repo, ['worktree', 'prune']);
    mkdirSync(dirname(dir), { recursive: true });
    await git(this.repo, ['worktree', 'add', '-q', dir, branch]);
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
        dir = join(dirname(this.integrationDir), agent);
        await git(this.repo, ['worktree', 'add', '-q', '-b', this.agentBranch(agent), dir, this.branch!]);
        this.agentDirs.set(agent, dir);
      } else {
        await git(dir, ['merge', '-q', '--no-edit', this.branch!], commitEnv('covibe'));
      }
      return dir;
    });
  }

  /**
   * Bring an agent's worktree up to date with the integration branch while it
   * works (a teammate it asked for work merged changes). Its own uncommitted
   * changes stay; returns false when they are in the way and nothing merged.
   */
  async refresh(agent: string): Promise<boolean> {
    const dir = this.agentDirs.get(agent);
    if (this.isolation === 'none' || !dir) return true;
    return this.exclusive(async () => {
      try {
        await git(dir, ['merge', '-q', '--no-edit', this.branch!], commitEnv('covibe'));
        return true;
      } catch {
        await git(dir, ['merge', '--abort']).catch(() => undefined);
        return false;
      }
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
      // The integration worktree may have been cleaned up since the run ended.
      if (!existsSync(this.integrationDir)) await this.addExisting(this.integrationDir, this.branch!);
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

/** Folder holding a run's worktrees (older runs kept them inside the repository). */
export function runDir(repo: string, runId: string): string {
  const legacy = join(repo, '.covibe', 'worktrees', runId);
  return existsSync(legacy) ? legacy : join(worktreesRoot(repo), runId);
}

export interface RunWorktrees {
  runId: string;
  dir: string;
  worktrees: string[];
  sizeKb: number;
}

/** Runs of a repository that still have worktrees on disk, with their size. */
export async function listRunWorktrees(repo: string): Promise<RunWorktrees[]> {
  const out: RunWorktrees[] = [];
  for (const root of [worktreesRoot(repo), join(repo, '.covibe', 'worktrees')]) {
    if (!existsSync(root)) continue;
    for (const runId of readdirSync(root)) {
      const dir = join(root, runId);
      const worktrees = existsSync(dir) ? readdirSync(dir) : [];
      if (!worktrees.length) continue;
      out.push({ runId, dir, worktrees, sizeKb: await diskUsageKb(dir) });
    }
  }
  return out;
}

async function diskUsageKb(dir: string): Promise<number> {
  try {
    const { stdout } = await exec('du', ['-sk', dir], { maxBuffer: 1 << 20 });
    return Number(stdout.split(/\s/)[0]) || 0;
  } catch {
    return 0;
  }
}

/**
 * Remove a run's worktrees from disk. Branches stay: the result branch is the
 * run's output, and agent branches let a later chat restore a worktree.
 */
export async function removeRunWorktrees(repo: string, runId: string): Promise<{ removed: string[]; freedKb: number }> {
  const dir = runDir(repo, runId);
  if (!existsSync(dir)) return { removed: [], freedKb: 0 };
  const freedKb = await diskUsageKb(dir);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    await git(repo, ['worktree', 'remove', '--force', join(dir, name)]).catch(() => undefined);
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  rmSync(dir, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
  return { removed, freedKb };
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
