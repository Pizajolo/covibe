import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { resumePoint, runTeam } from '../src/engine/engine.js';
import { feedbackOwners } from '../src/engine/selection.js';
import { EventStore } from '../src/events/store.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles, type Script } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;

const task = (id: string, owner: string) => ({ id, owner, title: `${owner} work`, description: 'do it', files: [`${owner === 'frontend' ? 'web' : 'api'}/x`], acceptance: ['works'] });
const plan = (members?: string[]) => ({ summary: 'Plan.', ...(members ? { members } : {}), tasks: [task('t1', 'frontend'), task('t2', 'backend')] });
const build = (files: string[]) => ({ status: 'done', summary: 'built', files_changed: files });
const clean = { blocking_count: 0, findings: [] };
const finding = (owner?: string) => ({ severity: 'blocking', ...(owner ? { owner } : {}), file: 'web/index.html', message: 'typo' });

function scripts(over: Partial<Record<string, Script>> = {}): Record<string, Script> {
  return {
    manager: (_inv, n) => (n === 0 ? { structured: plan() } : { text: 'Done.' }),
    frontend: (_inv, n) => ({ write: { 'web/index.html': `<h1>hello ${n}</h1>` }, structured: build(['web/index.html']) }),
    backend: (_inv, n) => ({ write: { 'api/greeting.ts': `export const g = ${n};` }, structured: build(['api/greeting.ts']) }),
    qa: () => ({ structured: clean }),
    tester: () => ({ structured: { command: 'npm test', passed: 1, failed: 0, failures: [] } }),
    ...over,
  } as Record<string, Script>;
}

/** A team whose planner chooses with the select_members tool (its plan has no schema). */
function toolTeam(required = '') {
  const dir = tempDir();
  writeFiles(dir, {
    'team.yaml': `
version: 1
name: pick
lead: lead
agents:
  lead: { prompt: "Plan.\\n", tools: [Read] }
  builder: { prompt: "Build.\\n", tools: [Read, Write] }
  reviewer: { prompt: "Review.\\n", tools: [Read], description: Reviews the change }
  docs: { prompt: "Write docs.\\n", tools: [Read, Write] }
workflow:
  steps:
    - { id: plan, agent: lead }
    - { id: build, agent: builder }
    - { id: docs, agent: docs }
    - { id: review, agent: reviewer${required} }
    - { id: report, agent: lead }
`,
  });
  return loadTeam(join(dir, 'team.yaml'));
}

describe('choosing the members a goal needs', () => {
  it('skips the steps of members the plan leaves out, gates included', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(scripts({ manager: (_inv, n) => (n === 0 ? { structured: plan(['frontend', 'backend']) } : { text: 'Done.' }) }));
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'g', store, runner, env: {} });

    expect(outcome.status).toBe('succeeded');
    expect(runner.callsFor('qa')).toHaveLength(0);
    expect(runner.callsFor('tester')).toHaveLength(0);
    // The summary step still runs (covibe writes it, without the manager).
    expect(runner.callsFor('manager')).toHaveLength(1);
    expect((outcome.context.report as { text: string }).text).toContain('qa, tester');
    const events = store.events(outcome.runId);
    expect(events.find((e) => e.type === 'members.selected')).toMatchObject({ agent: 'manager', data: { members: ['frontend', 'backend'], skipped: ['qa', 'tester'] } });
    expect(events.filter((e) => e.type === 'step.skipped').map((e) => [e.step, e.agent])).toEqual([
      ['review', 'qa'],
      ['test', 'tester'],
    ]);
    expect(events.some((e) => e.type === 'gate.passed' || e.type === 'gate.failed')).toBe(false);

    // The planner was asked to choose and to hand over what it found.
    const first = runner.callsFor('manager')[0]!.prompt;
    expect(first).toContain('## Who is needed');
    expect(first).toContain("your report's `members`");
    expect(first).toContain('## Hand over what you found');
    // Builders are told the plan already looked through the project.
    expect(runner.callsFor('frontend')[0]!.prompt).toContain('start from the files and facts it names');
  });

  it('runs everyone when the planner does not choose', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(scripts());
    await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'g', store, runner, env: {} });
    expect(runner.callsFor('qa')).toHaveLength(1);
    expect(runner.callsFor('tester')).toHaveLength(1);
  });

  it('lets the planner choose with select_members, keeps members with tasks and required steps', async () => {
    const run = async (required: string) => {
      const repo = tempRepo();
      const store = new EventStore(':memory:');
      const runner = new ScriptedRunner({
        lead: (_inv, n) =>
          n === 0
            ? {
                call: [
                  { tool: 'plan_tasks', args: { tasks: ['builder: Change the value', 'docs: Note it in the changelog'] } },
                  { tool: 'select_members', args: { members: ['builder'], reason: 'a one-line change' } },
                ],
                text: 'Planned.',
              }
            : { text: 'Done.' },
        builder: () => ({ write: { 'value.txt': '2' }, text: 'changed' }),
        docs: () => ({ text: 'noted' }),
        reviewer: () => ({ text: 'fine' }),
      });
      const outcome = await runTeam({ team: toolTeam(required), repo, goal: 'g', store, runner, env: {} });
      return { outcome, runner, store };
    };

    const { outcome, runner, store } = await run('');
    expect(outcome.status).toBe('succeeded');
    expect(runner.toolResults.find((r) => r.tool === 'select_members')?.result).toMatch(/Skipped unless you give them a task: docs, reviewer/);
    // docs was left out but owns a task: it runs. The reviewer does not.
    expect(runner.callsFor('docs')).toHaveLength(1);
    expect(runner.callsFor('reviewer')).toHaveLength(0);
    expect(store.events(outcome.runId).find((e) => e.type === 'step.skipped')).toMatchObject({ step: 'review', agent: 'reviewer', data: { reason: expect.stringContaining('a one-line change') } });

    // A required step runs whatever the planner chose.
    const pinned = await run(', required: true');
    expect(pinned.runner.callsFor('reviewer')).toHaveLength(1);
  });

  it('gives a member the same tools on every turn, so its prompt cache holds', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({ lead: () => ({ text: 'ok' }), builder: () => ({ text: 'ok' }), docs: () => ({ text: 'ok' }), reviewer: () => ({ text: 'ok' }) });
    await runTeam({ team: toolTeam(), repo, goal: 'g', store, runner, env: {} });
    const calls = runner.callsFor('lead');
    const tools = calls.map((c) => (c.customTools ?? []).map((t) => t.name));
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual(tools[1]);
    expect(tools[0]).toEqual(expect.arrayContaining(['plan_tasks', 'update_task', 'select_members']));
    // Only the planning turn is asked to choose.
    expect(calls[0]!.prompt).toContain('## Who is needed');
    expect(calls[1]!.prompt).not.toContain('## Who is needed');
  });

  it('tells later members what was changed and by whom', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(scripts());
    await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'g', store, runner, env: {} });
    const qa = runner.callsFor('qa')[0]!.prompt;
    expect(qa).toContain('## Changed in this run so far');
    expect(qa).toContain('- web/index.html (frontend)');
    expect(qa).toContain('- api/greeting.ts (backend)');
  });
});

describe('fix rounds', () => {
  it('rerun only the builders the feedback names', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(scripts({ qa: (_inv, n) => ({ structured: n === 0 ? { blocking_count: 1, findings: [finding('frontend')] } : clean }) }));
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'g', store, runner, env: {} });

    expect(outcome.status).toBe('succeeded');
    expect(runner.callsFor('frontend')).toHaveLength(2);
    expect(runner.callsFor('backend')).toHaveLength(1);
    // The backend's report from round 0 still stands in the build step.
    expect((outcome.context.build as Record<string, unknown>).backend).toEqual(build(['api/greeting.ts']));
    expect(store.events(outcome.runId).find((e) => e.type === 'step.skipped')).toMatchObject({ step: 'build', agent: 'backend', data: { reason: 'nothing in the feedback is its to fix' } });
  });

  it('rerun every builder when an item names no owner', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(
      scripts({
        qa: (_inv, n) => ({ structured: n === 0 ? { blocking_count: 1, findings: [finding('frontend')] } : clean }),
        tester: (_inv, n) => ({ structured: n === 0 ? { command: 't', passed: 1, failed: 1, failures: [{ test: 'x', message: 'broke' }] } : { command: 't', passed: 2, failed: 0, failures: [] } }),
      }),
    );
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'g', store, runner, env: {} });
    expect(outcome.status).toBe('succeeded');
    // Round 1 (qa: frontend) reruns only frontend; round 2 (a failure without owner) reruns both.
    expect(runner.callsFor('frontend')).toHaveLength(3);
    expect(runner.callsFor('backend')).toHaveLength(2);
  });

  it('read owners from the feedback only when every item has one', () => {
    expect(feedbackOwners({ 'review.findings': [{ owner: 'a' }, { owner: 'b' }], 'test.failures': null })).toEqual(new Set(['a', 'b']));
    expect(feedbackOwners({ 'review.findings': [{ owner: 'a' }, { message: 'x' }] })).toBeUndefined();
    expect(feedbackOwners({ 'review.findings': ['a string'] })).toBeUndefined();
    expect(feedbackOwners({ 'review.findings': [], 'test.failures': null })).toBeUndefined();
    expect(feedbackOwners({ 'review.findings': { owner: 'a', message: 'one finding' } })).toEqual(new Set(['a']));
  });
});

describe('continuing a run', () => {
  it('keeps the planner\'s choice', async () => {
    const team = loadTeam(EXAMPLE);
    const point = await resumePoint(team, [
      { type: 'run.started', data: { goal: 'g' } },
      { type: 'step.started', step: 'plan', data: { loop: 0 } },
      { type: 'step.finished', step: 'plan', data: { output: plan(['frontend']) } },
      { type: 'members.selected', step: 'plan', agent: 'manager', data: { members: ['frontend'], skipped: ['backend', 'qa', 'tester'], reason: 'ui only' } },
      { type: 'step.started', step: 'build', data: { loop: 0 } },
      { type: 'run.finished', data: { status: 'failed' } },
    ]);
    expect(point?.selected).toEqual({ members: ['frontend'], reason: 'ui only' });
  });
});
