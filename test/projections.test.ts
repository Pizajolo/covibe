import { describe, expect, it } from 'vitest';
import type { RunEvent, RunRecord } from '../src/events/types.js';
import type { NotificationKind } from '../src/server/api-types.js';
import { chatThreads, collectNotifications, shortenPaths, summarizeRun } from '../src/server/projections.js';

const run: RunRecord = { id: 'r1', kind: 'workflow', team: 't', teamFile: '/t.yaml', repo: '/code/app', goal: 'g', status: 'succeeded', pid: 1, startedAt: '2026-10-27T10:00:00.000Z' };
let id = 0;
const ev = (type: RunEvent['type'], data: Record<string, unknown>, extra: Partial<RunEvent> = {}): RunEvent => ({ id: ++id, runId: 'r1', ts: '2026-10-27T10:00:01.000Z', type, data, ...extra });

describe('projections', () => {
  it("shows the lead answering a teammate's question without making it a step", () => {
    const live = { ...run, status: 'running' as const };
    const events = [
      ev('run.started', { steps: ['plan', 'build'] }),
      ev('agent.started', {}, { step: 'plan', agent: 'manager' }),
      ev('agent.finished', { turns: 1, cost_usd: 0.1 }, { step: 'plan', agent: 'manager' }),
      ev('agent.started', {}, { step: 'build', agent: 'dev' }),
      ev('question.asked', { id: 1, question: 'Formal?', context: null, to: 'manager' }, { step: 'build', agent: 'dev' }),
      ev('agent.started', { resumed: true, question: true }, { step: 'question', agent: 'manager' }),
    ];
    const asking = summarizeRun(live, events, { id: 'p', name: 'app' }, true, ['manager', 'dev']);
    expect(asking.agents.find((a) => a.name === 'manager')).toMatchObject({ status: 'working', step: 'plan', activity: "answering dev's question" });
    expect(asking.agents.find((a) => a.name === 'dev')).toMatchObject({ status: 'asking', waitingOn: 'manager' });
    expect(asking.steps.map((s) => s.id)).toEqual(['plan', 'build']);
    expect(asking.steps.find((s) => s.id === 'build')!.cards.map((c) => c.agent)).toEqual(['dev']);
  });

  it('collects notifications: questions for you, plan limits once each, and how workflow runs ended', () => {
    const runs: Record<string, RunRecord> = {
      r1: { ...run, status: 'running', goal: 'Add a greeting' },
      r2: { ...run, id: 'r2', goal: 'Fix the build', status: 'failed' },
      r3: { ...run, id: 'r3', goal: 'Rename', status: 'failed' },
      r4: { ...run, id: 'r4', goal: 'Ship it', status: 'escalated' },
      r5: { ...run, id: 'r5', kind: 'ask', goal: 'What is this?' },
    };
    const at = (n: number) => `2026-10-27T10:00:${String(n).padStart(2, '0')}.000Z`;
    const events = [
      ev('question.asked', { id: 1, question: 'Formal?', to: 'manager' }, { agent: 'dev', ts: at(1) }),
      ev('question.escalated', { id: 1, from: 'dev', question: 'Formal or casual?' }, { agent: 'manager', ts: at(2) }),
      ev('question.asked', { id: 2, question: 'Which pages?', to: 'human' }, { agent: 'manager', ts: at(3) }),
      ev('question.answered', { id: 2, by: 'human', answer: 'All' }, { agent: 'manager', ts: at(4) }),
      ev('usage.limit', { status: 'allowed', window: 'five_hour', utilization: 0.5 }, { runId: 'r2', ts: at(5) }),
      ev('usage.limit', { status: 'allowed_warning', window: 'five_hour', utilization: 0.82, resetsAt: 1 }, { runId: 'r2', ts: at(6) }),
      ev('usage.limit', { status: 'allowed_warning', window: 'five_hour', utilization: 0.85, resetsAt: 1 }, { runId: 'r2', ts: at(7) }),
      ev('run.finished', { status: 'failed', reason: 'tests broke' }, { runId: 'r2', ts: at(8) }),
      ev('run.finished', { status: 'failed', reason: 'aborted' }, { runId: 'r3', ts: at(9) }),
      ev('run.finished', { status: 'escalated' }, { runId: 'r4', ts: at(10) }),
      ev('run.finished', { status: 'succeeded' }, { runId: 'r5', ts: at(11) }),
      ev('run.finished', { status: 'succeeded' }, { runId: 'r1', ts: at(12) }),
    ];
    const all = (bell: boolean, push: boolean) => Object.fromEntries((['question', 'limit', 'stopped', 'error', 'done'] as NotificationKind[]).map((k) => [k, { bell, push }])) as Record<NotificationKind, { bell: boolean; push: boolean }>;
    const src = { projectId: 'p', events, run: (rid: string) => runs[rid], live: (r: RunRecord) => r.status === 'running' };
    const list = collectNotifications([src], all(true, true));
    expect(list.map((n) => [n.kind, n.title, n.body])).toEqual([
      ['done', 'Job done', 'Add a greeting'],
      ['stopped', 'Stopped: out of fix rounds', 'Ship it'],
      ['stopped', 'Run stopped', 'Rename'],
      ['error', 'Run failed', 'Fix the build: tests broke'],
      ['limit', 'Close to your 5-hour limit', '82% used.'],
      ['question', 'manager asks you', 'Which pages?'],
      ['question', 'dev asks you', 'Formal or casual?'],
    ]);
    expect(list.filter((n) => n.kind === 'question').map((n) => [n.questionId, n.open])).toEqual([[2, false], [1, true]]);
    expect(list[0]).toMatchObject({ id: `p:${events.at(-1)!.id}`, projectId: 'p', runId: 'r1', goal: 'Add a greeting' });

    // Kinds switched off everywhere are left out; the rest carry their choices.
    const choices = { ...all(false, false), question: { bell: true, push: false } };
    expect(collectNotifications([src], choices).map((n) => [n.kind, n.bell, n.push])).toEqual([['question', true, false], ['question', true, false]]);
  });

  it('shortens worktree and project paths', () => {
    expect(shortenPaths('/Users/me/.covibe/worktrees/app-1a2b3c4d5e/20261027-101500-ab12/frontend/web/x.tsx')).toBe('web/x.tsx');
    expect(shortenPaths('/code/app/.covibe/worktrees/20261027-101500-ab12/_integration/api/a.ts')).toBe('api/a.ts');
    expect(shortenPaths('cat /code/app/src/a.js', ['/code/app'])).toBe('cat src/a.js');
  });

  it('builds member states, the board and chat threads from events', () => {
    const events = [
      ev('run.started', { steps: ['build', 'review'] }),
      ev('step.started', { loop: 0 }, { step: 'build' }),
      ev('agent.started', { resumed: false }, { step: 'build', agent: 'dev' }),
      ev('agent.tool', { tool: 'Edit', input: { file_path: '/code/app/src/a.js' } }, { step: 'build', agent: 'dev' }),
      ev('agent.text', { text: 'Done.' }, { step: 'build', agent: 'dev' }),
      ev('agent.finished', { turns: 3, cost_usd: 0.5, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }, { step: 'build', agent: 'dev' }),
      ev('step.finished', {}, { step: 'build' }),
      ev('chat.message', { from: 'human', to: 'dev', text: 'why?' }, { step: 'chat', agent: 'dev' }),
      ev('agent.started', { resumed: true }, { step: 'chat', agent: 'dev' }),
    ];
    const ended = summarizeRun(run, events, { id: 'p', name: 'app' }, false, ['dev', 'qa']);
    expect(ended.agents.map((a) => [a.name, a.status])).toEqual([['dev', 'error'], ['qa', 'idle']]);
    expect(ended.steps.map((s) => [s.id, s.status, s.cards.length])).toEqual([['build', 'done', 1], ['review', 'pending', 0]]);
    expect(ended).toMatchObject({ costUsd: 0.5, tokens: 15 });

    // A member answering a chat after the run ended is working, not stopped.
    const answering = summarizeRun(run, events, { id: 'p', name: 'app' }, false, ['dev'], new Set(['dev']));
    expect(answering.agents[0]!.status).toBe('working');

    const threads = chatThreads(events, ['/code/app']);
    expect(threads.dev!.map((i) => [i.kind, i.text])).toEqual([
      ['note', 'Started step "build"'],
      ['tool', 'Edit src/a.js'],
      ['agent', 'Done.'],
      ['human', 'why?'],
    ]);
  });
});
