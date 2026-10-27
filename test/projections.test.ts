import { describe, expect, it } from 'vitest';
import type { RunEvent, RunRecord } from '../src/events/types.js';
import { chatThreads, shortenPaths, summarizeRun } from '../src/server/projections.js';

const run: RunRecord = { id: 'r1', kind: 'workflow', team: 't', teamFile: '/t.yaml', repo: '/code/app', goal: 'g', status: 'succeeded', pid: 1, startedAt: '2026-10-27T10:00:00.000Z' };
let id = 0;
const ev = (type: RunEvent['type'], data: Record<string, unknown>, extra: Partial<RunEvent> = {}): RunEvent => ({ id: ++id, runId: 'r1', ts: '2026-10-27T10:00:01.000Z', type, data, ...extra });

describe('projections', () => {
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
