import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { FileSecrets } from '../src/connections/secrets.js';
import { Connections } from '../src/connections/store.js';
import { brainPrompt } from '../src/engine/brain.js';
import { runTeam } from '../src/engine/engine.js';
import { Workspace } from '../src/engine/workspace.js';
import { EventStore } from '../src/events/store.js';
import { brainRoot } from '../src/home.js';
import { memberEnv } from '../src/runner/claude-sdk.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { HelperDetail } from '../src/server/api-types.js';
import { sharesCheckout } from '../src/server/git-helper.js';
import { Library } from '../src/server/library.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe("collecting a member's work", () => {
  it('takes in commits the member made itself, and still discards what is outside its scope', async () => {
    const repo = tempRepo();
    const ws = await Workspace.create(repo, 'self-commit', 'worktree');
    const dir = await ws.prepare('builder', true);
    writeFiles(dir, { 'src/a.txt': 'mine\n', 'hack.txt': 'not mine\n' });
    // What a member does with a shell, although it is told not to.
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=m', '-c', 'user.email=m@m', 'commit', '-qm', 'my own commit');
    writeFiles(dir, { 'src/b.txt': 'left uncommitted\n' });

    const c = await ws.collect('builder', ['src/**'], 'build: builder');
    expect(c.files.sort()).toEqual(['src/a.txt', 'src/b.txt']);
    expect(c.reverted).toEqual(['hack.txt']);
    expect(c.merged).toBe(true);
    expect(git(repo, 'show', `${ws.branch}:src/a.txt`)).toBe('mine');
    expect(git(repo, 'ls-tree', '-r', '--name-only', ws.branch!).split('\n')).not.toContain('hack.txt');

    // A turn that changes nothing leaves the result as it is.
    const again = await ws.collect('builder', ['src/**'], 'build: builder');
    expect(again).toMatchObject({ files: [], merged: false });
  });

  it('commits where the project signs commits and has hooks that fail', async () => {
    const repo = tempRepo();
    git(repo, 'config', 'commit.gpgsign', 'true');
    git(repo, 'config', 'gpg.program', '/bin/false');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);

    const ws = await Workspace.create(repo, 'signed', 'worktree');
    const dir = await ws.prepare('builder', true);
    writeFiles(dir, { 'a.txt': 'x\n' });
    const c = await ws.collect('builder', undefined, 'build: builder');
    expect(c).toMatchObject({ files: ['a.txt'], merged: true });
  });
});

describe('the inbox', () => {
  it('hands every message over once, oldest first', () => {
    const store = new EventStore(':memory:');
    store.createRun({ id: 'r', team: 't', teamFile: '', repo: '/r', goal: 'g' });
    store.enqueue('r', 'a', 'human', 'one');
    store.enqueue('r', 'a', 'b', 'two');
    store.enqueue('r', 'other', 'human', 'not yours');
    expect(store.drainInbox('r', 'a').map((m) => [m.from, m.text])).toEqual([['human', 'one'], ['b', 'two']]);
    expect(store.drainInbox('r', 'a')).toEqual([]);
    expect(store.drainInbox('r', 'other')).toHaveLength(1);
  });

  it("knows a run's newest event without reading its log", () => {
    const store = new EventStore(':memory:');
    store.createRun({ id: 'r', team: 't', teamFile: '', repo: '/r', goal: 'g' });
    expect(store.lastEventIdOf('r')).toBe(0);
    const e = store.append('r', { type: 'run.started', data: {} });
    expect(store.lastEventIdOf('r')).toBe(e.id);
    expect(store.lastEventIdOf('nope')).toBe(0);
  });
});

describe('model providers', () => {
  it("refuses an address whose placeholder was not filled in, and keeps the list through a write", async () => {
    const home = tempDir('covibe-conn-');
    const c = new Connections(home, new FileSecrets(home));
    expect(() => c.add({ kind: 'anthropic', label: 'Alibaba', baseUrl: 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic' })).toThrow(/replace \{WorkspaceId\}/);
    const added = c.add({ kind: 'anthropic', label: 'Alibaba Cloud: Coding Plan', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic/', apiKey: 'sk-sp-x', models: [{ id: 'qwen3.7-plus' }] });
    expect(added).toMatchObject({ id: 'alibaba-cloud-coding-plan', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic' });
    expect(existsSync(join(home, 'connections.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'connections.json'), 'utf8')).connections).toHaveLength(1);

    // Another provider's key goes as a bearer token, and Claude Code's small requests go to the same model.
    const built = await c.resolve({ type: 'connection', connection: added.id, model: 'qwen3.7-plus' }, { PATH: '/usr/bin' });
    expect(built.env).toMatchObject({ ANTHROPIC_BASE_URL: added.baseUrl, ANTHROPIC_AUTH_TOKEN: 'sk-sp-x', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.7-plus' });
    expect(built.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.providerFor('qwen3.7-plus')).toEqual({ connection: added.id, model: 'qwen3.7-plus' });
    await c.close();
  });
});

describe('what a member is not given', () => {
  it('leaves out claude.ai connectors, Claude Code memory and its git instructions, unless the environment says otherwise', () => {
    expect(memberEnv({ HOME: '/h' })).toMatchObject({ HOME: '/h', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' });
    expect(memberEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: 'true', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' })).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: 'true', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' });
  });

  it("keeps a member's system prompt the same through a run while the brain grows", async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': `
version: 1
name: steady
brain: { curator: librarian, curate: manual }
agents:
  builder:
    prompt: "Build.\\n"
    tools: [Read, Write]
  librarian:
    prompt: "Keep the notes.\\n"
    tools: [Read, Write, Edit]
workflow:
  steps:
    - { id: build, agent: builder }
    - { id: notes, agent: librarian }
    - { id: polish, agent: builder }
`,
    });
    const team = loadTeam(join(dir, 'team.yaml'));
    const repo = tempRepo();
    const runner = new ScriptedRunner({
      builder: () => ({ text: 'built' }),
      librarian: (inv) => ({ write: { [relative(inv.cwd, join(brainRoot(repo), 'decisions.md'))]: '# Decisions\n' }, text: 'noted' }),
    });
    const out = await runTeam({ team, repo, goal: 'g', store: new EventStore(':memory:'), runner, env: {} });
    expect(out.status).toBe('succeeded');
    const [first, second] = runner.callsFor('builder');
    expect(first!.systemPrompt).not.toContain('decisions.md');
    expect(second!.systemPrompt).toBe(first!.systemPrompt);
    // The note is there for whoever starts after it was written.
    expect(brainPrompt(repo, team.agents.builder!, team)).toContain('decisions.md');
  });
});

describe('the git helper and uncommitted changes', () => {
  let server: CovibeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('knows which commands share the checked-out branch', () => {
    for (const [program, args] of [
      ['git', ['push']],
      ['git', ['push', 'origin']],
      ['git', ['push', '-u', 'origin', 'main']],
      ['git', ['push', 'origin', 'HEAD:refs/heads/x']],
      ['git', ['push', '--force-with-lease', 'origin', '+main']],
      ['gh', ['pr', 'create', '--fill']],
      ['gh', ['pr', 'create', '--head', 'main', '--base', 'dev']],
    ] as const) {
      expect(sharesCheckout(program, [...args], 'main'), `${program} ${args.join(' ')}`).toBe(true);
    }
    for (const [program, args] of [
      ['git', ['push', 'origin', 'other']],
      ['git', ['push', 'origin', '--delete', 'main']],
      ['git', ['push', '--tags']],
      ['git', ['commit', '-m', 'x']],
      ['gh', ['pr', 'create', '--head', 'other']],
      ['gh', ['pr', 'merge', '3']],
    ] as const) {
      expect(sharesCheckout(program, [...args], 'main'), `${program} ${args.join(' ')}`).toBe(false);
    }
  });

  it('does not propose a push past uncommitted changes until the person has been asked', async () => {
    const library = new Library(tempDir('covibe-home-'));
    const runner = new ScriptedRunner({
      'git-helper': () => ({
        call: [
          { tool: 'git', args: { args: ['push', 'origin', 'main'], why: 'Publish your commit' } },
          { tool: 'git', args: { args: ['push', 'origin', 'main'], why: 'Publish your commit', leave_uncommitted: true } },
        ],
        text: 'done',
      }),
    });
    server = await startServer({ library, runner, token: 't' });
    const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`http://127.0.0.1:${server!.port}${path}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return (await res.json()) as T;
    };
    const repo = tempRepo();
    writeFileSync(join(repo, 'left.txt'), 'not committed\n');
    const project = await api('POST', '/api/projects', { path: repo });
    const { runId } = await api('POST', `/api/projects/${project.id}/git-helper`, { message: 'push it' });

    let d: HelperDetail;
    for (;;) {
      d = await api<HelperDetail>('GET', `/api/git-helper/${runId}`);
      if (d.thread.some((i) => i.kind === 'proposal' && i.state === 'waiting')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // The first call was turned back to the helper; only the second reached the person, with the warning.
    expect(runner.toolResults[0]!.result).toMatch(/Not proposed yet: 1 file\(s\) have changes that are not committed.*left\.txt/);
    const proposals = d.thread.filter((i) => i.kind === 'proposal') as Extract<HelperDetail['thread'][number], { kind: 'proposal' }>[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.warning).toMatch(/1 file has changes that are not committed and will not be included: left\.txt/);
    await api('POST', `/api/git-helper/${runId}/decide`, { id: proposals[0]!.proposal, run: false });
  });
});

describe('the daily chart', () => {
  it('has fourteen different days when the clocks change in between', async () => {
    const { computeStats } = await import('../src/server/projections.js');
    const before = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      // 29 March 2026: the day is 23 hours long in Berlin.
      const stats = computeStats([], new Date(2026, 3, 2, 12));
      const days = stats.daily.map((d) => d.day);
      expect(new Set(days).size).toBe(14);
      expect(days).toContain('2026-03-29');
      expect(days[0]).toBe('2026-03-20');
      expect(days.at(-1)).toBe('2026-04-02');
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});
