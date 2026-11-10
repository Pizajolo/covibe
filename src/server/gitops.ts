// Git in a project's own checkout, for the app's Git tab, the git helper and
// shipping a run's result: status, branches (local and remote), a graph of
// recent commits, stashes, an operation in progress with its conflicts, and
// the operations people do from there. Everything shells out to git (and gh
// for pull requests, when it is installed and signed in).
//
// Every command runs through run(): no terminal (git or ssh can never sit
// waiting for a password nobody sees), no editor, English output (so errors
// can be explained), no optional locks for reads (so refreshing the tab never
// trips up a commit), retries when another git program holds the index lock,
// and a time limit. Failures become GitProblems: what went wrong in plain
// words, a hint on what to do, and git's own output.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { GitError } from '../engine/workspace.js';
import type { GitCommit, GitFile, GitOperation, GitOverview, GitProblemKind, GitRemoteBranch } from './api-types.js';

const SEP = '\x1f';
/** Branches covibe makes for each member's worktree; noise in the graph. */
const MEMBER_BRANCHES = 'covibe-agents/*';
const LOCAL_TIMEOUT = 2 * 60_000;
const NETWORK_TIMEOUT = 10 * 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

/** A git command that failed, explained. */
export class GitProblem extends GitError {
  constructor(
    message: string,
    readonly kind: GitProblemKind,
    readonly hint?: string,
    /** What git printed. */
    readonly detail?: string,
    /** The command, as `git …`. */
    readonly command?: string,
  ) {
    super(message);
  }
}

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The environment git runs in: nothing may wait for a person at a terminal. */
export function gitEnv(read = false): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
    LANGUAGE: 'C',
    ...(read ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  };
}

const NETWORK_COMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule', 'lfs']);
const LOCKED = /index\.lock': File exists|Unable to create '.*\.lock'|cannot lock ref/;

/**
 * Run a program (git by default) in `repo` and return what happened, without
 * throwing. Detached from any terminal; retries a few times while another git
 * program holds a lock.
 */
export async function runCommand(repo: string, args: string[], opts: { program?: string; read?: boolean; timeout?: number } = {}): Promise<RunResult> {
  const program = opts.program ?? 'git';
  const timeout = opts.timeout ?? (program === 'git' && NETWORK_COMMANDS.has(args[0] ?? '') ? NETWORK_TIMEOUT : LOCAL_TIMEOUT);
  for (let attempt = 0; ; attempt++) {
    const result = await new Promise<RunResult>((done) => {
      // detached: a session of its own, so there is no terminal for git or ssh to prompt on.
      const child = spawn(program, args, { cwd: repo, env: gitEnv(opts.read), detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      const keep = (into: Buffer[]) => (b: Buffer) => {
        size += b.length;
        if (size <= MAX_OUTPUT) into.push(b);
      };
      child.stdout.on('data', keep(out));
      child.stderr.on('data', keep(err));
      const timer = setTimeout(() => {
        timedOut = true;
        // The whole group: git and anything it started (ssh, hooks).
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }, timeout);
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        done({ ok: false, code: 127, stdout: '', stderr: e.code === 'ENOENT' ? `${program}: command not found` : e.message, timedOut: false });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ ok: code === 0 && !timedOut, code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
      });
    });
    if (result.ok || attempt >= 4 || !LOCKED.test(result.stderr)) return result;
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
}

/** Run git and return its output; throws a GitProblem when it fails. */
export async function run(repo: string, args: string[], opts: { read?: boolean; timeout?: number } = {}): Promise<string> {
  const r = await runCommand(repo, args, opts);
  if (!r.ok) throw problem(args, r);
  return r.stdout;
}

const read = (repo: string, args: string[]) => run(repo, args, { read: true });
const tryRead = (repo: string, args: string[]) => read(repo, args).catch(() => '');

/** Turn a failed command into a GitProblem: what happened, in plain words, and what to do. */
export function problem(args: string[], r: Pick<RunResult, 'stdout' | 'stderr' | 'timedOut'>, program = 'git'): GitProblem {
  const out = `${r.stderr}\n${r.stdout}`.trim();
  const command = `${program} ${args.join(' ')}`;
  const detail = out.length > 6000 ? `…${out.slice(-6000)}` : out;
  const lines = out.split('\n').map((l) => l.trim());
  const said =
    lines.filter((l) => /^(fatal|error):/.test(l)).map((l) => l.replace(/^(fatal|error):\s*/, '')).join(' ') ||
    lines.filter((l) => /^(CONFLICT|!)/.test(l)).join(' ') ||
    lines.filter(Boolean).at(-1) ||
    'it failed';
  const remoteHttps = /https?:\/\//.test(out);
  const p = (kind: GitProblemKind, message: string, hint?: string) => new GitProblem(message, kind, hint, detail, command);
  if (r.timedOut) return p('timeout', `${command} took too long and was stopped`, 'A network command may be waiting on the remote, or the repository is very large. Try again; if it keeps happening, run it in a terminal to see where it hangs.');
  if (/command not found/.test(out)) return p('not_found', `${program} is not installed or not on the PATH`, program === 'gh' ? 'Install the GitHub CLI (brew install gh) and sign in with gh auth login.' : 'Install git (on a Mac: xcode-select --install).');
  if (LOCKED.test(out))
    return p('lock', 'Another git program is working in this repository, or one stopped and left its lock file behind', 'Wait a moment and try again. If no other git program is running (an editor, a terminal, a GUI), the lock is stale: remove it (the git helper can do that).');
  if (/Please tell me who you are|Author identity unknown|Committer identity unknown|empty ident name|unable to auto-detect email|auto-detection is disabled|no (name|email) was given/.test(out))
    return p('identity', 'git does not know your name and email yet', 'Set them once (for this repository or for all of them); every commit records them.');
  if (/gpg failed to sign|cannot run gpg|error: cannot run ssh-keygen|failed to sign|signing failed/i.test(out))
    return p('signing', 'Signing the commit failed', 'Your git config signs commits (commit.gpgsign), and the signing program could not ask for your passphrase here. Unlock the key in a terminal first (or use an agent such as gpg-agent with pinentry-mac), or turn signing off for this repository.');
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]|Permission denied \(publickey|Host key verification failed|Could not read from remote repository|denied to |Permission to .* denied/.test(out))
    return p(
      'auth',
      'git could not sign in to the remote',
      remoteHttps || /Username|Password|HTTP/.test(out)
        ? 'covibe cannot type a password for git. Sign in once so git remembers it: for GitHub run gh auth login and then gh auth setup-git in a terminal; elsewhere push once from a terminal so your credential helper (the macOS Keychain) saves it. Or switch the remote to SSH.'
        : 'Your SSH key was not accepted or is not loaded. Add it to your SSH agent (ssh-add, or UseKeychain on a Mac), make sure the account has it, and connect once in a terminal (for example ssh -T git@github.com) to accept the host key.',
    );
  if (/Could not resolve host|Connection timed out|Connection refused|Network is unreachable|Operation timed out|unable to access|Could not connect|SSL certificate problem|The remote end hung up unexpectedly/.test(out))
    return p('network', `Could not reach the remote: ${said}`, 'Check your connection (and VPN or proxy), then try again.');
  if (/would be overwritten by (checkout|merge|switch)|Your local changes to the following files would be overwritten|Please commit your changes or stash them|untracked working tree files would be overwritten|cannot (pull|rebase) with uncommitted changes|You have unstaged changes|contains uncommitted changes/.test(out))
    return p('dirty', 'Your uncommitted changes are in the way', 'Commit or stash them first. Stashing puts them aside so you can bring them back on any branch.');
  if (/You have not concluded your merge|MERGE_HEAD exists|rebase-merge.*directory|It seems that there is already a rebase|cherry-pick is already in progress|revert is already in progress|you are in the middle of|Cannot do .* in the middle|You are currently (rebasing|cherry-picking|reverting|bisecting)/.test(out))
    return p('in_progress', 'Another operation (a merge, rebase, cherry-pick or revert) is still in progress', 'Finish it (resolve the conflicts and continue) or abort it first.');
  if (/CONFLICT|Automatic merge failed|could not apply|after resolving the conflicts|fix conflicts and then|Resolve all conflicts|needs merge|unmerged files|you need to resolve your current index first/.test(out))
    return p('conflict', 'There are conflicts to resolve', 'Choose a version for each conflicted file, or edit it, mark it resolved and continue. Or abort to go back to where you were.');
  if (/Not possible to fast-forward|have diverged|Need to specify how to reconcile divergent branches|divergent branches/.test(out))
    return p('diverged', 'Your branch and the remote both have new commits', 'Pull with rebase (your commits go on top of the remote ones; keeps history straight) or with a merge commit.');
  if (/\[rejected\]|\[remote rejected\]|failed to push some refs|Updates were rejected|non-fast-forward|fetch first|stale info/.test(out))
    return /stale info/.test(out)
      ? p('rejected', 'The remote branch changed since you last fetched, so the force push was refused', 'Fetch, look at what is new on the remote, then decide again.')
      : /remote rejected|protected branch|pre-receive hook declined/.test(out)
        ? p('rejected', `The remote refused the push: ${said}`, 'The branch may be protected, or a server hook refused it. Push to another branch and open a pull request.')
        : p('rejected', 'The remote has commits you do not have yet, so it refused the push', 'Pull first (with rebase or a merge), then push again. Force-pushing would throw the remote commits away.');
  if (/There is no tracking information|no upstream configured|has no upstream branch|does not track any|no such ref was fetched/.test(out))
    return p('no_upstream', 'This branch is not connected to a branch on the remote yet', 'Push it once; that connects it.');
  if (/No configured push destination|does not appear to be a git repository|No such remote|no remote/.test(out))
    return p('no_remote', `There is no remote to talk to: ${said}`, 'Add a remote (Remotes, below) with the repository URL from GitHub, GitLab or your server.');
  if (/You are not currently on a branch|HEAD detached|detached HEAD/.test(out)) return p('detached', 'You are not on a branch (detached HEAD)', 'Switch to a branch, or create one here to keep these commits.');
  if (/not fully merged/.test(out)) return p('unmerged', `${said}`, 'Its commits are not on any other branch. Delete it anyway only if you do not need them.');
  if (/hook/i.test(out) && /(pre-commit|commit-msg|pre-push|post-checkout|husky|lefthook)/i.test(out))
    return p('hook', 'A git hook in this repository stopped it', 'Hooks are scripts the project runs (lint, tests, message checks). Its output is below; fix what it reports and try again.');
  if (/nothing to commit|no changes added to commit|nothing added to commit/.test(out)) return p('nothing', 'There is nothing to commit', 'Stage the changes you want to commit first.');
  if (/did not match any file|pathspec|invalid reference|unknown revision|not a valid object name|couldn't find remote ref|not a commit|bad revision|unknown switch|is not a valid branch name|is not a valid reference|already exists/.test(out))
    return p('invalid', said);
  return p('other', said);
}

// ---- reading the repository

/** Status, branches, the recent history of every branch, stashes and any operation in progress. */
export async function gitOverview(repo: string, limit = 150): Promise<GitOverview> {
  const gitDir = (await read(repo, ['rev-parse', '--absolute-git-dir'])).trim();
  const [head, headSha, status, branchRows, remoteRows, log, remotes, stashRows, tagRows, name, email] = await Promise.all([
    tryRead(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s.trim()),
    tryRead(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((s) => s.trim()),
    read(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    read(repo, ['for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(upstream:track)${SEP}%(committerdate:iso-strict)${SEP}%(objectname:short)${SEP}%(contents:subject)`, 'refs/heads']),
    read(repo, ['for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${SEP}%(refname)${SEP}%(committerdate:iso-strict)${SEP}%(objectname:short)${SEP}%(contents:subject)${SEP}%(symref)`, 'refs/remotes']),
    tryRead(repo, ['log', `--exclude=${MEMBER_BRANCHES}`, '--branches', '--remotes', '--tags', 'HEAD', '--date-order', `-n${limit}`, `--format=%H${SEP}%P${SEP}%an${SEP}%aI${SEP}%s${SEP}%D`]),
    tryRead(repo, ['remote', '-v']),
    tryRead(repo, ['stash', 'list', `--format=%gd${SEP}%gs${SEP}%cI`]),
    tryRead(repo, ['for-each-ref', '--sort=-creatordate', '--count=200', `--format=%(refname:short)${SEP}%(objectname:short)`, 'refs/tags']),
    tryRead(repo, ['config', '--get', 'user.name']).then((s) => s.trim()),
    tryRead(repo, ['config', '--get', 'user.email']).then((s) => s.trim()),
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
  const tracked = new Set(branches.map((b) => b.upstream).filter(Boolean));
  const remoteBranches: GitRemoteBranch[] = remoteRows
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split(SEP))
    // origin/HEAD is a pointer, not a branch.
    .filter(([, , , , , symref]) => !symref)
    .map(([name, full, date, sha, subject]) => {
      const remote = remoteList.map((r) => r.name).find((r) => full!.startsWith(`refs/remotes/${r}/`)) ?? name!.split('/')[0]!;
      return { name: name!, remote, branch: name!.slice(remote.length + 1), date: date ?? '', sha: sha ?? '', subject: subject ?? '', tracked: tracked.has(name!) };
    })
    .filter((b) => !b.branch.startsWith('covibe-agents/'));
  const files = parseStatus(status);
  const fetchHead = join(gitDir, 'FETCH_HEAD');
  return {
    branch: head || undefined,
    detached: !head,
    head: headSha || undefined,
    files,
    branches,
    remoteBranches,
    commits,
    remotes: remoteList,
    stashes: stashRows
      .split('\n')
      .filter(Boolean)
      .map((row) => {
        const [ref, message, date] = row.split(SEP);
        return { index: Number(/\{(\d+)\}/.exec(ref ?? '')?.[1] ?? 0), ref: ref!, message: message ?? '', date: date ?? '' };
      }),
    tags: tagRows
      .split('\n')
      .filter(Boolean)
      .map((row) => {
        const [name, sha] = row.split(SEP);
        return { name: name!, sha: sha ?? '' };
      }),
    operation: operationOf(gitDir, files),
    identity: { name: name || undefined, email: email || undefined },
    fetchedAt: existsSync(fetchHead) ? statSync(fetchHead).mtime.toISOString() : undefined,
    defaultBranch: await defaultBranch(repo, branches.map((b) => b.name)),
    pullRequests: await canCreatePr(repo, remoteList.length > 0),
  };
}

/** A merge, rebase, cherry-pick, revert or bisect that is still going on, from the files git keeps while it does. */
function operationOf(gitDir: string, files: GitFile[]): GitOperation | undefined {
  const has = (f: string) => existsSync(join(gitDir, f));
  const text = (f: string) => {
    try {
      return readFileSync(join(gitDir, f), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const conflicts = files.filter((f) => f.state === 'conflict').map((f) => f.path);
  if (has('rebase-merge') || has('rebase-apply')) {
    const dir = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
    const branch = text(`${dir}/head-name`).replace(/^refs\/heads\//, '');
    const onto = text(`${dir}/onto`).slice(0, 7);
    const step = Number(text(`${dir}/msgnum`) || text(`${dir}/next`)) || undefined;
    const total = Number(text(`${dir}/end`) || text(`${dir}/last`)) || undefined;
    return {
      kind: 'rebase',
      subject: `${branch || 'your commits'} onto ${onto || 'the new base'}${step && total ? ` (commit ${step} of ${total})` : ''}`,
      conflicts,
      // While rebasing, "ours" is the base being rebased onto and "theirs" is your commit being replayed.
      labels: { current: 'the new base', incoming: 'your commit' },
      canSkip: true,
    };
  }
  if (has('MERGE_HEAD')) {
    const msg = text('MERGE_MSG').split('\n')[0] ?? '';
    return { kind: 'merge', subject: msg || 'a merge', conflicts, labels: { current: 'your branch', incoming: /Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg)?.[1] ?? /^Merge (\S+)/.exec(msg)?.[1] ?? 'the merged branch' }, canSkip: false };
  }
  if (has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', subject: `commit ${text('CHERRY_PICK_HEAD').slice(0, 7)}`, conflicts, labels: { current: 'your branch', incoming: 'the picked commit' }, canSkip: true };
  if (has('REVERT_HEAD')) return { kind: 'revert', subject: `commit ${text('REVERT_HEAD').slice(0, 7)}`, conflicts, labels: { current: 'your branch', incoming: 'the undo' }, canSkip: true };
  if (has('BISECT_LOG')) return { kind: 'bisect', subject: 'finding the commit that introduced a change', conflicts, labels: { current: 'current', incoming: 'incoming' }, canSkip: false };
  if (conflicts.length) return { kind: 'stash', subject: 'applying a stash', conflicts, labels: { current: 'your branch', incoming: 'the stash' }, canSkip: false };
  return undefined;
}

/** `git status --porcelain -z`: one entry per changed path. */
export function parseStatus(z: string): GitFile[] {
  const out: GitFile[] = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const x = p[0]!;
    const y = p[1]!;
    const path = p.slice(3);
    // Renames and copies carry the old path as the next entry.
    const from = x === 'R' || x === 'C' ? parts[++i] : undefined;
    const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    const state = conflict ? 'conflict' : x === '?' ? 'new' : x === 'D' || y === 'D' ? 'deleted' : x === 'A' ? 'added' : x === 'R' ? 'renamed' : 'modified';
    out.push({
      path,
      staged: !conflict && x !== ' ' && x !== '?',
      unstaged: !conflict && (y !== ' ' || x === '?'),
      state,
      ...(from ? { from } : {}),
    });
  }
  return out;
}

/** A remote's web address (GitHub, GitLab, Bitbucket…), from its https or ssh URL. */
export function webUrl(remote: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://${m[1]}/${m[2]}` : undefined;
}

async function defaultBranch(repo: string, local: string[]): Promise<string | undefined> {
  const remoteHead = (await tryRead(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
  if (remoteHead) return remoteHead;
  return ['main', 'master', 'trunk', 'develop'].find((b) => local.includes(b));
}

let ghInstalled: { at: number; ok: Promise<boolean> } | undefined;

/** Pull requests go through gh when it is installed and the repository has a GitHub remote. */
async function canCreatePr(repo: string, hasRemote: boolean): Promise<'gh' | 'browser' | 'none'> {
  if (!hasRemote) return 'none';
  if (!ghInstalled || Date.now() - ghInstalled.at > 300_000) ghInstalled = { at: Date.now(), ok: runCommand(repo, ['--version'], { program: 'gh', timeout: 10_000 }).then((r) => r.ok) };
  const remotes = await tryRead(repo, ['remote', '-v']);
  return (await ghInstalled.ok) && /github\.com/.test(remotes) ? 'gh' : 'browser';
}

const isSha = (sha: unknown): sha is string => typeof sha === 'string' && /^[0-9a-f]{4,40}$/i.test(sha);
const needSha = (sha: string) => {
  if (!isSha(sha)) throw new GitProblem(`not a commit: ${sha}`, 'invalid');
  return sha;
};

/** One commit: header and patch (clipped). */
export async function gitShow(repo: string, sha: string): Promise<{ sha: string; header: string; patch: string; files: { path: string; additions: number; deletions: number }[] }> {
  needSha(sha);
  const [header, numstat, patch] = await Promise.all([
    read(repo, ['show', '-s', '--format=%H%n%an <%ae>%n%aI%n%n%B', sha]),
    read(repo, ['show', '--numstat', '--format=', sha]),
    read(repo, ['show', '--format=', '--patch', sha]),
  ]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...path] = l.split('\t');
      return { path: path.join('\t'), additions: Number(add) || 0, deletions: Number(del) || 0 };
    });
  return { sha, header: header.trim(), files, patch: clipPatch(patch) };
}

const clipPatch = (patch: string) => (patch.length > 300_000 ? `${patch.slice(0, 300_000)}\n… (diff truncated)` : patch);

/** What changed in one file of the checkout, compared with the last commit (or, in a conflict, the conflict itself). */
export async function gitFileDiff(repo: string, path: string): Promise<{ path: string; patch: string }> {
  const p = repoPath(repo, path);
  const [status, head] = await Promise.all([read(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', p]), tryRead(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])]);
  const file = parseStatus(status)[0];
  let patch: string;
  if (file?.state === 'new') {
    // No commit has this file: show it whole. --no-index exits 1 when there are differences.
    const r = await runCommand(repo, ['diff', '--no-index', '--', '/dev/null', p], { read: true });
    patch = r.stdout;
  } else if (file?.state === 'conflict') patch = await read(repo, ['diff', '--', p]);
  else if (head.trim()) patch = await read(repo, ['diff', 'HEAD', '-M', '--', ...(file?.from ? [file.from] : []), p]);
  else patch = (await read(repo, ['diff', '--cached', '--', p])) + (await read(repo, ['diff', '--', p]));
  return { path: p, patch: clipPatch(patch) };
}

// ---- names and paths from the app

const branchName = (b: unknown, what = 'branch'): string => {
  const name = typeof b === 'string' ? b.trim() : '';
  if (!name || name.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{|\/$|\.lock$/.test(name)) throw new GitProblem(`"${name}" is not a valid ${what} name`, 'invalid', 'Use letters, digits, - _ . and / (for example feature/login).');
  return name;
};

/** A path inside the repository, relative to it; nothing outside and nothing in .git. */
function repoPath(repo: string, path: unknown): string {
  const raw = typeof path === 'string' ? path : '';
  const rel = relative(repo, resolve(repo, raw));
  if (!raw || !rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '.git') throw new GitProblem(`"${raw}" is not a file in this repository`, 'invalid');
  return rel;
}

const pathsOf = (repo: string, paths: unknown): string[] => {
  const list = Array.isArray(paths) ? paths.map((p) => repoPath(repo, p)) : [];
  if (!list.length) throw new GitProblem('no files given', 'invalid');
  return list;
};

const current = async (repo: string): Promise<string> => {
  const name = (await tryRead(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (!name) throw new GitProblem('You are not on a branch (detached HEAD)', 'detached', 'Switch to a branch, or create one here to keep these commits.');
  return name;
};

/** The files with changes that are not committed (staged or not, and new files). */
export async function gitUncommitted(repo: string): Promise<string[]> {
  return parseStatus(await read(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).map((f) => f.path);
}

const hasHead = async (repo: string) => !!(await tryRead(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
const conflicted = async (repo: string): Promise<string[]> => (await tryRead(repo, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);

/** The outcome of an operation that can stop on conflicts: done, or waiting for them to be resolved. */
export interface GitOutcome {
  sha?: string;
  conflicts: string[];
}

/** Run something that may stop on conflicts. Conflicts leave the operation in progress for the user (or the helper) to resolve. */
async function mayConflict(repo: string, args: string[]): Promise<GitOutcome> {
  const r = await runCommand(repo, args);
  if (r.ok) return { sha: (await tryRead(repo, ['rev-parse', 'HEAD'])).trim() || undefined, conflicts: [] };
  const conflicts = await conflicted(repo);
  if (conflicts.length) return { conflicts };
  throw problem(args, r);
}

// ---- changes and commits

export async function gitStage(repo: string, paths: unknown): Promise<void> {
  await run(repo, ['add', '-A', '--', ...pathsOf(repo, paths)]);
}

export async function gitUnstage(repo: string, paths: unknown): Promise<void> {
  const list = pathsOf(repo, paths);
  // Before the first commit there is no HEAD to go back to: take them out of the index instead.
  if (await hasHead(repo)) await run(repo, ['reset', '-q', 'HEAD', '--', ...list]);
  else await run(repo, ['rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', ...list]);
}

/** Throw away the changes to some files: back to the last commit, and new files deleted. */
export async function gitDiscard(repo: string, paths: unknown): Promise<void> {
  const list = pathsOf(repo, paths);
  const head = await hasHead(repo);
  for (const p of list) {
    const inHead = head && (await runCommand(repo, ['cat-file', '-e', `HEAD:${p}`], { read: true })).ok;
    if (inHead) await run(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', p]);
    else {
      await run(repo, ['rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', p]);
      rmSync(join(repo, p), { recursive: true, force: true });
    }
  }
}

/** Commit what is staged (or every change, with all), optionally amending the last commit. */
export async function gitCommit(repo: string, message: string, opts: { all?: boolean; amend?: boolean; paths?: string[] } = {}): Promise<string> {
  const text = message.trim();
  if (!text && !opts.amend) throw new GitProblem('a commit needs a message', 'invalid');
  if (opts.paths?.length) await gitStage(repo, opts.paths);
  else if (opts.all) await run(repo, ['add', '-A']);
  const left = await conflicted(repo);
  if (left.length) throw new GitProblem(`${left.length} file${left.length > 1 ? 's still have' : ' still has'} conflicts: ${left.join(', ')}`, 'conflict', 'Resolve them (choose a version, or edit and mark resolved) before committing.');
  await run(repo, ['commit', ...(opts.amend ? ['--amend'] : []), ...(text ? ['-m', text] : ['--no-edit']), ...(opts.paths?.length ? ['--', ...opts.paths.map((p) => repoPath(repo, p))] : [])]);
  return (await read(repo, ['rev-parse', 'HEAD'])).trim();
}

/** Take back the last commit; its changes stay, staged. */
export async function gitUndoCommit(repo: string): Promise<void> {
  if (!(await runCommand(repo, ['rev-parse', '--verify', '--quiet', 'HEAD~1'], { read: true })).ok) throw new GitProblem('There is no earlier commit to go back to', 'invalid');
  await run(repo, ['reset', '--soft', 'HEAD~1']);
}

// ---- branches

/**
 * Switch branch (a remote branch gets a local branch that tracks it), create
 * one (from `from`, or the current commit), or go to a commit (detached).
 * With stash, uncommitted changes that are in the way are stashed first.
 */
export async function gitCheckout(repo: string, branch: string, create = false, from?: string, opts: { stash?: boolean } = {}): Promise<{ stashed: boolean }> {
  let stashed = false;
  if (opts.stash && (await read(repo, ['status', '--porcelain', '--untracked-files=normal'])).trim()) {
    await run(repo, ['stash', 'push', '--include-untracked', '-m', `covibe: before switching to ${branch}`]);
    stashed = true;
  }
  if (create) {
    await run(repo, ['switch', '-c', branchName(branch), ...(from ? [isSha(from) ? from : branchName(from, 'start point')] : [])]);
    return { stashed };
  }
  if (isSha(branch) && !(await runCommand(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { read: true })).ok) {
    await run(repo, ['switch', '--detach', branch]);
    return { stashed };
  }
  const name = branchName(branch);
  const local = (await runCommand(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { read: true })).ok;
  const remote = !local && (await runCommand(repo, ['show-ref', '--verify', '--quiet', `refs/remotes/${name}`], { read: true })).ok;
  if (remote) {
    // origin/feature → a local feature that tracks it (or the local one, if it exists under that name).
    const short = name.slice(name.indexOf('/') + 1);
    const exists = (await runCommand(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${short}`], { read: true })).ok;
    await run(repo, exists ? ['switch', short] : ['switch', '--track', name]);
  } else await run(repo, ['switch', name]);
  return { stashed };
}

export async function gitDeleteBranch(repo: string, branch: string, force = false): Promise<void> {
  const name = branchName(branch);
  if (name === (await tryRead(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()) throw new GitProblem('You cannot delete the branch you are on', 'invalid', 'Switch to another branch first.');
  await run(repo, ['branch', force ? '-D' : '-d', name]);
}

/** Delete a branch on its remote ("origin/feature"). */
export async function gitDeleteRemoteBranch(repo: string, remoteBranch: string): Promise<void> {
  const name = branchName(remoteBranch);
  const remotes = (await read(repo, ['remote'])).split('\n').filter(Boolean);
  const remote = remotes.find((r) => name.startsWith(`${r}/`));
  if (!remote) throw new GitProblem(`${name} is not a remote branch`, 'invalid');
  await run(repo, ['push', remote, '--delete', name.slice(remote.length + 1)]);
}

export async function gitRenameBranch(repo: string, from: string, to: string): Promise<void> {
  await run(repo, ['branch', '-m', branchName(from), branchName(to, 'new branch')]);
}

// ---- remotes: fetch, pull, push

/** The remote to push to: the branch's own, else origin, else the only one. */
async function remoteFor(repo: string, branch: string): Promise<string> {
  const own = (await tryRead(repo, ['config', '--get', `branch.${branch}.remote`])).trim();
  if (own && own !== '.') return own;
  const remotes = (await read(repo, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.length) throw new GitProblem('This repository has no remote to push to', 'no_remote', 'Add a remote (Remotes, below) with the repository URL from GitHub, GitLab or your server.');
  return remotes.includes('origin') ? 'origin' : remotes[0]!;
}

/** Get what is new on every remote (branches deleted there are pruned). */
export async function gitFetch(repo: string): Promise<void> {
  if (!(await read(repo, ['remote'])).trim()) return;
  await run(repo, ['fetch', '--all', '--prune']);
}

/**
 * Push a branch (the current one by default). It goes to the branch it tracks;
 * a branch that tracks nothing yet is pushed under its own name and tracks it
 * from then on. force uses --force-with-lease: it refuses when the remote has
 * commits you have not fetched.
 */
export async function gitPush(repo: string, branch?: string, opts: { force?: boolean } = {}): Promise<{ branch: string; remote: string }> {
  const name = branch ? branchName(branch) : await current(repo);
  const remote = await remoteFor(repo, name);
  const merge = (await tryRead(repo, ['config', '--get', `branch.${name}.merge`])).trim().replace(/^refs\/heads\//, '');
  const tracksHere = merge && (await tryRead(repo, ['config', '--get', `branch.${name}.remote`])).trim() === remote;
  await run(repo, ['push', ...(opts.force ? ['--force-with-lease'] : []), ...(tracksHere ? [] : ['--set-upstream']), remote, `refs/heads/${name}:refs/heads/${tracksHere ? merge : name}`]);
  return { branch: name, remote };
}

/**
 * Bring the current branch up to date with the branch it tracks. ff: only when
 * that needs no new commit; rebase: your commits go on top; merge: a merge
 * commit. Uncommitted changes are put aside and brought back.
 */
export async function gitPull(repo: string, mode: 'ff' | 'rebase' | 'merge' = 'ff'): Promise<GitOutcome> {
  const name = await current(repo);
  if (!(await tryRead(repo, ['config', '--get', `branch.${name}.merge`])).trim()) {
    throw new GitProblem(`${name} is not connected to a branch on the remote yet`, 'no_upstream', 'Push it once; that connects it. To take changes from another branch, merge it instead.');
  }
  return mayConflict(repo, ['pull', '--autostash', ...(mode === 'ff' ? ['--ff-only'] : mode === 'rebase' ? ['--rebase'] : ['--no-rebase', '--no-edit'])]);
}

// ---- combining work: merge, rebase, cherry-pick, revert

/** Merge a branch into the current one (a merge commit, so it can be reverted as one). Conflicts leave the merge in progress. */
export async function gitMerge(repo: string, branch: string): Promise<GitOutcome> {
  const name = branchName(branch);
  const into = await current(repo);
  return mayConflict(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${name} into ${into}`, name]);
}

/** Replay the current branch's commits on top of another branch. Conflicts leave the rebase in progress. */
export async function gitRebase(repo: string, onto: string): Promise<GitOutcome> {
  await current(repo);
  return mayConflict(repo, ['rebase', '--autostash', branchName(onto, 'branch to rebase onto')]);
}

const parentsOf = async (repo: string, sha: string) => (await read(repo, ['rev-list', '--parents', '-n1', sha])).trim().split(' ').length - 1;

/** Copy a commit onto the current branch. */
export async function gitCherryPick(repo: string, sha: string): Promise<GitOutcome> {
  needSha(sha);
  return mayConflict(repo, ['cherry-pick', ...((await parentsOf(repo, sha)) > 1 ? ['-m', '1'] : []), sha]);
}

/** Undo a commit with a new commit (merges are reverted against their first parent). */
export async function gitRevert(repo: string, sha: string): Promise<GitOutcome> {
  needSha(sha);
  return mayConflict(repo, ['revert', '--no-edit', ...((await parentsOf(repo, sha)) > 1 ? ['-m', '1'] : []), sha]);
}

/** Move the current branch to a commit. soft keeps changes staged, mixed keeps them unstaged, hard throws them away. */
export async function gitReset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
  needSha(sha);
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new GitProblem(`unknown reset mode ${mode}`, 'invalid');
  await run(repo, ['reset', `--${mode}`, sha]);
}

/** Go on with, skip a commit of, or abort the operation in progress. */
export async function gitOperation(repo: string, action: 'continue' | 'abort' | 'skip'): Promise<GitOutcome> {
  const gitDir = (await read(repo, ['rev-parse', '--absolute-git-dir'])).trim();
  const op = operationOf(gitDir, parseStatus(await read(repo, ['status', '--porcelain=v1', '-z'])));
  if (!op) throw new GitProblem('Nothing is in progress', 'invalid');
  if (op.kind === 'stash') {
    if (action !== 'abort') throw new GitProblem('Resolve the conflicts, then commit or keep working; there is nothing to continue', 'invalid');
    // A stash that did not apply cleanly: go back to the last commit (the stash itself is kept).
    await run(repo, ['reset', '--merge']);
    return { conflicts: [] };
  }
  if (op.kind === 'bisect') {
    if (action !== 'abort') throw new GitProblem('Bisecting is done with git bisect good/bad; ask the git helper', 'invalid');
    await run(repo, ['bisect', 'reset']);
    return { conflicts: [] };
  }
  if (action === 'continue' && op.conflicts.length) {
    throw new GitProblem(`${op.conflicts.length} file${op.conflicts.length > 1 ? 's still have' : ' still has'} conflicts: ${op.conflicts.join(', ')}`, 'conflict', 'Choose a version for each, or edit it and mark it resolved, then continue.');
  }
  if (action === 'skip' && !op.canSkip) throw new GitProblem(`A ${op.kind} cannot skip; continue or abort it`, 'invalid');
  if (action === 'abort') {
    await run(repo, [op.kind, '--abort']);
    return { conflicts: [] };
  }
  // A merge whose conflicts are resolved is concluded by committing it.
  if (op.kind === 'merge' && action === 'continue') return mayConflict(repo, ['commit', '--no-edit']);
  return mayConflict(repo, [op.kind, `--${action}`]);
}

/**
 * Settle one conflicted file: keep the current or the incoming version (a side
 * that deleted the file deletes it), or mark it resolved after editing it.
 */
export async function gitResolve(repo: string, path: string, how: 'current' | 'incoming' | 'resolved'): Promise<void> {
  const p = repoPath(repo, path);
  if (how === 'resolved') {
    const full = join(repo, p);
    if (existsSync(full) && statSync(full).isFile() && /^(<{7}|>{7})( |$)/m.test(readFileSync(full, 'utf8'))) {
      throw new GitProblem(`${p} still has conflict markers (<<<<<<< and >>>>>>>)`, 'conflict', 'Edit the file so it has only the code you want, or keep one version.');
    }
    await run(repo, ['add', '-A', '--', p]);
    return;
  }
  const stages = new Set((await read(repo, ['ls-files', '-u', '--', p])).split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]));
  const stage = how === 'current' ? '2' : '3';
  if (!stages.has(stage)) {
    // That side deleted the file.
    await run(repo, ['rm', '-q', '--', p]);
    return;
  }
  await run(repo, ['checkout', how === 'current' ? '--ours' : '--theirs', '--', p]);
  await run(repo, ['add', '--', p]);
}

// ---- stashes

export async function gitStash(repo: string, message?: string): Promise<void> {
  if (!(await read(repo, ['status', '--porcelain', '--untracked-files=normal'])).trim()) throw new GitProblem('There are no changes to stash', 'nothing');
  await run(repo, ['stash', 'push', '--include-untracked', ...(message?.trim() ? ['-m', message.trim()] : [])]);
}

/** Bring a stash back (pop also drops it, unless it conflicts). */
export async function gitStashApply(repo: string, index: number, pop: boolean): Promise<GitOutcome> {
  if (!Number.isInteger(index) || index < 0) throw new GitProblem(`no stash #${index}`, 'invalid');
  return mayConflict(repo, ['stash', pop ? 'pop' : 'apply', '--index', `stash@{${index}}`]).catch(async (err) => {
    // --index fails when the staged state cannot be restored; try again without it.
    if (err instanceof GitProblem && /--index|could not restore untracked|Conflicts in index/.test(err.detail ?? '')) return mayConflict(repo, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`]);
    throw err;
  });
}

export async function gitStashDrop(repo: string, index: number): Promise<void> {
  if (!Number.isInteger(index) || index < 0) throw new GitProblem(`no stash #${index}`, 'invalid');
  await run(repo, ['stash', 'drop', `stash@{${index}}`]);
}

// ---- tags, remotes, identity

export async function gitTag(repo: string, name: string, sha?: string, message?: string): Promise<void> {
  const tag = branchName(name, 'tag');
  if (sha) needSha(sha);
  await run(repo, ['tag', ...(message?.trim() ? ['-a', '-m', message.trim()] : []), tag, ...(sha ? [sha] : [])]);
}

export async function gitDeleteTag(repo: string, name: string): Promise<void> {
  await run(repo, ['tag', '-d', branchName(name, 'tag')]);
}

export async function gitPushTag(repo: string, name: string): Promise<void> {
  const tag = branchName(name, 'tag');
  const remote = await remoteFor(repo, (await tryRead(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || 'HEAD');
  await run(repo, ['push', remote, `refs/tags/${tag}`]);
}

const remoteName = (n: unknown) => {
  const name = typeof n === 'string' ? n.trim() : '';
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) throw new GitProblem(`"${name}" is not a valid remote name`, 'invalid', 'Use a short name such as origin or upstream.');
  return name;
};
const remoteUrl = (u: unknown) => {
  const url = typeof u === 'string' ? u.trim() : '';
  if (!url || url.startsWith('-') || /\s/.test(url)) throw new GitProblem(`"${url}" is not a repository URL`, 'invalid', 'Copy the clone URL from GitHub, GitLab or your server (https://… or git@…).');
  return url;
};

export async function gitRemoteAdd(repo: string, name: string, url: string): Promise<void> {
  await run(repo, ['remote', 'add', remoteName(name), remoteUrl(url)]);
}
export async function gitRemoteRemove(repo: string, name: string): Promise<void> {
  await run(repo, ['remote', 'remove', remoteName(name)]);
}
export async function gitRemoteSetUrl(repo: string, name: string, url: string): Promise<void> {
  await run(repo, ['remote', 'set-url', remoteName(name), remoteUrl(url)]);
}

/** The name and email commits record, for this repository or (global) all of them. */
export async function gitSetIdentity(repo: string, name: string, email: string, global = false): Promise<void> {
  if (!name.trim() || !/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new GitProblem('a name and an email address are needed', 'invalid');
  const scope = global ? ['--global'] : [];
  await run(repo, ['config', ...scope, 'user.name', name.trim()]);
  await run(repo, ['config', ...scope, 'user.email', email.trim()]);
}

/** Remove a lock file git left behind, when no git program is running in this repository. */
export async function gitClearLock(repo: string): Promise<boolean> {
  const gitDir = (await read(repo, ['rev-parse', '--absolute-git-dir'])).trim();
  const lock = join(gitDir, 'index.lock');
  if (!existsSync(lock)) return false;
  // A lock younger than a few seconds most likely belongs to a git program that is still working.
  if (Date.now() - statSync(lock).mtimeMs < 5_000) throw new GitProblem('A git program is still working in this repository', 'lock', 'Wait a few seconds and try again.');
  rmSync(lock, { force: true });
  return true;
}

/**
 * Any git command, as you would type it after "git" (no shell). Its output
 * comes back whether it worked or not.
 */
export async function gitRun(repo: string, args: string[], program: 'git' | 'gh' = 'git'): Promise<{ ok: boolean; code: number; output: string }> {
  if (!args.length || args.some((a) => typeof a !== 'string')) throw new GitProblem('no command given', 'invalid');
  const r = await runCommand(repo, args, { program, timeout: NETWORK_TIMEOUT });
  const output = `${r.stdout}${r.stderr ? `${r.stdout ? '\n' : ''}${r.stderr}` : ''}`.trim();
  return { ok: r.ok, code: r.code, output: r.timedOut ? `${output}\n(stopped: it took longer than 10 minutes)` : output };
}

/** Split a command line typed by a person ("commit -m 'fix it'") into arguments, honouring quotes. A leading "git" is dropped. */
export function splitCommand(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) args.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new GitProblem('a quote is not closed', 'invalid');
  if (has || cur) args.push(cur);
  return args[0] === 'git' ? args.slice(1) : args;
}

/**
 * Open a pull request for a branch: push it, then create the PR with gh, or
 * hand back the page where the forge creates one (no gh, or gh not signed in).
 */
export async function gitPullRequest(repo: string, p: { branch: string; base: string; title: string; body?: string }): Promise<{ url: string; created: boolean }> {
  const branch = branchName(p.branch);
  const base = branchName(p.base, 'base branch');
  if (!p.title.trim()) throw new GitProblem('a pull request needs a title', 'invalid');
  const { remote } = await gitPush(repo, branch);
  const url = (await read(repo, ['remote', 'get-url', remote])).trim();
  const web = webUrl(url);
  if (/github\.com/.test(url)) {
    const r = await runCommand(repo, ['pr', 'create', '--head', branch, '--base', base, '--title', p.title.trim(), '--body', p.body?.trim() || ''], { program: 'gh', timeout: NETWORK_TIMEOUT });
    const made = r.stdout.trim().split('\n').at(-1) ?? '';
    if (r.ok && /^https?:\/\//.test(made)) return { url: made, created: true };
    // An open PR for the branch already: hand that one back.
    const existing = /https:\/\/\S+\/pull\/\d+/.exec(r.stderr)?.[0];
    if (existing) return { url: existing, created: false };
    // Otherwise (no gh, not signed in) fall through to the browser.
  }
  if (!web) throw new GitProblem(`cannot tell where ${url} opens pull requests`, 'invalid', 'Open the repository in your browser and create the pull request there; the branch is pushed.');
  const q = new URLSearchParams({ expand: '1', title: p.title.trim(), ...(p.body?.trim() ? { body: p.body.trim() } : {}) });
  const page = /gitlab/.test(web)
    ? `${web}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}&merge_request[target_branch]=${encodeURIComponent(base)}&merge_request[title]=${encodeURIComponent(p.title.trim())}`
    : `${web}/compare/${encodeURI(base)}...${encodeURI(branch)}?${q}`;
  return { url: page, created: false };
}
