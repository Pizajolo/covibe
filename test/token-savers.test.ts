import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { runTeam, withCacheTtl } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { computeStats } from '../src/server/projections.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const team = (extra = '', builder = '') => {
  const dir = tempDir();
  writeFiles(dir, {
    'team.yaml': `
version: 1
name: savers
brain: { curator: librarian${extra} }
defaults:
  cache_ttl: 1h
agents:
  builder:
    prompt: "Build.\\n"
    tools: [Read, Write]${builder}
  librarian:
    prompt: "Keep the notes.\\n"
    tools: [Read, Write, Edit]
    cache_ttl: 5m
workflow:
  steps:
    - { id: build, agent: builder }
`,
  });
  return loadTeam(join(dir, 'team.yaml'));
};

const propose = { call: [{ tool: 'propose_brain_note', args: { title: 'A fact', content: 'Something durable.' } }], text: 'built' };

describe('token savers', () => {
  it('reads the prompt cache lifetime from the team and its members', () => {
    const t = team();
    expect(t.agents.builder!.cacheTtl).toBe('1h');
    expect(t.agents.librarian!.cacheTtl).toBe('5m');
    expect(t.brain.minProposals).toBe(1);
    expect(team(', min_proposals: 5').brain.minProposals).toBe(5);
  });

  it('sets the cache lifetime only for members on Anthropic\'s API', () => {
    expect(withCacheTtl({ HOME: '/h' }, '1h')).toEqual({ HOME: '/h', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
    expect(withCacheTtl({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, '1h').CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
    expect(withCacheTtl({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, '1h').CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
    expect(withCacheTtl({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000/openrouter' }, '1h').CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
    expect(withCacheTtl({ HOME: '/h' }, undefined)).toEqual({ HOME: '/h' });
  });

  it('passes the lifetime to the member and batches brain reviews', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({ builder: () => propose, librarian: () => ({ text: 'curated' }) });
    const t = team(', min_proposals: 2');
    await runTeam({ team: t, repo, goal: 'g', store, runner, env: {} });
    expect(runner.callsFor('builder')[0]!.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
    // One proposal waiting, two needed: no review session yet.
    expect(runner.callsFor('librarian')).toHaveLength(0);
    await runTeam({ team: t, repo, goal: 'g', store, runner, env: {} });
    expect(runner.callsFor('librarian')).toHaveLength(1);
    expect(runner.callsFor('librarian')[0]!.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
  });

  it('counts cache writes, for the cache hit rate on Home', () => {
    const ev = (id: number, tokens: Record<string, number>) => ({ id, runId: 'r', ts: new Date().toISOString(), type: 'agent.finished' as const, agent: 'a', data: { cost_usd: 0, tokens } });
    const stats = computeStats([{ runs: [], events: [ev(1, { input: 10, output: 5, cacheRead: 800, cacheWrite: 190 })], live: () => false, activeAgents: 0 }]);
    expect(stats.tokens).toMatchObject({ input: 10, cacheRead: 800, cacheWrite: 190 });
  });
});

describe('report schemas for Claude Code', () => {
  it('leave out the $schema line, which Claude Code refuses for draft 2020-12', async () => {
    const { forClaudeCode } = await import('../src/runner/claude-sdk.js');
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'string' } } };
    expect(forClaudeCode(schema)).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    expect(schema.$schema).toBeDefined();
  });
});
