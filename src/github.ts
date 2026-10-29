// Shallow GitHub checkouts, shared by the skill and plugin libraries.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { covibeHome } from './home.js';

const exec = promisify(execFile);

export class GithubError extends Error {}

export interface GithubRef {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  /** A pinned commit (plugin marketplaces pin their sources). */
  sha?: string;
}

/**
 * Accepts https://github.com/o/r, …/tree/<ref>/<path>, …/blob/<ref>/<path>/SKILL.md, or o/r[/path].
 * A trailing SKILL.md, plugin.json or marketplace.json names the folder it is in.
 */
export function parseGithub(input: string): GithubRef {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const folder = (p: string | undefined) => (p ?? '').replace(/\/?(SKILL\.md|\.claude-plugin(\/(plugin|marketplace)\.json)?)$/, '');
  const url = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.*))?)?$/.exec(s);
  if (url) return { owner: url[1]!, repo: url[2]!, ref: url[3], path: folder(url[4]) };
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.*))?$/.exec(s);
  if (short) return { owner: short[1]!, repo: short[2]!, path: folder(short[3]) };
  throw new GithubError('Use a GitHub URL like https://github.com/owner/repo/tree/main/folder, or owner/repo');
}

// Checkouts leave Git LFS files as pointers: a failing LFS download (no git-lfs, a used-up
// quota, a proxy) must not fail the checkout. fetchLfs brings in the ones an install needs.
const NO_LFS = ['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false'];

export async function git(cwd: string, args: string[], timeout = 180_000): Promise<string> {
  try {
    return (await exec('git', [...NO_LFS, ...args], { cwd, maxBuffer: 32 << 20, timeout })).stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GithubError(`git ${args[0]}: ${(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}

const checkouts = new Map<string, { dir: string; commit: string; at: number }>();
const keyOf = (ref: Pick<GithubRef, 'owner' | 'repo' | 'ref' | 'sha'>) => `${ref.owner}/${ref.repo}@${ref.ref ?? ''}${ref.sha ? `#${ref.sha}` : ''}`;

/** A shallow, blobless, sparse clone: cheap even for big repositories. Reused for 10 minutes. */
export async function checkout(ref: GithubRef): Promise<{ dir: string; commit: string }> {
  const key = keyOf(ref);
  const cached = checkouts.get(key);
  if (cached && Date.now() - cached.at < 600_000 && existsSync(cached.dir)) return cached;
  const dir = join(covibeHome(), 'cache', 'github', `${ref.owner}__${ref.repo}__${(ref.sha ?? ref.ref ?? 'default').replace(/[^\w.-]/g, '_')}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const args = ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', ...(ref.ref ? ['--branch', ref.ref] : []), `https://github.com/${ref.owner}/${ref.repo}.git`, dir];
  await git(dirname(dir), args);
  if (ref.sha && !(await git(dir, ['rev-parse', 'HEAD'])).startsWith(ref.sha)) {
    await git(dir, ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref.sha]);
    await git(dir, ['checkout', '-q', 'FETCH_HEAD']);
  }
  const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const entry = { dir, commit, at: Date.now() };
  checkouts.set(key, entry);
  return entry;
}

/** Drop a cached checkout, so the next one fetches the latest commit. */
export function forgetCheckout(ref: Pick<GithubRef, 'owner' | 'repo' | 'ref' | 'sha'>) {
  checkouts.delete(keyOf(ref));
}

/** Check out only these files and folders (repository-relative; a folder ends in /). */
export async function sparse(dir: string, paths: string[]) {
  await git(dir, ['sparse-checkout', 'set', '--no-cone', ...paths.map((p) => (p === '' || p === '/' ? '/*' : `/${p.replace(/^\/+/, '')}`))]);
}

/** Most LFS content fetchLfs downloads; more than that is usually test media, not what a skill uses. */
const LFS_LIMIT = 50 << 20;

/** The size a Git LFS pointer file names, or undefined if the file is not one. */
function pointerSize(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const buf = Buffer.alloc(200);
  const fd = openSync(path, 'r');
  try {
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    const m = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:.*\n)*?size (\d+)$/m.exec(head);
    return m ? Number(m[1]) : undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Download the Git LFS files in these checked-out folders ('' for all), if git-lfs can and they
 * are small enough together. Best effort: files it cannot get stay pointers. Returns those.
 */
export async function fetchLfs(dir: string, folders: string[]): Promise<string[]> {
  const listed = (await git(dir, ['ls-files', '-z', '--', ...folders.map((f) => `:(attr:filter=lfs)${f.replace(/\/+$/, '')}`)])).split('\0').filter(Boolean);
  const pointers = listed.flatMap((file) => {
    const size = pointerSize(join(dir, file));
    return size === undefined ? [] : [{ file, size }];
  });
  if (!pointers.length) return [];
  if (pointers.reduce((n, p) => n + p.size, 0) <= LFS_LIMIT) {
    try {
      await git(dir, ['lfs', 'pull', `--include=${pointers.map((p) => p.file).join(',')}`], 120_000);
    } catch {
      // no git-lfs, or the download failed: keep the pointers
    }
  }
  return pointers.map((p) => p.file).filter((f) => pointerSize(join(dir, f)) !== undefined);
}
