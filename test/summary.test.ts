import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadTeam } from '../src/config/load.js';
import { runTeam } from '../src/engine/engine.js';
import { reportLine } from '../src/engine/summary.js';
import { EventStore } from '../src/events/store.js';
import { computeStats } from '../src/server/projections.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles, type Script } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;

const plan = {
  summary: 'A greeting page backed by an API.',
  tasks: [
    { id: 't1', owner: 'frontend', title: 'Greeting page', description: 'Show it', acceptance: ['shows greeting'] },
    { id: 't2', owner: 'backend', title: 'Greeting API', description: 'GET /greeting', acceptance: ['returns hello'] },
  ],
};
const build = (summary: string, files: string[]) => ({ status: 'done', summary, files_changed: files });
const isQuestion = (prompt: string) => prompt.includes('# Question from');

function scripts(): Record<string, Script> {
  return {
    manager: (inv) => (isQuestion(inv.prompt) ? { structured: { decision: 'answer', answer: 'Lowercase "hello".' } } : { structured: plan }),
    frontend: (_inv, n) =>
      n === 0
        ? { call: [{ tool: 'ask_question', args: { question: 'Which greeting text?' } }], write: { 'web/index.html': '<h1>helo</h1>' }, structured: build('Added the page.', ['web/index.html']) }
        : { write: { 'web/index.html': '<h1>hello</h1>' }, structured: build('Fixed the typo.', ['web/index.html']) },
    backend: () => ({ write: { 'api/greeting.ts': 'export const g = "hello";' }, structured: build('Added GET /greeting.', ['api/greeting.ts']) }),
    qa: (_inv, n) => ({
      structured:
        n === 0
          ? { blocking_count: 1, findings: [{ severity: 'blocking', owner: 'frontend', file: 'web/index.html', message: 'greeting is misspelled' }] }
          : { blocking_count: 0, findings: [{ severity: 'minor', owner: 'backend', file: 'api/greeting.ts', message: 'name the constant greeting' }] },
    }),
    tester: () => ({ structured: { command: 'npm test', passed: 2, failed: 0, failures: [] } }),
  } as Record<string, Script>;
}

describe('a summary step', () => {
  it('is written by covibe from the run, without a member or a model', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(scripts());
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner, env: {} });

    expect(outcome.status).toBe('succeeded');
    // The manager planned and answered one question; nobody wrote the report.
    expect(runner.callsFor('manager').filter((c) => !isQuestion(c.prompt))).toHaveLength(1);
    const text = (outcome.context.report as { text: string }).text;
    expect(text).toContain('**Goal:** Add a greeting');
    expect(text).toContain('**Plan:** A greeting page backed by an API.');
    expect(text).toContain('## Tasks (2 of 2 done)');
    expect(text).toContain('- [done] t1: Greeting page (frontend)');
    // The latest report of each member.
    expect(text).toContain('- **frontend** (build): Fixed the typo.');
    expect(text).toContain('- **backend** (build): Added GET /greeting.');
    expect(text).toContain('- **tester** (test): command: npm test · passed 2 · failed 0 · failures: 0');
    expect(text).toContain('## Files changed (2)');
    expect(text).toContain('- web/index.html (frontend)');
    expect(text).toContain('- review: passed (`review.blocking_count = 0`)');
    expect(text).toContain('- 1 fix round');
    expect(text).toContain('frontend asked "Which greeting text?". manager answered: Lowercase "hello".');
    expect(text).toContain('## Left for later\n\n- api/greeting.ts: name the constant greeting (backend), from qa');
    expect(text).toContain('Estimated cost: $');

    const events = store.events(outcome.runId);
    expect(events.filter((e) => e.step === 'report').map((e) => e.type)).toEqual(['step.started', 'step.finished']);
    expect(events.find((e) => e.type === 'step.finished' && e.step === 'report')!.data.agents).toEqual([]);
  });

  it('takes no member, task or gate', () => {
    const dir = tempDir();
    const file = (step: string) => {
      writeFiles(dir, { 'team.yaml': `version: 1\nname: t\nagents:\n  a: { prompt: "A.\\n", tools: [Read] }\nworkflow:\n  steps:\n    - { id: one, agent: a }\n    - ${step}\n` });
      return join(dir, 'team.yaml');
    };
    expect(loadTeam(file('{ id: sum, summary: true }')).steps[1]).toEqual({ id: 'sum', kind: 'summary' });
    expect(() => loadTeam(file('{ id: sum, summary: true, agent: a }'))).toThrow(ConfigError);
    expect(() => loadTeam(file('{ id: sum, summary: true, gate: "true" }'))).toThrow(ConfigError);
  });

  it('puts a report in one line', () => {
    expect(reportLine({ summary: 'Did it.', files: ['a'] })).toBe('Did it.');
    expect(reportLine({ text: 'Long\n\nanswer' })).toBe('Long answer');
    expect(reportLine({ blocking_count: 0, findings: [] })).toBe('blocking_count 0 · findings: 0');
    expect(reportLine(undefined)).toBe('');
  });
});

describe('a summary step with a model', () => {
  const team = (step: string) => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': `version: 1\nname: t\nagents:\n  builder: { prompt: "Build.\\n", tools: [Read, Write] }\nworkflow:\n  steps:\n    - { id: build, agent: builder }\n    - ${step}\n`,
    });
    return loadTeam(join(dir, 'team.yaml'));
  };
  const builder: Script = () => ({ write: { 'value.txt': '2' }, text: 'Changed the value to 2.' });

  it('reads the model, effort, backend and instructions from the team file', () => {
    expect(team('{ id: report, summary: true, model: haiku, effort: low, instructions: "In German." }').steps[1]).toEqual({
      id: 'report',
      kind: 'summary',
      model: 'haiku',
      effort: 'low',
      backend: { type: 'subscription' },
      instructions: 'In German.',
    });
    // No model: covibe writes it, and there is nothing to run it on.
    expect(team('{ id: report, summary: true }').steps[1]).toEqual({ id: 'report', kind: 'summary' });
  });

  it('has the model write the summary up from covibe\'s record, in one request without tools', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({ builder, report: () => ({ text: 'The value is now 2.' }) });
    const outcome = await runTeam({ team: team('{ id: report, summary: true, model: haiku, instructions: "One sentence." }'), repo, goal: 'Set the value to 2', store, runner, env: {} });

    expect(outcome.status).toBe('succeeded');
    const [call] = runner.callsFor('report');
    expect(call).toBeDefined();
    expect(call!.model).toBe('haiku');
    expect(call!.tools).toEqual([]);
    expect(call!.customTools).toBeUndefined();
    expect(call!.ownSystemPrompt).toBe(true);
    expect(call!.systemPrompt).toContain('You have no tools');
    expect(call!.settingSources).toEqual([]);
    expect(call!.resumeSessionId).toBeUndefined();
    expect(call!.cwd.startsWith(repo)).toBe(false);
    // The model gets the facts covibe gathered, and the team's instructions.
    expect(call!.prompt).toContain('# What covibe recorded');
    expect(call!.prompt).toContain('**Goal:** Set the value to 2');
    expect(call!.prompt).toContain('- value.txt (builder)');
    expect(call!.prompt).toContain('# How to write it\n\nOne sentence.');
    expect(call!.prompt).not.toContain('without a model');

    expect((outcome.context.report as { text: string }).text).toBe("The value is now 2.\n\n_Written by haiku from covibe's record of the run._");
    const written = store.events(outcome.runId).find((e) => e.type === 'summary.written')!;
    expect(written.agent ?? null).toBeNull();
    expect(written).toMatchObject({ step: 'report', data: { model: 'haiku', ok: true, cost_usd: 0.01 } });
    // Its cost counts with the run's, under the step's name, without it becoming a member.
    expect(outcome.costUsd).toBeCloseTo(0.02);
    const stats = computeStats([{ runs: store.listRuns(10), events: store.events(outcome.runId), live: () => false, activeAgents: 0 }]);
    expect(stats.byAgent.map((a) => a.agent).sort()).toEqual(['builder', 'report']);
  });

  it('falls back to covibe\'s own summary when the model fails', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({ builder, report: () => ({ fail: 'overloaded' }) });
    const outcome = await runTeam({ team: team('{ id: report, summary: true, model: haiku }'), repo, goal: 'Set the value to 2', store, runner, env: {} });

    expect(outcome.status).toBe('succeeded');
    const text = (outcome.context.report as { text: string }).text;
    expect(text).toContain('# Summary');
    expect(text).toContain("_haiku could not write the summary (overloaded), so this is covibe's own._");
    expect(store.events(outcome.runId).find((e) => e.type === 'summary.written')).toMatchObject({ data: { ok: false, error: 'overloaded' } });
  });
});
