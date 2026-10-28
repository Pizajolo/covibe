import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitCheckout, gitCommit, gitMerge, gitOverview, gitPullRequest, gitPush, gitRevert, gitShow, parseStatus, webUrl } from '../src/server/gitops.js';
import { layoutGraph } from '../ui/src/components/git-graph.js';
import { tempDir, tempRepo } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('git in the project checkout', () => {
  it('reads status, branches and history, and commits, switches, merges and reverts', async () => {
    const repo = tempRepo();
    const main = git(repo, 'symbolic-ref', '--short', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    let g = await gitOverview(repo);
    expect(g.branch).toBe(main);
    expect(g.files).toEqual([{ path: 'a.txt', staged: false, state: 'new' }]);
    expect(g.pullRequests).toBe('none');

    await expect(gitCommit(repo, '  ')).rejects.toThrow(/message/);
    await gitCommit(repo, 'Add a');
    await gitCheckout(repo, 'feature/b', true);
    writeFileSync(join(repo, 'b.txt'), 'two\n');
    const b = await gitCommit(repo, 'Add b');
    await gitCheckout(repo, main);
    await expect(gitCheckout(repo, '--force')).rejects.toThrow(/not a valid/);
    const merge = await gitMerge(repo, 'feature/b');

    g = await gitOverview(repo);
    expect(g.files).toEqual([]);
    expect(g.branches.map((x) => [x.name, x.current])).toEqual(expect.arrayContaining([[main, true], ['feature/b', false]]));
    expect(g.commits[0]).toMatchObject({ sha: merge, subject: `Merge feature/b into ${main}`, parents: [expect.any(String), b] });
    expect(g.commits[0]!.refs).toContain(`HEAD -> ${main}`);
    expect((await gitShow(repo, b)).files).toEqual([{ path: 'b.txt', additions: 1, deletions: 0 }]);

    // Reverting the merge takes b.txt out again, with a new commit.
    await gitRevert(repo, merge);
    expect(git(repo, 'ls-files')).not.toContain('b.txt');
    expect(git(repo, 'log', '-1', '--format=%s')).toMatch(/^Revert/);
  });

  it('pushes to the remote and hands back the page for a pull request without gh', async () => {
    const remote = tempDir();
    git(remote, 'init', '-q', '--bare');
    const repo = tempRepo();
    git(repo, 'remote', 'add', 'origin', remote);
    await gitCheckout(repo, 'feature/x', true);
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    await gitCommit(repo, 'Add x');
    expect(await gitPush(repo)).toEqual({ branch: 'feature/x', remote: 'origin' });
    expect(git(remote, 'branch', '--list', 'feature/x')).toContain('feature/x');
    const g = await gitOverview(repo);
    expect(g.branches.find((x) => x.current)).toMatchObject({ upstream: 'origin/feature/x', ahead: 0, behind: 0 });
    await expect(gitPullRequest(repo, { branch: 'feature/x', base: 'main', title: 'X' })).rejects.toThrow(/cannot tell where/);

    expect(webUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app');
    expect(webUrl('https://user@gitlab.com/acme/app.git')).toBe('https://gitlab.com/acme/app');
    expect(webUrl('/tmp/remote')).toBeUndefined();
    expect(parseStatus(' M a.ts\0R  new.ts\0old.ts\0?? n.ts\0')).toEqual([
      { path: 'a.ts', staged: false, state: 'modified' },
      { path: 'new.ts', staged: true, state: 'renamed' },
      { path: 'n.ts', staged: false, state: 'new' },
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
