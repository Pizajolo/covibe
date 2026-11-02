import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { runTeam } from '../src/engine/engine.js';
import { normalizeTasks, replayBoard, TaskBoard } from '../src/engine/tasks.js';
import { EventStore } from '../src/events/store.js';
import type { NewEvent } from '../src/events/types.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;
const plan = {
  summary: 'Greeting page and API.',
  tasks: [
    { id: 't1', owner: 'frontend', title: 'Page', description: 'Show it', acceptance: ['shows greeting'] },
    { id: 't2', owner: 'backend', title: 'API', description: 'GET /greeting', acceptance: ['returns hello'] },
  ],
};
const build = { status: 'done', summary: 'built', files_changed: [] };

describe('the todo list of a run', () => {
  it("is the plan's tasks, worked on while each member's step runs and done when it hands it in", async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({
      manager: (_inv, n) => (n === 0 ? { structured: plan } : { text: 'Done.' }),
      // The frontend marks its own task as it goes; the backend leaves it to the engine.
      frontend: () => ({ call: [{ tool: 'update_task', args: { id: 't1', status: 'done', note: 'page is up' } }], structured: build }),
      backend: () => ({ structured: build }),
      qa: () => ({ structured: { blocking_count: 0, findings: [] } }),
      tester: () => ({ structured: { command: 'npm test', passed: 1, failed: 0, failures: [] } }),
    });
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner });
    expect(outcome.status).toBe('succeeded');

    const events = store.events(outcome.runId);
    expect(events.find((e) => e.type === 'tasks.planned')).toMatchObject({ step: 'plan', agent: 'manager', data: { source: 'report', tasks: [{ id: 't1', owner: 'frontend', title: 'Page' }, { id: 't2', owner: 'backend', title: 'API' }] } });
    const updates = events.filter((e) => e.type === 'task.updated').map((e) => [e.agent, e.data.id, e.data.status]);
    expect(updates).toEqual(expect.arrayContaining([
      ['frontend', 't1', 'working'],
      ['frontend', 't1', 'done'],
      ['backend', 't2', 'working'],
      ['backend', 't2', 'done'],
    ]));
    expect(replayBoard(events)).toMatchObject([
      { id: 't1', status: 'done', note: 'page is up' },
      { id: 't2', status: 'done' },
    ]);
    // Each builder read the list, and could update it; the planner (whose report lists tasks) was not asked to write one.
    expect(runner.callsFor('frontend')[0]!.prompt).toMatch(/## Todo list\n\nYour tasks:\n- \[working\] t1: Page/);
    expect(runner.callsFor('manager')[0]!.customTools?.map((t) => t.name)).not.toContain('plan_tasks');
  });

  it('is written with plan_tasks by a planner whose report does not list tasks', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': `version: 1
name: duo
lead: planner
agents:
  planner: { prompt: "You plan the work.\\n", tools: [Read] }
  builder: { prompt: "You build it.\\n", tools: [Read, Write] }
workflow:
  steps:
    - { id: plan, agent: planner }
    - { id: build, agent: builder }
`,
    });
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({
      planner: () => ({ call: [{ tool: 'plan_tasks', args: { tasks: ['builder: Add the page', 'builder: Style it', 'Tidy up'] } }], text: 'Planned.' }),
      builder: () => ({ call: [{ tool: 'update_task', args: { id: 'T2', status: 'blocked', note: 'no design yet' } }], text: 'Built.' }),
    });
    const outcome = await runTeam({ team: loadTeam(`${dir}/team.yaml`), repo, goal: 'A page', store, runner });
    expect(outcome.status).toBe('succeeded');
    expect(runner.callsFor('planner')[0]!.prompt).toMatch(/plan_tasks/);
    expect(runner.toolResults.find((r) => r.tool === 'plan_tasks')!.result).toMatch(/3 task\(s\); 1 name no member/);
    expect(replayBoard(store.events(outcome.runId))).toMatchObject([
      { id: 'T1', owner: 'builder', title: 'Add the page', status: 'done' },
      { id: 'T2', owner: 'builder', title: 'Style it', status: 'blocked', note: 'no design yet' },
      { id: 'T3', title: 'Tidy up', status: 'open' },
    ]);
  });
});

describe('the task board', () => {
  it('gives tasks ids and owners however the plan wrote them', () => {
    expect(normalizeTasks(['Write docs', { description: 'Fix the bug\nin detail', agent: 'dev' }, { id: 7, title: 'Seven' }, { id: 7, title: 'Again' }])).toEqual([
      { id: 'T1', title: 'Write docs' },
      { id: 'T2', title: 'Fix the bug', owner: 'dev', description: 'Fix the bug\nin detail' },
      { id: '7', title: 'Seven' },
      { id: "7'", title: 'Again' },
    ]);
  });

  it('finds the tasks a step hands a member, keeps progress when replanned, and only members update their own', () => {
    const events: NewEvent[] = [];
    const board = new TaskBoard((e) => events.push(e));
    board.plan([{ id: 'a', owner: 'x', title: 'A' }, { title: 'B', owner: 'y' }], { step: 'plan', agent: 'lead' }, 'report');
    expect(board.match([{ id: 'a', title: 'A', owner: 'x' }])).toEqual(['a']);
    expect(board.match({ items: [{ title: 'B' }] })).toEqual(['T2']);
    expect(board.match(['some acceptance criterion'])).toEqual([]);
    board.set(['a'], 'done', { agent: 'x' });
    board.set(['a'], 'done', { agent: 'x' }); // no change, no event
    expect(events.filter((e) => e.type === 'task.updated')).toHaveLength(1);
    board.plan([{ id: 'a', owner: 'x', title: 'A, renamed' }], { step: 'plan', agent: 'lead' }, 'report');
    expect(board.list).toEqual([{ id: 'a', owner: 'x', title: 'A, renamed', status: 'done' }]);
    expect(replayBoard(events.map((e) => ({ ...e, data: e.data as Record<string, unknown> })))).toMatchObject([{ id: 'a', status: 'done' }]);
  });

  it('shows nobody working on a run that stopped', () => {
    const events = [
      { type: 'tasks.planned', data: { tasks: [{ id: 'T1', title: 'A' }] } },
      { type: 'task.updated', agent: 'x', data: { id: 'T1', status: 'working' } },
    ];
    expect(replayBoard(events)[0]!.status).toBe('working');
    expect(replayBoard(events, false)[0]!.status).toBe('open');
  });
});
