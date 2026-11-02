// When the app does not start: what covibe fixes by itself, what it
// recognises in the log (and where to fix it), and the app doctor, whose
// proposals the person applies or declines.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { missingScript, needsInstall, rememberApp, rememberedApp, resolveApp } from '../src/apps/config.js';
import { diagnoseApp, type FailedApp } from '../src/apps/diagnose.js';
import { appHub } from '../src/apps/manager.js';
import type { DoctorDetail, RunApp, RunDetail } from '../src/server/api-types.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import { Library } from '../src/server/library.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles, type Script } from './helpers.js';

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  await appHub.shutdown();
});

describe('what covibe fixes by itself', () => {
  it('skips what ran last time when it runs a file this folder does not have', () => {
    const dir = tempDir();
    writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'node_modules/.keep': '' });
    expect(missingScript(dir, 'node apps/web/scripts/preview.mjs')).toBe('apps/web/scripts/preview.mjs');
    expect(missingScript(dir, 'CUTROOM_HOME="$(mktemp -d)" npm run dev')).toBeUndefined();
    writeFiles(dir, { 'apps/web/scripts/preview.mjs': '' });
    expect(missingScript(dir, 'node --enable-source-maps apps/web/scripts/preview.mjs')).toBeUndefined();

    const fresh = tempDir();
    writeFiles(fresh, { 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'node_modules/.keep': '' });
    rememberApp(fresh, { command: 'node apps/web/scripts/preview.mjs' });
    const spec = resolveApp(fresh, { remembered: rememberedApp(fresh) });
    expect(spec).toMatchObject({ source: 'detected', command: 'npm run dev -- --port $PORT --strictPort --host 127.0.0.1' });
    expect(spec.notes).toEqual([expect.stringMatching(/skipped what ran last time .*apps\/web\/scripts\/preview\.mjs is not in/)]);
  });

  it('installs packages first in a folder without node_modules', () => {
    const dir = tempDir();
    writeFiles(dir, { 'package.json': JSON.stringify({ devDependencies: { 'electron-vite': '4.0.0' } }), 'pnpm-lock.yaml': '' });
    expect(needsInstall(dir, 'npm run dev')).toBe(true);
    expect(needsInstall(dir, 'python3 -m http.server $PORT')).toBe(false);
    const spec = resolveApp(dir, { given: { command: 'CUTROOM_NO_AUTO_DOWNLOAD=1 npm run dev' } });
    expect(spec).toMatchObject({ setup: 'pnpm install', command: 'CUTROOM_NO_AUTO_DOWNLOAD=1 npm run dev' });
    expect(spec.notes).toEqual([expect.stringMatching(/node_modules is missing .* `pnpm install` runs first/)]);
    mkdirSync(join(dir, 'node_modules'));
    expect(resolveApp(dir, { given: { command: 'npm run dev' } }).setup).toBeUndefined();
    // Nothing to install: nothing runs first.
    const plain = tempDir();
    writeFiles(plain, { 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) });
    expect(needsInstall(plain, 'node server.js')).toBe(false);
  });

  it("keeps the team's setup when a member chooses the command", () => {
    const dir = tempDir();
    const team = { setup: 'npm ci', command: 'npm run dev:web -- --port $PORT' };
    expect(resolveApp(dir, { given: { command: 'npm run dev' }, team })).toMatchObject({ setup: 'npm ci', command: 'npm run dev', source: 'given' });
    // A person's own settings are taken as they are.
    expect(resolveApp(dir, { given: { command: 'npm run dev' }, team, allowRuntime: true }).setup).toBeUndefined();
  });
});

describe('what covibe recognises when the app does not start', () => {
  const failed = (folder: string, more: Partial<FailedApp> = {}): FailedApp => ({ status: 'failed', reason: 'the app exited with code 127', folder, runtime: 'sandbox', port: 50313, command: 'npm run dev', source: 'remembered', ...more });

  it('a command from node_modules in a fresh worktree', () => {
    const dir = tempDir();
    writeFiles(dir, { 'package.json': '{}' });
    const [p] = diagnoseApp(failed(dir), '$ npm run dev\n> electron-vite dev\n\nsh: electron-vite: command not found\n');
    expect(p).toMatchObject({ kind: 'not_installed', fixes: [{ where: 'settings', text: expect.stringContaining('`npm install`') }, { where: 'team' }] });
  });

  it('a script that is only in a member’s worktree', () => {
    const dir = tempDir();
    const log = `Error: Cannot find module '${dir}/apps/web/scripts/authoring-preview.mjs'\n    at Function._resolveFilename\n{ code: 'MODULE_NOT_FOUND' }`;
    const [p] = diagnoseApp(failed(dir, { reason: 'the app exited with code 1', command: 'node apps/web/scripts/authoring-preview.mjs' }), log);
    expect(p).toMatchObject({ kind: 'missing_file', title: expect.stringContaining('apps/web/scripts/authoring-preview.mjs'), detail: expect.stringMatching(/member’s worktree/) });
    expect(p!.fixes.map((f) => f.where)).toEqual(['memory', 'settings', 'code']);
  });

  it('a desktop app, an app on the wrong port, a blocked domain', () => {
    const dir = tempDir();
    expect(diagnoseApp(failed(dir, { reason: 'the app did not answer at http://127.0.0.1:50313/ within 180 s.', command: 'electron-vite dev' }), '')[0]).toMatchObject({ kind: 'no_port', title: expect.stringMatching(/Electron/) });
    expect(diagnoseApp(failed(dir, { reason: 'the app did not answer at http://127.0.0.1:50313/ within 180 s.' }), '  ➜  Local:   http://localhost:5173/\n')[0]).toMatchObject({ kind: 'wrong_port', title: 'It listens on port 5173, not on $PORT (50313)' });
    expect(diagnoseApp(failed(dir, { reason: 'the app exited with code 1' }), 'Error: getaddrinfo ENOTFOUND fonts.googleapis.com\n')[0]).toMatchObject({ kind: 'blocked_domain', title: 'The sandbox blocked fonts.googleapis.com' });
    expect(diagnoseApp(failed(dir, { reason: 'the app exited with code 3' }), 'boom\n')[0]).toMatchObject({ kind: 'crashed', detail: 'boom' });
  });
});

async function setup(doctor: Script) {
  const library = new Library(tempDir('covibe-home-'));
  const runner = new ScriptedRunner({
    builder: () => ({ write: { 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) }, text: 'Built it.' }),
    reviewer: () => ({ structured: { blocking_count: 0, findings: [] } }),
    'app-doctor': doctor,
  });
  server = await startServer({ library, runner, token: 't' });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
    return json as T;
  };
  const repo = tempRepo();
  const project = await api('POST', '/api/projects', { path: repo });
  const team = await api('POST', '/api/teams', { name: 'web', template: 'build-and-review' });
  const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Make a shop' });
  await until(() => api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`), (d) => d.summary.status !== 'running');
  return { api, runner, repo, project, runId };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the App tab and the app doctor', () => {
  it('shows and forgets what ran last time', async () => {
    const { api, repo, project, runId } = await setup(() => ({ text: 'ok' }));
    rememberApp(repo, { command: 'node apps/web/scripts/preview.mjs' });
    const app = `/api/runs/${project.id}/${runId}/app`;
    let info = await api<RunApp>('GET', app);
    expect(info.places.memory).toEqual({ file: join(repo, '.covibe', 'app.json'), settings: { command: 'node apps/web/scripts/preview.mjs' } });
    expect(info.places.teamFile).toMatch(/team\.yaml$/);
    // The missing script is skipped: Start would use what covibe detects.
    expect(info.suggested).toMatchObject({ command: 'npm run start', source: 'detected' });
    expect(await api('DELETE', `${app}/memory`)).toEqual({ forgotten: true });
    info = await api<RunApp>('GET', app);
    expect(info.places.memory).toBeUndefined();
    expect(existsSync(join(repo, '.covibe', 'app.json'))).toBe(false);
  });

  it('looks into it by itself and changes something only once the person approves', async () => {
    const { api, runner, repo, project, runId } = await setup((inv, n) => {
      expect(inv.tools).toEqual(['Read', 'Grep', 'Glob']);
      return n === 0
        ? {
            call: [
              { tool: 'app_info', args: {} },
              { tool: 'propose_forget', args: { why: 'It runs a script that is not merged in.' } },
              { tool: 'propose_message', args: { to: 'builder', message: 'Add a dev:web script that listens on $PORT.' } },
              { tool: 'propose_message', args: { to: 'nobody', message: 'x' } },
            ],
            text: 'Forgot the old start.',
          }
        : { text: 'second' };
    });
    rememberApp(repo, { command: 'node gone.mjs' });
    const { runId: did } = await api('POST', `/api/runs/${project.id}/${runId}/app/doctor`, { message: 'The app does not start.' });

    let d = await until(() => api<DoctorDetail>('GET', `/api/app-doctor/${did}`), (x) => x.thread.some((i) => i.kind === 'proposal' && i.state === 'waiting'));
    const forget = d.thread.find((i) => i.kind === 'proposal')!;
    expect(forget).toMatchObject({ action: 'forget', why: 'It runs a script that is not merged in.', state: 'waiting' });
    expect(existsSync(join(repo, '.covibe', 'app.json'))).toBe(true);
    expect((await api<RunApp>('GET', `/api/runs/${project.id}/${runId}/app`)).doctor).toMatchObject({ runId: did, busy: true, waiting: 1 });
    await api('POST', `/api/app-doctor/${did}/decide`, { id: (forget as { proposal: string }).proposal, run: true });

    d = await until(() => api<DoctorDetail>('GET', `/api/app-doctor/${did}`), (x) => x.thread.some((i) => i.kind === 'proposal' && i.action === 'message' && i.state === 'waiting'));
    const message = d.thread.find((i) => i.kind === 'proposal' && i.action === 'message')!;
    expect(message).toMatchObject({ to: 'builder', message: 'Add a dev:web script that listens on $PORT.', title: 'Ask builder to change the code' });
    await api('POST', `/api/app-doctor/${did}/decide`, { id: (message as { proposal: string }).proposal, run: false });

    d = await until(() => api<DoctorDetail>('GET', `/api/app-doctor/${did}`), (x) => !x.busy);
    expect(existsSync(join(repo, '.covibe', 'app.json'))).toBe(false);
    expect(d.thread.filter((i) => i.kind === 'proposal').map((i) => (i as { state: string }).state)).toEqual(['applied', 'skipped']);
    const results = runner.toolResults.filter((r) => r.agent === 'app-doctor').map((r) => r.result);
    expect(results[0]).toMatch(/Remembered from last time .*node gone\.mjs/);
    expect(results[1]).toMatch(/^The person approved it\. Forgot /);
    expect(results[2]).toMatch(/declined/);
    expect(results[3]).toMatch(/"to" must be one of: builder, reviewer/);
    expect(runner.calls.find((c) => c.agentName === 'app-doctor')!.prompt).toContain('<app>');
    // The builder got no message.
    expect(runner.calls.filter((c) => c.agentName === 'builder')).toHaveLength(1);

    // The conversation continues in the same session.
    await api('POST', `/api/runs/${project.id}/${runId}/app/doctor`, { message: 'And now?', runId: did });
    await until(() => api<DoctorDetail>('GET', `/api/app-doctor/${did}`), (x) => !x.busy && x.thread.some((i) => i.kind === 'agent' && i.text === 'second'));
    expect(runner.calls.filter((c) => c.agentName === 'app-doctor')[1]!.resumeSessionId).toBe('session-app-doctor');
  });
});
