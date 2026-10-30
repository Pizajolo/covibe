import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { CHECK_SCHEMA, checkerOf, checkVerdict, goalPrompt } from '../src/engine/backlog.js';
import { EventStore } from '../src/events/store.js';
import type { PlanUsage } from '../src/runner/types.js';
import type { AppNotification, BacklogView, RunSummary } from '../src/server/api-types.js';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import { ScriptedRunner, tempDir, tempRepo, type Script } from './helpers.js';

const TEAM = new URL('../examples/build-and-review/team.yaml', import.meta.url).pathname;
const pass = { blocking_count: 0, findings: [] };

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** The builder checks goals too (the team has no lead): a goal with "?" in it has a question. */
const builder: Script = (inv, n) => {
  if (inv.outputSchema === CHECK_SCHEMA) {
    return inv.prompt.includes('?')
      ? { structured: { verdict: 'needs_info', summary: 'Add a module.', questions: [{ question: 'Which name?', options: ['b', 'c'] }] } }
      : { structured: { verdict: 'ready', summary: 'Add module a.' } };
  }
  return { write: { [`src/m${n}.js`]: `export const m = ${n};` }, text: 'Built.' };
};

async function setup(opts: { usage?: () => Promise<PlanUsage>; builder?: Script } = {}) {
  const library = new Library(tempDir('covibe-home-'));
  const runner = new ScriptedRunner({ builder: opts.builder ?? builder, reviewer: () => ({ structured: pass }) });
  if (opts.usage) (runner as ScriptedRunner & { usage?: () => Promise<PlanUsage> }).usage = opts.usage;
  server = await startServer({ library, runner, token: 't' });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
    return json as T;
  };
  const team = await api('POST', '/api/teams', { name: 'duo', template: 'build-and-review' });
  const repo = tempRepo();
  const project = await api('POST', '/api/projects', { path: repo });
  return { library, runner, api, team: team.id as string, project: project.id as string, repo };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v, null, 1).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('backlog: checking goals', () => {
  it('reads the check, and lets anything unusable through', () => {
    expect(checkVerdict({ verdict: 'ready', summary: ' Add a. ' })).toEqual({ verdict: 'ready', summary: 'Add a.' });
    expect(checkVerdict({ verdict: 'needs_info', summary: 'x', questions: [{ question: 'Which?', options: ['a', 'b', 'a'] }, { question: ' ' }] })).toEqual({
      verdict: 'needs_info',
      summary: 'x',
      questions: [{ question: 'Which?', options: ['a', 'b'] }],
    });
    // Needs info but asks nothing: nothing to wait for.
    expect(checkVerdict({ verdict: 'needs_info', questions: [] })).toEqual({ verdict: 'ready' });
    expect(checkVerdict('nonsense')).toEqual({ verdict: 'ready' });
  });

  it('gives the team your answers with the goal', () => {
    expect(goalPrompt({ text: 'Add a' })).toBe('Add a');
    const prompt = goalPrompt({ text: 'Add a', check: { verdict: 'needs_info', at: '', questions: [{ question: 'Which name?', answer: 'b' }, { question: 'Tests?' }] } });
    expect(prompt).toContain('Which name?\n  b');
    expect(prompt).not.toContain('Tests?');
  });

  it('checks with the lead read-only, on a faster model when asked', () => {
    const team = loadTeam(TEAM);
    const lead = checkerOf(team, 'lead');
    expect(lead.name).toBe('builder');
    expect(lead.writes).toBe(false);
    expect(lead.tools).not.toContain('Write');
    expect(lead.model).toBe(team.agents.builder!.model);
    const fast = checkerOf(team, 'fast');
    expect(fast.model).toBe('haiku');
    expect(fast.effort).toBeUndefined();
  });

  it('keeps goals in order in the store', () => {
    const store = new EventStore(':memory:');
    const a = store.addGoal({ text: 'a', team: 't', state: 'ready', attachments: [] });
    const b = store.addGoal({ text: 'b', team: 't', state: 'ready', attachments: [] });
    const c = store.addGoal({ text: 'c', team: 't', state: 'ready', attachments: [] });
    expect(store.moveGoal(c.id, 0).map((g) => g.text)).toEqual(['c', 'a', 'b']);
    expect(store.updateGoal(a.id, { state: 'started', runs: ['r1'] })).toMatchObject({ text: 'a', state: 'started', runs: ['r1'] });
    store.deleteGoal(b.id);
    expect(store.goals().map((g) => g.text)).toEqual(['c', 'a']);
  });
});

describe('backlog: the server works it off', () => {
  it('checks goals, asks about unclear ones, and works the rest off one after another', async () => {
    const { api, runner, team, project, repo } = await setup();
    // Paused, so nothing starts while the goals are checked.
    await api('PUT', `/api/projects/${project}/backlog`, { team, auto: false });
    await api('POST', `/api/projects/${project}/goals`, { goals: ['Add module a', 'Add another module?'] });

    let view = await until(
      () => api<BacklogView>('GET', `/api/projects/${project}/backlog`),
      (v) => v.goals.every((g) => g.status !== 'checking'),
    );
    expect(view.goals.map((g) => g.status)).toEqual(['ready', 'needs_info']);
    expect(view.goals[1]!.check).toMatchObject({ verdict: 'needs_info', by: 'builder', questions: [{ question: 'Which name?', options: ['b', 'c'] }] });
    expect(view.state).toEqual({ kind: 'paused' });
    // The check ran read-only on the faster model.
    const check = runner.calls.find((c) => c.outputSchema === CHECK_SCHEMA)!;
    expect(check.model).toBe('haiku');
    expect(check.tools).not.toContain('Write');
    // The checks are not listed as runs, but you hear about the questions.
    expect((await api<RunSummary[]>('GET', '/api/runs')).length).toBe(0);
    const notes = await api<AppNotification[]>('GET', '/api/notifications');
    expect(notes).toContainEqual(expect.objectContaining({ kind: 'question', title: 'Questions before the team starts', goalId: view.goals[1]!.id, body: 'Add another module?' }));

    await api('POST', `/api/projects/${project}/goals/${view.goals[1]!.id}/answer`, { answers: ['c'] });
    await api('PUT', `/api/projects/${project}/backlog`, { auto: true });

    view = await until(
      () => api<BacklogView>('GET', `/api/projects/${project}/backlog`),
      (v) => v.goals.every((g) => g.status === 'succeeded'),
      20_000,
    );
    expect(view.state).toEqual({ kind: 'idle' });
    const [first, second] = view.goals.map((g) => g.run!);
    // One after the other, the second on the first's result, with your answer.
    expect(Date.parse(second!.startedAt)).toBeGreaterThanOrEqual(Date.parse(first!.finishedAt!));
    expect(second!.base).toBe(first!.branch);
    expect(second!.goal).toContain('Which name?\n  c');
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', second!.branch!], { cwd: repo, encoding: 'utf8' });
    // The builder's turns 0 and 1 were the checks; 2 built the first goal, 3 the second.
    expect(files.split('\n')).toEqual(expect.arrayContaining(['src/m2.js', 'src/m3.js']));
  }, 30_000);

  it('waits while plan usage is above the threshold, and starts when you say so', async () => {
    const resets = new Date(Date.now() + 3_600_000).toISOString();
    const { api, team, project } = await setup({
      usage: async () => ({ available: true, windows: [{ window: 'five_hour', label: '5-hour session', utilization: 95, resetsAt: resets }] }),
    });
    await api('PUT', `/api/projects/${project}/backlog`, { team, check: 'off' });
    await api('POST', `/api/projects/${project}/goals`, { goal: 'Add module a' });

    const view = await until(
      () => api<BacklogView>('GET', `/api/projects/${project}/backlog`),
      (v) => v.state.kind === 'waiting',
    );
    expect(view.state).toEqual({ kind: 'waiting', until: resets, window: 'five_hour', label: '5-hour session', used: 95 });
    expect(view.goals[0]).toMatchObject({ status: 'ready', check: { verdict: 'skipped' } });

    await api('POST', `/api/projects/${project}/backlog/next`);
    await until(
      () => api<BacklogView>('GET', `/api/projects/${project}/backlog`),
      (v) => v.goals[0]!.status === 'succeeded',
      20_000,
    );

    // Without a threshold the next goal starts on its own.
    await api('PUT', '/api/settings', { backlogMaxUsage: null });
    await api('POST', `/api/projects/${project}/goals`, { goal: 'Add module b' });
    await until(
      () => api<BacklogView>('GET', `/api/projects/${project}/backlog`),
      (v) => v.goals[1]?.status === 'succeeded',
      20_000,
    );
  }, 30_000);

  it('pauses when you stop a goal\'s run, so the next one does not start right away', async () => {
    // The builder works until it is stopped (or 5 s pass).
    const { api, runner, team, project } = await setup({ builder: () => ({ awaitLive: 1, text: 'Working.' }) });
    await api('PUT', `/api/projects/${project}/backlog`, { team, check: 'off', auto: false });
    let view = await api<BacklogView>('POST', `/api/projects/${project}/goals`, { goals: ['first', 'second'] });
    const working = runner.whenWorking('builder');
    await api('PUT', `/api/projects/${project}/backlog`, { auto: true });
    await working;
    view = await api('GET', `/api/projects/${project}/backlog`);
    expect(view.state).toEqual({ kind: 'working', goalId: view.goals[0]!.id });
    await expect(api('DELETE', `/api/projects/${project}/goals/${view.goals[0]!.id}`)).rejects.toThrow(/stop its run first/);
    await api('POST', `/api/runs/${project}/${view.goals[0]!.run!.id}/stop`);
    view = await until(
      () => api<BacklogView>('GET', `/api/projects/${project}/backlog`),
      (v) => v.state.kind === 'paused',
    );
    expect(view.settings.auto).toBe(false);
    expect(view.goals.map((g) => g.status)).toEqual(['failed', 'ready']);
    // Try again puts it back in line.
    view = await api('POST', `/api/projects/${project}/goals/${view.goals[0]!.id}/queue`);
    expect(view.goals.map((g) => g.status)).toEqual(['ready', 'ready']);
  }, 20_000);

  it('edits, reorders and removes goals that have not started', async () => {
    const { api, team, project } = await setup();
    await api('PUT', `/api/projects/${project}/backlog`, { team, auto: false, check: 'off' });
    let view = await api<BacklogView>('POST', `/api/projects/${project}/goals`, { goals: ['one', 'two', 'three'] });
    const [one, two, three] = view.goals.map((g) => g.id);
    view = await api('POST', `/api/projects/${project}/goals/${three}/move`, { index: 0 });
    expect(view.goals.map((g) => g.text)).toEqual(['three', 'one', 'two']);
    view = await api('PUT', `/api/projects/${project}/goals/${one}`, { text: 'one, better' });
    expect(view.goals.find((g) => g.id === one)).toMatchObject({ text: 'one, better', status: 'ready' });
    view = await api('DELETE', `/api/projects/${project}/goals/${two}`);
    expect(view.goals.map((g) => g.text)).toEqual(['three', 'one, better']);
    await expect(api('POST', `/api/projects/${project}/goals`, { goals: ['a', 'b'], attachments: ['abcdefgh'] })).rejects.toThrow(/one goal at a time/);
    await expect(api('PUT', '/api/settings', { backlogMaxUsage: 150 })).rejects.toThrow(/percentage/);
  });
});
