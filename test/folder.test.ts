import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { chat } from '../src/engine/chat.js';
import { cleanupWorktrees } from '../src/engine/cleanup.js';
import { runTeam } from '../src/engine/engine.js';
import { denyWritePaths, folderDiff, undoFolderRun } from '../src/engine/folder.js';
import { EventStore } from '../src/events/store.js';
import { ScriptedRunner, tempDir, writeFiles } from './helpers.js';

/** A writer that may change docs/ and a reviewer that reads; worktree isolation, as most teams have it. */
function team() {
  const dir = tempDir('covibe-team-');
  writeFiles(dir, {
    'team.yaml': [
      'version: 1',
      'name: docs',
      'defaults:',
      '  isolation: worktree',
      'agents:',
      '  writer:',
      '    prompt: "Write.\\n"',
      '    tools: [Read, Edit, Write, Bash]',
      '    scope: { write: ["docs/**"] }',
      '  reviewer:',
      '    prompt: "Review.\\n"',
      '    tools: [Read, Grep, Glob]',
      'workflow:',
      '  steps:',
      '    - { id: write, agent: writer }',
      '    - { id: review, agent: reviewer }',
      '',
    ].join('\n'),
  });
  return loadTeam(join(dir, 'team.yaml'));
}

/** A plain folder (no git): a document, and raw material the team must leave alone. */
function folder() {
  const dir = tempDir('covibe-folder-');
  writeFiles(dir, { 'docs/guide.md': '# Guide\n\nOld text.\n', 'docs/old.md': 'remove me\n', 'raw/clip.txt': 'footage\n' });
  return dir;
}

describe('plain folders', () => {
  it('works in the folder itself, records each change, and keeps writes outside the scope out', async () => {
    const root = folder();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({
      writer: (inv) => {
        rmDoc(inv.cwd);
        return {
          write: { 'docs/guide.md': '# Guide\n\nNew text.\n', 'docs/new.md': 'added\n', 'raw/clip.txt': 'overwritten' },
          bashWrite: { 'raw/notes.txt': 'stray' },
        };
      },
      reviewer: (inv) => {
        // Members see the work as it is in the folder.
        expect(readFileSync(join(inv.cwd, 'docs/guide.md'), 'utf8')).toContain('New text');
        return { text: 'looks good' };
      },
    });
    const outcome = await runTeam({ team: team(), repo: root, goal: 'Update the guide', store, runner, env: {} });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.branch).toBeUndefined();
    const writer = runner.callsFor('writer')[0]!;
    expect(writer.cwd).toBe(root);
    expect(writer.systemPrompt).toContain(`You work directly in the person's own folder (${root})`);
    expect(writer.systemPrompt).not.toContain('git commit');
    // The OS sandbox keeps the writer's shell commands out of raw/ and covibe's own folder.
    expect(writer.sandbox?.denyWrite).toEqual(expect.arrayContaining([join(root, 'raw'), join(root, '.covibe')]));
    expect(writer.sandbox?.denyWrite).not.toContain(join(root, 'docs'));
    // The file tools are held to the scope.
    expect(runner.denied).toEqual([expect.objectContaining({ agent: 'writer', reason: expect.stringMatching(/raw\/clip.txt is outside your write scope/) })]);
    expect(readFileSync(join(root, 'raw/clip.txt'), 'utf8')).toBe('footage\n');

    const events = store.events(outcome.runId);
    expect(events.find((e) => e.type === 'run.started')?.data).toMatchObject({ isolation: 'folder', folder: root });
    expect(events.find((e) => e.type === 'files.changed')).toMatchObject({
      agent: 'writer',
      data: { files: ['docs/guide.md', 'docs/new.md', 'docs/old.md'], added: ['docs/new.md'], modified: ['docs/guide.md'], deleted: ['docs/old.md'] },
    });
    // A stray shell write outside the scope stays (it might be the person's own) and is reported.
    expect(events.find((e) => e.type === 'scope.violation')).toMatchObject({ agent: 'writer', data: { files: ['raw/notes.txt'], kept: true } });
    expect(events.some((e) => e.type === 'git.commit')).toBe(false);

    const diff = await folderDiff(root, outcome.runId);
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([
      ['docs/guide.md', 'modified'],
      ['docs/new.md', 'added'],
      ['docs/old.md', 'deleted'],
      ['raw/notes.txt', 'added'],
    ]);
    expect(diff.files[0]).toMatchObject({ by: ['writer'], additions: 1, deletions: 1 });
    expect(diff.patch).toContain('-Old text.');
    expect(diff.patch).toContain('+New text.');
    expect(diff.patch).toContain('docs/guide.md');
    expect(diff.patch).not.toContain('folder-runs');
  });

  it('undoes a run, setting aside what it left, and skips files changed since', async () => {
    const root = folder();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({
      writer: (inv) => {
        rmDoc(inv.cwd);
        return { write: { 'docs/guide.md': 'rewritten\n', 'docs/new.md': 'added\n', 'docs/later.md': 'mine\n' } };
      },
      reviewer: () => ({ text: 'ok' }),
    });
    const outcome = await runTeam({ team: team(), repo: root, goal: 'g', store, runner, env: {} });
    // The person edits one of the files after the run.
    writeFileSync(join(root, 'docs/later.md'), 'edited by the person, longer\n');

    const undone = await undoFolderRun(root, outcome.runId);
    expect(undone.restored).toEqual(['docs/guide.md', 'docs/old.md']);
    expect(undone.removed).toEqual(['docs/new.md']);
    expect(undone.skipped).toEqual([{ path: 'docs/later.md', reason: 'it changed again after the run' }]);
    expect(readFileSync(join(root, 'docs/guide.md'), 'utf8')).toBe('# Guide\n\nOld text.\n');
    expect(readFileSync(join(root, 'docs/old.md'), 'utf8')).toBe('remove me\n');
    expect(existsSync(join(root, 'docs/new.md'))).toBe(false);
    expect(readFileSync(join(root, 'docs/later.md'), 'utf8')).toContain('edited by the person');
    // Nothing is thrown away: the run's versions are kept aside.
    expect(readFileSync(join(undone.keptIn, 'docs/guide.md'), 'utf8')).toBe('rewritten\n');

    const diff = await folderDiff(root, outcome.runId);
    expect(diff.files.map((f) => f.path)).toEqual(['docs/later.md']);
    expect(diff.undoneAt).toBeDefined();
  });

  it('records what a member changes when you chat with it after the run', async () => {
    const root = folder();
    const store = new EventStore(':memory:');
    const t = team();
    const runner = new ScriptedRunner({
      writer: (_inv, n) => (n === 0 ? { text: 'nothing to do' } : { write: { 'docs/guide.md': 'from chat\n' }, text: 'done' }),
      reviewer: () => ({ text: 'ok' }),
    });
    const outcome = await runTeam({ team: t, repo: root, goal: 'g', store, runner, env: {} });
    const reply = await chat({ store, runner, team: t, runId: outcome.runId, agent: 'writer', message: 'Rewrite the guide', env: {} });
    expect(reply).toMatchObject({ mode: 'replied', ok: true });
    expect(runner.callsFor('writer')[1]!.systemPrompt).toContain("person's own folder");
    expect(store.events(outcome.runId).find((e) => e.type === 'files.changed')).toMatchObject({ step: 'chat', data: { files: ['docs/guide.md'] } });
    expect((await folderDiff(root, outcome.runId)).files.map((f) => f.path)).toEqual(['docs/guide.md']);
  });

  it('frees the copies with the worktree cleanup', async () => {
    const root = folder();
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({ writer: () => ({ write: { 'docs/a.md': 'a' } }), reviewer: () => ({ text: 'ok' }) });
    const outcome = await runTeam({ team: team(), repo: root, goal: 'g', store, runner, env: {} });
    const res = await cleanupWorktrees(root, store, {});
    expect(res.cleaned.map((c) => c.runId)).toEqual([outcome.runId]);
    await expect(undoFolderRun(root, outcome.runId)).rejects.toThrow(/no record/);
    expect(readFileSync(join(root, 'docs/a.md'), 'utf8')).toBe('a');
  });

  it('denies shell writes to whatever the scope cannot reach', () => {
    const root = folder();
    writeFiles(root, { 'final/out.txt': 'x', 'notes.md': 'n' });
    expect(denyWritePaths(root, undefined)).toEqual([join(root, '.covibe')]);
    expect(denyWritePaths(root, ['**/*.md'])).toEqual([join(root, '.covibe')]);
    expect(denyWritePaths(root, ['final/**']).sort()).toEqual([join(root, '.covibe'), join(root, 'docs'), join(root, 'notes.md'), join(root, 'raw')].sort());
    expect(denyWritePaths(root, ['notes.md', 'docs/*.md']).sort()).toEqual([join(root, '.covibe'), join(root, 'final'), join(root, 'raw')].sort());
  });
});

/** Delete docs/old.md the way a shell command would. */
function rmDoc(cwd: string) {
  rmSync(join(cwd, 'docs/old.md'));
}
