import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { runTeam } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { LiveUsage } from '../src/runner/claude-sdk.js';
import { claudePrice } from '../src/runner/prices.js';
import type { TokenUsage } from '../src/runner/types.js';
import { computeStats, summarizeRun } from '../src/server/projections.js';
import { ScriptedRunner, tempRepo } from './helpers.js';

const TEAM = new URL('../examples/build-and-review/team.yaml', import.meta.url).pathname;
const pass = { blocking_count: 0, findings: [] };
const tokens = (input: number, output: number): TokenUsage => ({ input, output, cacheRead: 0, cacheWrite: 0 });

afterEach(() => vi.useRealTimers());

describe('live spend', () => {
  it('knows Claude list prices by model id, in any spelling', () => {
    expect(claudePrice('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(claudePrice('us.anthropic.claude-opus-5-5[1m]')).toMatchObject({ input: 4 });
    expect(claudePrice('claude-opus-5')).toMatchObject({ input: 5 });
    expect(claudePrice('claude-sonnet-5-5')).toMatchObject({ input: 2 });
    expect(claudePrice('claude-haiku-4-5-20251001')).toMatchObject({ input: 1 });
    expect(claudePrice('deepseek-chat')).toBeUndefined();
  });

  it('reports a running total every few seconds, counting each response once', () => {
    vi.useFakeTimers();
    const reports: { tokens: TokenUsage; cost?: number }[] = [];
    const live = new LiveUsage(undefined, (t, cost) => reports.push({ tokens: t, cost }));
    // Claude Code sends one message per content block, each with the response's usage so far.
    live.add({ id: 'r1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 10 } });
    live.add({ id: 'r1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50_000 } });
    vi.advanceTimersByTime(3_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.tokens).toEqual({ input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 0 });
    // $2/M in, $10/M out, $0.20/M cache reads
    expect(reports[0]!.cost).toBeCloseTo(0.002 + 0.002 + 0.01);

    live.add({ id: 'r2', model: 'some-unknown-model', usage: { input_tokens: 10, output_tokens: 10 } });
    vi.advanceTimersByTime(3_000);
    expect(reports[1]).toMatchObject({ tokens: { input: 1010, output: 210 }, cost: undefined });
    live.close();
    live.add({ id: 'r3', usage: { input_tokens: 1 } });
    live.close();
    vi.advanceTimersByTime(10_000);
    expect(reports).toHaveLength(2);
  });

  it('follows output tokens through the stream, per response and per subagent', () => {
    vi.useFakeTimers();
    let last: TokenUsage | undefined;
    const live = new LiveUsage({ input: 1, output: 2 }, (t) => (last = t));
    live.stream({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900 } } }, '');
    live.stream({ type: 'message_start', message: { id: 's1', usage: { input_tokens: 50, output_tokens: 1 } } }, 'tool-1');
    live.stream({ type: 'message_delta', usage: { output_tokens: 40 } }, '');
    live.stream({ type: 'message_delta', usage: { output_tokens: 7 } }, 'tool-1');
    // An assistant message repeats the early snapshot; it must not undo the delta.
    live.add({ id: 'm1', usage: { input_tokens: 100, output_tokens: 1 } });
    live.flush();
    expect(last).toEqual({ input: 150, output: 47, cacheRead: 900, cacheWrite: 0 });
    live.close();

    // Claude's 1-hour cache writes cost twice the input price ($2/M on Sonnet 5.5), 5-minute ones 1.25×.
    let cost: number | undefined;
    const writes = new LiveUsage(undefined, (_t, c) => (cost = c));
    writes.add({ id: 'w', model: 'claude-sonnet-5-5', usage: { cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } } });
    writes.flush();
    expect(cost).toBeCloseTo(2.5 + 4);
  });

  it("counts a member's spend while it works, then its exact figure", async () => {
    const store = new EventStore(':memory:');
    let midRun: ReturnType<typeof summarizeRun> | undefined;
    let midStats: ReturnType<typeof computeStats> | undefined;
    const runner = new ScriptedRunner({
      builder: (inv) => {
        inv.onEvent({ kind: 'usage', tokens: tokens(1000, 100), costUsd: 0.5 });
        inv.onEvent({ kind: 'usage', tokens: tokens(5000, 400), costUsd: 1.25 });
        const runId = store.listRuns(1)[0]!.id;
        const events = store.events(runId);
        midRun = summarizeRun(store.getRun(runId)!, events, { id: 'p', name: 'p' }, true);
        midStats = computeStats([{ runs: store.listRuns(10), events, live: () => true, activeAgents: 1 }]);
        return { write: { 'src/a.js': 'export const a = 1;' }, text: 'Built.' };
      },
      reviewer: () => ({ structured: pass }),
    });
    const outcome = await runTeam({ team: loadTeam(TEAM), repo: tempRepo(), goal: 'Add a', store, runner });

    // While it worked: the latest running total, once.
    expect(midRun!.agents.find((a) => a.name === 'builder')).toMatchObject({ costUsd: 1.25, tokens: 5400 });
    expect(midRun!.costUsd).toBe(1.25);
    expect(midStats!.costUsd.today).toBe(1.25);
    expect(midStats!.byVia).toEqual([expect.objectContaining({ via: 'claude', costUsd: 1.25 })]);

    // Only the latest running total is stored.
    const events = store.events(outcome.runId);
    expect(events.filter((e) => e.type === 'agent.usage')).toHaveLength(1);
    // After the turn: the exact figure (0.01 from the scripted runner) replaces the estimate.
    const after = summarizeRun(store.getRun(outcome.runId)!, events, { id: 'p', name: 'p' }, false);
    expect(after.agents.find((a) => a.name === 'builder')!.costUsd).toBeCloseTo(0.01);
    expect(computeStats([{ runs: store.listRuns(10), events, live: () => false, activeAgents: 0 }]).costUsd.today).toBeCloseTo(0.02);
  });
});
