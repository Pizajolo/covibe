import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadTeam } from '../src/config/load.js';
import { runTeam } from '../src/engine/engine.js';
import { answerQuestion, Deadline, LEAD_SCHEMA, leadVerdict, questionOptions, RunPause } from '../src/engine/questions.js';
import { EventStore } from '../src/events/store.js';
import type { RunEvent } from '../src/events/types.js';
import { summarizeRun } from '../src/server/projections.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles, type Script } from './helpers.js';

const EXAMPLE = new URL('../examples/feature-team/team.yaml', import.meta.url).pathname;

const plan = {
  summary: 'Add a greeting page backed by an API.',
  tasks: [
    { id: 't1', owner: 'frontend', title: 'Greeting page', description: 'Show the greeting', acceptance: ['page shows greeting'] },
    { id: 't2', owner: 'backend', title: 'Greeting API', description: 'GET /greeting', acceptance: ['returns hello'] },
  ],
};
const build = (files: string[]) => ({ status: 'done', summary: 'built', files_changed: files });
const isQuestion = (prompt: string) => prompt.includes('# Question from');

/** The feature team, all gates passing; the manager answers questions with `lead`. */
function scripts(lead: Script, overrides: Partial<Record<string, Script>> = {}): Record<string, Script> {
  return {
    manager: (inv, n) => (isQuestion(inv.prompt) ? lead(inv, n) : inv.outputSchema ? { structured: plan } : { text: 'Shipped.' }),
    frontend: () => ({ write: { 'web/index.html': '<h1>hello</h1>' }, structured: build(['web/index.html']) }),
    backend: () => ({ write: { 'api/greeting.ts': 'export const greeting = "hello";' }, structured: build(['api/greeting.ts']) }),
    qa: () => ({ structured: { blocking_count: 0, findings: [] } }),
    tester: () => ({ structured: { command: 'npm test', passed: 2, failed: 0, failures: [] } }),
    ...overrides,
  } as Record<string, Script>;
}

const asks = (question: string): Script => () => ({
  call: [{ tool: 'ask_question', args: { question, context: 'web/index.html shows the greeting' } }],
  write: { 'web/index.html': '<h1>hello</h1>' },
  structured: build(['web/index.html']),
});

function types(events: RunEvent[], prefix: RegExp = /^(question|run\.(paused|resumed))/) {
  return events.filter((e) => prefix.test(e.type)).map((e) => e.type);
}

describe('team lead', () => {
  const teamFile = (lead: string | undefined) => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': `version: 1
name: t
${lead === undefined ? '' : `lead: ${lead}\n`}agents:
  manager: { prompt: prompts/a.md, tools: [Read] }
  dev: { prompt: prompts/a.md, tools: [Read, Write] }
workflow:
  steps:
    - { id: one, agent: dev }
`,
      'prompts/a.md': 'You are A.',
    });
    return join(dir, 'team.yaml');
  };

  it('defaults to the member named manager, can be set or switched off, and must exist', () => {
    expect(loadTeam(teamFile(undefined)).lead).toBe('manager');
    expect(loadTeam(teamFile('dev')).lead).toBe('dev');
    expect(loadTeam(teamFile('null')).lead).toBeUndefined();
    expect(() => loadTeam(teamFile('boss'))).toThrow(ConfigError);
    try {
      loadTeam(teamFile('boss'));
    } catch (err) {
      expect((err as ConfigError).problems).toContain('/lead: unknown agent "boss"');
    }
  });
});

describe('leadVerdict', () => {
  it('passes anything but a real answer on to the human', () => {
    expect(leadVerdict({ decision: 'answer', answer: ' Use hello. ' }, 'q')).toEqual({ answer: 'Use hello.' });
    expect(leadVerdict({ decision: 'ask_human', question_for_human: 'Formal?', reason: 'product call' }, 'q')).toEqual({ forHuman: 'Formal?', note: 'product call' });
    expect(leadVerdict({ decision: 'ask_human' }, 'q')).toEqual({ forHuman: 'q', note: undefined });
    expect(leadVerdict({ decision: 'answer', answer: '' }, 'q')).toMatchObject({ forHuman: 'q' });
    expect(leadVerdict(undefined, 'q')).toMatchObject({ forHuman: 'q' });
  });

  it('keeps the options the lead offers the human', () => {
    expect(leadVerdict({ decision: 'ask_human', question_for_human: 'Tone?', options_for_human: [' Formal ', 'Casual', 'Casual', ''] }, 'q')).toEqual({ forHuman: 'Tone?', note: undefined, options: ['Formal', 'Casual'] });
    expect(questionOptions(['only one'])).toBeUndefined();
    expect(questionOptions('a, b')).toBeUndefined();
    expect(questionOptions(Array.from({ length: 12 }, (_, i) => `o${i}`))).toHaveLength(8);
  });
});

describe('Deadline and RunPause', () => {
  afterEach(() => vi.useRealTimers());

  it('stop the clock while held or paused and hold waiters until the last question is answered', async () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const pause = new RunPause((paused) => changes.push(paused));
    const d = new Deadline(1000);
    const untrack = pause.track(d);

    vi.advanceTimersByTime(600);
    pause.add(1);
    pause.add(2);
    vi.advanceTimersByTime(5000);
    expect(d.signal.aborted).toBe(false);

    let resumed = false;
    const waiting = pause.wait().then(() => (resumed = true));
    pause.remove(1);
    await Promise.resolve();
    expect(resumed).toBe(false);
    pause.remove(2);
    await waiting;
    expect(changes).toEqual([true, false]);

    // A member's own hold (waiting for its answer) stacks with the pause.
    const release = d.hold();
    vi.advanceTimersByTime(5000);
    expect(d.signal.aborted).toBe(false);
    release();
    vi.advanceTimersByTime(399);
    expect(d.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(d.signal.aborted).toBe(true);
    untrack();
    d.dispose();
  });
});

describe('questions in a run', () => {
  it('a member asks the lead, which answers from a read-only copy of its session; nothing pauses', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(scripts(() => ({ structured: { decision: 'answer', answer: 'Use "hello", lowercase.' } }), { frontend: asks('Which greeting text?') }));
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner });

    expect(outcome.status).toBe('succeeded');
    expect(runner.toolResults).toContainEqual({ agent: 'frontend', tool: 'ask_question', result: 'Answer from manager:\nUse "hello", lowercase.' });

    const consult = runner.callsFor('manager').find((c) => isQuestion(c.prompt))!;
    expect(consult.prompt).toContain('Which greeting text?');
    expect(consult.prompt).toContain('web/index.html shows the greeting');
    expect(consult.outputSchema).toBe(LEAD_SCHEMA);
    // It resumes the session from planning, as a fork, and cannot change anything or ask in turn.
    expect(consult.resumeSessionId).toBe('session-manager');
    expect(consult.forkSession).toBe(true);
    expect(consult.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(consult.customTools?.map((t) => t.name) ?? []).not.toContain('ask_question');

    // Members know whom to ask; the lead's own question would go to the human.
    expect(runner.callsFor('frontend')[0]!.systemPrompt).toContain('ask manager (the team lead) with the ask_question tool');
    const managerPlan = runner.callsFor('manager')[0]!;
    expect(managerPlan.systemPrompt).toContain('The whole team pauses until they answer');

    const events = store.events(outcome.runId);
    expect(types(events)).toEqual(['question.asked', 'question.answered']);
    expect(events.find((e) => e.type === 'question.asked')).toMatchObject({ agent: 'frontend', step: 'build', data: { to: 'manager' } });
    expect(events.find((e) => e.type === 'question.answered')).toMatchObject({ agent: 'frontend', data: { by: 'manager' } });
    // The lead's answering turn is not a workflow step on the board.
    const summary = summarizeRun(store.getRun(outcome.runId)!, events, { id: 'p', name: 'p' }, false);
    expect(summary.steps.map((s) => s.id)).toEqual(['plan', 'build', 'review', 'test', 'report']);
    expect(summary.questions).toMatchObject([{ id: 1, from: 'frontend', status: 'answered', answeredBy: 'manager' }]);
    expect(store.questions(outcome.runId)).toMatchObject([{ status: 'answered', answeredBy: 'manager' }]);
  });

  it('when the lead cannot answer, the run pauses, holds the team, and resumes on the human answer', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(
      scripts(() => ({ structured: { decision: 'ask_human', question_for_human: 'Should the greeting be formal?', reason: 'a product decision' } }), {
        frontend: asks('Formal or casual greeting?'),
      }),
    );
    const checks: Promise<void>[] = [];
    store.subscribe((e) => {
      if (e.type !== 'run.paused') return;
      checks.push(
        (async () => {
          const run = store.getRun(e.runId)!;
          const summary = summarizeRun(run, store.events(run.id), { id: 'p', name: 'p' }, true);
          expect(summary.paused).toBe(true);
          expect(summary.questions).toMatchObject([
            { from: 'frontend', status: 'open', question: 'Formal or casual greeting?', forHuman: 'Should the greeting be formal?', leadNote: 'a product decision', lead: 'manager' },
          ]);
          expect(summary.agents.find((a) => a.name === 'frontend')).toMatchObject({ status: 'asking', waitingOn: 'human' });

          // The teammate working in parallel is held at its next tool call: its write waits.
          for (let i = 0; i < 100 && !runner.callsFor('backend').length; i++) await new Promise((r) => setTimeout(r, 20));
          const hold = runner.callsFor('backend')[0]!.beforeToolUse!();
          let released = false;
          void hold.then(() => (released = true));
          await new Promise((r) => setTimeout(r, 50));
          expect(released).toBe(false);
          expect(store.events(run.id).filter((x) => x.type === 'agent.tool' && x.agent === 'backend')).toEqual([]);

          expect(() => answerQuestion(store, run.id, (e.data.questions as number[])[0]!, '  ')).toThrow('empty');
          answerQuestion(store, run.id, (e.data.questions as number[])[0]!, 'Casual: "hey there".');
          await hold;
        })(),
      );
    });
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner });
    await Promise.all(checks);

    expect(checks).toHaveLength(1);
    expect(outcome.status).toBe('succeeded');
    expect(runner.toolResults).toContainEqual({ agent: 'frontend', tool: 'ask_question', result: 'Answer from the human:\nCasual: "hey there".' });
    expect(types(store.events(outcome.runId))).toEqual(['question.asked', 'question.escalated', 'run.paused', 'question.answered', 'run.resumed']);
    expect(store.questions(outcome.runId)).toMatchObject([{ status: 'answered', answeredBy: 'human', forHuman: 'Should the greeting be formal?' }]);
  });

  it('offers the options a member gives, through the lead, to the human', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner(
      scripts(() => ({ structured: { decision: 'ask_human', reason: 'a product decision' } }), {
        frontend: () => ({
          call: [{ tool: 'ask_question', args: { question: 'Which tone?', options: ['Formal', 'Casual'] } }],
          write: { 'web/index.html': '<h1>hello</h1>' },
          structured: build(['web/index.html']),
        }),
      }),
    );
    store.subscribe((e) => {
      if (e.type !== 'run.paused') return;
      const run = store.getRun(e.runId)!;
      const summary = summarizeRun(run, store.events(run.id), { id: 'p', name: 'p' }, true);
      expect(summary.questions).toMatchObject([{ status: 'open', options: ['Formal', 'Casual'], lead: 'manager' }]);
      setTimeout(() => answerQuestion(store, run.id, 1, 'Casual'), 0);
    });
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner });

    expect(outcome.status).toBe('succeeded');
    expect(runner.callsFor('manager').find((c) => isQuestion(c.prompt))!.prompt).toContain('- Formal\n- Casual');
    expect(store.events(outcome.runId).find((e) => e.type === 'question.escalated')).toMatchObject({ data: { options: ['Formal', 'Casual'] } });
    expect(store.questions(outcome.runId)).toMatchObject([{ options: ['Formal', 'Casual'], answer: 'Casual' }]);
    expect(runner.toolResults).toContainEqual({ agent: 'frontend', tool: 'ask_question', result: 'Answer from the human:\nCasual' });
  });

  it("sends the lead's own questions straight to the human, and cancels open questions when the run stops", async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const controller = new AbortController();
    const runner = new ScriptedRunner(
      scripts(() => ({ fail: 'the lead should not be consulted' }), {
        manager: () => ({ call: [{ tool: 'ask_question', args: { question: 'Which pages are in scope?' } }], structured: plan }),
      }),
    );
    store.subscribe((e) => {
      if (e.type === 'run.paused') setTimeout(() => controller.abort(), 10);
    });
    const outcome = await runTeam({ team: loadTeam(EXAMPLE), repo, goal: 'Add a greeting', store, runner, signal: controller.signal });

    expect(outcome).toMatchObject({ status: 'failed', reason: 'aborted' });
    const events = store.events(outcome.runId);
    expect(events.find((e) => e.type === 'question.asked')).toMatchObject({ agent: 'manager', data: { to: 'human' } });
    expect(types(events)).toEqual(['question.asked', 'run.paused', 'run.resumed']);
    expect(store.questions(outcome.runId)).toMatchObject([{ status: 'cancelled' }]);
    expect(() => answerQuestion(store, outcome.runId, 1, 'too late')).toThrow('cancelled');
  });
});
