import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadTeam } from '../src/config/load.js';
import { runTeam } from '../src/engine/engine.js';
import { systemPrompt } from '../src/engine/prompts.js';
import { RequestChains } from '../src/engine/requests.js';
import { EventStore } from '../src/events/store.js';
import { chatThreads, stepReports, summarizeRun } from '../src/server/projections.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles, type Script } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;

const plan = {
  summary: 'Add a greeting page backed by an API.',
  tasks: [
    { id: 't1', owner: 'frontend', title: 'Greeting page', description: 'Build it from design/greeting.md', acceptance: ['page shows greeting'] },
    { id: 't2', owner: 'backend', title: 'Greeting API', description: 'GET /greeting', acceptance: ['returns hello'] },
  ],
};
const build = (files: string[]) => ({ status: 'done', summary: 'built', files_changed: files });

function scripts(overrides: Partial<Record<string, Script>> = {}): Record<string, Script> {
  return {
    manager: (inv) => (inv.outputSchema ? { structured: plan } : { text: 'Shipped.' }),
    frontend: () => ({ write: { 'web/index.html': '<h1>hello</h1>' }, structured: build(['web/index.html']) }),
    backend: () => ({ write: { 'api/greeting.ts': 'export const greeting = "hello";' }, structured: build(['api/greeting.ts']) }),
    designer: () => ({ write: { 'design/greeting.md': '# Greeting\nBig, centred, friendly.' }, text: 'Made design/greeting.md: a centred headline.' }),
    qa: () => ({ structured: { blocking_count: 0, findings: [] } }),
    tester: () => ({ structured: { command: 'npm test', passed: 2, failed: 0, failures: [] } }),
    ...overrides,
  } as Record<string, Script>;
}


describe('requests between members', () => {
  it('lets a builder ask an on-call teammate for work, and merges it into the builder’s folder', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    let frontendCwd = '';
    const runner = new ScriptedRunner(
      scripts({
        frontend: (inv) => {
          frontendCwd = inv.cwd;
          return {
            call: [{ tool: 'request_work', args: { to: 'designer', request: 'Design the greeting page', context: 'one headline' } }],
            write: { 'web/index.html': '<h1>hello</h1>' },
            structured: build(['web/index.html']),
          };
        },
      }),
    );
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner, env: { PATH: process.env.PATH } });
    expect(outcome.status).toBe('succeeded');

    // The designer has no step: it worked once, on the request, and the builder got its reply and its files.
    const designer = runner.callsFor('designer');
    expect(designer).toHaveLength(1);
    expect(designer[0]!.prompt).toContain('# Request from frontend');
    expect(designer[0]!.prompt).toContain('one headline');
    const answer = runner.toolResults.find((r) => r.tool === 'request_work')!.result;
    expect(answer).toContain('Reply from designer:\nMade design/greeting.md');
    expect(answer).toContain('merged into your working folder');
    expect(existsSync(join(frontendCwd, 'design/greeting.md'))).toBe(true);

    const events = store.events(outcome.runId);
    const sent = events.find((e) => e.type === 'request.sent')!;
    expect(sent).toMatchObject({ step: 'build', agent: 'frontend', data: { id: 1, to: 'designer', request: 'Design the greeting page' } });
    expect(events.find((e) => e.type === 'request.done')!.data).toMatchObject({ id: 1, ok: true, files: ['design/greeting.md'] });
    expect(events.find((e) => e.type === 'agent.started' && e.agent === 'designer')).toMatchObject({ step: 'build', data: { request: 1, request_from: 'frontend' } });

    // Only members that may ask get the tool, and the system prompts say who asks whom.
    expect(runner.callsFor('backend')[0]!.customTools!.map((t) => t.name)).not.toContain('request_work');
    expect(runner.callsFor('frontend')[0]!.systemPrompt).toContain('You can ask designer to do work for you');
    expect(designer[0]!.systemPrompt).toContain('manager, frontend can ask you to do work for them');

    const run = store.getRun(outcome.runId)!;
    const summary = summarizeRun(run, events, { id: 'p', name: 'app' }, false, Object.keys(loadTeam(EXAMPLE).agents));
    expect(summary.requests).toEqual([expect.objectContaining({ id: 1, from: 'frontend', to: 'designer', step: 'build', status: 'done', files: ['design/greeting.md'] })]);
    expect(summary.steps.find((s) => s.id === 'build')!.cards.find((c) => c.agent === 'designer')).toMatchObject({ requestedBy: 'frontend', status: 'done' });
    const threads = chatThreads(events);
    expect(threads.designer!.map((i) => i.text)).toContain('Request from frontend: Design the greeting page');
    expect(threads.frontend!.some((i) => i.text.startsWith('designer finished: Made design/greeting.md'))).toBe(true);
  });

  it('keeps every step report in the log, with the plan picked out', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(
      scripts({
        // The manager asks the designer while it plans; nobody else does.
        manager: (inv) =>
          inv.outputSchema
            ? { call: [{ tool: 'request_work', args: { to: 'designer', request: 'Sketch the greeting page' } }], structured: plan }
            : { text: 'Shipped.' },
      }),
    );
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner, env: { PATH: process.env.PATH } });
    expect(outcome.status).toBe('succeeded');
    const events = store.events(outcome.runId);
    expect(events.find((e) => e.type === 'step.finished' && e.step === 'plan')!.data).toMatchObject({ agents: ['manager'], parallel: false, output: plan });

    const { reports, planStep } = stepReports(events);
    expect(planStep).toBe('plan');
    expect(reports.map((r) => r.step)).toEqual(['plan', 'build', 'review', 'test', 'report']);
    expect(reports.find((r) => r.step === 'build')).toMatchObject({ parallel: true, agents: ['frontend', 'backend'] });
    expect(reports.find((r) => r.step === 'report')!.output).toEqual({ text: 'Shipped.' });
    // The read-only manager sees the design at once: it works in the merged state.
    expect(runner.toolResults.find((r) => r.agent === 'manager')!.result).toContain('Reply from designer');
  });

  describe('two members that may ask each other', () => {
    const teamFile = () => {
      const dir = tempDir();
      writeFiles(dir, {
        'team.yaml': `version: 1
name: pair
lead: null
defaults: { max_parallel: 1 }
agents:
  a: { prompt: prompts/p.md, tools: [Read, Write], scope: { write: ["a/**"] }, can_request: [b] }
  b: { prompt: prompts/p.md, tools: [Read, Write], scope: { write: ["b/**"] }, can_request: [a] }
workflow:
  steps:
    - { id: one, agent: a }
`,
        'prompts/p.md': 'You are on the team.',
      });
      return join(dir, 'team.yaml');
    };

    it('never waits in a circle, even with one member at a time', async () => {
      const repo = tempRepo();
      const store = new EventStore(':memory:');
      const runner = new ScriptedRunner({
        a: () => ({ call: [{ tool: 'request_work', args: { to: 'b', request: 'make b/x' } }], write: { 'a/x': 'a' }, text: 'done' }),
        b: () => ({ call: [{ tool: 'request_work', args: { to: 'a', request: 'make a/y' } }], write: { 'b/x': 'b' }, text: 'made b/x' }),
      });
      const outcome = await runTeam({ team: loadTeam(teamFile()), repo, goal: 'g', store, runner, env: { PATH: process.env.PATH } });
      expect(outcome.status).toBe('succeeded');
      const [fromB, fromA] = [runner.toolResults.find((r) => r.agent === 'b')!, runner.toolResults.find((r) => r.agent === 'a')!];
      expect(fromB.result).toMatch(/^Error: a is waiting for you, so a cannot take a request now/);
      expect(fromA.result).toContain('Reply from b:\nmade b/x');
      expect(runner.callsFor('a')).toHaveLength(1);
    });

    it('reports a teammate that fails to the member that asked, and the run goes on', async () => {
      const repo = tempRepo();
      const store = new EventStore(':memory:');
      const runner = new ScriptedRunner({
        a: () => ({ call: [{ tool: 'request_work', args: { to: 'b', request: 'make b/x' } }], text: 'done without b' }),
        b: () => ({ fail: 'model overloaded' }),
      });
      const outcome = await runTeam({ team: loadTeam(teamFile()), repo, goal: 'g', store, runner, env: { PATH: process.env.PATH } });
      expect(outcome.status).toBe('succeeded');
      expect(runner.toolResults[0]!.result).toBe('Error: b could not finish your request: b failed on step one: model overloaded');
      expect(store.events(outcome.runId).find((e) => e.type === 'request.done')!.data).toMatchObject({ ok: false, to: 'b' });
    });
  });

  it('checks can_request targets when loading', () => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': `version: 1
name: t
agents:
  a: { prompt: prompts/p.md, tools: [Read], can_request: [a, ghost] }
workflow:
  steps:
    - { id: one, agent: a }
`,
      'prompts/p.md': 'x',
    });
    try {
      loadTeam(join(dir, 'team.yaml'));
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toEqual(['/agents/a/can_request: an agent cannot request work from itself', '/agents/a/can_request: unknown agent "ghost"']);
    }
  });

  it('describes the request tool only when the member has it', () => {
    const team = loadTeam(EXAMPLE);
    expect(systemPrompt(team, team.agents.frontend!, { canRequest: false })).not.toContain('You can ask designer');
    expect(systemPrompt(team, team.agents.frontend!, { canRequest: true })).toContain('You can ask designer to do work for you with the request_work tool');
  });
});

describe('RequestChains', () => {
  it('finds the chain that would make two members wait on each other', () => {
    const c = new RequestChains();
    const doneAB = c.wait('a', 'b');
    c.wait('b', 'c');
    expect(c.cycle('c', 'a')).toEqual(['a', 'b']);
    expect(c.cycle('d', 'a')).toBeUndefined();
    doneAB();
    expect(c.cycle('c', 'a')).toBeUndefined();
  });
});
