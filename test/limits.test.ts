import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { runTeam } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { limitOf } from '../src/runner/claude-sdk.js';
import { summarizeRun } from '../src/server/projections.js';
import { ScriptedRunner, tempRepo } from './helpers.js';

const TEAM = new URL('../examples/build-and-review/team.yaml', import.meta.url).pathname;
const pass = { blocking_count: 0, findings: [] };
const LIMITED = 'Claude AI usage limit reached|1761660000';

describe('plan usage limits', () => {
  it("recognises a turn the plan's limit stopped", () => {
    expect(limitOf(LIMITED, undefined)).toEqual({ resetsAt: 1761660000, window: undefined });
    expect(limitOf('5-hour limit reached ∙ resets 3pm', { resetsAt: 1761661111, window: 'five_hour' })).toEqual({ resetsAt: 1761661111, window: 'five_hour' });
    expect(limitOf('tests failed', undefined)).toBeUndefined();
    // A rejected limit reported during the turn counts, whatever the error says.
    expect(limitOf('API Error', { resetsAt: 5, window: 'seven_day' })).toEqual({ resetsAt: 5, window: 'seven_day' });
  });

  it('waits for the reset and continues the same session', async () => {
    const store = new EventStore(':memory:');
    const past = Math.floor(Date.now() / 1000) - 120;
    const runner = new ScriptedRunner({
      builder: (_inv, n) => (n === 0 ? { fail: LIMITED, limit: { resetsAt: past } } : { write: { 'src/a.js': 'export const a = 1;' }, text: 'Built.' }),
      reviewer: () => ({ structured: pass }),
    });
    const outcome = await runTeam({ team: loadTeam(TEAM), repo: tempRepo(), goal: 'Add a', store, runner });

    expect(outcome.status).toBe('succeeded');
    const [first, second] = runner.callsFor('builder');
    expect(second!.resumeSessionId).toBe('session-builder');
    expect(second!.prompt).toContain('usage limit was reached');
    expect(first!.prompt).not.toContain('usage limit');
    const events = store.events(outcome.runId);
    const limited = events.find((e) => e.type === 'agent.limited')!;
    expect(limited).toMatchObject({ agent: 'builder', data: { waiting: true, resets_at: new Date(past * 1000).toISOString() } });
    expect(events.filter((e) => e.agent === 'builder' && e.type === 'agent.started').map((e) => !!e.data.after_limit)).toEqual([false, true]);
    // Waiting shows on the run while it lasts.
    const during = summarizeRun({ ...store.getRun(outcome.runId)!, status: 'running' }, events.slice(0, events.indexOf(limited) + 1), { id: 'p', name: 'p' }, true);
    expect(during.limit).toMatchObject({ waiting: true, agents: ['builder'] });
    expect(during.agents.find((a) => a.name === 'builder')).toMatchObject({ status: 'limited' });
    expect(summarizeRun(store.getRun(outcome.runId)!, events, { id: 'p', name: 'p' }, false).limit).toBeUndefined();
  }, 15_000);

  it('stops the run instead when asked', async () => {
    const store = new EventStore(':memory:');
    const later = Math.floor(Date.now() / 1000) + 3600;
    const runner = new ScriptedRunner({ builder: () => ({ fail: LIMITED, limit: { resetsAt: later } }), reviewer: () => ({ structured: pass }) });
    const outcome = await runTeam({ team: loadTeam(TEAM), repo: tempRepo(), goal: 'Add a', store, runner, onLimit: 'stop' });

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/usage limit/);
    const events = store.events(outcome.runId);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { limit: { resets_at: new Date(later * 1000).toISOString() } } });
    const summary = summarizeRun(store.getRun(outcome.runId)!, events, { id: 'p', name: 'p' }, false);
    expect(summary.limit).toEqual({ waiting: false, resetsAt: new Date(later * 1000).toISOString(), agents: ['builder'] });
  });
});
