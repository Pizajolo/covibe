import { describe, expect, it } from 'vitest';
import type { AgentState, RunSummary } from '../src/server/api-types.js';
import { deskNote, deskState } from '../ui/src/components/office-state.js';
import { boardText, kindOf, layout } from '../ui/src/components/office-art.js';

const agent = (a: Partial<AgentState>): AgentState => ({ name: 'dev', status: 'idle', invocations: 0, turns: 0, costUsd: 0, tokens: 0, inbox: 0, ...a });
const run = (r: Partial<RunSummary>) => ({ status: 'running', paused: false, ...r }) as RunSummary;

describe('office', () => {
  it('shows each member in the state that matters most to you', () => {
    const live = run({});
    expect(deskState(agent({ status: 'working' }), live, false)).toBe('working');
    expect(deskState(agent({ status: 'asking', waitingOn: 'manager' }), live, false)).toBe('asking');
    expect(deskState(agent({ status: 'asking', waitingOn: 'human' }), run({ paused: true }), false)).toBe('needs');
    // Everyone else working is held while the run is paused.
    expect(deskState(agent({ status: 'working' }), run({ paused: true }), false)).toBe('held');
    expect(deskState(agent({ status: 'done' }), live, false)).toBe('done');
    expect(deskState(agent({ status: 'error' }), live, false)).toBe('stopped');
    expect(deskState(agent({ status: 'idle' }), live, false)).toBe('sleeping');
    // Once the run ends, the office goes to sleep; a member answering a chat wakes up.
    expect(deskState(agent({ status: 'done' }), run({ status: 'succeeded' }), false)).toBe('sleeping');
    expect(deskState(agent({ status: 'done' }), run({ status: 'succeeded' }), true)).toBe('working');

    expect(deskNote(agent({ status: 'working', activity: 'Edit web/a.tsx' }), 'working', live)).toBe('Edit web/a.tsx');
    expect(deskNote(agent({ waitingOn: 'manager' }), 'asking', live)).toBe('asking manager');
    expect(deskNote(agent({ status: 'done', step: 'build' }), 'done', live)).toBe('done with build');
    expect(deskNote(agent({ inbox: 2 }), 'sleeping', live)).toBe('2 messages waiting');
    expect(deskNote(agent({}), 'sleeping', live)).toBe('waiting for its step');
    expect(deskNote(agent({ status: 'done' }), 'sleeping', run({ status: 'succeeded' }))).toBe('asleep');
  });

  it('seats any team in centred rows of three and reads roles from names first', () => {
    expect(layout(1)).toEqual({ h: 128, spots: [{ cx: 160, by: 90 }] });
    expect(layout(5).spots.map((s) => [s.cx, s.by])).toEqual([[56, 90], [160, 90], [264, 90], [108, 152], [212, 152]]);
    expect(layout(5).h).toBe(190);

    expect(kindOf('qa', 'Reviews the merged change')).toBe('review');
    expect(kindOf('tester', 'Adds and runs tests')).toBe('test');
    expect(kindOf('frontend', 'Builds the web UI')).toBe('frontend');
    expect(kindOf('builder', 'Builds the API under api/')).toBe('backend');
    expect(kindOf('curator')).toBe('docs');
    expect(kindOf('alice', '', true)).toBe('lead');
    expect(kindOf('assistant', 'Works on the goal end to end.')).toBe('general');
    expect(boardText('build_api ok?')).toBe('BUILD-API OK?');
  });
});
