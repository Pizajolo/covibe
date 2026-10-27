import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { chat } from '../src/engine/chat.js';
import { runTeam } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { ScriptedRunner, tempRepo, type Script } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;

const plan = {
  summary: 'Add a greeting page backed by an API.',
  tasks: [
    { id: 't1', owner: 'frontend', title: 'Greeting page', description: 'Show the greeting', acceptance: ['page shows greeting'] },
    { id: 't2', owner: 'backend', title: 'Greeting API', description: 'GET /greeting', acceptance: ['returns hello'] },
  ],
};
const build = (files: string[]) => ({ status: 'done', summary: 'built', files_changed: files });
const cleanReview = { blocking_count: 0, findings: [] };
const badReview = {
  blocking_count: 1,
  findings: [{ severity: 'blocking', owner: 'frontend', file: 'web/index.html', message: 'greeting is misspelled' }],
};

function scripts(overrides: Partial<Record<string, Script>> = {}): Record<string, Script> {
  return {
    manager: (_inv, n) => (n === 0 ? { structured: plan } : { text: 'Shipped a greeting page and API.' }),
    frontend: (_inv, n) =>
      n === 0
        ? {
            write: { 'web/index.html': '<h1>helo</h1>', 'api/hack.ts': 'nope' },
            send: [{ to: 'backend', text: 'I call GET /greeting and expect {"text": string}' }],
            structured: build(['web/index.html']),
          }
        : { write: { 'web/index.html': '<h1>hello</h1>' }, structured: build(['web/index.html']) },
    backend: () => ({ write: { 'api/greeting.ts': 'export const greeting = "hello";' }, structured: build(['api/greeting.ts']) }),
    qa: (_inv, n) => ({ structured: n === 0 ? badReview : cleanReview }),
    tester: () => ({
      // Bash-style writes bypass the hook; the out-of-scope one must be discarded.
      bashWrite: { 'web/tests/greeting.test.ts': 'test("hello")', 'web/index.html': '<h1>tester was here</h1>' },
      structured: { command: 'npm test', passed: 2, failed: 0, failures: [] },
    }),
    ...overrides,
  } as Record<string, Script>;
}

function show(repo: string, ref: string) {
  return execFileSync('git', ['show', ref], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('runTeam', () => {
  it('runs plan → build → review, loops back on a failed gate, and merges in-scope work', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(
      scripts({
        qa: (inv, n) => {
          // QA reviews the merged state: both builders' files are there.
          expect(existsSync(join(inv.cwd, 'web/index.html'))).toBe(true);
          expect(existsSync(join(inv.cwd, 'api/greeting.ts'))).toBe(true);
          return { structured: n === 0 ? badReview : cleanReview };
        },
      }),
    );
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner, env: { PATH: process.env.PATH } });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.context.loop).toBe(1);
    expect(outcome.branch).toBe(`covibe/${outcome.runId}`);

    const types = store.events(outcome.runId).map((e) => e.type);
    expect(types).toContain('gate.failed');
    expect(types).toContain('loop.goto');
    expect(types.at(-1)).toBe('run.finished');

    // Round two: the builder gets the QA findings and resumes its own session.
    const fe = runner.callsFor('frontend');
    expect(fe).toHaveLength(2);
    expect(fe[0]!.prompt).toContain('"id": "t1"');
    expect(fe[0]!.prompt).not.toContain('"id": "t2"');
    expect(fe[1]!.prompt).toContain('greeting is misspelled');
    expect(fe[1]!.resumeSessionId).toBe('session-frontend');
    expect(fe[0]!.systemPrompt).toContain('You may only change files matching: web/**');

    // The scope hook blocked the frontend's write to api/.
    expect(runner.denied).toEqual([expect.objectContaining({ agent: 'frontend', reason: expect.stringMatching(/api\/hack.ts is outside your write scope/) })]);

    // The message frontend sent reached backend on its next turn.
    expect(runner.callsFor('backend').some((c) => c.prompt.includes('from frontend: I call GET /greeting'))).toBe(true);

    // Result branch: fixed frontend, backend, tester's test; not the tester's change to web/index.html.
    expect(show(repo, `${outcome.branch}:web/index.html`)).toBe('<h1>hello</h1>');
    expect(show(repo, `${outcome.branch}:api/greeting.ts`)).toContain('hello');
    expect(show(repo, `${outcome.branch}:web/tests/greeting.test.ts`)).toContain('hello');
    expect(() => show(repo, `${outcome.branch}:api/hack.ts`)).toThrow();
    const violation = store.events(outcome.runId).find((e) => e.type === 'scope.violation');
    expect(violation).toMatchObject({ agent: 'tester', data: { files: ['web/index.html'] } });

    // The user's checkout is untouched.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# app\n');
    expect(existsSync(join(repo, 'web'))).toBe(false);
    expect(store.getRun(outcome.runId)!.status).toBe('succeeded');
  });

  it('escalates to the human once max_loops is used up', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(scripts({ qa: () => ({ structured: badReview }) }));
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'g', store, runner, env: {} });

    expect(outcome.status).toBe('escalated');
    expect(outcome.context.loop).toBe(3);
    expect(runner.callsFor('frontend')).toHaveLength(4);
    expect(runner.callsFor('tester')).toHaveLength(0);
    expect(outcome.reason).toMatch(/still failing after 3 fix round/);
  });

  it('fails the run when an agent fails or returns a report that breaks its schema', async () => {
    const store = new EventStore(':memory:');
    const failing = await runTeam({
      team: loadTeam(EXAMPLE),
      repo: tempRepo(),
      goal: 'g',
      store,
      runner: new ScriptedRunner(scripts({ backend: () => ({ fail: 'error_max_turns' }) })),
      env: {},
    });
    expect(failing.status).toBe('failed');
    expect(failing.reason).toMatch(/backend failed on step build: error_max_turns/);

    const badPlan = await runTeam({
      team: loadTeam(EXAMPLE),
      repo: tempRepo(),
      goal: 'g',
      store,
      runner: new ScriptedRunner(scripts({ manager: () => ({ structured: { summary: 'x' } }) })),
      env: {},
    });
    expect(badPlan.status).toBe('failed');
    expect(badPlan.reason).toMatch(/does not match its output schema/);
  });

  it('skips a parallel branch whose task selector finds nothing', async () => {
    const store = new EventStore(':memory:');
    const frontendOnly = { ...plan, tasks: [plan.tasks[0]] };
    const runner = new ScriptedRunner(
      scripts({ manager: (_i, n) => (n === 0 ? { structured: frontendOnly } : { text: 'ok' }), qa: () => ({ structured: cleanReview }) }),
    );
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo: tempRepo(), goal: 'g', store, runner, env: {} });
    expect(outcome.status).toBe('succeeded');
    expect(runner.callsFor('backend')).toHaveLength(0);
    expect(store.events(outcome.runId).some((e) => e.type === 'step.skipped' && e.agent === 'backend')).toBe(true);
  });
});

describe('chat', () => {
  it('queues a message while the run is live and resumes the session once it has ended', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const team = loadTeam(EXAMPLE);
    const runner = new ScriptedRunner(scripts({ qa: () => ({ structured: cleanReview }) }));
    const { runId, branch } = await runTeam({ team, repo, goal: 'g', store, runner, env: {} });

    // Ended run: the agent's session is resumed and its in-scope edit is merged.
    const chatRunner = new ScriptedRunner({
      frontend: (inv) => {
        expect(inv.resumeSessionId).toBe('session-frontend');
        expect(inv.prompt).toBe('make it bold');
        return { write: { 'web/index.html': '<h1><b>helo</b></h1>' }, text: 'Made it bold.' };
      },
    });
    const replied = await chat({ store, runner: chatRunner, team, runId, agent: 'frontend', message: 'make it bold', env: {} });
    expect(replied).toEqual({ mode: 'replied', text: 'Made it bold.', ok: true, error: undefined });
    expect(show(repo, `${branch}:web/index.html`)).toBe('<h1><b>helo</b></h1>');

    // Live run (owned by this process): the message is queued for the next turn.
    store.createRun({ id: 'live-run', team: team.name, teamFile: team.file, repo, goal: 'g' });
    const queued = await chat({ store, runner: chatRunner, team, runId: 'live-run', agent: 'qa', message: 'check a11y', env: {} });
    expect(queued.mode).toBe('queued');
    expect(store.drainInbox('live-run', 'qa')).toEqual([expect.objectContaining({ from: 'human', text: 'check a11y' })]);
  });
});
