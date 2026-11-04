import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brainLoad, brainLog, ensureBrain, listNotes, summarizeBrain, SUMMARIZER } from '../src/engine/brain.js';
import { EventStore } from '../src/events/store.js';
import { ScriptedRunner, tempRepo } from './helpers.js';

const LONG = `# Decisions\n\n${'We decided, after a long discussion that went on for a while, that prices are stored in integer cents.\n'.repeat(30)}`;

async function brainWith(notes: Record<string, string>) {
  const repo = tempRepo();
  const dir = await ensureBrain(repo);
  for (const [rel, text] of Object.entries(notes)) writeFileSync(join(dir, rel), text);
  return { repo, dir };
}

describe('summarizing the brain', () => {
  it('lets an agent rewrite the notes shorter, merge and delete them, and commits the result', async () => {
    const { repo, dir } = await brainWith({ 'decisions.md': LONG, 'prices.md': '# Prices\n\nCents.\n' });
    const store = new EventStore(':memory:');
    const run = store.createRun({ id: 'r1', kind: 'curate', team: SUMMARIZER, teamFile: '', repo, goal: 'Summarize' });
    const runner = new ScriptedRunner({
      [SUMMARIZER]: (inv) => {
        expect(inv.prompt).toMatch(/decisions\.md \(\d+ bytes\)/);
        return {
          write: { 'decisions.md': '# Decisions\n\n- Prices are integer cents.\n', '../outside.md': 'nope' },
          call: [
            { tool: 'delete_note', args: { path: 'prices.md' } },
            { tool: 'delete_note', args: { path: 'README.md' } },
          ],
          text: 'Merged prices into decisions.',
        };
      },
    });
    const out = await summarizeBrain({ store, runner, repo, runId: run.id });
    expect(out.after).toBeLessThan(out.before / 4);
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe('# Decisions\n\n- Prices are integer cents.\n');
    expect(existsSync(join(dir, 'prices.md'))).toBe(false);
    // It works only in the brain, and README.md stays.
    expect(runner.denied.map((d) => d.reason)).toEqual([expect.stringMatching(/outside your workspace/)]);
    expect(runner.toolResults.map((r) => r.result)).toEqual(['Deleted prices.md.', expect.stringMatching(/README.md is the index of the brain and stays/)]);
    expect(listNotes(repo).map((n) => n.path)).toEqual(['README.md', 'decisions.md']);
    const log = await brainLog(repo);
    expect(log[0]).toMatchObject({ author: `covibe/${SUMMARIZER}`, message: expect.stringMatching(/^Summarized the brain: 3 KB to 0 KB, 1 note\(s\) merged away/) });
    expect(log[1]).toMatchObject({ message: 'Before summarizing' });
    const events = store.events(run.id).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['step.started', 'agent.started', 'agent.finished', 'brain.updated', 'step.finished']));
  });

  it('leaves the brain as it was when the agent fails', async () => {
    const { repo, dir } = await brainWith({ 'decisions.md': LONG });
    const store = new EventStore(':memory:');
    const run = store.createRun({ id: 'r2', kind: 'curate', team: SUMMARIZER, teamFile: '', repo, goal: 'Summarize' });
    const runner = new ScriptedRunner({ [SUMMARIZER]: () => ({ write: { 'decisions.md': '# Half', 'new.md': '# New' }, fail: 'Claude Code process exited with code 1' }) });
    await expect(summarizeBrain({ store, runner, repo, runId: run.id })).rejects.toThrow(/exited with code 1/);
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe(LONG);
    expect(existsSync(join(dir, 'new.md'))).toBe(false);
  });

  it('runs on the model, effort and provider from Settings', async () => {
    const { repo } = await brainWith({ 'decisions.md': LONG });
    const store = new EventStore(':memory:');
    const run = store.createRun({ id: 'r3', kind: 'curate', team: SUMMARIZER, teamFile: '', repo, goal: 'Summarize' });
    const runner = new ScriptedRunner({ [SUMMARIZER]: () => ({ text: 'Nothing to merge.' }) });
    const resolved: unknown[] = [];
    const backends = { resolve: async (b: { type: string; connection?: string }) => (resolved.push(b), { env: {}, warnings: [], via: b.connection ?? 'claude' }) };
    await summarizeBrain({ store, runner, repo, runId: run.id, model: 'haiku', effort: 'low', backends });
    expect(runner.calls[0]).toMatchObject({ model: 'haiku', effort: 'low' });
    await summarizeBrain({ store, runner, repo, runId: run.id, model: 'haiku', backend: { type: 'connection', connection: 'deepseek', model: 'deepseek-chat' }, backends });
    // A provider's model wins over the Claude model.
    expect(runner.calls[1]).toMatchObject({ model: 'deepseek-chat' });
    expect(resolved).toEqual([{ type: 'subscription' }, { type: 'connection', connection: 'deepseek', model: 'deepseek-chat' }]);
    expect(store.events(run.id).filter((e) => e.type === 'agent.started').map((e) => e.data.via)).toEqual(['claude', 'deepseek']);
  });
});

describe('what the brain costs members', () => {
  it('estimates the list in every prompt, each note, and what recent runs read', async () => {
    const { repo, dir } = await brainWith({ 'decisions.md': LONG, 'prices.md': '# Prices\n\nCents.\n' });
    const load = brainLoad(repo, { runs: 2, reads: [join(dir, 'decisions.md'), join(dir, 'decisions.md'), join(dir, 'prices.md'), '/elsewhere/prices.md'] });
    expect(load.notes['decisions.md']).toBe(Math.ceil(LONG.length / 4));
    expect(load.notesTokens).toBe(Object.values(load.notes).reduce((a, b) => a + b, 0));
    // The prompt lists the notes, it does not include them.
    expect(load.promptTokens).toBeGreaterThan(20);
    expect(load.promptTokens).toBeLessThan(load.notes['decisions.md']!);
    expect(load.recent).toEqual({ runs: 2, reads: 3, tokens: 2 * load.notes['decisions.md']! + load.notes['prices.md']! });
  });
});
