import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { chat } from '../src/engine/chat.js';
import { cleanupWorktrees, worktreeReport } from '../src/engine/cleanup.js';
import { buildInvocation, startRun } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const DUO = `
version: 1
name: duo
agents:
  builder:
    prompt: "Build.\\n"
    tools: [Read, Write, Bash]
    scope: { write: ["src/**"] }
    can_message: [reviewer]
  reviewer:
    prompt: "Review.\\n"
    tools: [Read]
workflow:
  steps:
    - { id: build, agent: builder }
    - { id: review, agent: reviewer }
`;

function duo(extra = '') {
  const dir = tempDir();
  writeFiles(dir, { 'team.yaml': DUO.replace('name: duo', `name: duo${extra}`) });
  return loadTeam(join(dir, 'team.yaml'));
}

describe('live messages', () => {
  it('steers or interrupts a working member, and keeps queue-mode messages for its next turn', async () => {
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({
      builder: () => ({ awaitLive: 2, write: { 'src/a.js': 'a' }, text: 'built' }),
      reviewer: () => ({ text: 'ok' }),
    });
    const working = runner.whenWorking('builder');
    const team = duo();
    const { runId, done } = await startRun({ team, repo: tempRepo(), goal: 'g', store, runner, env: {} });
    await working;

    const steer = await chat({ store, runner, team, runId, agent: 'builder', message: 'use tabs', delivery: 'steer' });
    const later = await chat({ store, runner, team, runId, agent: 'reviewer', message: 'check names', delivery: 'queue' });
    const stop = await chat({ store, runner, team, runId, agent: 'builder', message: 'stop, use spaces', delivery: 'interrupt' });
    expect([steer.mode, later.mode, stop.mode]).toEqual(['queued', 'queued', 'queued']);

    const outcome = await done;
    expect(outcome.status).toBe('succeeded');
    expect(runner.live).toEqual([
      { agent: 'builder', text: expect.stringContaining('use tabs'), priority: 'next' },
      { agent: 'builder', text: expect.stringContaining('stop, use spaces'), priority: 'now' },
    ]);
    // The queue-mode message waited for the reviewer's own turn.
    expect(runner.callsFor('reviewer')[0]!.prompt).toContain('from human: check names');
    const delivered = store.events(runId).filter((e) => e.type === 'message.delivered');
    expect(delivered.map((e) => [e.agent, e.data.live ?? false, e.data.mode ?? null])).toEqual([
      ['builder', true, 'steer'],
      ['builder', true, 'interrupt'],
      ['reviewer', false, null],
    ]);
  });

  it('delivers a teammate message while the recipient works', async () => {
    const store = new EventStore(':memory:');
    const team = duo();
    const runner = new ScriptedRunner({ builder: () => ({ text: 'x' }), reviewer: () => ({ text: 'y' }) });
    const { runId } = await startRun({ team, repo: tempRepo(), goal: 'g', store, runner, env: {} }).then(async (r) => (await r.done, r));
    const sent: { text: string; priority: string }[] = [];
    const inv = buildInvocation(team, store, runId, team.agents.builder!, { cwd: '/x', root: '/x', prompt: 'p', env: {}, step: 's', signal: new AbortController().signal });
    const recipient = buildInvocation(team, store, runId, team.agents.reviewer!, { cwd: '/x', root: '/x', prompt: 'p', env: {}, step: 's', signal: new AbortController().signal });
    recipient.onControl!({ send: (text, priority) => (sent.push({ text, priority }), true) });
    expect(inv.sendMessage('reviewer', 'API is GET /x')).toMatch(/reads it between its tool calls/);
    await new Promise((r) => setTimeout(r, 700));
    recipient.onControl!(null);
    expect(sent).toEqual([{ text: '[Message from your teammate builder]\nAPI is GET /x', priority: 'next' }]);
  });
});

describe('sandbox config', () => {
  it('sandboxes members with Bash by default, with registry and cache defaults', () => {
    const team = duo();
    expect(team.agents.builder!.sandbox).toMatchObject({ network: expect.arrayContaining(['registry.npmjs.org']), allowWrite: expect.arrayContaining([expect.stringMatching(/\/\.npm$/)]) });
    expect(team.agents.reviewer!.sandbox).toBeUndefined();
    const inv = buildInvocation(team, new EventStore(':memory:'), 'r', team.agents.builder!, { cwd: '/x', root: '/x', prompt: 'p', env: {}, step: 's', signal: new AbortController().signal });
    expect(inv.sandbox).toBe(team.agents.builder!.sandbox);
    expect(inv.systemPrompt).toContain('Shell commands run in a sandbox');
  });

  it('lets teams and members override or disable it', () => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': DUO.replace('version: 1', 'version: 1\ndefaults:\n  sandbox: { network: [example.com], allow_write: ["~/scratch"] }').replace(
        'can_message: [reviewer]',
        'can_message: [reviewer]\n    sandbox: { network: [api.example.com] }',
      ),
    });
    const team = loadTeam(join(dir, 'team.yaml'));
    expect(team.agents.builder!.sandbox!.network).toEqual(['api.example.com']);
    expect(team.agents.builder!.sandbox!.allowWrite).toEqual([join(process.env.HOME ?? require('node:os').homedir(), 'scratch')]);
    writeFiles(dir, { 'off.yaml': DUO.replace('can_message: [reviewer]', 'can_message: [reviewer]\n    sandbox: { enabled: false }') });
    expect(loadTeam(join(dir, 'off.yaml')).agents.builder!.sandbox).toBeUndefined();
  });
});

describe('worktree cleanup', () => {
  it('removes worktrees of finished runs, keeps branches, and restores a worktree for chat', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const team = duo();
    const runner = new ScriptedRunner({ builder: (_i, n) => ({ write: { 'src/a.js': `v${n}` }, text: 'built' }), reviewer: () => ({ text: 'ok' }) });
    const { runId, done } = await startRun({ team, repo, goal: 'g', store, runner, env: {} });
    const outcome = await done;

    const report = await worktreeReport(repo, store);
    expect(report).toEqual([expect.objectContaining({ runId, live: false, status: 'succeeded', worktrees: expect.arrayContaining(['_integration', 'builder']) })]);
    expect((await cleanupWorktrees(repo, store, { olderThanDays: 1 })).skipped).toEqual([{ runId, reason: 'finished recently' }]);

    const res = await cleanupWorktrees(repo, store, { runIds: [runId] });
    expect(res.cleaned.map((c) => c.runId)).toEqual([runId]);
    expect(await worktreeReport(repo, store)).toEqual([]);
    const branches = execFileSync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' });
    expect(branches).toContain(outcome.branch!);
    expect(branches).toContain(`covibe-agents/${runId}/builder`);
    expect(store.events(runId).at(-1)!.type).toBe('workspace.cleaned');

    // Chat afterwards: the builder's worktree comes back at the same path and its edit is merged.
    const cwd = store.getSession(runId, 'builder')!.cwd;
    expect(existsSync(cwd)).toBe(false);
    const reply = await chat({ store, runner, team, runId, agent: 'builder', message: 'once more', env: {} });
    expect(reply).toMatchObject({ mode: 'replied', ok: true });
    expect(existsSync(cwd)).toBe(true);
    expect(execFileSync('git', ['show', `${outcome.branch}:src/a.js`], { cwd: repo, encoding: 'utf8' })).toBe('v1');
  });

  it('never removes a live run', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({ builder: () => ({ awaitLive: 1 }), reviewer: () => ({ text: 'ok' }) });
    const working = runner.whenWorking('builder');
    const team = duo();
    const { runId, done } = await startRun({ team, repo, goal: 'g', store, runner, env: {} });
    await working;
    expect((await cleanupWorktrees(repo, store)).skipped).toEqual([{ runId, reason: 'still running' }]);
    await chat({ store, runner, team, runId, agent: 'builder', message: 'done', delivery: 'steer' });
    await done;
  });
});
