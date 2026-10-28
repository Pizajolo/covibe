import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, DEFAULT_SANDBOX_NETWORK, DEFAULT_SANDBOX_WRITE } from '../config/load.js';
import type { TeamConfig } from '../config/types.js';
import { acceptIntoNote, brainLog, BrainError, curate, deleteNote, ensureBrain, listNotes, readNote, writeNote } from '../engine/brain.js';
import { ask, chat } from '../engine/chat.js';
import { cleanupWorktrees, worktreeReport } from '../engine/cleanup.js';
import { buildInvocation, newRunId, startRun } from '../engine/engine.js';
import { answerQuestion } from '../engine/questions.js';
import { brainRoot } from '../home.js';
import {
  ANTHROPIC_SKILLS,
  createSkill,
  deleteSkill,
  getSkill,
  installGithub,
  listSkills,
  readSkillFile,
  scanGithub,
  setEveryone,
  SkillError,
  skillMd,
  updateSkill,
  writeSkillFile,
} from '../skills.js';
import { ConnectionError, Connections, listModels, startLogin, type NewConnection } from '../connections/store.js';
import { MAIN_ACCOUNT, type ProviderModel } from '../connections/types.js';
import { backendEnv, BackendError } from '../runner/backend.js';
import type { EnvironmentInfo, PlanUsage } from '../runner/types.js';
import { ARCHITECT, design } from './designer.js';
import { GitError } from '../engine/workspace.js';
import { EventStore } from '../events/store.js';
import type { DeliveryMode, RunEvent, RunRecord } from '../events/types.js';
import { ClaudeSdkRunner } from '../runner/claude-sdk.js';
import type { AgentRunner } from '../runner/types.js';
import type { AccountInfo, ConnectionsInfo, MemberInfo, RunDetail, RunSummary, Stats, TeamDetail, UsageReport } from './api-types.js';
import { BadRequest, Library, NeedsGit, NotFound, rawDoc, type EditOp, type Project } from './library.js';
import { gitCheckout, gitCommit, gitMerge, gitOverview, gitPull, gitPullRequest, gitPush, gitRevert, gitShow } from './gitops.js';
import { chatThreads, collectNotifications, computeStats, NOTIFY_EVENTS, summarizeRun, usageReport } from './projections.js';

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
  /** Claude accounts and providers (Settings → Advanced); defaults to the library's home. */
  connections?: Connections;
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
  const connections = opts.connections ?? new Connections(library.home);
  if (runner.usage && !connections.usageReader) connections.usageReader = (env) => runner.usage!(env);
  const token = opts.token ?? randomBytes(24).toString('hex');
  const uiDir = opts.uiDir ?? UI_DIR;
  const stores = new Map<string, EventStore>();
  const active = new Map<string, AbortController>();
  const sse = new Set<ServerResponse>();
  /** `${runId}/${agent}` for members answering a chat after their run ended. */
  const answering = new Set<string>();
  const busyIn = (runId: string) => new Set([...answering].filter((k) => k.startsWith(`${runId}/`)).map((k) => k.slice(runId.length + 1)));
  const cursors = new Map<string, number>();

  // Conversations that belong to the library rather than a project (team design).
  const libraryStore = new EventStore(join(library.home, 'library.db'));
  libraryStore.reapDeadRuns();
  cursors.set('_library', libraryStore.lastEventId());

  let environment: { at: number; info: Promise<EnvironmentInfo> } | undefined;
  const discover = (): Promise<EnvironmentInfo> => {
    if (!environment || Date.now() - environment.at > 600_000) {
      const info = runner.discover ? runner.discover(backendEnv({ type: 'subscription' }).env) : Promise.resolve({ skills: [] });
      environment = { at: Date.now(), info: info.catch(() => ({ skills: [] })) };
    }
    return environment.info;
  };
  // Plan usage from Claude Code, read at most once a minute per account (each read starts a Claude Code process).
  const planUsage = (fresh = false): Promise<PlanUsage | undefined> => connections.usage(MAIN_ACCOUNT, fresh);
  /** Your login's limits, plus every other Claude account's. */
  const usageAll = async (fresh = false): Promise<UsageReport> => {
    const fromRuns = stats().usage;
    const main = usageReport(await planUsage(fresh), fromRuns);
    const accounts = await Promise.all(
      connections.accounts().map(async (a) => {
        const [plan, info] = await Promise.all([connections.usage(a.id, fresh), accountInfo(a.id)]);
        return { id: a.id, label: a.label, ...(info.email ? { email: info.email } : {}), usage: usageReport(plan, fromRuns, new Date(), a.id) };
      }),
    );
    return accounts.length ? { ...main, accounts, balance: connections.balance } : main;
  };
  // Who each extra account is signed in as: `claude auth status`, then the account details Claude Code reports.
  const infoCache = new Map<string, { at: number; value: Promise<AccountInfo> }>();
  const accountInfo = (id: string, fresh = false): Promise<AccountInfo> => {
    const cached = infoCache.get(id);
    if (!fresh && cached && Date.now() - cached.at < 600_000) return cached.value;
    const env = connections.accountEnv(id);
    const value = (async (): Promise<AccountInfo> => {
      const status = await exec('claude', ['auth', 'status', '--json'], { env, timeout: 20_000 })
        .then((r) => JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string; orgName?: string })
        .catch(() => undefined);
      if (!status?.loggedIn) return { loggedIn: false };
      const account = runner.discover ? (await runner.discover(env).catch(() => undefined))?.account : undefined;
      const email = account?.email ?? status.email;
      const subscriptionType = account?.subscriptionType ?? status.subscriptionType;
      const organization = account?.organization ?? status.orgName;
      return { loggedIn: true, ...(email ? { email } : {}), ...(subscriptionType ? { subscriptionType } : {}), ...(organization ? { organization } : {}) };
    })();
    infoCache.set(id, { at: Date.now(), value });
    return value;
  };
  const connectionsInfo = async (): Promise<ConnectionsInfo> => {
    const env = await discover();
    const views = await Promise.all(connections.views().map(async (c) => (c.kind === 'claude' ? { ...c, account: await accountInfo(c.id) } : c)));
    const main: AccountInfo = { loggedIn: !!env.account, ...env.account };
    return { connections: views, main, balance: connections.balance, secretStore: connections.secrets.kind };
  };
  /** What the team architect may use besides the user's own login. */
  const connectionsNote = (): string => {
    const lines = ['# Accounts and providers', '- Your own Claude login: { type: subscription }'];
    for (const c of connections.list()) {
      if (c.kind === 'claude') lines.push(`- Claude account "${c.label}": { type: subscription, account: ${c.id} }`);
      else lines.push(`- ${c.label} (${c.kind === 'anthropic' ? 'Anthropic-compatible' : 'OpenAI-compatible'}): { type: connection, connection: ${c.id}, model: <one of ${(c.models ?? []).map((m) => m.id).join(', ') || 'no models yet'}> }`);
    }
    if (connections.balance) lines.push('Sharing across Claude accounts is on: members with { type: subscription } and no account use whichever account has room.');
    if (lines.length === 2) lines.push('Nothing else is set up; more accounts and providers can be added in Settings → Advanced.');
    return lines.join('\n');
  };
  /** A connection's id or a run's "via" as people read it. */
  const viaLabel = (via: string): string => {
    if (via === 'claude') return 'Claude (your login)';
    if (via.startsWith('claude:')) return `Claude (${connections.get(via.slice(7))?.label ?? via.slice(7)})`;
    const c = connections.get(via);
    if (c) return c.label;
    return ({ api_key: 'Anthropic API key', gateway: 'Gateway', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', subscription: 'Claude (your login)' } as Record<string, string>)[via] ?? via;
  };
  /** Skill name → the team members that have it (directly or from team defaults). */
  const skillUsage = () => {
    const used = new Map<string, { team: string; agent: string }[]>();
    for (const t of library.teams()) {
      const doc = rawDoc(library.readFile(t.id, 'team.yaml')) as { defaults?: { skills?: string[] }; agents?: Record<string, { skills?: string[] }> };
      for (const [agent, a] of Object.entries(doc.agents ?? {})) {
        for (const s of new Set([...(doc.defaults?.skills ?? []), ...(a?.skills ?? [])])) (used.get(s) ?? used.set(s, []).get(s)!).push({ team: t.name, agent });
      }
    }
    return used;
  };
  let catalog: { at: number; data: Promise<Awaited<ReturnType<typeof scanGithub>>> } | undefined;

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

  const stats = (): Stats => {
    const roster = rosters();
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const computed = computeStats(
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
            events: store.eventsOfType(['agent.usage', 'agent.finished', 'agent.error', 'agent.limited', 'gate.passed', 'gate.failed', 'usage.limit'], since),
            live: (r: RunRecord) => store.isLive(r),
            activeAgents,
          };
        }),
    );
    for (const v of computed.byVia) v.label = viaLabel(v.via);
    return computed;
  };

  /** The bell's list, from the last week of every project. */
  const notifications = () => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return collectNotifications(
      library
        .projects()
        .filter((p) => existsSync(p.path))
        .map((p) => {
          const store = storeFor(p);
          return { projectId: p.id, events: store.eventsOfType(NOTIFY_EVENTS, since), run: (id: string) => store.getRun(id), live: (r: RunRecord) => store.isLive(r) };
        }),
      library.settings().notifications,
    );
  };

  /** Start a goal in the background and keep its stop handle. */
  const launch = async (project: Project, team: TeamConfig, goal: string, base?: string) => {
    const controller = new AbortController();
    const onLimit = library.settings().onLimit ?? 'wait';
    const { runId, done } = await startRun({ team, repo: project.path, goal, store: storeFor(project), runner, signal: controller.signal, base, onLimit, connections });
    const key = `${project.id}/${runId}`;
    active.set(key, controller);
    done.catch(() => undefined).finally(() => active.delete(key));
    return { runId, projectId: project.id };
  };

  /**
   * Run a stopped run's goal again with the same team, starting from its
   * result branch so the work it committed is kept.
   */
  const restartRun = async (project: Project, run: RunRecord) => {
    const team = teamForRun(run).load();
    const keep = run.branch && (await exec('git', ['rev-parse', '--verify', '--quiet', `${run.branch}^{commit}`], { cwd: project.path }).then(() => true, () => false));
    const started = await launch(project, team, run.goal, keep ? run.branch : run.base);
    storeFor(project).append(run.id, { type: 'run.restarted', data: { run_id: started.runId } });
    return started;
  };

  /** When the limit that stopped a run resets: from the run, else from the plan's 5-hour window. */
  const resetFor = async (project: Project, run: RunRecord): Promise<string | undefined> => {
    const own = summary(project, run).limit?.resetsAt;
    if (own && Date.parse(own) > Date.now()) return new Date(Date.parse(own) + 60_000).toISOString();
    const usage = await usageAll();
    const blocked = usage.windows.filter((w) => w.resetsAt && (w.status === 'rejected' || (w.utilization ?? 0) >= 1)).map((w) => w.resetsAt!);
    const next = (blocked.length ? blocked : usage.windows.filter((w) => w.window === 'five_hour').map((w) => w.resetsAt).filter((r): r is string => !!r)).sort().at(-1);
    return next && Date.parse(next) > Date.now() ? new Date(Date.parse(next) + 60_000).toISOString() : undefined;
  };

  // Restarts scheduled for when a limit resets. They are events in the run's store, so they survive a restart of the app.
  const restartDue = async () => {
    for (const p of library.projects()) {
      if (!existsSync(p.path)) continue;
      const store = storeFor(p);
      const latest = new Map<string, RunEvent>();
      for (const e of store.eventsOfType(['run.restart_scheduled', 'run.restart_cancelled', 'run.restarted'])) latest.set(e.runId, e);
      for (const e of latest.values()) {
        if (e.type !== 'run.restart_scheduled' || Date.parse(String(e.data.at)) > Date.now()) continue;
        const run = store.getRun(e.runId);
        if (!run || store.isLive(run)) continue;
        try {
          await restartRun(p, run);
        } catch (err) {
          store.append(run.id, { type: 'run.restart_cancelled', data: { error: (err as Error).message } });
        }
      }
    }
  };
  const restartTimer = setInterval(() => void restartDue().catch((err) => console.error(err)), 30_000);
  restartTimer.unref();

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

  const membersOf = (run: RunRecord): MemberInfo[] => {
    let team: TeamConfig;
    try {
      team = teamForRun(run).load();
    } catch {
      return [];
    }
    return Object.values(team.agents).map((a) => ({
      name: a.name,
      description: a.description,
      model: a.model,
      effort: a.effort,
      thinking: a.thinking,
      tools: a.tools,
      writeScope: a.writeScope,
      writes: a.writes,
      canMessage: a.canMessage,
      lead: team.lead === a.name,
      curator: team.brain.curator === a.name,
    }));
  };

  // ---- live feed: poll every store for new events and fan them out
  const poll = setInterval(() => {
    if (!sse.size) return;
    let libCursor = cursors.get('_library') ?? 0;
    for (const e of libraryStore.eventsAfter(libCursor)) {
      const line = `event: run-event\ndata: ${JSON.stringify({ projectId: '_library', event: e })}\n\n`;
      for (const res of sse) res.write(line);
      libCursor = e.id;
    }
    cursors.set('_library', libCursor);
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
    ['GET', '/api/overview', () => ({ projects: library.projects(), teams: library.teams(), runs: allRuns(30), stats: stats(), home: library.home, defaultParent: library.defaultParent() })],
    ['GET', '/api/environment', () => discover()],
    ['GET', '/api/usage', (_p, _b, q) => usageAll(q.get('fresh') === '1')],

    // ---- connections (Settings → Advanced)
    ['GET', '/api/connections', () => connectionsInfo()],
    ['PUT', '/api/connections', async (_p, body) => {
      const balance = (body as { balance?: unknown }).balance;
      if (typeof balance !== 'boolean') throw new BadRequest('"balance" is true or false');
      connections.setBalance(balance);
      return connectionsInfo();
    }],
    ['POST', '/api/connections', async (_p, body) => {
      const c = connections.add(body as NewConnection);
      return connections.views().find((v) => v.id === c.id);
    }],
    ['PUT', '/api/connections/:id', (p, body) => {
      const b = body as { label?: string; baseUrl?: string; models?: ProviderModel[]; apiKey?: string | null };
      connections.update(p.id!, { label: b.label, baseUrl: b.baseUrl, models: b.models, apiKey: b.apiKey });
      return connections.views().find((v) => v.id === p.id);
    }],
    ['DELETE', '/api/connections/:id', async (p) => {
      await connections.remove(p.id!);
      infoCache.delete(p.id!);
      return { ok: true };
    }],
    ['POST', '/api/connections/:id/login', async (p) => {
      const c = connections.get(p.id!);
      if (!c) throw new NotFound(`no connection "${p.id}"`);
      infoCache.delete(c.id);
      return startLogin(c);
    }],
    ['GET', '/api/connections/:id/account', (p, _b, q) => {
      if (connections.get(p.id!)?.kind !== 'claude') throw new NotFound(`no Claude account "${p.id}"`);
      return accountInfo(p.id!, q.get('fresh') === '1');
    }],
    // The models a provider offers: for a saved connection (its stored key), or for one being set up.
    ['POST', '/api/connections/models', async (_p, body) => {
      const b = body as { id?: string; kind?: string; baseUrl?: string; apiKey?: string };
      const saved = b.id ? connections.get(b.id) : undefined;
      const kind = (saved?.kind ?? b.kind) as string;
      if (kind !== 'anthropic' && kind !== 'openai') throw new BadRequest('"kind" is anthropic or openai');
      return { models: await listModels(kind, b.baseUrl ?? saved?.baseUrl ?? '', b.apiKey || (saved ? connections.key(saved.id) : undefined)) };
    }],

    // ---- skills
    ['GET', '/api/skills', async () => {
      const used = skillUsage();
      const env = await discover();
      return {
        library: listSkills().map((s) => ({ ...s, usedBy: used.get(s.name) ?? [] })),
        builtin: env.skills.map((s) => ({ ...s, usedBy: used.get(s.name) ?? [] })),
      };
    }],
    ['GET', '/api/skills/catalog', async () => {
      if (!catalog || Date.now() - catalog.at > 3_600_000) {
        catalog = { at: Date.now(), data: scanGithub(ANTHROPIC_SKILLS) };
        catalog.data.catch(() => (catalog = undefined));
      }
      const installed = new Set(listSkills().map((s) => s.name));
      const data = await catalog.data;
      return { source: ANTHROPIC_SKILLS, commit: data.commit, skills: data.skills.map((s) => ({ ...s, installed: installed.has(s.name) })) };
    }],
    ['POST', '/api/skills/github/scan', async (_p, body) => {
      const r = await scanGithub(str(body, 'url'));
      return { repo: `${r.ref.owner}/${r.ref.repo}`, commit: r.commit, skills: r.skills };
    }],
    ['POST', '/api/skills/github/install', async (_p, body) => {
      const paths = (body as { paths?: unknown }).paths;
      if (!Array.isArray(paths) || !paths.every((x) => typeof x === 'string')) throw new BadRequest('"paths" must list the skill folders to install');
      return installGithub(str(body, 'url'), paths as string[]);
    }],
    ['POST', '/api/skills', (_p, body) => createSkill({ name: str(body, 'name'), description: str(body, 'description'), body: str(body, 'body', true) })],
    ['GET', '/api/skills/:name', (p) => {
      const detail = getSkill(p.name!);
      return { ...detail, skill: { ...detail.skill, usedBy: skillUsage().get(p.name!) ?? [] }, skillMd: readSkillFile(p.name!, 'SKILL.md') };
    }],
    ['GET', '/api/skills/:name/file', (p, _b, q) => ({ content: readSkillFile(p.name!, q.get('path') ?? '') })],
    ['PUT', '/api/skills/:name/file', (p, body) => (writeSkillFile(p.name!, str(body, 'path'), str(body, 'content', true)), getSkill(p.name!))],
    ['PUT', '/api/skills/:name/everyone', (p, body) => setEveryone(p.name!, !!(body as { everyone?: unknown }).everyone)],
    ['POST', '/api/skills/:name/update', (p) => updateSkill(p.name!)],
    ['DELETE', '/api/skills/:name', (p) => (deleteSkill(p.name!), { ok: true })],
    ['POST', '/api/skills/:name/describe', (p, body) => {
      // Rewrite the frontmatter from the form, keeping the body.
      const current = readSkillFile(p.name!, 'SKILL.md');
      const bodyText = current.replace(/^---[\s\S]*?---\r?\n?/, '');
      writeSkillFile(p.name!, 'SKILL.md', skillMd(p.name!, str(body, 'description'), typeof (body as { body?: unknown }).body === 'string' ? String((body as { body: string }).body) : bodyText));
      return getSkill(p.name!);
    }],

    // ---- project brain
    ['GET', '/api/projects/:pid/brain', async (p) => {
      const project = library.project(p.pid!);
      await ensureBrain(project.path);
      const store = storeFor(project);
      const curators = library.teams().flatMap((t) => {
        const doc = rawDoc(library.readFile(t.id, 'team.yaml')) as { brain?: { curator?: string } };
        return doc.brain?.curator ? [{ teamId: t.id, team: t.name, curator: doc.brain.curator }] : [];
      });
      return { dir: brainRoot(project.path), notes: listNotes(project.path), proposals: store.proposals(), log: await brainLog(project.path), curators };
    }],
    ['GET', '/api/projects/:pid/brain/note', (p, _b, q) => ({ path: q.get('path'), content: readNote(library.project(p.pid!).path, q.get('path') ?? '') })],
    ['PUT', '/api/projects/:pid/brain/note', async (p, body) => {
      const project = library.project(p.pid!);
      const commit = await writeNote(project.path, str(body, 'path'), str(body, 'content', true));
      return { commit, notes: listNotes(project.path) };
    }],
    ['DELETE', '/api/projects/:pid/brain/note', async (p, _b, q) => {
      const project = library.project(p.pid!);
      await deleteNote(project.path, q.get('path') ?? '');
      return { notes: listNotes(project.path) };
    }],
    ['POST', '/api/projects/:pid/brain/proposals/:id', async (p, body) => {
      const project = library.project(p.pid!);
      const store = storeFor(project);
      const proposal = store.getProposal(Number(p.id));
      if (!proposal) throw new NotFound(`proposal #${p.id} not found`);
      const decision = (body as { decision?: unknown }).decision;
      if (decision !== 'accept' && decision !== 'reject') throw new BadRequest('"decision" must be accept or reject');
      const requested = (body as { notePath?: unknown }).notePath;
      const notePath = decision === 'accept' ? await acceptIntoNote(project.path, proposal, typeof requested === 'string' && requested ? requested : undefined) : undefined;
      const decided = store.decideProposal(proposal.id, { status: decision === 'accept' ? 'accepted' : 'rejected', by: 'you', note: typeof (body as { note?: unknown }).note === 'string' ? String((body as { note: string }).note) : undefined, notePath });
      if (proposal.runId && store.getRun(proposal.runId)) store.append(proposal.runId, { type: 'brain.decided', agent: 'you', data: { id: decided.id, status: decided.status, note_path: notePath ?? null } });
      return decided;
    }],
    ['POST', '/api/projects/:pid/brain/curate', async (p, body) => {
      const project = library.project(p.pid!);
      const team = library.load(str(body, 'team'));
      if (!team.brain.curator) throw new BadRequest(`team ${team.name} has no curator (set brain.curator in Team settings)`);
      const store = storeFor(project);
      if (!store.proposals('pending').length) throw new BadRequest('there are no pending proposals');
      const run = store.createRun({ id: newRunId(), kind: 'curate', team: team.name, teamFile: team.file, repo: project.path, goal: 'Review proposals for the project brain' });
      store.append(run.id, { type: 'run.started', data: { team: team.name, goal: run.goal, kind: 'curate', steps: ['curate'] } });
      void curate({ team, store, runner, repo: project.path, runId: run.id, buildInvocation, connections })
        .catch((err) => store.append(run.id, { type: 'agent.error', step: 'curate', agent: team.brain.curator, data: { ok: false, error: (err as Error).message } }))
        .finally(() => {
          store.finishRun(run.id, 'succeeded');
          store.append(run.id, { type: 'run.finished', data: { status: 'succeeded', loops: 0, cost_usd: null } });
        });
      return { runId: run.id, projectId: project.id };
    }],

    // ---- team design chat
    ['POST', '/api/design', async (_p, body) => {
      const b = body as { team?: unknown; name?: unknown; template?: unknown; project?: unknown };
      let teamId = typeof b.team === 'string' && b.team ? b.team : undefined;
      if (!teamId) teamId = library.createTeam(typeof b.name === 'string' && b.name.trim() ? b.name : 'new-team', typeof b.template === 'string' ? b.template : 'starter').id;
      else library.teamDir(teamId);
      const project = typeof b.project === 'string' && b.project ? library.project(b.project) : undefined;
      const settings = library.settings();
      const { runId, done } = await design({ library, store: libraryStore, runner, teamId, projectPath: project?.path, message: str(body, 'message'), model: settings.designerModel, effort: settings.designerEffort, builtinSkills: async () => (await discover()).skills, connections: connectionsNote });
      answering.add(`${runId}/${ARCHITECT}`);
      void done.finally(() => answering.delete(`${runId}/${ARCHITECT}`));
      return { runId, teamId };
    }],
    ['POST', '/api/design/:rid', async (p, body) => {
      const run = libraryStore.getRun(p.rid!);
      if (!run) throw new NotFound('conversation not found');
      if (answering.has(`${run.id}/${ARCHITECT}`)) throw new BadRequest('the architect is still answering');
      const settings = library.settings();
      const { done } = await design({ library, store: libraryStore, runner, teamId: run.team, runId: run.id, message: str(body, 'message'), model: settings.designerModel, effort: settings.designerEffort, builtinSkills: async () => (await discover()).skills, connections: connectionsNote });
      answering.add(`${run.id}/${ARCHITECT}`);
      void done.finally(() => answering.delete(`${run.id}/${ARCHITECT}`));
      return { runId: run.id, teamId: run.team };
    }],
    ['GET', '/api/design/:rid', (p) => {
      const run = libraryStore.getRun(p.rid!);
      if (!run) throw new NotFound('conversation not found');
      const events = libraryStore.events(run.id);
      return {
        runId: run.id,
        teamId: run.team,
        busy: answering.has(`${run.id}/${ARCHITECT}`),
        thread: chatThreads(events, run.repo ? [run.repo] : [])[ARCHITECT] ?? [],
        saves: events.filter((e) => e.type === 'team.saved').map((e) => ({ ts: e.ts, ...e.data })),
        costUsd: events.filter((e) => e.type === 'agent.finished' || e.type === 'agent.error').reduce((n, e) => n + Number(e.data.cost_usd ?? 0), 0),
      };
    }],
    ['GET', '/api/teams/:tid/design', (p) => {
      const latest = libraryStore.listRuns(200).find((r) => r.kind === 'design' && r.team === p.tid);
      return { runId: latest?.id ?? null };
    }],
    ['GET', '/api/stats', () => stats()],
    ['GET', '/api/settings', () => library.settings()],
    ['PUT', '/api/settings', (_p, body) => library.updateSettings(body as Parameters<Library['updateSettings']>[0])],
    ['GET', '/api/notifications', () => notifications()],
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
    // ---- git in the project's own checkout
    ['GET', '/api/projects/:pid/git', (p) => gitOverview(library.project(p.pid!).path)],
    ['GET', '/api/projects/:pid/git/commits/:sha', (p) => gitShow(library.project(p.pid!).path, p.sha!)],
    ['POST', '/api/projects/:pid/git/commit', async (p, body) => {
      const paths = (body as { paths?: unknown }).paths;
      return { sha: await gitCommit(library.project(p.pid!).path, str(body, 'message'), Array.isArray(paths) ? paths.map(String) : undefined) };
    }],
    ['POST', '/api/projects/:pid/git/checkout', async (p, body) => {
      const b = body as { create?: unknown; from?: unknown };
      await gitCheckout(library.project(p.pid!).path, str(body, 'branch'), b.create === true, typeof b.from === 'string' && b.from ? b.from : undefined);
      return { ok: true };
    }],
    ['POST', '/api/projects/:pid/git/push', (p, body) => {
      const branch = (body as { branch?: unknown }).branch;
      return gitPush(library.project(p.pid!).path, typeof branch === 'string' && branch ? branch : undefined);
    }],
    ['POST', '/api/projects/:pid/git/pull', async (p) => (await gitPull(library.project(p.pid!).path), { ok: true })],
    ['POST', '/api/projects/:pid/git/merge', async (p, body) => ({ sha: await gitMerge(library.project(p.pid!).path, str(body, 'branch')) })],
    ['POST', '/api/projects/:pid/git/revert', async (p, body) => ({ sha: await gitRevert(library.project(p.pid!).path, str(body, 'sha')) })],
    ['POST', '/api/projects/:pid/git/pr', (p, body) => {
      const b = body as { body?: unknown };
      return gitPullRequest(library.project(p.pid!).path, { branch: str(body, 'branch'), base: str(body, 'base'), title: str(body, 'title'), body: typeof b.body === 'string' ? b.body : undefined });
    }],
    ['GET', '/api/projects', () => library.projects()],
    ['POST', '/api/projects', (_p, body) => library.addProject(str(body, 'path'), { init: !!(body as { init?: unknown }).init })],
    ['POST', '/api/projects/create', (_p, body) => library.createProject(str(body, 'parent'), str(body, 'name'))],
    ['POST', '/api/projects/clone', (_p, body) => library.cloneProject(str(body, 'url'), str(body, 'parent'), typeof (body as { name?: unknown }).name === 'string' ? String((body as { name: string }).name) : undefined)],
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
        members: membersOf(run),
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
      return launch(project, team, str(body, 'goal'), base);
    }],
    ['POST', '/api/runs/:pid/:rid/restart', async (p, body) => {
      const { project, store, run } = findRun(p.pid!, p.rid!);
      if (run.kind !== 'workflow') throw new BadRequest('only workflow runs can be restarted');
      const when = (body as { when?: unknown }).when;
      if (when === 'cancel') {
        store.append(run.id, { type: 'run.restart_cancelled', data: {} });
        return { ok: true };
      }
      if (store.isLive(run)) throw new BadRequest('this run is still going');
      if (when === 'reset') {
        const at = await resetFor(project, run);
        if (!at) throw new BadRequest('the reset time is not known; restart it now instead');
        store.append(run.id, { type: 'run.restart_scheduled', data: { at } });
        return { at };
      }
      return restartRun(project, run);
    }],
    ['POST', '/api/runs/:pid/:rid/stop', (p) => {
      const c = active.get(`${p.pid}/${p.rid}`);
      if (!c) throw new BadRequest('this run is not running in the app (runs started from the terminal are stopped there)');
      c.abort();
      return { ok: true };
    }],
    ['GET', '/api/runs/:pid/:rid/views/:vid', (p) => {
      const { store, run } = findRun(p.pid!, p.rid!);
      const view = store.getView(run.id, Number(p.vid));
      if (!view) throw new NotFound(`image ${p.vid} is not kept any more`);
      return new Raw(view.data, view.mediaType);
    }],
    ['POST', '/api/runs/:pid/:rid/questions/:qid/answer', (p, body) => {
      const { store, run } = findRun(p.pid!, p.rid!);
      if (!store.isLive(run)) throw new BadRequest('this run has ended, so nobody is waiting for the answer');
      try {
        return answerQuestion(store, run.id, Number(p.qid), str(body, 'answer'));
      } catch (err) {
        throw new BadRequest((err as Error).message);
      }
    }],
    ['POST', '/api/runs/:pid/:rid/chat', async (p, body) => {
      const { store, run } = findRun(p.pid!, p.rid!);
      const team = teamForRun(run).load();
      const agent = str(body, 'agent');
      const message = str(body, 'message');
      const requested = (body as { delivery?: unknown }).delivery;
      const delivery: DeliveryMode = requested === 'steer' || requested === 'interrupt' ? requested : 'queue';
      if (store.isLive(run)) return chat({ store, runner, team, runId: run.id, agent, message, delivery, connections });
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
      void chat({ store, runner, team, runId: run.id, agent, message, connections })
        .catch((err) => store.append(run.id, { type: 'agent.error', agent, step: 'chat', data: { ok: false, error: (err as Error).message } }))
        .finally(() => answering.delete(key));
      return { mode: 'answering' };
    }],
    ['POST', '/api/ask', async (_p, body) => {
      const project = library.project(str(body, 'project'));
      const team = library.load(str(body, 'team'));
      const { runId, done } = await ask({ store: storeFor(project), runner, team, repo: project.path, agent: str(body, 'agent'), question: str(body, 'question'), connections });
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
        const out = await handler(params, body, url.searchParams);
        if (out instanceof Raw) {
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
          return res.end(out.data);
        }
        return send(res, 200, out);
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      const status =
        err instanceof NeedsGit
          ? 409
          : err instanceof NotFound
            ? 404
            : err instanceof BadRequest || err instanceof ConfigError || err instanceof GitError || err instanceof SkillError || err instanceof BrainError || err instanceof ConnectionError || err instanceof BackendError
              ? 400
              : 500;
      const message = err instanceof ConfigError ? `The team file has problems:\n${err.problems.map((p) => `• ${p}`).join('\n')}` : (err as Error).message;
      if (status === 500) console.error(err);
      send(res, status, { error: message, ...(err instanceof NeedsGit ? { code: 'needs_git' } : {}) });
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
      clearInterval(restartTimer);
      clearInterval(autoCleanTimer);
      for (const c of active.values()) c.abort();
      for (const res of sse) res.end();
      await new Promise<void>((r) => server.close(() => r()));
      // Give aborted runs a moment to record their end.
      await new Promise((r) => setTimeout(r, 200));
      for (const s of stores.values()) s.close();
      libraryStore.close();
      await connections.close();
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

/** A route's answer sent as is (an image), not as JSON. */
class Raw {
  constructor(
    readonly data: Buffer,
    readonly type: string,
  ) {}
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
