import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTeam } from '../src/config/load.js';
import { brainLog, ensureBrain, listNotes } from '../src/engine/brain.js';
import { buildInvocation, runTeam } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { brainRoot } from '../src/home.js';
import { createSkill, deleteSkill, listSkills, parseGithub, parseSkillMd, resolveSkills, setEveryone, skillsPluginDir } from '../src/skills.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const TEAM = `
version: 1
name: brainy
brain: { curator: librarian }
defaults:
  skills: [house-style]
agents:
  builder:
    prompt: "Build.\\n"
    tools: [Read, Write, Bash]
    skills: [dataviz]
  librarian:
    prompt: "Keep the notes.\\n"
    tools: [Read, Write, Edit]
workflow:
  steps:
    - { id: build, agent: builder }
`;

function team(yaml = TEAM) {
  const dir = tempDir();
  writeFiles(dir, { 'team.yaml': yaml });
  return loadTeam(join(dir, 'team.yaml'));
}

describe('skills', () => {
  it('creates library skills and resolves them for the SDK', () => {
    const s = createSkill({ name: 'house-style', description: 'Our code style. Use when writing code.', body: 'Use tabs.\n' });
    expect(s).toMatchObject({ name: 'house-style', source: 'manual', everyone: false, files: 1 });
    expect(parseSkillMd(readFileSync(join(skillsPluginDir(), 'skills', 'house-style', 'SKILL.md'), 'utf8'))).toMatchObject({ name: 'house-style', description: 'Our code style. Use when writing code.' });
    expect(existsSync(join(skillsPluginDir(), '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(() => createSkill({ name: 'Bad Name', description: 'x', body: '' })).toThrow(/not a valid skill name/);

    // Library names are plugin-qualified; others are taken as built-in skills.
    expect(resolveSkills(['house-style', 'dataviz'])).toEqual({ names: ['covibe:house-style', 'dataviz'], pluginDirs: [skillsPluginDir()] });
    expect(resolveSkills(['dataviz'])).toEqual({ names: ['dataviz'], pluginDirs: [] });

    createSkill({ name: 'security-basics', description: 'Security checklist.', body: 'Never log secrets.\n' });
    setEveryone('security-basics', true);
    expect(resolveSkills([])!.names).toEqual(['covibe:security-basics']);
    deleteSkill('security-basics');
    expect(listSkills().map((s) => s.name)).toEqual(['house-style']);
  });

  it('merges team and member skills and passes them to the runner', () => {
    const t = team();
    expect(t.agents.builder!.skills).toEqual(['house-style', 'dataviz']);
    expect(t.agents.librarian!.skills).toEqual(['house-style']);
    const inv = buildInvocation(t, new EventStore(':memory:'), 'r', t.agents.builder!, { cwd: '/x', root: '/x', prompt: 'p', env: {}, step: 's', signal: new AbortController().signal });
    expect(inv.skills?.names).toEqual(expect.arrayContaining(['dataviz']));
  });

  it('parses GitHub locations', () => {
    expect(parseGithub('https://github.com/anthropics/skills/tree/main/skills/pdf')).toEqual({ owner: 'anthropics', repo: 'skills', ref: 'main', path: 'skills/pdf' });
    expect(parseGithub('https://github.com/o/r/blob/dev/a/b/SKILL.md')).toEqual({ owner: 'o', repo: 'r', ref: 'dev', path: 'a/b' });
    expect(parseGithub('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r', ref: undefined, path: '' });
    expect(parseGithub('o/r/skills/x')).toEqual({ owner: 'o', repo: 'r', path: 'skills/x' });
    expect(() => parseGithub('not a url')).toThrow(/GitHub URL/);
  });
});

describe('project brain', () => {
  it('lets members read and propose, and only the curator write; proposals are curated after the run', async () => {
    const repo = tempRepo();
    const store = new EventStore(':memory:');
    const t = team();
    const runner = new ScriptedRunner({
      builder: (inv) => {
        // Everyone reads the brain and is told how it works.
        expect(inv.readDirs).toEqual([brainRoot(repo)]);
        expect(inv.systemPrompt).toContain('# Project brain');
        expect(inv.systemPrompt).toContain('README.md: Project brain');
        expect(inv.systemPrompt).toContain('librarian curates the brain');
        // It cannot write there, even with its Write tool.
        expect(inv.checkToolUse('Write', { file_path: join(brainRoot(repo), 'hack.md') })).toMatch(/outside your workspace/);
        return {
          call: [{ tool: 'propose_brain_note', args: { title: 'Prices are integer cents', content: 'All money is stored as integer cents.', reason: 'Saw it in api/money.ts' } }],
          text: 'built',
        };
      },
      librarian: (inv) => {
        // Curation pass: works in the brain folder, may write there, decides each proposal.
        expect(inv.cwd).toBe(brainRoot(repo));
        expect(inv.prompt).toContain('Proposal #1: Prices are integer cents');
        expect(inv.checkToolUse('Write', { file_path: join(brainRoot(repo), 'money.md') })).toBeUndefined();
        expect(inv.checkToolUse('Write', { file_path: join(repo, 'README.md') })).toMatch(/outside your workspace/);
        writeFiles(inv.cwd, { 'money.md': '# Money\n\nAll money is stored as integer cents.\n' });
        return { call: [{ tool: 'decide_proposal', args: { id: 1, decision: 'accept', note: 'Added to money.md', note_path: 'money.md' } }], text: 'curated' };
      },
    });
    const outcome = await runTeam({ team: t, repo, goal: 'g', store, runner, env: {} });
    expect(outcome.status).toBe('succeeded');
    expect(runner.toolResults.map((r) => r.result)).toEqual([expect.stringMatching(/Proposal #1 recorded/), 'Recorded: #1 accepted.']);
    expect(store.getProposal(1)).toMatchObject({ status: 'accepted', decidedBy: 'librarian', notePath: 'money.md' });
    expect(listNotes(repo).map((n) => [n.path, n.title])).toEqual([
      ['README.md', 'Project brain'],
      ['money.md', 'Money'],
    ]);
    const log = await brainLog(repo);
    expect(log[0]).toMatchObject({ author: 'covibe/librarian', message: 'Curated 1 proposal(s)' });
    const types = store.events(outcome.runId).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['brain.proposed', 'brain.decided', 'brain.updated']));
    expect(types.indexOf('brain.updated')).toBeLessThan(types.indexOf('run.finished'));
  });

  it('rejects a curator without write tools', () => {
    expect(() => team(TEAM.replace('tools: [Read, Write, Edit]', 'tools: [Read]'))).toThrow(/librarian needs the Write or Edit tool/);
  });

  it('starts the brain as its own git repository with a README', async () => {
    const repo = tempRepo();
    const dir = await ensureBrain(repo);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('Start the project brain');
  });
});
