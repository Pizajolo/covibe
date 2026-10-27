import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { RunDetail, Stats, TeamDetail } from '../src/server/api-types.js';
import { ScriptedRunner, tempDir, tempRepo } from './helpers.js';

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const review = (n: number) => ({ blocking_count: n === 0 ? 1 : 0, findings: n === 0 ? [{ severity: 'blocking', file: 'src/a.js', message: 'off by one' }] : [] });

async function setup() {
  const library = new Library(tempDir('covibe-home-'));
  const runner = new ScriptedRunner({
    builder: (_inv, n) => ({ write: { 'src/a.js': `export const a = ${n};` }, text: `Built round ${n}.` }),
    reviewer: (inv, n) => (inv.outputSchema ? { structured: review(n) } : { text: 'The repo has one module, src/a.js.' }),
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
