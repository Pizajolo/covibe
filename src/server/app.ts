import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, DEFAULT_SANDBOX_NETWORK, DEFAULT_SANDBOX_WRITE } from '../config/load.js';
import { ask, chat } from '../engine/chat.js';
import { cleanupWorktrees, worktreeReport } from '../engine/cleanup.js';
import { startRun } from '../engine/engine.js';
import { GitError } from '../engine/workspace.js';
import { EventStore } from '../events/store.js';
import type { DeliveryMode, RunEvent, RunRecord } from '../events/types.js';
import { ClaudeSdkRunner } from '../runner/claude-sdk.js';
import type { AgentRunner } from '../runner/types.js';
import type { AppSettings, RunDetail, RunSummary, TeamDetail } from './api-types.js';
import { BadRequest, Library, NotFound, rawDoc, type EditOp, type Project } from './library.js';
import { chatThreads, computeStats, summarizeRun } from './projections.js';

const exec = promisify(execFile);
const UI_DIR = new URL('../../dist-ui/', import.meta.url).pathname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  port?: number;
  library?: Library;
  runner?: AgentRunner;
  /** Fixed token (tests); otherwise random per start. */
  token?: string;
  uiDir?: string;
}

export interface CovibeServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/**
 * The local server behind the desktop app: a JSON API over the library and the
 * per-project event stores, plus a Server-Sent Events feed of every event.
 * It listens on 127.0.0.1 only and every request needs the per-start token,
 * so other local web pages cannot drive agents.
 */
export async function startServer(opts: ServerOptions = {}): Promise<CovibeServer> {
  const library = opts.library ?? new Library();
  const runner = opts.runner ?? new ClaudeSdkRunner();
  const token = opts.token ?? randomBytes(24).toString('hex');
  const uiDir = opts.uiDir ?? UI_DIR;
  const stores = new Map<string, EventStore>();
  const active = new Map<string, AbortController>();
  const sse = new Set<ServerResponse>();
  /** `${runId}/${agent}` for members answering a chat after their run ended. */
  const answering = new Set<string>();
  const busyIn = (runId: string) => new Set([...answering].filter((k) => k.startsWith(`${runId}/`)).map((k) => k.slice(runId.length + 1)));
  const cursors = new Map<string, number>();

  const storeFor = (project: Project): EventStore => {
    let s = stores.get(project.id);
    if (!s) {
      const dir = join(project.path, '.covibe');
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
      s = new EventStore(join(dir, 'covibe.db'));
      s.reapDeadRuns();
      stores.set(project.id, s);
      cursors.set(project.id, s.lastEventId());
    }
    return s;
  };

  /** Team name → member names, so a run shows every member, even ones that have not started yet. */
  const rosters = () => new Map(library.teams().map((t) => [t.name, t.agents]));

  const summary = (project: Project, run: RunRecord, events?: RunEvent[], roster = rosters()): RunSummary => {
    const store = storeFor(project);
    return summarizeRun(run, events ?? store.events(run.id), project, store.isLive(run), run.kind === 'ask' ? [] : (roster.get(run.team) ?? []), busyIn(run.id));
  };

  const allRuns = (limit: number, projectId?: string): RunSummary[] => {
    const out: RunSummary[] = [];
    const roster = rosters();
    for (const p of library.projects()) {
      if (projectId && p.id !== projectId) continue;
      if (!existsSync(p.path)) continue;
      for (const r of storeFor(p).listRuns(limit)) out.push(summary(p, r, undefined, roster));
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  };

  const stats = () => {
    const roster = rosters();
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    return computeStats(
      library
        .projects()
        .filter((p) => existsSync(p.path))
        .map((p) => {
          const store = storeFor(p);
          const runs = store.listRuns(10_000);
          const live = runs.filter((r) => store.isLive(r));
          const activeAgents = live.reduce((n, r) => n + summary(p, r, undefined, roster).agents.filter((a) => a.status === 'working').length, 0);
          return {
            runs,
            events: store.eventsOfType(['agent.finished', 'agent.error', 'gate.passed', 'gate.failed', 'usage.limit'], since),
            live: (r: RunRecord) => store.isLive(r),
            activeAgents,
          };
        }),
    );
  };

  const findRun = (pid: string, rid: string) => {
    const project = library.project(pid);
    const store = storeFor(project);
    const run = store.getRun(rid);
    if (!run) throw new NotFound(`run ${rid} not found`);
    return { project, store, run };
  };

  const teamForRun = (run: RunRecord) => {
    const listing = library.teams().find((t) => library.teamFile(t.id) === run.teamFile);
    if (!listing) {
      // Run started from a team file outside the library (CLI); load it directly.
      return { load: () => library.loadFile(run.teamFile) };
    }
    return { load: () => library.load(listing.id) };
  };

  // ---- live feed: poll every store for new events and fan them out
  const poll = setInterval(() => {
    if (!sse.size) return;
    for (const p of library.projects()) {
      if (!existsSync(p.path)) continue;
      const store = storeFor(p);
      let cursor = cursors.get(p.id) ?? 0;
      const events = store.eventsAfter(cursor);
      for (const e of events) {
        const line = `event: run-event\ndata: ${JSON.stringify({ projectId: p.id, event: e })}\n\n`;
        for (const res of sse) res.write(line);
        cursor = e.id;
      }
      cursors.set(p.id, cursor);
    }
  }, 400);
  const keepAlive = setInterval(() => {
    for (const res of sse) res.write(': ping\n\n');
  }, 15_000);

  // Optional automatic cleanup of old worktrees (Settings → Disk space).
  const autoClean = async () => {
    const days = library.settings().autoCleanDays;
    if (days === null) return;
    for (const p of library.projects()) {
      if (!existsSync(p.path)) continue;
      await cleanupWorktrees(p.path, storeFor(p), { olderThanDays: days }).catch((err) => console.error(`auto-clean ${p.name}:`, err));
    }
  };
  const autoCleanFirst = setTimeout(() => void autoClean(), 10_000);
  const autoCleanTimer = setInterval(() => void autoClean(), 3_600_000);
  autoCleanFirst.unref();
  autoCleanTimer.unref();

  const routes: Route[] = [
    ['GET', '/api/overview', () => ({ projects: library.projects(), teams: library.teams(), runs: allRuns(30), stats: stats(), home: library.home })],
    ['GET', '/api/stats', () => stats()],
    ['GET', '/api/settings', () => library.settings()],
    ['PUT', '/api/settings', (_p, body) => library.updateSettings(body as Partial<AppSettings>)],
    ['GET', '/api/projects/:pid/worktrees', async (p) => {
      const project = library.project(p.pid!);
      return worktreeReport(project.path, storeFor(project));
    }],
    ['POST', '/api/projects/:pid/cleanup', async (p, body) => {
      const project = library.project(p.pid!);
      const b = body as { runIds?: unknown; olderThanDays?: unknown };
      const runIds = Array.isArray(b.runIds) ? b.runIds.filter((x): x is string => typeof x === 'string') : undefined;
      const olderThanDays = typeof b.olderThanDays === 'number' ? b.olderThanDays : undefined;
      return cleanupWorktrees(project.path, storeFor(project), { runIds, olderThanDays });
    }],
    ['GET', '/api/projects', () => library.projects()],
    ['POST', '/api/projects', (_p, body) => library.addProject(str(body, 'path'))],
    ['DELETE', '/api/projects/:pid', (p) => (library.removeProject(p.pid!), { ok: true })],

    ['GET', '/api/templates', () => library.templates()],
    ['GET', '/api/teams', () => library.teams()],
    ['POST', '/api/teams', (_p, body) => library.createTeam(str(body, 'name'), str(body, 'template'))],
    ['GET', '/api/teams/:tid', (p): TeamDetail => {
      const yaml = library.readFile(p.tid!, 'team.yaml');
      return {
        id: p.tid!,
        dir: library.teamDir(p.tid!),
        yaml,
        doc: rawDoc(yaml),
        problems: library.check(p.tid!).problems,
        files: library.files(p.tid!),
        sandboxDefaults: { network: DEFAULT_SANDBOX_NETWORK, allowWrite: DEFAULT_SANDBOX_WRITE },
      };
    }],
    ['DELETE', '/api/teams/:tid', (p) => (library.deleteTeam(p.tid!), { ok: true })],
    ['POST', '/api/teams/:tid/duplicate', (p, body) => library.duplicateTeam(p.tid!, str(body, 'name'))],
    ['POST', '/api/teams/:tid/validate', (p, body) => ({ problems: library.validateText(p.tid!, str(body, 'yaml', true)) })],
    ['POST', '/api/teams/:tid/edit', (p, body) => {
      const yaml = library.applyEdits(p.tid!, (body as { ops: EditOp[] }).ops ?? []);
      return { yaml, doc: rawDoc(yaml), problems: library.check(p.tid!).problems };
    }],
    ['GET', '/api/teams/:tid/file', (p, _b, q) => ({ path: q.get('path'), content: library.readFile(p.tid!, q.get('path') ?? '') })],
    ['PUT', '/api/teams/:tid/file', (p, body) => {
      library.writeFile(p.tid!, str(body, 'path'), str(body, 'content', true));
      return { problems: library.check(p.tid!).problems, files: library.files(p.tid!) };
    }],
    ['DELETE', '/api/teams/:tid/file', (p, _b, q) => (library.deleteFile(p.tid!, q.get('path') ?? ''), { files: library.files(p.tid!) })],

    ['GET', '/api/runs', (_p, _b, q) => allRuns(Number(q.get('limit') ?? 100), q.get('project') ?? undefined)],
    ['GET', '/api/runs/:pid/:rid', (p): RunDetail => {
      const { project, store, run } = findRun(p.pid!, p.rid!);
      const events = store.events(run.id);
      return {
        summary: summary(project, run, events),
        events,
        threads: chatThreads(events, [project.path]),
        roots: [project.path],
        chatMode: store.isLive(run) ? 'queue' : 'answer',
        canStop: active.has(`${project.id}/${run.id}`),
        answering: [...busyIn(run.id)],
      };
    }],
    ['POST', '/api/runs', async (_p, body) => {
      const project = library.project(str(body, 'project'));
      const team = library.load(str(body, 'team'));
      const base = typeof (body as { base?: unknown }).base === 'string' && (body as { base: string }).base ? (body as { base: string }).base : undefined;
      const controller = new AbortController();
      const { runId, done } = await startRun({ team, repo: project.path, goal: str(body, 'goal'), store: storeFor(project), runner, signal: controller.signal, base });
      const key = `${project.id}/${runId}`;
      active.set(key, controller);
      done.catch(() => undefined).finally(() => active.delete(key));
      return { runId, projectId: project.id };
    }],
    ['POST', '/api/runs/:pid/:rid/stop', (p) => {
      const c = active.get(`${p.pid}/${p.rid}`);
      if (!c) throw new BadRequest('this run is not running in the app (runs started from the terminal are stopped there)');
      c.abort();
      return { ok: true };
    }],
    ['POST', '/api/runs/:pid/:rid/chat', async (p, body) => {
      const { store, run } = findRun(p.pid!, p.rid!);
      const team = teamForRun(run).load();
      const agent = str(body, 'agent');
      const message = str(body, 'message');
      const requested = (body as { delivery?: unknown }).delivery;
      const delivery: DeliveryMode = requested === 'steer' || requested === 'interrupt' ? requested : 'queue';
      if (store.isLive(run)) return chat({ store, runner, team, runId: run.id, agent, message, delivery });
      if (!store.getSession(run.id, agent)) throw new BadRequest(`${agent} has not worked on this run yet, so there is no conversation to continue. Ask it a question instead.`);
      const key = `${run.id}/${agent}`;
      if (answering.has(key)) {
        // It is answering an earlier message: hand this one to it while it works.
        const mode: DeliveryMode = delivery === 'interrupt' ? 'interrupt' : 'steer';
        const m = store.enqueue(run.id, agent, 'human', message, mode);
        store.append(run.id, { type: 'message.queued', agent, step: 'chat', data: { id: m.id, to: agent, from: 'human', text: message, mode } });
        return { mode: 'queued', messageId: m.id, delivery: mode };
      }
      answering.add(key);
      // The answer streams in as events; don't hold the request open for it.
      void chat({ store, runner, team, runId: run.id, agent, message })
        .catch((err) => store.append(run.id, { type: 'agent.error', agent, step: 'chat', data: { ok: false, error: (err as Error).message } }))
        .finally(() => answering.delete(key));
      return { mode: 'answering' };
    }],
    ['POST', '/api/ask', async (_p, body) => {
      const project = library.project(str(body, 'project'));
      const team = library.load(str(body, 'team'));
      const { runId, done } = await ask({ store: storeFor(project), runner, team, repo: project.path, agent: str(body, 'agent'), question: str(body, 'question') });
      done.catch(() => undefined);
      return { runId, projectId: project.id };
    }],
    ['GET', '/api/runs/:pid/:rid/diff', async (p) => {
      const { project, run } = findRun(p.pid!, p.rid!);
      if (!run.branch) return { files: [], patch: '', note: 'This run worked directly in your checkout, so there is no separate branch to compare.' };
      const range = `${run.base ?? 'HEAD'}...${run.branch}`;
      try {
        const numstat = (await exec('git', ['diff', '--numstat', range], { cwd: project.path, maxBuffer: 32 << 20 })).stdout;
        const patch = (await exec('git', ['diff', range], { cwd: project.path, maxBuffer: 64 << 20 })).stdout;
        const files = numstat
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [add, del, ...path] = l.split('\t');
            return { path: path.join('\t'), additions: Number(add) || 0, deletions: Number(del) || 0 };
          });
        return { files, patch: patch.length > 400_000 ? patch.slice(0, 400_000) + '\n… (diff truncated)' : patch, range };
      } catch (err) {
        return { files: [], patch: '', note: `Could not diff ${range}: ${(err as Error).message.split('\n')[0]}` };
      }
    }],
  ];

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'forbidden host' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/')) return serveStatic(uiDir, url.pathname, res);

      const auth = req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
      if (!auth) return send(res, 401, { error: 'missing or wrong token' });

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        sse.add(res);
        req.on('close', () => sse.delete(res));
        return;
      }

      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const params = match(pattern, url.pathname);
        if (!params) continue;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
        return send(res, 200, await handler(params, body, url.searchParams));
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err instanceof NotFound ? 404 : err instanceof BadRequest || err instanceof ConfigError || err instanceof GitError ? 400 : 500;
      const message = err instanceof ConfigError ? `The team file has problems:\n${err.problems.map((p) => `• ${p}`).join('\n')}` : (err as Error).message;
      if (status === 500) console.error(err);
      send(res, status, { error: message });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: async () => {
      clearInterval(poll);
      clearInterval(keepAlive);
      clearTimeout(autoCleanFirst);
      clearInterval(autoCleanTimer);
      for (const c of active.values()) c.abort();
      for (const res of sse) res.end();
      await new Promise<void>((r) => server.close(() => r()));
      // Give aborted runs a moment to record their end.
      await new Promise((r) => setTimeout(r, 200));
      for (const s of stores.values()) s.close();
    },
  };
}

type Handler = (params: Record<string, string>, body: unknown, query: URLSearchParams) => unknown;
type Route = [string, string, Handler];

function match(pattern: string, path: string): Record<string, string> | undefined {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return undefined;
  }
  return params;
}

function str(body: unknown, key: string, allowEmpty = false): string {
  const v = (body as Record<string, unknown>)?.[key];
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new BadRequest(`"${key}" is required`);
  return v;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 << 20) throw new BadRequest('request too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body ?? null));
}

function serveStatic(root: string, pathname: string, res: ServerResponse) {
  const base = resolve(root);
  let file = normalize(join(base, decodeURIComponent(pathname)));
  if (!file.startsWith(base)) return send(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<p>The covibe UI is not built yet. Run <code>npm run build:ui</code>.</p>');
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(readFileSync(file));
}
