import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { HelperDetail } from '../src/server/api-types.js';
import { ghReadsOnly, gitReadsOnly } from '../src/server/git-helper.js';
import { Library } from '../src/server/library.js';
import { ScriptedRunner, tempDir, tempRepo, type Script } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(helper: Script) {
  const library = new Library(tempDir('covibe-home-'));
  const runner = new ScriptedRunner({ 'git-helper': helper });
  server = await startServer({ library, runner, token: 't' });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status, body: json });
    return json as T;
  };
  const repo = tempRepo();
  const project = await api('POST', '/api/projects', { path: repo });
  return { api, runner, repo, project };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('git helper', () => {
  it('tells reading commands from ones that change something', () => {
    for (const ok of [['status'], ['log', '--oneline', '-5'], ['diff', 'HEAD'], ['branch', '-vv'], ['branch', '--show-current'], ['remote', '-v'], ['stash', 'list'], ['config', '--get', 'user.email'], ['fetch', '--all', '--prune'], ['tag'], ['reflog']]) {
      expect(gitReadsOnly(ok), ok.join(' ')).toBe(true);
    }
    for (const change of [['commit', '-m', 'x'], ['branch', 'new'], ['branch', '-D', 'x'], ['tag', 'v1'], ['remote', 'add', 'o', 'u'], ['stash'], ['stash', 'drop'], ['config', 'user.email', 'x'], ['reset', '--hard'], ['push'], ['reflog', 'expire', '--all'], ['diff', '--output=/tmp/x'], ['log', '-p', '--output', 'x'], ['grep', '-O', 'x'], ['fetch', '--upload-pack=evil'], ['-C', '/', 'status'], ['-c', 'core.pager=evil', 'log']]) {
      expect(gitReadsOnly(change), change.join(' ')).toBe(false);
    }
    expect(ghReadsOnly(['pr', 'view', '12'])).toBe(true);
    expect(ghReadsOnly(['auth', 'status'])).toBe(true);
    expect(ghReadsOnly(['pr', 'merge', '12'])).toBe(false);
    expect(ghReadsOnly(['api', 'repos/x'])).toBe(false);
  });

  it('looks around on its own and runs a change only once the person says so', async () => {
    const { api, runner, repo, project } = await setup((inv, n) =>
      n === 0
        ? {
            call: [
              { tool: 'git', args: { args: ['status', '--short'] } },
              { tool: 'git', args: { args: ['add', '-A'], why: 'Stage the new file' } },
              { tool: 'git', args: { args: ['commit', '-m', 'Add notes'], why: 'Commit it' } },
              { tool: 'git', args: { args: ['-C', '/', 'status'] } },
            ],
            text: 'Committed your notes.',
          }
        : { text: `Second message: ${inv.prompt.split('\n')[0]}` },
    );
    writeFileSync(join(repo, 'notes.txt'), 'hello\n');
    const { runId } = await api('POST', `/api/projects/${project.id}/git-helper`, { message: 'Please commit my notes' });
    expect(await api('GET', `/api/projects/${project.id}/git-helper`)).toMatchObject({ runId });

    // The first change waits; the person runs it.
    let d = await until(() => api<HelperDetail>('GET', `/api/git-helper/${runId}`), (x) => x.thread.some((i) => i.kind === 'proposal' && i.state === 'waiting'));
    const status = d.thread.find((i) => i.kind === 'command')!;
    expect(status).toMatchObject({ program: 'git', args: ['status', '--short'], ok: true, output: '?? notes.txt' });
    const add = d.thread.find((i) => i.kind === 'proposal')! as Extract<HelperDetail['thread'][number], { kind: 'proposal' }>;
    expect(add).toMatchObject({ args: ['add', '-A'], why: 'Stage the new file', state: 'waiting' });
    expect(git(repo, 'status', '--porcelain')).toBe('?? notes.txt');
    await api('POST', `/api/git-helper/${runId}/decide`, { id: add.proposal, run: true });

    // The second one the person declines.
    d = await until(() => api<HelperDetail>('GET', `/api/git-helper/${runId}`), (x) => x.thread.filter((i) => i.kind === 'proposal' && i.state === 'waiting').length === 1 && x.thread.some((i) => i.kind === 'proposal' && i.state === 'ran'));
    const commit = d.thread.find((i) => i.kind === 'proposal' && i.state === 'waiting') as Extract<HelperDetail['thread'][number], { kind: 'proposal' }>;
    await expect(api('POST', `/api/git-helper/${runId}/decide`, { id: 'nope', run: true })).rejects.toThrow(/no longer waiting/);
    await api('POST', `/api/git-helper/${runId}/decide`, { id: commit.proposal, run: false });
    d = await until(() => api<HelperDetail>('GET', `/api/git-helper/${runId}`), (x) => !x.busy);

    expect(git(repo, 'status', '--porcelain')).toBe('A  notes.txt');
    expect(d.thread.filter((i) => i.kind === 'proposal').map((i) => (i as { state: string }).state)).toEqual(['ran', 'skipped']);
    expect(d.thread.at(-1)).toMatchObject({ kind: 'agent', text: 'Committed your notes.' });
    const results = runner.toolResults.map((r) => r.result);
    expect(results[1]).toMatch(/^The person ran it\. exit code 0/);
    expect(results[2]).toMatch(/did not run it/);
    expect(results[3]).toMatch(/without options before it/);

    // It gets the repository's state with every message, and keeps the conversation.
    expect(runner.calls[0]!.prompt).toContain('<repository_state>');
    expect(runner.calls[0]!.prompt).toContain('notes.txt [new]');
    await api('POST', `/api/projects/${project.id}/git-helper`, { message: 'And now?', runId });
    await until(() => api<HelperDetail>('GET', `/api/git-helper/${runId}`), (x) => !x.busy && x.thread.some((i) => i.kind === 'agent' && i.text.startsWith('Second message')));
    expect(runner.calls[1]!.resumeSessionId).toBe('session-git-helper');
  });

  it('may edit only files that have merge conflicts', async () => {
    const { api, runner, repo, project } = await setup(() => ({ write: { 'a.txt': 'both\n', 'README.md': 'rewritten\n' }, text: 'Resolved a.txt.' }));
    const main = git(repo, 'symbolic-ref', '--short', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'switch', '-qc', 'other');
    writeFileSync(join(repo, 'a.txt'), 'theirs\n');
    git(repo, 'commit', '-qam', 'theirs');
    git(repo, 'switch', '-q', main);
    writeFileSync(join(repo, 'a.txt'), 'ours\n');
    git(repo, 'commit', '-qam', 'ours');
    try {
      git(repo, 'merge', 'other');
    } catch {
      // the conflict is the point
    }
    const { runId } = await api('POST', `/api/projects/${project.id}/git-helper`, { message: 'Help me with this merge' });
    const d = await until(() => api<HelperDetail>('GET', `/api/git-helper/${runId}`), (x) => !x.busy);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('both\n');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# app\n');
    expect(runner.denied).toEqual([{ agent: 'git-helper', tool: 'Write', reason: expect.stringMatching(/only edit files that have merge conflicts right now \(a\.txt\)/) }]);
    expect(d.thread.some((i) => i.kind === 'note' && /Not allowed/.test(i.text))).toBe(true);
    expect(runner.calls[0]!.prompt).toMatch(/In progress: merge .*Conflicts: a\.txt/);
  });

  it('answers a failed operation with what went wrong and what to do', async () => {
    const { api, project } = await setup(() => ({ text: 'ok' }));
    const err = await api('POST', `/api/projects/${project.id}/git/push`, {}).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ error: 'This repository has no remote to push to', git: { kind: 'no_remote', hint: expect.stringMatching(/Add a remote/) } });
    await expect(api('POST', `/api/projects/${project.id}/git/nonsense`, {})).rejects.toThrow(/no git operation/);
    const ran = await api('POST', `/api/projects/${project.id}/git/run`, { command: 'git log --format=%s' });
    expect(ran).toMatchObject({ ok: true, args: ['log', '--format=%s'], output: 'init' });
  });
});
