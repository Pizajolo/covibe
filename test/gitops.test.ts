import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as g from '../src/server/gitops.js';
import { GitProblem, gitCheckout, gitCommit, gitMerge, gitOverview, gitPullRequest, gitPush, gitRevert, gitShow, parseStatus, problem, splitCommand, webUrl } from '../src/server/gitops.js';
import { layoutGraph } from '../ui/src/components/git-graph.js';
import { tempDir, tempRepo } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (repo: string, file: string, text: string) => writeFileSync(join(repo, file), text);

/** What a rejected promise's GitProblem says. */
async function fails(p: Promise<unknown>): Promise<GitProblem> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(GitProblem);
    return err as GitProblem;
  }
  throw new Error('expected it to fail');
}

/** A repository with a bare remote, and a second clone standing in for a teammate. */
function withRemote() {
  const remote = tempDir();
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const repo = tempRepo();
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const mate = tempDir();
  git(mate, 'clone', '-q', remote, '.');
  git(mate, 'config', 'user.name', 'mate');
  git(mate, 'config', 'user.email', 'm@m');
  return { remote, repo, mate };
}

describe('git in the project checkout', () => {
  it('reads status, branches and history, and commits, switches, merges and reverts', async () => {
    const repo = tempRepo();
    const main = git(repo, 'symbolic-ref', '--short', 'HEAD');
    write(repo, 'a.txt', 'one\n');
    let o = await gitOverview(repo);
    expect(o.branch).toBe(main);
    expect(o.files).toEqual([{ path: 'a.txt', staged: false, unstaged: true, state: 'new' }]);
    expect(o.pullRequests).toBe('none');
    expect(o.identity).toEqual({ name: 't', email: 't@t' });
    expect(o.operation).toBeUndefined();

    await expect(gitCommit(repo, '  ')).rejects.toThrow(/message/);
    await gitCommit(repo, 'Add a', { all: true });
    await gitCheckout(repo, 'feature/b', true);
    write(repo, 'b.txt', 'two\n');
    const b = await gitCommit(repo, 'Add b', { all: true });
    await gitCheckout(repo, main);
    await expect(gitCheckout(repo, '--force')).rejects.toThrow(/not a valid/);
    const merged = await gitMerge(repo, 'feature/b');
    expect(merged.conflicts).toEqual([]);

    o = await gitOverview(repo);
    expect(o.files).toEqual([]);
    expect(o.branches.map((x) => [x.name, x.current])).toEqual(expect.arrayContaining([[main, true], ['feature/b', false]]));
    expect(o.commits[0]).toMatchObject({ sha: merged.sha, subject: `Merge feature/b into ${main}`, parents: [expect.any(String), b] });
    expect(o.commits[0]!.refs).toContain(`HEAD -> ${main}`);
    expect((await gitShow(repo, b)).files).toEqual([{ path: 'b.txt', additions: 1, deletions: 0 }]);

    // Reverting the merge takes b.txt out again, with a new commit.
    await gitRevert(repo, merged.sha!);
    expect(git(repo, 'ls-files')).not.toContain('b.txt');
    expect(git(repo, 'log', '-1', '--format=%s')).toMatch(/^Revert/);
  });

  it('stages, unstages, discards, commits only what is staged, shows a file diff and undoes a commit', async () => {
    const repo = tempRepo();
    write(repo, 'README.md', '# app\nmore\n');
    write(repo, 'new.txt', 'new\n');
    await g.gitStage(repo, ['new.txt']);
    let o = await gitOverview(repo);
    expect(o.files).toEqual(
      expect.arrayContaining([
        { path: 'README.md', staged: false, unstaged: true, state: 'modified' },
        { path: 'new.txt', staged: true, unstaged: false, state: 'added' },
      ]),
    );
    expect((await g.gitFileDiff(repo, 'README.md')).patch).toContain('+more');
    expect((await g.gitFileDiff(repo, 'new.txt')).patch).toContain('+new');
    await expect(g.gitFileDiff(repo, '../outside')).rejects.toThrow(/not a file in this repository/);

    // Only the staged file goes into the commit.
    await gitCommit(repo, 'Add new');
    expect(git(repo, 'show', '--name-only', '--format=')).toBe('new.txt');
    expect(git(repo, 'status', '--porcelain')).toBe('M README.md');

    await g.gitStage(repo, ['README.md']);
    await g.gitUnstage(repo, ['README.md']);
    expect(git(repo, 'status', '--porcelain')).toBe('M README.md');
    write(repo, 'junk.txt', 'x');
    await g.gitDiscard(repo, ['README.md', 'junk.txt']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, 'junk.txt'))).toBe(false);

    await g.gitUndoCommit(repo);
    o = await gitOverview(repo);
    expect(o.files).toEqual([{ path: 'new.txt', staged: true, unstaged: false, state: 'added' }]);
    expect((await fails(gitCommit(repo, 'x', { amend: false, all: false }).then(() => g.gitUndoCommit(repo)).then(() => g.gitUndoCommit(repo)))).message).toMatch(/no earlier commit/);
  });

  it('never trips over its own reads, and waits out another git program’s lock', async () => {
    const repo = tempRepo();
    // Reading the overview over and over while committing: reads take no locks.
    let reading = true;
    const reader = (async () => {
      while (reading) await gitOverview(repo);
    })();
    for (let i = 0; i < 15; i++) {
      write(repo, 'README.md', `# app ${i}\n`);
      await gitCommit(repo, `c${i}`, { all: true });
    }
    reading = false;
    await reader;

    // A lock that goes away is waited for; one that stays is explained, and a stale one can be cleared.
    const lock = join(repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    setTimeout(() => execFileSync('rm', ['-f', lock]), 300);
    write(repo, 'README.md', '# app again\n');
    await gitCommit(repo, 'after the lock', { all: true });
    writeFileSync(lock, '');
    write(repo, 'README.md', '# app once more\n');
    const stuck = await fails(gitCommit(repo, 'stuck', { all: true }));
    expect(stuck.kind).toBe('lock');
    expect(stuck.hint).toMatch(/stale/);
    await expect(g.gitClearLock(repo)).rejects.toThrow(/still working/);
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(await g.gitClearLock(repo)).toBe(true);
    await gitCommit(repo, 'unstuck', { all: true });
  }, 30_000);

  it('keeps a conflicted merge in progress, resolves it file by file, and continues or aborts', async () => {
    const repo = tempRepo();
    const main = git(repo, 'symbolic-ref', '--short', 'HEAD');
    write(repo, 'a.txt', 'base\n');
    write(repo, 'b.txt', 'base\n');
    await gitCommit(repo, 'base', { all: true });
    await gitCheckout(repo, 'other', true);
    write(repo, 'a.txt', 'theirs\n');
    write(repo, 'b.txt', 'theirs\n');
    await gitCommit(repo, 'theirs', { all: true });
    await gitCheckout(repo, main);
    write(repo, 'a.txt', 'ours\n');
    write(repo, 'b.txt', 'ours\n');
    await gitCommit(repo, 'ours', { all: true });

    const out = await gitMerge(repo, 'other');
    expect(out).toEqual({ conflicts: ['a.txt', 'b.txt'] });
    let o = await gitOverview(repo);
    expect(o.operation).toMatchObject({ kind: 'merge', conflicts: ['a.txt', 'b.txt'], labels: { current: 'your branch', incoming: 'other' } });
    expect(o.files.find((f) => f.path === 'a.txt')).toMatchObject({ state: 'conflict', staged: false, unstaged: false });

    // Continuing or committing is refused while conflicts are left; a file with markers cannot be marked resolved.
    expect((await fails(g.gitOperation(repo, 'continue'))).kind).toBe('conflict');
    expect((await fails(gitCommit(repo, 'x'))).kind).toBe('conflict');
    expect((await fails(g.gitResolve(repo, 'b.txt', 'resolved'))).message).toMatch(/conflict markers/);

    await g.gitResolve(repo, 'a.txt', 'incoming');
    write(repo, 'b.txt', 'both\n');
    await g.gitResolve(repo, 'b.txt', 'resolved');
    const done = await g.gitOperation(repo, 'continue');
    expect(done.conflicts).toEqual([]);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('theirs\n');
    expect(git(repo, 'rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3);
    expect((await gitOverview(repo)).operation).toBeUndefined();

    // The same conflict again, aborted: back to where it was.
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    await gitMerge(repo, 'other');
    await g.gitOperation(repo, 'abort');
    o = await gitOverview(repo);
    expect(o.operation).toBeUndefined();
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('ours\n');
  });

  it('rebases, cherry-picks and stashes, stopping on conflicts with the right labels', async () => {
    const repo = tempRepo();
    const main = git(repo, 'symbolic-ref', '--short', 'HEAD');
    write(repo, 'a.txt', 'base\n');
    await gitCommit(repo, 'base', { all: true });
    await gitCheckout(repo, 'topic', true);
    write(repo, 'a.txt', 'topic\n');
    const topic = await gitCommit(repo, 'topic', { all: true });
    await gitCheckout(repo, main);
    write(repo, 'a.txt', 'main\n');
    await gitCommit(repo, 'main', { all: true });

    await gitCheckout(repo, 'topic');
    expect((await g.gitRebase(repo, main)).conflicts).toEqual(['a.txt']);
    const o = await gitOverview(repo);
    expect(o.operation).toMatchObject({ kind: 'rebase', labels: { current: 'the new base', incoming: 'your commit' }, canSkip: true });
    expect(o.operation!.subject).toMatch(/^topic onto/);
    await g.gitResolve(repo, 'a.txt', 'incoming');
    await g.gitOperation(repo, 'continue');
    expect(git(repo, 'log', '--format=%s', '-2')).toBe('topic\nmain');

    await gitCheckout(repo, main);
    expect((await g.gitCherryPick(repo, topic)).conflicts).toEqual(['a.txt']);
    expect((await gitOverview(repo)).operation?.kind).toBe('cherry-pick');
    await g.gitOperation(repo, 'abort');

    // A stash: put aside, listed, brought back.
    write(repo, 'a.txt', 'wip\n');
    write(repo, 'untracked.txt', 'u\n');
    await g.gitStash(repo, 'half done');
    let s = await gitOverview(repo);
    expect(s.files).toEqual([]);
    expect(s.stashes).toEqual([expect.objectContaining({ index: 0, message: expect.stringContaining('half done') })]);
    await g.gitStashApply(repo, 0, true);
    s = await gitOverview(repo);
    expect(s.stashes).toEqual([]);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('wip\n');
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
    expect((await fails(g.gitStashDrop(repo, 3))).kind).toBe('invalid');
  });

  it('explains uncommitted changes in the way of a switch, and can stash them first', async () => {
    const repo = tempRepo();
    const main = git(repo, 'symbolic-ref', '--short', 'HEAD');
    await gitCheckout(repo, 'other', true);
    write(repo, 'README.md', '# other\n');
    await gitCommit(repo, 'other', { all: true });
    await gitCheckout(repo, main);
    write(repo, 'README.md', '# mine\n');

    const err = await fails(gitCheckout(repo, 'other'));
    expect(err.kind).toBe('dirty');
    expect(err.hint).toMatch(/stash/i);
    expect(await gitCheckout(repo, 'other', false, undefined, { stash: true })).toEqual({ stashed: true });
    const o = await gitOverview(repo);
    expect(o.branch).toBe('other');
    expect(o.stashes[0]!.message).toContain('before switching to other');

    // A commit can be checked out on its own (detached), and a branch made there.
    const first = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
    await gitCheckout(repo, first);
    expect((await gitOverview(repo)).detached).toBe(true);
    expect((await fails(gitPush(repo))).kind).toBe('detached');
    await gitCheckout(repo, 'from-first', true);
    expect((await gitOverview(repo)).branch).toBe('from-first');
  });

  it('fetches, pulls when branches diverged, refuses and force-pushes safely, and works with remote branches', async () => {
    const { remote, repo, mate } = withRemote();
    // The teammate pushes a commit and a branch of their own.
    write(mate, 'mate.txt', 'm\n');
    git(mate, 'add', '-A');
    git(mate, 'commit', '-qm', 'mate');
    git(mate, 'push', '-q');
    git(mate, 'switch', '-q', '-c', 'mate/feature');
    git(mate, 'push', '-q', '-u', 'origin', 'mate/feature');

    await g.gitFetch(repo);
    let o = await gitOverview(repo);
    expect(o.fetchedAt).toBeDefined();
    expect(o.branches.find((b) => b.current)).toMatchObject({ upstream: 'origin/main', behind: 1, ahead: 0 });
    expect(o.remoteBranches.map((b) => [b.name, b.branch, b.tracked])).toEqual(expect.arrayContaining([['origin/main', 'main', true], ['origin/mate/feature', 'mate/feature', false]]));

    // A local commit too: fast-forward is impossible, and pushing is refused.
    write(repo, 'mine.txt', 'x\n');
    await gitCommit(repo, 'mine', { all: true });
    expect((await fails(g.gitPull(repo))).kind).toBe('diverged');
    expect((await fails(gitPush(repo))).kind).toBe('rejected');
    // Uncommitted changes do not stop a pull: they are put aside and brought back.
    write(repo, 'README.md', '# wip\n');
    expect((await g.gitPull(repo, 'rebase')).conflicts).toEqual([]);
    expect(git(repo, 'log', '--format=%s', '-2')).toBe('mine\nmate');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# wip\n');
    expect(await gitPush(repo)).toEqual({ branch: 'main', remote: 'origin' });

    // A force push only goes through when nobody pushed in between (with lease).
    git(repo, 'commit', '-qam', 'wip');
    await gitPush(repo);
    git(repo, 'commit', '-q', '--amend', '-m', 'wip, reworded');
    expect((await fails(gitPush(repo))).kind).toBe('rejected');
    await gitPush(repo, 'main', { force: true });
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('wip, reworded');

    // A remote branch: switching to it makes a local branch that tracks it; it can be deleted on the remote.
    await gitCheckout(repo, 'origin/mate/feature');
    o = await gitOverview(repo);
    expect(o.branches.find((b) => b.current)).toMatchObject({ name: 'mate/feature', upstream: 'origin/mate/feature' });
    await gitCheckout(repo, 'main');
    await g.gitDeleteRemoteBranch(repo, 'origin/mate/feature');
    expect(git(remote, 'branch', '--list', 'mate/feature')).toBe('');
    expect((await fails(g.gitDeleteBranch(repo, 'main'))).message).toMatch(/branch you are on/);
    await g.gitDeleteBranch(repo, 'mate/feature', true);

    // A branch that tracks a differently named remote branch pushes there.
    git(repo, 'switch', '-q', '-c', 'local-name');
    git(repo, 'push', '-q', '-u', 'origin', 'local-name:remote-name');
    write(repo, 'more.txt', '1\n');
    await gitCommit(repo, 'more', { all: true });
    await gitPush(repo);
    expect(git(remote, 'log', '-1', '--format=%s', 'remote-name')).toBe('more');
    expect(git(remote, 'branch', '--list', 'local-name')).toBe('');
  }, 30_000);

  it('pushes a new branch, adds and removes remotes and tags, and hands back the page for a pull request without gh', async () => {
    const remote = tempDir();
    git(remote, 'init', '-q', '--bare');
    const repo = tempRepo();
    expect((await fails(gitPush(repo))).kind).toBe('no_remote');
    await g.gitRemoteAdd(repo, 'origin', remote);
    await expect(g.gitRemoteAdd(repo, '-x', remote)).rejects.toThrow(/not a valid remote name/);
    await gitCheckout(repo, 'feature/x', true);
    write(repo, 'x.txt', 'x\n');
    await gitCommit(repo, 'Add x', { all: true });
    expect((await fails(g.gitPull(repo))).kind).toBe('no_upstream');
    expect(await gitPush(repo)).toEqual({ branch: 'feature/x', remote: 'origin' });
    expect(git(remote, 'branch', '--list', 'feature/x')).toContain('feature/x');
    const o = await gitOverview(repo);
    expect(o.branches.find((x) => x.current)).toMatchObject({ upstream: 'origin/feature/x', ahead: 0, behind: 0 });
    await expect(gitPullRequest(repo, { branch: 'feature/x', base: 'main', title: 'X' })).rejects.toThrow(/cannot tell where/);

    await g.gitTag(repo, 'v1.0', undefined, 'First release');
    expect((await gitOverview(repo)).tags).toEqual([{ name: 'v1.0', sha: expect.any(String) }]);
    await g.gitPushTag(repo, 'v1.0');
    expect(git(remote, 'tag')).toBe('v1.0');
    await g.gitDeleteTag(repo, 'v1.0');
    await g.gitRemoteSetUrl(repo, 'origin', 'git@git.example.com:acme/app.git');
    expect((await gitOverview(repo)).remotes).toEqual([{ name: 'origin', url: 'git@git.example.com:acme/app.git', web: 'https://git.example.com/acme/app' }]);
    await g.gitRemoteRemove(repo, 'origin');
    expect((await gitOverview(repo)).remotes).toEqual([]);

    expect(webUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app');
    expect(webUrl('https://user@gitlab.com/acme/app.git')).toBe('https://gitlab.com/acme/app');
    expect(webUrl('/tmp/remote')).toBeUndefined();
  });

  it('asks for a name and email when git has none, and sets them', async () => {
    const repo = tempRepo();
    git(repo, 'config', '--unset', 'user.name');
    git(repo, 'config', '--unset', 'user.email');
    git(repo, 'config', 'user.useConfigOnly', 'true');
    const home = process.env.HOME;
    const globalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(tempDir(), 'none');
    try {
      expect((await gitOverview(repo)).identity).toEqual({});
      write(repo, 'a.txt', 'a\n');
      expect((await fails(gitCommit(repo, 'a', { all: true }))).kind).toBe('identity');
      await expect(g.gitSetIdentity(repo, 'Ada', 'not an email')).rejects.toThrow(/email/);
      await g.gitSetIdentity(repo, 'Ada', 'ada@example.com');
      await gitCommit(repo, 'a', { all: true });
      expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Ada <ada@example.com>');
    } finally {
      process.env.HOME = home;
      if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = globalConfig;
    }
  });

  it('runs any git command typed in, and splits it like a shell would', async () => {
    const repo = tempRepo();
    expect(splitCommand(`git commit -m "fix: it's done" --allow-empty`)).toEqual(['commit', '-m', "fix: it's done", '--allow-empty']);
    expect(splitCommand(`log --format='%h %s' -1`)).toEqual(['log', '--format=%h %s', '-1']);
    expect(() => splitCommand('commit -m "open')).toThrow(/quote/);
    const ok = await g.gitRun(repo, splitCommand('commit --allow-empty -m "empty one"'));
    expect(ok.ok).toBe(true);
    const bad = await g.gitRun(repo, ['checkout', 'nope']);
    expect(bad).toMatchObject({ ok: false, code: 1 });
    expect(bad.output).toMatch(/did not match/);
  });

  it('explains what git says when it fails', () => {
    const explain = (stderr: string) => problem(['push'], { stdout: '', stderr, timedOut: false });
    expect(explain("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toMatchObject({ kind: 'auth', hint: expect.stringMatching(/gh auth login/) });
    expect(explain('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.')).toMatchObject({ kind: 'auth', hint: expect.stringMatching(/SSH key/) });
    expect(explain('ssh: Could not resolve hostname github.com: nodename nor servname provided')).toMatchObject({ kind: 'network' });
    expect(explain(' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs')).toMatchObject({ kind: 'rejected', hint: expect.stringMatching(/Pull first/) });
    expect(explain(' ! [remote rejected] main -> main (protected branch hook declined)')).toMatchObject({ kind: 'rejected', hint: expect.stringMatching(/protected/) });
    expect(explain('error: gpg failed to sign the data\nfatal: failed to write commit object')).toMatchObject({ kind: 'signing' });
    expect(explain('husky - pre-commit hook exited with code 1 (error)')).toMatchObject({ kind: 'hook' });
    expect(problem(['fetch'], { stdout: '', stderr: '', timedOut: true })).toMatchObject({ kind: 'timeout' });
    const p = explain('fatal: something new');
    expect(p).toMatchObject({ kind: 'other', message: 'something new', command: 'git push', detail: 'fatal: something new' });
    expect(parseStatus(' M a.ts\0R  new.ts\0old.ts\0?? n.ts\0UU c.ts\0')).toEqual([
      { path: 'a.ts', staged: false, unstaged: true, state: 'modified' },
      { path: 'new.ts', staged: true, unstaged: false, state: 'renamed', from: 'old.ts' },
      { path: 'n.ts', staged: false, unstaged: true, state: 'new' },
      { path: 'c.ts', staged: false, unstaged: false, state: 'conflict' },
    ]);
  });

  it('lays out the commit graph in lanes', () => {
    const c = (sha: string, ...parents: string[]) => ({ sha, parents, author: '', date: '', subject: sha, refs: [] });
    // m merges f into d; f and d both come from a.
    const rows = layoutGraph([c('m', 'd', 'f'), c('f', 'a'), c('d', 'a'), c('a')]);
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 1]);
    expect(rows[0]!.out).toEqual([0, 1]);
    // d's line joins the lane already waiting for a, which ends there.
    expect(rows[2]!.out).toEqual([1]);
    expect(rows[2]!.through).toEqual([[1, 1]]);
    expect(rows[3]!.into).toEqual([1]);
  });
});
