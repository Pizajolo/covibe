import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { RunDetail, Stats, TeamDetail } from '../src/server/api-types.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles, type Script } from './helpers.js';

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const review = (n: number) => ({ blocking_count: n === 0 ? 1 : 0, findings: n === 0 ? [{ severity: 'blocking', file: 'src/a.js', message: 'off by one' }] : [] });

async function setup(scripts: Record<string, Script> = {}) {
  const library = new Library(tempDir('covibe-home-'));
  const runner = new ScriptedRunner({
    builder: (_inv, n) => ({ write: { 'src/a.js': `export const a = ${n};` }, text: `Built round ${n}.` }),
    reviewer: (inv, n) => (inv.outputSchema ? { structured: review(n) } : { text: 'The repo has one module, src/a.js.' }),
    ...scripts,
  });
  server = await startServer({ library, runner, token: 'test-token' });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
    return json as T;
  };
  return { library, runner, base, api };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('server', () => {
  it('requires the token and a local Host header', async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    // fetch() will not send a custom Host header, so use node:http (DNS-rebinding check).
    const status = await new Promise<number>((resolve, reject) =>
      request(`${base}/api/overview`, { headers: { authorization: 'Bearer test-token', host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
        .on('error', reject)
        .end(),
    );
    expect(status).toBe(403);
    expect((await fetch(`${base}/api/overview?token=test-token`)).status).toBe(200);
  });

  it('creates teams from templates and edits them without losing comments', async () => {
    const { api } = await setup();
    const templates = await api('GET', '/api/templates');
    expect(templates.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(['feature-team', 'build-and-review', 'starter']));

    const team = await api('POST', '/api/teams', { name: 'My Team', template: 'build-and-review' });
    expect(team).toMatchObject({ id: 'my-team', name: 'my-team', valid: true, agents: ['builder', 'reviewer'] });

    const edited = await api('POST', `/api/teams/${team.id}/edit`, {
      ops: [
        { op: 'set', path: ['agents', 'builder', 'model'], value: 'opus' },
        { op: 'set', path: ['agents', 'docs'], value: { prompt: 'prompts/docs.md', tools: ['Read', 'Write'], scope: { write: ['docs/**'] } } },
      ],
    });
    expect(edited.yaml).toContain('# A builder and a reviewer.');
    expect(edited.yaml).toContain('model: opus');
    expect(edited.yaml).toContain('tools: [ Read, Write ]');
    expect(edited.problems).toEqual(['/agents/docs/prompt: file "prompts/docs.md" not found']);

    const saved = await api('PUT', `/api/teams/${team.id}/file`, { path: 'prompts/docs.md', content: 'You write docs.' });
    expect(saved.problems).toEqual([]);
    const detail = await api<TeamDetail>('GET', `/api/teams/${team.id}`);
    expect(detail.files.map((f) => f.path)).toContain('prompts/docs.md');
    expect(Object.keys(detail.doc.agents as object)).toEqual(['builder', 'reviewer', 'docs']);

    const live = await api('POST', `/api/teams/${team.id}/validate`, { yaml: detail.yaml.replace('version: 1', 'version: 2') });
    expect(live.problems[0]).toMatch(/version/);
    await expect(api('GET', `/api/teams/${team.id}/file?path=../../config.json`)).rejects.toMatchObject({ status: 400 });
  });

  it('starts a run, streams its state, chats with an agent afterwards and reports stats', async () => {
    const { api, runner } = await setup();
    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const team = await api('POST', '/api/teams', { name: 'duo', template: 'build-and-review' });
    await expect(api('POST', '/api/projects', { path: tempDir() })).rejects.toThrow(/not a git repository/);

    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Add module a' });
    const done = await until(
      () => api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`),
      (d) => d.summary.status !== 'running',
    );
    expect(done.summary).toMatchObject({ status: 'succeeded', loops: 1, kind: 'workflow', team: 'duo', filesChanged: ['src/a.js'] });
    expect(done.summary.steps.map((s) => [s.id, s.status, s.rounds])).toEqual([
      ['build', 'done', 2],
      ['review', 'passed', 2],
    ]);
    expect(done.summary.agents.map((a) => [a.name, a.status, a.invocations])).toEqual([
      ['builder', 'done', 2],
      ['reviewer', 'done', 2],
    ]);
    expect(done.chatMode).toBe('answer');
    expect(done.threads.builder!.some((i) => i.kind === 'agent' && i.text === 'Built round 1.')).toBe(true);

    const diff = await api('GET', `/api/runs/${project.id}/${runId}/diff`);
    expect(diff.files).toEqual([{ path: 'src/a.js', additions: 1, deletions: 0 }]);

    // Chat after the run: answered by resuming the builder's session.
    expect(await api('POST', `/api/runs/${project.id}/${runId}/chat`, { agent: 'builder', message: 'why?' })).toEqual({ mode: 'answering' });
    const afterChat = await until(
      () => api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`),
      (d) => (d.threads.builder ?? []).filter((i) => i.kind === 'agent').length === 3,
    );
    expect(afterChat.threads.builder!.find((i) => i.kind === 'human')).toMatchObject({ text: 'why?' });
    expect(runner.callsFor('builder').at(-1)!.resumeSessionId).toBe('session-builder');

    // A question: read-only, its own session.
    const q = await api('POST', '/api/ask', { project: project.id, team: team.id, agent: 'reviewer', question: 'What is in this repo?' });
    const asked = await until(
      () => api<RunDetail>('GET', `/api/runs/${project.id}/${q.runId}`),
      (d) => d.summary.status !== 'running',
    );
    expect(asked.summary.kind).toBe('ask');
    expect(asked.threads.reviewer!.map((i) => i.kind)).toEqual(['human', 'agent']);
    expect(runner.callsFor('reviewer').at(-1)!.tools).toEqual(['Read', 'Grep', 'Glob']);

    const stats = await api<Stats>('GET', '/api/stats');
    expect(stats.runs).toMatchObject({ total: 1, succeeded: 1, questions: 1 });
    expect(stats.costUsd.all).toBeCloseTo(0.06);
    expect(stats.byAgent.map((a) => a.agent).sort()).toEqual(['builder', 'reviewer']);
    expect(stats.gatePassRate).toBe(0.5);
    expect(stats.daily).toHaveLength(14);
  });

  it('pauses a run on a question for you and resumes it when you answer', async () => {
    const { api, runner } = await setup({
      // build-and-review has no manager, so the question comes straight to you.
      builder: (_inv, n) => ({
        call: n === 0 ? [{ tool: 'ask_question', args: { question: 'CommonJS or ES modules?' } }] : [],
        write: { 'src/a.js': 'export const a = 1;' },
        text: 'Built.',
      }),
      reviewer: () => ({ structured: review(1) }),
    });
    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const team = await api('POST', '/api/teams', { name: 'duo', template: 'build-and-review' });
    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Add module a' });

    const paused = await until(
      () => api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`),
      (d) => d.summary.paused,
    );
    expect(paused.summary).toMatchObject({ status: 'running', questions: [{ id: 1, from: 'builder', status: 'open', question: 'CommonJS or ES modules?' }] });
    // Member details for the office: build-and-review has no manager, so nobody leads.
    expect(paused.members.map((m) => [m.name, m.lead, m.writes])).toEqual([
      ['builder', false, true],
      ['reviewer', false, false],
    ]);
    const overview = await api('GET', '/api/overview');
    expect(overview.runs.find((r: { id: string }) => r.id === runId)).toMatchObject({ paused: true });

    await expect(api('POST', `/api/runs/${project.id}/${runId}/questions/1/answer`, { answer: ' ' })).rejects.toThrow('"answer" is required');
    await api('POST', `/api/runs/${project.id}/${runId}/questions/1/answer`, { answer: 'ES modules.' });
    await expect(api('POST', `/api/runs/${project.id}/${runId}/questions/1/answer`, { answer: 'again' })).rejects.toThrow(/already answered/);

    const done = await until(
      () => api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`),
      (d) => d.summary.status !== 'running',
    );
    expect(done.summary).toMatchObject({ status: 'succeeded', paused: false, questions: [{ status: 'answered', answeredBy: 'human', answer: 'ES modules.' }] });
    expect(runner.toolResults).toContainEqual({ agent: 'builder', tool: 'ask_question', result: 'Answer from the human:\nES modules.' });
  });

  it('reorders and inserts workflow steps without losing comments', async () => {
    const { api } = await setup();
    const team = await api('POST', '/api/teams', { name: 'flow', template: 'feature-team' });
    const before = await api<TeamDetail>('GET', `/api/teams/${team.id}`);
    expect(before.yaml).toContain('# tasks[] with an owner each');
    const moved = await api('POST', `/api/teams/${team.id}/edit`, {
      ops: [
        { op: 'move', path: ['workflow', 'steps'], from: 4, to: 0 },
        { op: 'insert', path: ['workflow', 'steps'], index: 2, value: { id: 'lint', agent: 'tester' } },
        { op: 'insert', path: ['workflow', 'steps', 3, 'parallel'], value: { agent: 'qa' } },
      ],
    });
    const ids = (moved.doc.workflow.steps as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(['report', 'plan', 'lint', 'build', 'review', 'test']);
    expect(moved.doc.workflow.steps[3].parallel.map((b: { agent: string }) => b.agent)).toEqual(['frontend', 'backend', 'qa']);
    expect(moved.yaml).toContain('# tasks[] with an owner each');
    await expect(api('POST', `/api/teams/${team.id}/edit`, { ops: [{ op: 'move', path: ['workflow', 'steps'], from: 0, to: 99 }] })).rejects.toThrow(/out of range/);
  });

  it('lists and cleans up worktrees, and stores settings', async () => {
    const { api } = await setup();
    const on = { bell: true, push: true };
    const notifications = { question: on, limit: on, stopped: on, error: on, done: on };
    expect(await api('GET', '/api/settings')).toEqual({ autoCleanDays: null, notifications });
    expect(await api('PUT', '/api/settings', { autoCleanDays: 7 })).toEqual({ autoCleanDays: 7, notifications });
    await expect(api('PUT', '/api/settings', { autoCleanDays: -1 })).rejects.toThrow(/between/);
    // Notification choices change one kind and one channel at a time.
    expect((await api('PUT', '/api/settings', { notifications: { done: { push: false } } })).notifications).toEqual({ ...notifications, done: { bell: true, push: false } });
    expect((await api('GET', '/api/settings')).notifications.done).toEqual({ bell: true, push: false });
    await expect(api('PUT', '/api/settings', { notifications: { lunch: { push: false } } })).rejects.toThrow(/unknown notification kind/);
    await expect(api('PUT', '/api/settings', { notifications: { done: { push: 'yes' } } })).rejects.toThrow(/true or false/);

    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const team = await api('POST', '/api/teams', { name: 'duo', template: 'build-and-review' });
    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'g' });
    await until(() => api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`), (d) => d.summary.status !== 'running');
    const listed = await api('GET', `/api/projects/${project.id}/worktrees`);
    expect(listed).toEqual([expect.objectContaining({ runId, status: 'succeeded', live: false })]);
    const res = await api('POST', `/api/projects/${project.id}/cleanup`, { runIds: [runId] });
    expect(res.cleaned.map((c: { runId: string }) => c.runId)).toEqual([runId]);
    expect(await api('GET', `/api/projects/${project.id}/worktrees`)).toEqual([]);
    const detail = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
    expect(detail.summary.worktreesRemoved).toBe(true);

    // The finished run is under the bell, but not pushed: done notifications were switched off for push above.
    expect(await api('GET', '/api/notifications')).toEqual([expect.objectContaining({ kind: 'done', title: 'Job done', body: 'g', projectId: project.id, runId, bell: true, push: false })]);
    await api('PUT', '/api/settings', { notifications: { done: { bell: false } } });
    expect(await api('GET', '/api/notifications')).toEqual([]);
  });

  it('sets up projects: open (initialising git if asked), create empty, or clone', async () => {
    const { api } = await setup();
    const plain = tempDir('plain-');
    writeFiles(plain, { 'app.js': 'x', '.env': 'SECRET=1', 'node_modules/a/index.js': 'y' });
    await expect(api('POST', '/api/projects', { path: plain })).rejects.toMatchObject({ status: 409 });
    const opened = await api('POST', '/api/projects', { path: plain, init: true });
    const tracked = execFileSync('git', ['ls-files'], { cwd: opened.path, encoding: 'utf8' }).trim().split('\n');
    expect(tracked).toEqual(['.gitignore', 'app.js']); // no secrets, no dependencies

    const parent = tempDir('parent-');
    const created = await api('POST', '/api/projects/create', { parent, name: 'fresh-app' });
    expect(created).toMatchObject({ name: 'fresh-app', path: join(parent, 'fresh-app') });
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: created.path, encoding: 'utf8' }).trim()).toBe('Initial commit');

    const cloned = await api('POST', '/api/projects/clone', { url: `file://${tempRepo()}`, parent, name: 'copy' });
    expect(cloned.path).toBe(join(parent, 'copy'));
    expect((await api('GET', '/api/overview')).projects).toHaveLength(3);
    await expect(api('POST', '/api/projects/clone', { url: 'not a url', parent })).rejects.toThrow(/git URL/);
  });

  it('designs a team through chat: the architect saves only valid teams', async () => {
    const library = new Library(tempDir('covibe-home-'));
    let call = 0;
    const runner = new ScriptedRunner({
      architect: (inv) => {
        call += 1;
        if (call === 1) {
          expect(inv.tools).toEqual(['Read', 'Grep', 'Glob']);
          expect(inv.customTools!.map((t) => t.name)).toEqual(['get_team', 'read_team_file', 'save_team', 'list_skills', 'sandbox_defaults']);
          expect(inv.prompt).toContain('A team for a Python API');
          const yaml = 'version: 1\nname: api-team\nagents:\n  dev:\n    prompt: prompts/dev.md\n    tools: [Read, Edit, Bash]\nworkflow:\n  steps:\n    - { id: build, agent: dev }\n';
          return {
            call: [
              { tool: 'save_team', args: { yaml: yaml.replace('version: 1', 'version: 2'), summary: 'first try' } },
              { tool: 'save_team', args: { yaml, files: [{ path: 'prompts/dev.md', content: 'You build Python APIs.' }], summary: 'one developer' } },
            ],
            text: 'I set up a one-person team.',
          };
        }
        expect(inv.resumeSessionId).toBe('session-architect');
        return { call: [{ tool: 'get_team', args: {} }], text: 'Looked again.' };
      },
    });
    server = await startServer({ library, runner, token: 't' });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${server!.port}${path}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      return json;
    };
    const started = await api('POST', '/api/design', { name: 'api team', message: 'A team for a Python API' });
    expect(started.teamId).toBe('api-team');
    const first = await until(() => api('GET', `/api/design/${started.runId}`), (d) => !d.busy && d.thread.some((i: { kind: string }) => i.kind === 'agent'));
    expect(runner.toolResults.map((r) => r.result.split('\n')[0])).toEqual(['Not saved. team.yaml has problems:', 'Saved. The team is valid and ready to run.']);
    expect(first.saves.map((s: { valid: boolean }) => s.valid)).toEqual([false, true]);
    expect((await api('GET', '/api/teams/api-team')).problems).toEqual([]);
    expect((await api('GET', '/api/teams/api-team/design')).runId).toBe(started.runId);

    await api('POST', `/api/design/${started.runId}`, { message: 'check it' });
    const second = await until(() => api('GET', `/api/design/${started.runId}`), (d) => !d.busy && d.thread.filter((i: { kind: string }) => i.kind === 'agent').length === 2);
    expect(second.thread.filter((i: { kind: string }) => i.kind === 'human').map((i: { text: string }) => i.text)).toEqual(['A team for a Python API', 'check it']);
  });

  it('serves the brain: notes, your edits, and accepting proposals', async () => {
    const { api } = await setup();
    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const brain = await api('GET', `/api/projects/${project.id}/brain`);
    expect(brain.notes.map((n: { path: string }) => n.path)).toEqual(['README.md']);
    await api('PUT', `/api/projects/${project.id}/brain/note`, { path: 'deploy.md', content: '# Deploying\n\nUse make deploy.\n' });
    await expect(api('PUT', `/api/projects/${project.id}/brain/note`, { path: '../escape.md', content: 'x' })).rejects.toMatchObject({ status: 400 });
    const after = await api('GET', `/api/projects/${project.id}/brain`);
    expect(after.notes.map((n: { title: string }) => n.title)).toEqual(['Project brain', 'Deploying']);
    expect(after.log[0]).toMatchObject({ author: 'you', message: 'Edit deploy.md' });
  });

  it('manages library skills over the API', async () => {
    const { api } = await setup();
    await api('POST', '/api/skills', { name: 'house-style', description: 'Style guide. Use when writing code.', body: 'Tabs.' });
    await api('PUT', '/api/skills/house-style/everyone', { everyone: true });
    const list = await api('GET', '/api/skills');
    expect(list.library).toEqual([expect.objectContaining({ name: 'house-style', everyone: true, usedBy: [] })]);
    expect(list.builtin).toEqual([]);
    const detail = await api('GET', '/api/skills/house-style');
    expect(detail.skillMd).toContain('description: "Style guide. Use when writing code."');
    await api('POST', '/api/skills/house-style/describe', { description: 'Updated.' });
    expect((await api('GET', '/api/skills/house-style')).skill.description).toBe('Updated.');
    await expect(api('POST', '/api/skills/github/scan', { url: 'nonsense' })).rejects.toThrow(/GitHub URL/);
  });

  it('streams events over SSE', async () => {
    const { api, base } = await setup();
    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const team = await api('POST', '/api/teams', { name: 'duo', template: 'build-and-review' });
    await api('GET', '/api/overview'); // opens the project's store and sets the feed cursor

    const controller = new AbortController();
    const res = await fetch(`${base}/api/events?token=test-token`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'g' });
    let text = '';
    while (!text.includes('"run.finished"')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain('event: run-event');
    expect(text).toContain(`"projectId":"${project.id}"`);
  });
});
