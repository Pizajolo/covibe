// Running a project's app: how covibe decides what to run, the sandbox and
// Docker runtimes, the view people see it through, the members' app tools in
// a team run, and the App panel's API.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigError, detectApp, rememberApp, rememberedApp, resolveApp } from '../src/apps/config.js';
import { appHub, answers } from '../src/apps/manager.js';
import { AppView } from '../src/apps/view.js';
import { appSandboxConfig, homeTools, sandboxedCommand } from '../src/apps/policy.js';
import { loadTeam } from '../src/config/load.js';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { RunApp, RunDetail } from '../src/server/api-types.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const sandboxReady = SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;
const dockerReady = (() => {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 });
    return !!process.env.COVIBE_TEST_DOCKER;
  } catch {
    return false;
  }
})();

/** A tiny web app: answers with a page that names its port. */
const SERVER_JS = `require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<!doctype html><html><head><title>Shop</title></head><body><h1>Shop on ' + process.env.PORT + '</h1></body></html>'); }).listen(process.env.PORT, process.env.HOST, () => console.log('listening on ' + process.env.PORT));\n`;

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  await appHub.shutdown();
});

describe('what covibe runs', () => {
  it('detects a dev server from package.json, with the port flags Vite and Next need', () => {
    const vite = tempDir();
    writeFiles(vite, { 'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }) });
    expect(detectApp(vite, 'sandbox')).toEqual({ setup: 'npm install', command: 'npm run dev -- --port $PORT --strictPort --host 127.0.0.1' });
    const next = tempDir();
    writeFiles(next, { 'package.json': JSON.stringify({ scripts: { dev: 'next dev' } }), 'pnpm-lock.yaml': '' });
    expect(detectApp(next, 'sandbox')).toEqual({ setup: 'pnpm install', command: 'pnpm run dev -p $PORT -H 127.0.0.1' });
    const express = tempDir();
    writeFiles(express, { 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) });
    expect(detectApp(express, 'sandbox')).toEqual({ setup: 'npm install', command: 'npm run start' });
    // In a container the server listens on every interface.
    expect(detectApp(vite, 'docker')).toMatchObject({ command: 'npm run dev -- --port $PORT --strictPort --host 0.0.0.0', port: 3000, image: 'node:22-bookworm-slim' });
    const site = tempDir();
    writeFiles(site, { 'index.html': '<h1>hi</h1>' });
    expect(detectApp(site, 'sandbox')).toEqual({ command: 'python3 -m http.server $PORT --bind 127.0.0.1' });
    expect(detectApp(tempDir(), 'sandbox')).toBeUndefined();
  });

  it('prefers a compose file, then a Dockerfile, in Docker', () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
      Dockerfile: 'FROM node:22\nEXPOSE 8080\nCMD node server.js\n',
      'compose.yaml': 'services:\n  db:\n    image: postgres\n  web:\n    build: .\n    ports: ["8080:8080"]\n',
    });
    expect(detectApp(dir, 'docker')).toEqual({ compose: 'compose.yaml', service: 'web', port: 8080 });
    const only = tempDir();
    writeFiles(only, { Dockerfile: 'FROM node:22\nEXPOSE 8080\n' });
    expect(detectApp(only, 'docker')).toEqual({ dockerfile: 'Dockerfile', port: 8080 });
  });

  it('takes what was given, then the team file, then what worked last time, then detection', () => {
    const repo = tempDir();
    writeFiles(repo, { 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) });
    expect(resolveApp(repo, {})).toMatchObject({ runtime: 'sandbox', command: 'npm run start', source: 'detected', path: '/', readyTimeoutS: 180 });
    rememberApp(repo, { command: 'node server.js', path: '/shop' });
    expect(rememberedApp(repo)).toEqual({ command: 'node server.js', path: '/shop' });
    expect(resolveApp(repo, { remembered: rememberedApp(repo) })).toMatchObject({ command: 'node server.js', path: '/shop', source: 'remembered' });
    const team = { command: 'npm run dev', env: { API: 'mock' }, readyTimeoutS: 30 };
    expect(resolveApp(repo, { team, remembered: rememberedApp(repo) })).toMatchObject({ command: 'npm run dev', source: 'team', env: { API: 'mock' } });
    // A given command wins, and keeps the team's environment and patience.
    expect(resolveApp(repo, { given: { command: 'node other.js' }, team })).toMatchObject({ command: 'node other.js', source: 'given', env: { API: 'mock' }, readyTimeoutS: 30 });
    // Members cannot switch the runtime; people can.
    expect(resolveApp(repo, { given: { runtime: 'docker', command: 'x' } }).runtime).toBe('sandbox');
    expect(resolveApp(repo, { given: { runtime: 'docker', command: 'x' }, allowRuntime: true })).toMatchObject({ runtime: 'docker', image: 'node:22-bookworm-slim' });
    expect(() => resolveApp(tempDir(), {})).toThrow(AppConfigError);
    // In Docker an image alone runs as it is; with a project to detect, the detected command runs in it.
    expect(resolveApp(tempDir(), { given: { runtime: 'docker', image: 'nginx:1.27', port: 80 }, allowRuntime: true })).toMatchObject({ image: 'nginx:1.27', port: 80 });
    expect(resolveApp(tempDir(), { given: { runtime: 'docker', image: 'nginx:1.27' }, allowRuntime: true }).command).toBeUndefined();
    expect(resolveApp(repo, { given: { runtime: 'docker', image: 'node:20' }, allowRuntime: true })).toMatchObject({ image: 'node:20', command: 'npm run start', source: 'detected' });
  });

  it('reads the app section of a team file and gives members the app tools by default', () => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': `version: 1
name: web
app:
  runtime: docker
  compose: compose.yaml
  service: web
  port: 8080
  ready_timeout_s: 60
agents:
  dev: { prompt: "do\\nit", tools: [Read, Bash] }
  qa: { prompt: "do\\nit", tools: [Read], browser: true }
  docs: { prompt: "do\\nit", tools: [Read] }
  ops: { prompt: "do\\nit", tools: [Read, Bash], app: false }
workflow:
  steps:
    - { id: a, agent: dev }
`,
      'bad.yaml': `version: 1
name: bad
app: { compose: compose.yaml }
agents:
  dev: { prompt: "do\\nit", tools: [Read] }
workflow:
  steps:
    - { id: a, agent: dev }
`,
    });
    const team = loadTeam(join(dir, 'team.yaml'));
    expect(team.app).toEqual({ runtime: 'docker', compose: 'compose.yaml', service: 'web', port: 8080, readyTimeoutS: 60 });
    expect(Object.fromEntries(Object.values(team.agents).map((a) => [a.name, a.app]))).toEqual({ dev: true, qa: true, docs: false, ops: false });
    expect(() => loadTeam(join(dir, 'bad.yaml'))).toThrow(/runtime: docker[\s\S]*service/);
  });

  it('keeps the sandbox to the folder, its temp and caches; on Linux it bridges the port through a socket', () => {
    const spec = { folder: '/p/app', command: 'npm start', port: 4100, env: {}, network: ['registry.npmjs.org'], allowWrite: ['/h/.npm'], tmp: '/s/tmp', socket: '/t/x/app.sock' };
    const cfg = appSandboxConfig(spec, '/h', false);
    expect(cfg.filesystem.allowWrite).toEqual(['/p/app', '/s/tmp', '/h/.npm', '/t/x']);
    expect(cfg.filesystem.denyRead).toEqual(['/h']);
    expect(cfg.filesystem.denyWrite).toEqual(['/p/app/.git', '/p/app/.claude', '/p/app/.mcp.json', '/p/app/.covibe']);
    expect(cfg.network).toMatchObject({ allowedDomains: ['registry.npmjs.org'], allowLocalBinding: true, allowAllUnixSockets: true });
    // On Linux only what exists is protected: a missing one would get a placeholder file in the folder while the app runs.
    const folder = tempDir();
    writeFiles(folder, { '.mcp.json': '{}', '.claude/settings.json': '{}' });
    expect(appSandboxConfig({ ...spec, folder }, '/h', true).filesystem.denyWrite).toEqual([join(folder, '.claude'), join(folder, '.mcp.json')]);
    // Tools on PATH in the home folder stay readable (and the folder around a bin folder); the rest of it does not.
    expect(homeTools('/h/.local/share/fnm/node-versions/v22/bin:/usr/bin:/h/bin:/h/tools/go/bin', '/h')).toEqual(['/h/.local/share/fnm/node-versions/v22/bin', '/h/.local/share/fnm/node-versions/v22', '/h/bin', '/h/tools/go/bin', '/h/tools/go']);
    expect(sandboxedCommand(spec)).toBe('socat UNIX-LISTEN:/t/x/app.sock,fork,reuseaddr TCP:127.0.0.1:4100 & cd /p/app && npm start');
    expect(sandboxedCommand({ ...spec, socket: undefined })).toBe('cd /p/app && npm start');
    // Its log file (its stdout and stderr) stays readable though it is in the home folder: on macOS Node aborts at startup otherwise.
    expect(appSandboxConfig({ ...spec, log: '/h/.covibe/apps/x/r1/app/app.log' }, '/h', false).filesystem.allowRead).toContain('/h/.covibe/apps/x/r1/app/app.log');
    expect(cfg.filesystem.allowWrite).not.toContain('/h/.covibe/apps/x/r1/app/app.log');
  });
});

describe.skipIf(!sandboxReady)('an app in the OS sandbox', () => {
  it('starts, answers on its port, writes its log, and stops', async () => {
    const folder = tempDir();
    writeFiles(folder, { 'server.js': SERVER_JS });
    const events: string[] = [];
    const spec = resolveApp(folder, { given: { command: 'node server.js', setup: 'echo installing' } });
    const state = await appHub.start({ repo: folder, runId: 'r1', folder, spec, by: 'test', network: [], allowWrite: [], onEvent: (e) => events.push(e.type) });
    expect(state).toMatchObject({ status: 'running', runtime: 'sandbox', by: 'test' });
    expect(await fetch(state.url).then((r) => r.text())).toContain(`Shop on ${state.port}`);
    expect(appHub.logs(folder, 'r1')).toMatch(/installing[\s\S]*listening on/);
    expect(events).toEqual(['app.starting', 'app.ready']);
    // What a person or member chose is remembered for the project.
    expect(rememberedApp(folder)).toMatchObject({ command: 'node server.js', setup: 'echo installing' });
    await appHub.stop(folder, 'r1', 'app', 'done');
    expect(appHub.get(folder, 'r1')).toMatchObject({ status: 'stopped', reason: 'done' });
    expect(events.at(-1)).toBe('app.stopped');
    expect(await answers(state.url, 500)).toBe(false);
  });

  it('reports an app that exits or never answers, with its log', async () => {
    const folder = tempDir();
    const crash = await appHub.start({ repo: folder, runId: 'r2', folder, spec: resolveApp(folder, { given: { command: 'echo boom >&2; exit 3' } }), by: 'test', network: [], allowWrite: [] });
    expect(crash.status).toBe('failed');
    expect(crash.reason).toMatch(/exited with code 3/);
    expect(appHub.logs(folder, 'r2')).toContain('boom');
    const silent = await appHub.start({ repo: folder, runId: 'r3', folder, spec: { ...resolveApp(folder, { given: { command: 'sleep 30' } }), readyTimeoutS: 2 }, by: 'test', network: [], allowWrite: [] });
    expect(silent).toMatchObject({ status: 'failed', reason: expect.stringMatching(/did not answer .* within 2 s/) });
  });

  it('cannot write outside its folder', async () => {
    const folder = tempDir();
    const outside = tempDir();
    writeFiles(folder, { 'server.js': SERVER_JS });
    const command = `echo x > ${join(outside, 'escaped.txt')}; echo y > inside.txt; node server.js`;
    const state = await appHub.start({ repo: folder, runId: 'r4', folder, spec: resolveApp(folder, { given: { command } }), by: 'test', network: [], allowWrite: [] });
    expect(state.status).toBe('running');
    expect(existsSync(join(folder, 'inside.txt'))).toBe(true);
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
    // Nothing of the sandbox's own shows up in the folder while it runs.
    expect(readdirSync(folder).sort()).toEqual(['.claude', '.covibe', 'inside.txt', 'server.js']);
  });
});

describe.skipIf(!dockerReady)('an app in Docker', () => {
  it('runs a command in an image with the project mounted', async () => {
    const folder = tempDir();
    writeFiles(folder, { 'server.js': SERVER_JS });
    const spec = resolveApp(folder, { given: { runtime: 'docker', command: 'node server.js', port: 3000 }, allowRuntime: true });
    const state = await appHub.start({ repo: folder, runId: 'd1', folder, spec, by: 'test', network: [], allowWrite: [] });
    expect(state).toMatchObject({ status: 'running', runtime: 'docker', containerPort: 3000 });
    expect(await fetch(state.url).then((r) => r.text())).toContain('Shop on 3000');
    await appHub.stop(folder, 'd1');
    expect(execFileSync('docker', ['ps', '-aq', '--filter', `name=${state.container}`]).toString().trim()).toBe('');
  }, 300_000);
});

describe('the view people see an app through', () => {
  it('adds the feedback bridge to pages, lets them be framed, and keeps redirects inside', async () => {
    const { createServer } = await import('node:http');
    const app = createServer((req, res) => {
      if (req.url === '/old') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/new` });
        return res.end();
      }
      if (req.url === '/data') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'" });
      res.end('<!doctype html><html><head><title>A</title></head><body>hi</body></html>');
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const port = (app.address() as { port: number }).port;
    const view = await AppView.start(port);
    try {
      const page = await fetch(`http://127.0.0.1:${view.port}/`);
      const html = await page.text();
      expect(html).toContain('data-covibe-pick');
      expect(html).toContain('<title>A</title>');
      expect(page.headers.get('x-frame-options')).toBeNull();
      expect(page.headers.get('content-security-policy')).toBeNull();
      expect(await fetch(`http://127.0.0.1:${view.port}/data`).then((r) => r.json())).toEqual({ ok: true });
      const redirect = await fetch(`http://127.0.0.1:${view.port}/old`, { redirect: 'manual' });
      expect(redirect.headers.get('location')).toBe('/new');
    } finally {
      await view.close();
      app.close();
    }
  });
});

describe.skipIf(!sandboxReady)('the app through a team run and the App panel', () => {
  it('a builder starts it, the reviewer finds it, and people see, stop and start it', async () => {
    const library = new Library(tempDir('covibe-home-'));
    const runner = new ScriptedRunner({
      builder: (inv) => {
        expect(inv.customTools?.map((t) => t.name)).toEqual(expect.arrayContaining(['app_start', 'app_status', 'app_logs', 'app_stop']));
        expect(inv.systemPrompt).toContain("You can run the project's app");
        return { write: { 'server.js': SERVER_JS, 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) }, call: [{ tool: 'app_start', args: { command: 'node server.js' } }], text: 'Built it and started it.' };
      },
      reviewer: (inv) => {
        // A reviewer without Bash cannot choose the command, but finds the builder's app.
        const start = inv.customTools!.find((t) => t.name === 'app_start')!;
        expect(Object.keys(start.params)).not.toContain('command');
        return { call: [{ tool: 'app_start', args: { command: 'rm -rf /' } }, { tool: 'app_start', args: {} }, { tool: 'app_logs', args: { find: 'listening' } }], structured: { blocking_count: 0, findings: [] } };
      },
    });
    server = await startServer({ library, runner, token: 't' });
    const base = `http://127.0.0.1:${server.port}`;
    const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
      return json as T;
    };
    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const team = await api('POST', '/api/teams', { name: 'web', template: 'build-and-review' });
    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Make a shop' });
    let detail: RunDetail;
    for (let i = 0; ; i++) {
      detail = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
      if (detail.summary.status !== 'running') break;
      if (i > 600) throw new Error('run did not finish');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(detail.summary.status).toBe('succeeded');
    const [built, refused, reused, logs] = runner.toolResults;
    expect(built!.result).toMatch(/^The app runs at http:\/\/127\.0\.0\.1:\d+\/: `node server\.js` in the OS sandbox/);
    expect(refused!.result).toMatch(/^Error: you cannot choose how the app starts/);
    expect(reused!.result).toMatch(/^The app already runs at http:\/\/127\.0\.0\.1:\d+\/.*started by builder/);
    expect(reused!.result).toContain('not your working folder');
    expect(logs!.result).toMatch(/listening on \d+/);
    expect(detail.events.filter((e) => e.type.startsWith('app.')).map((e) => [e.type, e.agent])).toEqual([
      ['app.starting', 'builder'],
      ['app.ready', 'builder'],
    ]);

    // The App panel sees it running after the run, and can show it through its view.
    const app = `/api/runs/${project.id}/${runId}/app`;
    let info = await api<RunApp>('GET', app);
    expect(info.app).toMatchObject({ status: 'running', by: 'builder', runtime: 'sandbox', settings: { command: 'node server.js' } });
    expect(info.log).toContain('listening on');
    const view = await api<{ port: number }>('POST', `${app}/view`);
    expect(await fetch(`http://127.0.0.1:${view.port}/`).then((r) => r.text())).toMatch(/data-covibe-pick[\s\S]*Shop on/);

    // People stop it, and start it again from the run's result.
    expect(await api('POST', `${app}/stop`)).toMatchObject({ status: 'stopped', reason: 'stopped by you' });
    info = await api<RunApp>('GET', app);
    expect(info.folder).toMatch(/_integration$/);
    expect(info.suggested).toMatchObject({ command: 'node server.js', source: 'remembered' });
    await api('POST', `${app}/start`, { settings: { command: 'node server.js' } });
    for (let i = 0; ; i++) {
      info = await api<RunApp>('GET', app);
      if (info.app?.status !== 'starting') break;
      if (i > 200) throw new Error('app did not start');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(info.app).toMatchObject({ status: 'running', by: 'you', folder: info.folder });
    expect(await fetch(info.app!.url).then((r) => r.text())).toContain('Shop on');
    await expect(api('POST', `${app}/start`, { settings: { port: 'abc' } })).rejects.toThrow(/port/);

    // Freeing disk space stops the app; looking at the App tab afterwards does not bring the worktree back.
    await api('POST', `/api/projects/${project.id}/cleanup`, { runIds: [runId] });
    info = await api<RunApp>('GET', app);
    expect(info.app).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/removed to free disk space/) });
    expect(existsSync(info.folder!)).toBe(false);
    expect(info.suggestError).toMatch(/starting the app puts it back/);
  });
});

describe('config files stay readable', () => {
  it('writes app.json into the project’s .covibe folder with its own .gitignore', () => {
    const repo = tempDir();
    rememberApp(repo, { command: 'x', runtime: 'docker', image: 'node:22' });
    expect(JSON.parse(readFileSync(join(repo, '.covibe', 'app.json'), 'utf8'))).toEqual({ runtime: 'docker', command: 'x', image: 'node:22' });
    expect(readFileSync(join(repo, '.covibe', '.gitignore'), 'utf8')).toBe('*\n');
  });
});
