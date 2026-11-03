import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { continueRun, runTeam } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { removeRunWorktrees } from '../src/engine/workspace.js';
import { ScriptedRunner, tempRepo, type Script } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;
const plan = {
  summary: 'Greeting page and API.',
  tasks: [
    { id: 't1', owner: 'frontend', title: 'Page', description: 'Show it', acceptance: ['shows greeting'] },
    { id: 't2', owner: 'backend', title: 'API', description: 'GET /greeting', acceptance: ['returns hello'] },
  ],
};
const build = (files: string[]) => ({ status: 'done', summary: 'built', files_changed: files });
const clean = { blocking_count: 0, findings: [] };
const bad = { blocking_count: 1, findings: [{ severity: 'blocking', owner: 'frontend', file: 'web/index.html', message: 'typo' }] };

function scripts(over: Partial<Record<string, Script>> = {}): Record<string, Script> {
  return {
    manager: (_inv, n) => (n === 0 ? { structured: plan } : { text: 'Done.' }),
    frontend: () => ({ write: { 'web/index.html': '<h1>hello</h1>' }, structured: build(['web/index.html']) }),
    backend: (_inv: unknown, n: number) => {
      const write: Record<string, string> = n === 0 ? { 'api/half.ts': 'export {}' } : { 'api/greeting.ts': 'export const g = 1;' };
      return n === 0 ? { write, fail: 'Claude Code process exited with code 1' } : { write, structured: build(['api/half.ts', 'api/greeting.ts']) };
    },
    qa: () => ({ structured: clean }),
    tester: () => ({ structured: { command: 'npm test', passed: 1, failed: 0, failures: [] } }),
    ...over,
  } as Record<string, Script>;
}

const show = (repo: string, ref: string) => execFileSync('git', ['show', ref], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('continuing a stopped run', () => {
  it('picks up in the step that failed, in the same run, without redoing finished work', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const team = loadTeam(EXAMPLE);
    const runner = new ScriptedRunner(scripts());
    const first = await runTeam({ team, repo, goal: 'Add a greeting', store, runner });
    expect(first.status).toBe('failed');
    expect(first.reason).toMatch(/backend failed on step build/);

    const { runId, done } = await continueRun({ team, repo, runId: first.runId, store, runner });
    expect(runId).toBe(first.runId);
    const outcome = await done;
    expect(outcome.status).toBe('succeeded');
    expect(store.getRun(runId)!.status).toBe('succeeded');

    // The plan was not made again, and the frontend's finished branch was kept.
    expect(runner.callsFor('manager')).toHaveLength(1); // the plan; covibe writes the summary
    expect(runner.callsFor('frontend')).toHaveLength(1);
    // The backend resumed its own session, told to carry on, with its unfinished work still there.
    const again = runner.callsFor('backend')[1]!;
    expect(again.resumeSessionId).toBe('session-backend');
    expect(again.prompt).toMatch(/^The run stopped while you were working on this step/);
    expect(show(repo, `${outcome.branch}:api/half.ts`)).toBe('export {}');
    expect(show(repo, `${outcome.branch}:web/index.html`)).toBe('<h1>hello</h1>');

    const events = store.events(runId);
    expect(events.filter((e) => e.type === 'run.continued')).toMatchObject([{ step: 'build', data: { from_step: 'build', kind: 'step', done: ['frontend'] } }]);
    await expect(continueRun({ team, repo, runId, store, runner })).rejects.toThrow(/finished/);
  });

  it('gives a fix loop that ran out of rounds one more round', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const team = loadTeam(EXAMPLE);
    let reviews = 0;
    const runner = new ScriptedRunner(scripts({ backend: () => ({ structured: build([]) }), qa: () => ({ structured: ++reviews <= 4 ? bad : clean }) }));
    const first = await runTeam({ team, repo, goal: 'Add a greeting', store, runner });
    expect(first.status).toBe('escalated');
    // Freed disk space meanwhile: the worktrees come back from their branches.
    expect((await removeRunWorktrees(repo, first.runId)).removed.length).toBeGreaterThan(0);

    const outcome = await (await continueRun({ team, repo, runId: first.runId, store, runner })).done;
    expect(outcome.status).toBe('succeeded');
    expect(outcome.context.loop).toBe(4);
    expect(runner.callsFor('manager')).toHaveLength(1);
    const last = runner.callsFor('frontend').at(-1)!;
    expect(last.prompt).not.toMatch(/^The run stopped/);
    expect(last.prompt).toContain('typo');
    expect(store.events(first.runId).find((e) => e.type === 'run.continued')).toMatchObject({ data: { from_step: 'build', kind: 'round', loop: 4 } });
  });
});
