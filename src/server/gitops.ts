// Git in a project's own checkout, for the app's Git tab and for shipping a
// run's result: status, branches, a graph of recent commits, and the few
// operations people do from there (commit, switch branch, push, pull, merge,
// revert, open a pull request). Everything shells out to git (and gh for pull
// requests, when it is installed and signed in).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, GitError } from '../engine/workspace.js';
import type { GitCommit, GitOverview } from './api-types.js';

const exec = promisify(execFile);
const SEP = '\x1f';
/** Branches covibe makes for each member's worktree; noise in the graph. */
const MEMBER_BRANCHES = 'covibe-agents/*';

/** Status, branches and the recent history of every branch, newest first. */
export async function gitOverview(repo: string, limit = 150): Promise<GitOverview> {
  const [head, status, branchRows, log, remotes] = await Promise.all([
    git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s.trim(), () => ''),
    git(repo, ['status', '--porcelain=v1', '-z']),
    git(repo, ['for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(upstream:track)${SEP}%(committerdate:iso-strict)${SEP}%(objectname:short)${SEP}%(contents:subject)`, 'refs/heads']),
    git(repo, ['log', `--exclude=${MEMBER_BRANCHES}`, '--branches', '--remotes', '--tags', 'HEAD', '--date-order', `-n${limit}`, `--format=%H${SEP}%P${SEP}%an${SEP}%aI${SEP}%s${SEP}%D`]).catch(() => ''),
    git(repo, ['remote', '-v']),
  ]);
  const commits: GitCommit[] = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, author, date, subject, refs] = line.split(SEP);
      return {
        sha: sha!,
        parents: parents ? parents.split(' ') : [],
        author: author ?? '',
        date: date ?? '',
        subject: subject ?? '',
        refs: refs ? refs.split(', ').filter((r) => !r.startsWith(MEMBER_BRANCHES.slice(0, -1))) : [],
      };
    });
  const branches = branchRows
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [name, upstream, track, date, sha, subject] = row.split(SEP);
      return {
        name: name!,
        current: name === head,
        upstream: upstream || undefined,
        ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
        gone: (track ?? '').includes('gone'),
        date: date ?? '',
        sha: sha ?? '',
        subject: subject ?? '',
        run: name!.startsWith('covibe/'),
      };
    })
    .filter((b) => !b.name.startsWith('covibe-agents/'));
  const remoteList = [...new Map(remotes.split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([n, url]) => [n!, { name: n!, url: url!, web: webUrl(url!) }])).values()];
  return {
    branch: head || undefined,
    detached: !head,
    files: parseStatus(status),
    branches,
    commits,
    remotes: remoteList,
    defaultBranch: await defaultBranch(repo, branches.map((b) => b.name)),
    pullRequests: await canCreatePr(repo),
  };
}

/** `git status --porcelain -z`: one entry per changed path. */
export function parseStatus(z: string): GitOverview['files'] {
  const out: GitOverview['files'] = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const x = p[0]!;
    const y = p[1]!;
    const path = p.slice(3);
    // Renames and copies carry the old path as the next entry.
    if (x === 'R' || x === 'C') i++;
    out.push({ path, staged: x !== ' ' && x !== '?', state: x === '?' ? 'new' : x === 'D' || y === 'D' ? 'deleted' : x === 'A' ? 'added' : x === 'R' ? 'renamed' : x === 'U' || y === 'U' ? 'conflict' : 'modified' });
  }
  return out;
}

/** A remote's web address (GitHub, GitLab, Bitbucket…), from its https or ssh URL. */
export function webUrl(remote: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://${m[1]}/${m[2]}` : undefined;
}

async function defaultBranch(repo: string, local: string[]): Promise<string | undefined> {
  const remoteHead = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).then((s) => s.trim().replace(/^origin\//, ''), () => '');
  if (remoteHead) return remoteHead;
  return ['main', 'master', 'trunk', 'develop'].find((b) => local.includes(b));
}

/** Pull requests go through gh when it is installed and the repository has a GitHub remote. */
async function canCreatePr(repo: string): Promise<'gh' | 'browser' | 'none'> {
  const remotes = await git(repo, ['remote', '-v']).catch(() => '');
  if (!remotes.trim()) return 'none';
  const gh = await exec('gh', ['--version'], { cwd: repo }).then(() => true, () => false);
  return gh && /github\.com/.test(remotes) ? 'gh' : 'browser';
}

/** One commit: header and patch (clipped). */
export async function gitShow(repo: string, sha: string): Promise<{ sha: string; header: string; patch: string; files: { path: string; additions: number; deletions: number }[] }> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new GitError(`not a commit: ${sha}`);
  const [header, numstat, patch] = await Promise.all([
    git(repo, ['show', '-s', '--format=%H%n%an <%ae>%n%aI%n%n%B', sha]),
    git(repo, ['show', '--numstat', '--format=', sha]),
    git(repo, ['show', '--format=', '--patch', sha]),
  ]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...path] = l.split('\t');
      return { path: path.join('\t'), additions: Number(add) || 0, deletions: Number(del) || 0 };
    });
  return { sha, header: header.trim(), files, patch: patch.length > 300_000 ? `${patch.slice(0, 300_000)}\n… (diff truncated)` : patch };
}

const branchName = (b: unknown, what = 'branch'): string => {
  const name = typeof b === 'string' ? b.trim() : '';
  if (!name || name.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{/.test(name)) throw new GitError(`"${name}" is not a valid ${what} name`);
  return name;
};

/** Commit everything that changed (or the given paths) with a message. */
export async function gitCommit(repo: string, message: string, paths?: string[]): Promise<string> {
  if (!message.trim()) throw new GitError('a commit needs a message');
  if (paths?.length) await git(repo, ['add', '-A', '--', ...paths]);
  else await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message.trim()]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

/** Switch branch, or create one (from `from`, or the current commit) and switch to it. */
export async function gitCheckout(repo: string, branch: string, create = false, from?: string): Promise<void> {
  const name = branchName(branch);
  if (create) await git(repo, ['switch', '-c', name, ...(from ? [branchName(from, 'start point')] : [])]);
  else await git(repo, ['switch', name]);
}

/** The remote to push to: the branch's own, else origin, else the only one. */
async function remoteFor(repo: string, branch: string): Promise<string> {
  const own = await git(repo, ['config', '--get', `branch.${branch}.remote`]).then((s) => s.trim(), () => '');
  if (own) return own;
  const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.length) throw new GitError('this repository has no remote to push to; add one with git remote add origin <url>');
  return remotes.includes('origin') ? 'origin' : remotes[0]!;
}

/** Push a branch (the current one by default) and track it. */
export async function gitPush(repo: string, branch?: string): Promise<{ branch: string; remote: string }> {
  const name = branch ? branchName(branch) : (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).trim();
  const remote = await remoteFor(repo, name);
  await git(repo, ['push', '--set-upstream', remote, `${name}:${name}`]);
  return { branch: name, remote };
}

/** Bring the current branch up to date with its upstream, fast-forward only. */
export async function gitPull(repo: string): Promise<void> {
  await git(repo, ['pull', '--ff-only']);
}

/** Merge a branch into the current one (a merge commit, so it can be reverted as one). */
export async function gitMerge(repo: string, branch: string): Promise<string> {
  const name = branchName(branch);
  const current = (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).trim();
  try {
    await git(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${name} into ${current}`, name]);
  } catch (err) {
    // Leave the checkout as it was rather than half-merged.
    await git(repo, ['merge', '--abort']).catch(() => undefined);
    throw new GitError(`could not merge ${name} into ${current}: ${(err as Error).message.split('\n').slice(-3).join(' ')} The merge was aborted; resolve it in your editor or terminal.`);
  }
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

/** Undo a commit with a new commit (merges are reverted against their first parent). */
export async function gitRevert(repo: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new GitError(`not a commit: ${sha}`);
  const parents = (await git(repo, ['rev-list', '--parents', '-n1', sha])).trim().split(' ').length - 1;
  try {
    await git(repo, ['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha]);
  } catch (err) {
    await git(repo, ['revert', '--abort']).catch(() => undefined);
    throw new GitError(`could not revert ${sha.slice(0, 7)} cleanly; nothing was changed. ${(err as Error).message.split('\n').at(-1)}`);
  }
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

/**
 * Open a pull request for a branch: push it, then create the PR with gh, or
 * hand back the page where the forge creates one (no gh, or gh not signed in).
 */
export async function gitPullRequest(repo: string, p: { branch: string; base: string; title: string; body?: string }): Promise<{ url: string; created: boolean }> {
  const branch = branchName(p.branch);
  const base = branchName(p.base, 'base branch');
  if (!p.title.trim()) throw new GitError('a pull request needs a title');
  const { remote } = await gitPush(repo, branch);
  const remoteUrl = (await git(repo, ['remote', 'get-url', remote])).trim();
  const web = webUrl(remoteUrl);
  if (/github\.com/.test(remoteUrl)) {
    try {
      const { stdout } = await exec('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', p.title.trim(), '--body', p.body?.trim() || ''], { cwd: repo });
      const url = stdout.trim().split('\n').at(-1)!;
      if (/^https?:\/\//.test(url)) return { url, created: true };
    } catch (err) {
      const msg = (err as { stderr?: string }).stderr ?? '';
      // An open PR for the branch already: hand that one back.
      const existing = /https:\/\/\S+\/pull\/\d+/.exec(msg)?.[0];
      if (existing) return { url: existing, created: false };
      // Otherwise (no gh, not signed in) fall through to the browser.
    }
  }
  if (!web) throw new GitError(`cannot tell where ${remoteUrl} opens pull requests`);
  const q = new URLSearchParams({ expand: '1', title: p.title.trim(), ...(p.body?.trim() ? { body: p.body.trim() } : {}) });
  const url = /gitlab/.test(web)
    ? `${web}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}&merge_request[target_branch]=${encodeURIComponent(base)}&merge_request[title]=${encodeURIComponent(p.title.trim())}`
    : `${web}/compare/${encodeURI(base)}...${encodeURI(branch)}?${q}`;
  return { url, created: false };
}
