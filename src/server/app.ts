import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, DEFAULT_SANDBOX_NETWORK, DEFAULT_SANDBOX_WRITE } from '../config/load.js';
import type { TeamConfig } from '../config/types.js';
import { acceptIntoNote, brainLoad, brainLog, BrainError, brainSize, curate, deleteNote, ensureBrain, listNotes, readNote, summarizeBrain, SUMMARIZER, writeNote } from '../engine/brain.js';
import { ask, chat, type ChatOutcome } from '../engine/chat.js';
import { cleanupWorktrees, worktreeReport } from '../engine/cleanup.js';
import { checkGoal, goalFilesKey, goalPrompt } from '../engine/backlog.js';
import { buildInvocation, continueRun, newRunId, startRun, type RunOutcome } from '../engine/engine.js';
import { folderDiff, isFolderRun, undoFolderRun } from '../engine/folder.js';
import { answerQuestion } from '../engine/questions.js';
import { GithubError } from '../github.js';
import { brainRoot } from '../home.js';
import * as plugins from '../plugins.js';
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
import { CodexAuthError } from '../connections/codex-auth.js';
import { ConnectionError, Connections, listModels, openInBrowser, startLogin, type NewConnection } from '../connections/store.js';
import { forgetClient, McpAuthError, setClient, signInStatus, signOut, startSignIn } from '../connections/mcp-auth.js';
import { stopMcpProxy } from '../connections/mcp-proxy.js';
import { MAIN_ACCOUNT, type ProviderModel } from '../connections/types.js';
import { Voice, VoiceError, type VoiceSettings } from '../voice.js';
import { backendEnv, BackendError } from '../runner/backend.js';
import type { EnvironmentInfo, PlanUsage } from '../runner/types.js';
import { ARCHITECT, design } from './designer.js';
import { Approvals, GIT_HELPER, gitHelp, helperThread } from './git-helper.js';
import { APP_DOCTOR, appDoctor, doctorKey, doctorThread, type DoctorActions } from './app-doctor.js';
import { diagnoseApp } from '../apps/diagnose.js';
import { GitError } from '../engine/workspace.js';
import { EventStore } from '../events/store.js';
import type { DeliveryMode, Goal, RunEvent, RunRecord } from '../events/types.js';
import { ClaudeSdkRunner } from '../runner/claude-sdk.js';
import type { AgentRunner } from '../runner/types.js';
import type { AccountInfo, AppSettings, AppViewInfo, BacklogSettings, BacklogState, BacklogView, ConnectionsInfo, GoalView, DiffResult, DoctorDetail, FeedbackList, MemberInfo, OpenedFile, PreviewSite, RunApp, RunAppSettings, RunDetail, RunFile, RunFiles, RunSummary, Stats, TeamDetail, UndoResult, UsageReport } from './api-types.js';
import { BadRequest, Library, NeedsGit, NotFound, rawDoc, type EditOp, type Project } from './library.js';
import * as gitops from './gitops.js';
import { GitProblem, gitOverview, gitShow } from './gitops.js';
import { replayBoard } from '../engine/tasks.js';
import { chatThreads, collectNotifications, computeStats, NOTIFY_EVENTS, stepReports, summarizeRun, usageReport } from './projections.js';
import { diskSource, FEEDBACK_BRIDGE, gitSource, isText, relPath, SITE_MIME, SiteServer, type SiteSource } from './site.js';
import { browserHub, type LiveTab } from '../browser/hub.js';
import { AppConfigError, forgetApp, rememberedApp, rememberedFile, resolveApp, type AppConfig, type AppSpec } from '../apps/config.js';
import { appHub, AppError, tail, type AppState } from '../apps/manager.js';
import { AppView } from '../apps/view.js';
import { expandHome } from '../sandbox-policy.js';
import { Workspace } from '../engine/workspace.js';
import { cleanItem, cleanItems, feedbackGoal, readFeedback, writeFeedback } from './feedback.js';
import { AttachmentError, attachmentsDir, saveUpload, takeUploads, type Attachment } from '../engine/attachments.js';
import { withFiles } from '../engine/chat.js';
import { covibeHome } from '../home.js';
import type { BrowserProvider } from '../browser/types.js';

const exec = promisify(execFile);
/** Files listed in the Preview tab, at most. */
const MAX_LISTED = 5000;
/** Text shown in the code view, at most. */
const MAX_TEXT = 1 << 20;
/** Files of a run covibe opens in their own app (documents, media, images): never programs or scripts. */
const OPENABLE = /\.(docx?|dotx?|xlsx?|xlsm|csv|pptx?|potx?|odt|ods|odp|rtf|key|pages|numbers|vsdx?|pdf|png|jpe?g|gif|webp|avif|bmp|tiff?|heic|psd|ai|sketch|fig|mp4|mov|m4v|webm|mp3|wav|m4a|ogg|aiff?)$/i;
/** A run's preview site closes after this long without a request. */
const PREVIEW_IDLE_MS = 30 * 60_000;
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
  /** Voice input (tests give one whose engines are fakes). */
  voice?: Voice;
  /** Fixed token (tests); otherwise random per start. */
  token?: string;
  uiDir?: string;
  /** The browser members' browser tools use (the Mac app passes its built-in Chromium); default a headless one via Playwright. */
  browser?: BrowserProvider;
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
  library.providerFor ??= (model) => connections.providerFor(model);
  const voice = opts.voice ?? new Voice(library.home, connections.secrets, connections);
  if (runner.usage && !connections.usageReader) connections.usageReader = (env) => runner.usage!(env);
  const token = opts.token ?? randomBytes(24).toString('hex');
  const uiDir = opts.uiDir ?? UI_DIR;
  if (opts.browser) browserHub.use(opts.browser);
  const stores = new Map<string, EventStore>();
  const active = new Map<string, AbortController>();
  const sse = new Set<ServerResponse>();
  /** Live browser streams (see streamBrowser). */
  const streams = new Set<ServerResponse>();
  /** `${runId}/${agent}` for members answering a chat after their run ended. */
  const answering = new Set<string>();
  /** Projects whose brain is being summarized right now. */
  const summarizing = new Set<string>();
  const busyIn = (runId: string) => new Set([...answering].filter((k) => k.startsWith(`${runId}/`)).map((k) => k.slice(runId.length + 1)));
  const cursors = new Map<string, number>();
  /** The git helper's proposals waiting for the person, and how to stop a conversation's turn. */
  const approvals = new Approvals();
  const helperStops = new Map<string, AbortController>();

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
  /** Your login's limits, plus every other Claude account's and every ChatGPT account's. */
  const usageAll = async (fresh = false): Promise<UsageReport> => {
    const fromRuns = stats().usage;
    const main = usageReport(await planUsage(fresh), fromRuns);
    const claude = await Promise.all(
      connections.accounts().map(async (a) => {
        const [plan, info] = await Promise.all([connections.usage(a.id, fresh), accountInfo(a.id)]);
        return { id: a.id, label: a.label, kind: 'claude' as const, ...(info.email ? { email: info.email } : {}), usage: usageReport(plan, fromRuns, new Date(), a.id) };
      }),
    );
    const codex = await Promise.all(
      connections
        .list()
        .filter((c) => c.kind === 'codex')
        .map(async (c) => {
          const info = connections.codexInfo(c.id);
          const plan = info.loggedIn ? await connections.usage(c.id, fresh) : undefined;
          return { id: c.id, label: c.label, kind: 'codex' as const, ...(info.email ? { email: info.email } : {}), usage: usageReport(plan, [], new Date(), c.id, 'codex') };
        }),
    );
    const accounts = [...claude, ...codex];
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
    const views = await Promise.all(
      connections.views().map(async (c) => (c.kind === 'claude' ? { ...c, account: await accountInfo(c.id) } : c.kind === 'codex' ? { ...c, account: connections.codexInfo(c.id) } : c)),
    );
    const main: AccountInfo = { loggedIn: !!env.account, ...env.account };
    return { connections: views, main, balance: connections.balance, secretStore: connections.secrets.kind };
  };
  /** What the team architect may use besides the user's own login. */
  const connectionsNote = (): string => {
    const lines = ['# Accounts and providers', '- Your own Claude login: { type: subscription }'];
    for (const c of connections.list()) {
      const models = (c.models ?? []).map((m) => m.id).join(', ') || 'no models yet';
      if (c.kind === 'claude') lines.push(`- Claude account "${c.label}": { type: subscription, account: ${c.id} }`);
      else if (c.kind === 'codex') lines.push(`- ChatGPT account "${c.label}" (OpenAI models on the ChatGPT plan, with Claude Code's tools): { type: connection, connection: ${c.id}, model: <one of ${models}> }`);
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
  /** Skill (or plugin) name → the team members that have it (directly or from team defaults). */
  const usage = (field: 'skills' | 'plugins' = 'skills') => {
    const used = new Map<string, { team: string; agent: string }[]>();
    for (const t of library.teams()) {
      type Named = Partial<Record<typeof field, string[]>>;
      const doc = rawDoc(library.readFile(t.id, 'team.yaml')) as { defaults?: Named; agents?: Record<string, Named> };
      for (const [agent, a] of Object.entries(doc.agents ?? {})) {
        for (const s of new Set([...(doc.defaults?.[field] ?? []), ...(a?.[field] ?? [])])) (used.get(s) ?? used.set(s, []).get(s)!).push({ team: t.name, agent });
      }
    }
    return used;
  };
  const skillUsage = () => usage('skills');
  let catalog: { at: number; data: Promise<Awaited<ReturnType<typeof scanGithub>>> } | undefined;
  let pluginCatalog: { at: number; data: Promise<Awaited<ReturnType<typeof plugins.scanGithub>>> } | undefined;
  const withUsage = (p: plugins.LibraryPlugin, used = usage('plugins')) => ({ ...p, usedBy: used.get(p.name) ?? [] });

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

  /**
   * Summaries of runs that are over. Every refresh of the app lists the recent
   * runs, and a finished run's summary only changes when its log does, so its
   * whole log is not read and replayed again each time.
   */
  const summaries = new Map<string, { key: string; value: RunSummary }>();
  const summary = (project: Project, run: RunRecord, events?: RunEvent[], roster = rosters()): RunSummary => {
    const store = storeFor(project);
    const live = store.isLive(run);
    const busy = busyIn(run.id);
    const members = run.kind === 'ask' || run.kind === 'check' ? [] : (roster.get(run.team) ?? []);
    if (events || live || busy.size) return summarizeRun(run, events ?? store.events(run.id), project, live, members, busy);
    const id = `${project.id}/${run.id}`;
    const key = [store.lastEventIdOf(run.id), run.status, run.finishedAt ?? '', project.name, ...members].join('\x1f');
    const kept = summaries.get(id);
    if (kept?.key === key) return kept.value;
    const value = summarizeRun(run, store.events(run.id), project, live, members, busy);
    if (summaries.size >= 500) summaries.clear();
    summaries.set(id, { key, value });
    return value;
  };

  const allRuns = (limit: number, projectId?: string): RunSummary[] => {
    const out: RunSummary[] = [];
    const roster = rosters();
    for (const p of library.projects()) {
      if (projectId && p.id !== projectId) continue;
      if (!existsSync(p.path)) continue;
      // Backlog checks show with their goal, not as runs of their own.
      for (const r of storeFor(p).listRuns(limit)) if (r.kind !== 'check') out.push(summary(p, r, undefined, roster));
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

  /** The files given with a run's goal (or question). */
  const attachmentsOf = (store: EventStore, runId: string): Attachment[] =>
    ((store.events(runId).find((e) => e.type === 'run.started')?.data.attachments as Attachment[] | undefined) ?? []);

  /** Start a goal in the background and keep its stop handle. */
  const launch = async (project: Project, team: TeamConfig, goal: string, base?: string, files: { uploads?: string[]; files?: string[] } = {}, after?: (outcome: RunOutcome | undefined) => void) => {
    const controller = new AbortController();
    const onLimit = library.settings().onLimit ?? 'wait';
    const { runId, done } = await startRun({ team, repo: project.path, goal, store: storeFor(project), runner, signal: controller.signal, base, onLimit, connections, ...files });
    const key = `${project.id}/${runId}`;
    active.set(key, controller);
    done
      .then((outcome) => after?.(outcome), () => after?.(undefined))
      .finally(() => {
        active.delete(key);
        // The team is free again: the backlog's next goal may start.
        kickBacklog(project);
      });
    return { runId, projectId: project.id };
  };

  /**
   * Carry on a stopped run in place, from the step it stopped in: its members
   * resume their conversations and finished steps keep their reports.
   */
  const continueStopped = async (project: Project, run: RunRecord) => {
    const busy = [...answering].find((k) => k.startsWith(`${run.id}/`));
    if (busy) throw new BadRequest(`${busy.slice(run.id.length + 1)} is still answering your message; continue the run once it has replied.`);
    const team = teamForRun(run).load();
    const controller = new AbortController();
    const onLimit = library.settings().onLimit ?? 'wait';
    let started: { runId: string; done: Promise<RunOutcome> };
    try {
      started = await continueRun({ team, repo: project.path, runId: run.id, store: storeFor(project), runner, signal: controller.signal, onLimit, connections });
    } catch (err) {
      throw new BadRequest((err as Error).message);
    }
    // A restart waiting for a limit to reset is not wanted any more.
    const store = storeFor(project);
    if (store.eventsOfType(['run.restart_scheduled', 'run.restart_cancelled', 'run.restarted']).filter((e) => e.runId === run.id).at(-1)?.type === 'run.restart_scheduled') {
      store.append(run.id, { type: 'run.restart_cancelled', data: { continued: true } });
    }
    const key = `${project.id}/${run.id}`;
    active.set(key, controller);
    started.done
      .catch(() => undefined)
      .finally(() => {
        active.delete(key);
        kickBacklog(project);
      });
    return { runId: run.id, projectId: project.id };
  };

  /**
   * Run a stopped run's goal again with the same team, starting from its
   * result branch so the work it committed is kept.
   */
  const restartRun = async (project: Project, run: RunRecord) => {
    const team = teamForRun(run).load();
    const keep = run.branch && (await exec('git', ['rev-parse', '--verify', '--quiet', `${run.branch}^{commit}`], { cwd: project.path }).then(() => true, () => false));
    // The files given with the goal go with it again.
    const files = attachmentsOf(storeFor(project), run.id).map((a) => a.path).filter((p) => existsSync(p));
    const started = await launch(project, team, run.goal, keep ? run.branch : run.base, { files });
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

  // ---- backlogs: goals lined up per project, checked first, then worked off one at a time (see engine/backlog.ts)

  /** Checks in progress (`${project}/${goal}`), so an edit can stop an outdated one and a restart picks up unfinished ones. */
  const checks = new Map<string, AbortController>();
  /** Projects whose next goal waits for plan usage to come down. */
  const usageWaits = new Map<string, Extract<BacklogState, { kind: 'waiting' }>>();

  /** Tell the app a backlog changed (on the live feed only), and see whether its next goal can start. */
  const backlogChanged = (project: Project) => {
    const line = `event: run-event\ndata: ${JSON.stringify({ projectId: project.id, event: { id: 0, runId: '', ts: new Date().toISOString(), type: 'backlog.changed', data: {} } })}\n\n`;
    for (const res of sse) res.write(line);
    kickBacklog(project);
  };

  const findGoal = (pid: string, gid: string) => {
    const project = library.project(pid);
    const store = storeFor(project);
    const goal = store.getGoal(Number(gid));
    if (!goal) throw new NotFound(`goal ${gid} not found`);
    return { project, store, goal };
  };

  /** The run working on a goal right now, if any. */
  const liveRunOf = (store: EventStore, goal: Goal): RunRecord | undefined => {
    if (goal.state !== 'started') return undefined;
    const run = goal.runs.length ? store.getRun(goal.runs.at(-1)!) : undefined;
    return run && store.isLive(run) ? run : undefined;
  };

  /** Look a goal over, or let it straight through when checks are off. Replaces a check of an earlier version of the goal. */
  const checkGoalNow = (project: Project, goal: Goal) => {
    const store = storeFor(project);
    const key = `${project.id}/${goal.id}`;
    checks.get(key)?.abort();
    checks.delete(key);
    const mode = library.backlog(project.id).check;
    if (mode === 'off') {
      store.updateGoal(goal.id, { state: 'ready', check: { verdict: 'skipped', at: new Date().toISOString() } });
      return backlogChanged(project);
    }
    let team: TeamConfig;
    try {
      team = library.load(goal.team);
    } catch (err) {
      store.updateGoal(goal.id, { state: 'ready', check: { verdict: 'failed', error: (err as Error).message, at: new Date().toISOString() } });
      return backlogChanged(project);
    }
    const controller = new AbortController();
    checks.set(key, controller);
    store.updateGoal(goal.id, { state: 'checking' });
    backlogChanged(project);
    void checkGoal({ store, runner, team, repo: project.path, goal, mode, connections, signal: controller.signal })
      .then((check) => {
        // Edited, removed or sent on meanwhile: this check is about an older goal.
        const now = store.getGoal(goal.id);
        if (checks.get(key) !== controller || !now || now.state !== 'checking') return;
        store.updateGoal(goal.id, { state: check.verdict === 'needs_info' ? 'needs_info' : 'ready', check });
      })
      .catch((err) => console.error(err))
      .finally(() => {
        if (checks.get(key) === controller) checks.delete(key);
        backlogChanged(project);
      });
  };

  /**
   * Whether plan usage holds the backlog back: every Claude account the team's
   * members could use is at or above the threshold. Undefined = go ahead (also
   * when usage is not known, or the team is not on a subscription).
   */
  const usageGate = async (team: TeamConfig): Promise<Extract<BacklogState, { kind: 'waiting' }> | undefined> => {
    const max = library.settings().backlogMaxUsage;
    if (max === null) return undefined;
    const members = Object.values(team.agents).filter((a) => a.backend.type === 'subscription');
    if (!members.length) return undefined;
    const report = await usageAll();
    const claude = (report.accounts ?? []).filter((a) => a.kind === 'claude');
    const usageOf = new Map<string, { usage: Omit<UsageReport, 'accounts' | 'balance'>; label?: string }>([[MAIN_ACCOUNT, { usage: report }], ...claude.map((a) => [a.id, { usage: a.usage, label: a.label }] as const)]);
    const ids = new Set<string>();
    for (const m of members) {
      if (m.backend.account) ids.add(m.backend.account);
      else {
        ids.add(MAIN_ACCOUNT);
        if (report.balance) for (const a of claude) ids.add(a.id);
      }
    }
    let soonest: Extract<BacklogState, { kind: 'waiting' }> | undefined;
    for (const id of ids) {
      const known = usageOf.get(id);
      if (!known) return undefined;
      const over = known.usage.windows.filter((w) => w.window !== 'overage' && (w.status === 'rejected' || (w.utilization ?? 0) * 100 >= max));
      // This account has room.
      if (!over.length) return undefined;
      // It frees up when the last of its full windows resets.
      const last = over.reduce((a, b) => ((b.resetsAt ?? '') > (a.resetsAt ?? '') ? b : a));
      const wait = { kind: 'waiting' as const, ...(last.resetsAt ? { until: last.resetsAt } : {}), window: last.window, label: last.label, used: Math.round((last.utilization ?? 1) * 100), ...(known.label ? { account: known.label } : {}) };
      if (!soonest || (wait.until && (!soonest.until || wait.until < soonest.until))) soonest = wait;
    }
    return soonest;
  };

  /** Where a goal starts from: the last backlog result that succeeded and is not in your branch yet, else your branch. */
  const chainBase = async (project: Project, store: EventStore): Promise<string | undefined> => {
    if (project.kind === 'folder' || !library.backlog(project.id).chain) return undefined;
    const done = store
      .goals()
      .flatMap((g) => g.runs.map((id) => store.getRun(id)))
      .filter((r): r is RunRecord => !!r && r.status === 'succeeded' && !!r.branch)
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
    if (!done?.branch) return undefined;
    const exists = await exec('git', ['rev-parse', '--verify', '--quiet', `${done.branch}^{commit}`], { cwd: project.path }).then(() => true, () => false);
    if (!exists) return undefined;
    const merged = await exec('git', ['merge-base', '--is-ancestor', done.branch, 'HEAD'], { cwd: project.path }).then(() => true, () => false);
    return merged ? undefined : done.branch;
  };

  /** Start a run on a goal, for the backlog or because you asked (which works while it is paused or waiting too). */
  const startGoal = async (project: Project, goal: Goal) => {
    const store = storeFor(project);
    if (liveRunOf(store, goal)) throw new BadRequest('this goal is being worked on already');
    let team: TeamConfig;
    try {
      team = library.load(goal.team);
    } catch (err) {
      store.updateGoal(goal.id, { state: 'needs_info', check: { ...(goal.check ?? { verdict: 'failed' as const }), error: `It could not start: ${(err as Error).message}`, at: new Date().toISOString() } });
      backlogChanged(project);
      throw err;
    }
    const files = goal.attachments.map((a) => a.path).filter((p) => existsSync(p));
    const started = await launch(project, team, goalPrompt(goal), await chainBase(project, store), { files }, (outcome) => {
      // Stopping a goal's run pauses the backlog, so the next goal does not start right away.
      if (outcome?.reason === 'aborted') library.setBacklog(project.id, { auto: false });
      backlogChanged(project);
    });
    store.updateGoal(goal.id, { state: 'started', runs: [...goal.runs, started.runId] });
    usageWaits.delete(project.id);
    backlogChanged(project);
    return started;
  };

  /** Start the backlog's next goal if the team is free, the backlog is not paused and the plan has room. */
  const tickBacklog = async (project: Project) => {
    if (!existsSync(project.path)) return;
    const store = storeFor(project);
    const goals = store.goals();
    // Checks cut short by quitting the app run again.
    for (const g of goals) if (g.state === 'checking' && !checks.has(`${project.id}/${g.id}`)) checkGoalNow(project, g);
    const next = goals.find((g) => g.state === 'ready');
    if (!library.backlog(project.id).auto || !next || goals.some((g) => liveRunOf(store, g))) {
      if (usageWaits.delete(project.id)) backlogChanged(project);
      return;
    }
    let team: TeamConfig;
    try {
      team = library.load(next.team);
    } catch {
      // startGoal sets it aside with the reason.
      return void (await startGoal(project, next).catch(() => undefined));
    }
    const wait = await usageGate(team).catch(() => undefined);
    if (wait) {
      const before = usageWaits.get(project.id);
      usageWaits.set(project.id, wait);
      if (JSON.stringify(before) !== JSON.stringify(wait)) backlogChanged(project);
      return;
    }
    await startGoal(project, next);
  };
  /** One look at a project's backlog at a time, so a goal never starts twice. */
  const kickBacklog = (project: Project) => {
    void serially(`backlog:${project.id}`, () => tickBacklog(project)).catch((err) => console.error(`backlog ${project.name}:`, err));
  };
  const backlogTimer = setInterval(() => {
    for (const p of library.projects()) kickBacklog(p);
  }, 20_000);
  backlogTimer.unref();
  const backlogFirst = setTimeout(() => {
    for (const p of library.projects()) kickBacklog(p);
  }, 1_000);
  backlogFirst.unref();

  const backlogView = (project: Project): BacklogView => {
    const store = storeFor(project);
    const roster = rosters();
    const settings = library.backlog(project.id);
    const goals = store.goals().map((g): GoalView => {
      const run = g.runs.length ? store.getRun(g.runs.at(-1)!) : undefined;
      const status: GoalView['status'] = g.state !== 'started' ? g.state : !run || store.isLive(run) ? 'running' : run.status === 'running' ? 'failed' : run.status;
      return { ...g, status, ...(run ? { run: summary(project, run, undefined, roster) } : {}) };
    });
    const working = goals.find((g) => g.status === 'running');
    const state: BacklogState = working
      ? { kind: 'working', goalId: working.id }
      : !goals.some((g) => g.status === 'ready')
        ? { kind: 'idle' }
        : !settings.auto
          ? { kind: 'paused' }
          : (usageWaits.get(project.id) ?? { kind: 'idle' });
    return { settings, maxUsage: library.settings().backlogMaxUsage, goals, state };
  };

  /** Goals from a request: `goal` (one, may come with files) or `goals` (several). */
  const addGoals = (project: Project, body: unknown): BacklogView => {
    const b = (body ?? {}) as { goal?: unknown; goals?: unknown; team?: unknown };
    const texts = (Array.isArray(b.goals) ? b.goals : [b.goal]).map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
    if (!texts.length) throw new BadRequest('"goal" is required');
    if (texts.length > 100) throw new BadRequest('at most 100 goals at a time');
    const ids = uploadIds(body);
    if (ids.length && texts.length > 1) throw new BadRequest('files go with one goal at a time');
    const team = typeof b.team === 'string' && b.team ? b.team : library.backlog(project.id).team;
    if (!team) throw new BadRequest('"team" is required (or set the backlog\'s team)');
    library.teamDir(team);
    const store = storeFor(project);
    for (const text of texts) {
      const goal = store.addGoal({ text, team, state: 'checking', attachments: [] });
      const files = ids.length ? takeUploads(ids, project.path, goalFilesKey(goal.id)) : [];
      checkGoalNow(project, files.length ? store.updateGoal(goal.id, { attachments: files }) : goal);
    }
    return backlogView(project);
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

  /** The run worked directly in a plain folder (no git). */
  const inFolder = (project: Project, run: RunRecord) => !run.branch && (project.kind === 'folder' || isFolderRun(project.path, run.id));

  /** Where a run's files are: its result branch, or your checkout (or plain folder) when it worked there. */
  const filesOf = async (project: Project, run: RunRecord): Promise<{ source: SiteSource; kind: RunFiles['source'] }> => {
    if (inFolder(project, run)) return { source: diskSource(project.path, 'your folder'), kind: { kind: 'folder' } };
    if (!run.branch) return { source: diskSource(project.path, 'your checkout'), kind: { kind: 'checkout' } };
    const exists = await exec('git', ['rev-parse', '--verify', '--quiet', `${run.branch}^{commit}`], { cwd: project.path }).then(() => true, () => false);
    if (!exists) throw new NotFound(`branch ${run.branch} no longer exists, so its files cannot be shown`);
    return { source: gitSource(project.path, run.branch), kind: { kind: 'branch', ref: run.branch } };
  };

  // ---- a run's app (see apps/): where Start runs it, what it would run, and the views people see it through

  /** The folder the App panel starts the app from: the run's merged result (its worktree, restored if it was removed), or the folder or checkout it worked in. */
  const appFolders = new Map<string, string>();
  /** `restore`: put the worktree back if it was removed to free disk space (only when starting the app, not to look at it). */
  const appFolder = async (project: Project, run: RunRecord, restore: boolean): Promise<string> => {
    if (inFolder(project, run) || !run.branch) return project.path;
    const known = appFolders.get(`${project.id}/${run.id}`);
    if (known && existsSync(known)) return known;
    const exists = await exec('git', ['rev-parse', '--verify', '--quiet', `${run.branch}^{commit}`], { cwd: project.path }).then(() => true, () => false);
    if (!exists) throw new BadRequest(`branch ${run.branch} no longer exists, so the app cannot run from it`);
    const ws = await Workspace.attach(project.path, run.id, 'worktree', run.branch);
    if (!restore) return ws.integrationDir;
    await ws.restore(ws.integrationDir);
    appFolders.set(`${project.id}/${run.id}`, ws.integrationDir);
    return ws.integrationDir;
  };
  /** The team's app settings and the domains its members' shell commands may reach (for an app a person starts). */
  const appContext = (run: RunRecord): { team?: AppConfig; network: string[] } => {
    try {
      const team = teamForRun(run).load();
      const lists = Object.values(team.agents).map((a) => a.sandbox?.network).filter((n): n is string[] => !!n);
      return { team: team.app, network: lists.length ? [...new Set(lists.flat())] : DEFAULT_SANDBOX_NETWORK };
    } catch {
      return { network: DEFAULT_SANDBOX_NETWORK };
    }
  };
  /** A person's message to a member of a run: into the live run, or a follow-up conversation after it ended. */
  const chatWith = async (project: Project, store: EventStore, run: RunRecord, agent: string, message: string, delivery: DeliveryMode = 'queue', uploads: string[] = []): Promise<ChatOutcome | { mode: 'answering' }> => {
    const team = teamForRun(run).load();
    if (!team.agents[agent]) throw new BadRequest(`team ${team.name} has no member "${agent}"`);
    // Files sent with the message go to a folder of their own in the run's.
    const attachments = uploads.length ? takeUploads(uploads, project.path, run.id, `chat-${Date.now()}`) : [];
    if (store.isLive(run)) return chat({ store, runner, team, runId: run.id, agent, message, delivery, connections, attachments });
    if (!store.getSession(run.id, agent)) throw new BadRequest(`${agent} has not worked on this run yet, so there is no conversation to continue. Ask it a question instead.`);
    const key = `${run.id}/${agent}`;
    if (answering.has(key)) {
      // It is answering an earlier message: hand this one to it while it works.
      const mode: DeliveryMode = delivery === 'interrupt' ? 'interrupt' : 'steer';
      const m = store.enqueue(run.id, agent, 'human', withFiles(message, attachments), mode);
      store.append(run.id, { type: 'message.queued', agent, step: 'chat', data: { id: m.id, to: agent, from: 'human', text: message, mode, ...(attachments.length ? { attachments } : {}) } });
      return { mode: 'queued' as const, messageId: m.id, delivery: mode };
    }
    answering.add(key);
    // The answer streams in as events; don't hold the request open for it.
    void chat({ store, runner, team, runId: run.id, agent, message, connections, attachments })
      .catch((err) => store.append(run.id, { type: 'agent.error', agent, step: 'chat', data: { ok: false, error: (err as Error).message } }))
      .finally(() => answering.delete(key));
    return { mode: 'answering' as const };
  };
  /** Where a run's app settings live: what covibe remembered for the project, and the team file's app: section. */
  const appPlaces = (project: Project, run: RunRecord): RunApp['places'] => {
    const remembered = rememberedApp(project.path);
    const { team } = appContext(run);
    return {
      ...(remembered ? { memory: { file: rememberedFile(project.path), settings: settingsOf(remembered) } } : {}),
      ...(run.teamFile ? { teamFile: run.teamFile } : {}),
      ...(team ? { team: settingsOf(team) } : {}),
    };
  };
  /**
   * Start a run's app as a person (the App tab) or with their approval (the
   * app doctor). Resolves with its state once it answers or fails.
   */
  const startApp = async (project: Project, store: EventStore, run: RunRecord, given: AppConfig, by: string, allowRuntime: boolean): Promise<{ started: Promise<AppState> }> => {
    const folder = await appFolder(project, run, true);
    const { team, network } = appContext(run);
    let spec: AppSpec;
    try {
      spec = resolveApp(folder, { given, team, remembered: rememberedApp(project.path), allowRuntime });
    } catch (err) {
      if (err instanceof AppConfigError) throw new BadRequest(err.message);
      throw err;
    }
    // Whatever a person starts is remembered for next time (as they gave it, or as it was suggested).
    spec = { ...spec, source: 'given' };
    const started = appHub.start({
      repo: project.path,
      runId: run.id,
      folder,
      spec,
      by,
      network,
      allowWrite: DEFAULT_SANDBOX_WRITE.map((d) => expandHome(d, homedir())),
      onEvent: (e) => store.append(run.id, { type: e.type, step: 'app', data: e.data }),
      keepAlive: () => store.isLive(store.getRun(run.id) ?? run),
    });
    started.catch((err) => store.append(run.id, { type: 'app.failed', step: 'app', data: { name: 'app', reason: (err as Error).message } }));
    return { started };
  };
  /** What the app doctor reads, and does once the person approves. */
  const doctorActions = (project: Project, store: EventStore, run: RunRecord, folder: string): DoctorActions => {
    let members: string[] = [];
    try {
      members = Object.keys(teamForRun(run).load().agents);
    } catch {
      // the team file is gone: no one to message
    }
    const logs = (n: number, find?: string) => {
      let lines = appHub.logs(project.path, run.id).split('\n');
      if (find) lines = lines.filter((l) => l.toLowerCase().includes(find.toLowerCase()));
      return lines.slice(-n).join('\n').trim() || (find ? `No lines with "${find}".` : 'The log is empty.');
    };
    return {
      members,
      logs,
      info: () => {
        const state = appHub.get(project.path, run.id);
        const places = appPlaces(project, run);
        const { team } = appContext(run);
        let next: string;
        try {
          const spec = resolveApp(folder, { team, remembered: rememberedApp(project.path) });
          next = `Start would run: ${JSON.stringify(settingsOf(spec))} (${spec.source})${spec.notes?.length ? `; covibe by itself: ${spec.notes.join('; ')}` : ''}`;
        } catch (err) {
          next = `Start cannot tell how to run it: ${(err as Error).message}`;
        }
        const problems = state?.status === 'failed' ? diagnoseApp(state, appHub.logs(project.path, run.id)) : [];
        return [
          `Folder: ${folder}`,
          state
            ? `Last start: ${state.status}${state.reason ? ` (${state.reason})` : ''}, by ${state.by}, runtime ${state.runtime}, settings ${JSON.stringify(settingsOf(state.spec))} (${state.source}).`
            : 'It has not been started for this run.',
          next,
          `Team file: ${places.teamFile ?? 'none'}; its app: section: ${places.team ? JSON.stringify(places.team) : 'none'}.`,
          `Remembered from last time (${rememberedFile(project.path)}): ${places.memory ? JSON.stringify(places.memory.settings) : 'nothing'}.`,
          problems.length ? `covibe recognised: ${problems.map((p) => `${p.title} (${p.detail})`).join(' | ')}` : '',
          state ? `The end of its log:\n${tail(appHub.logs(project.path, run.id), 40)}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      },
      start: async (settings) => {
        const state = await (await startApp(project, store, run, settings, 'the app doctor (you approved)', false)).started.catch((err: Error) => ({ status: 'failed', reason: err.message, url: '' }) as Pick<AppState, 'status' | 'reason' | 'url'>);
        const end = tail(appHub.logs(project.path, run.id), 30) || '(empty)';
        return state.status === 'running'
          ? { ok: true, text: `It runs at ${state.url}. The end of its log:\n${end}` }
          : { ok: false, text: `It did not start: ${state.reason ?? 'unknown reason'}. The end of its log:\n${end}` };
      },
      forget: () => (forgetApp(project.path) ? { ok: true, text: `Forgot ${rememberedFile(project.path)}.` } : { ok: true, text: 'Nothing was remembered.' }),
      message: async (to, text) => {
        const r = await chatWith(project, store, run, to, `${text}\n\n(From covibe's app doctor, approved by the person.)`);
        return { ok: true, text: `The message went to ${to} (${r.mode}).` };
      },
    };
  };
  const settingsOf = (c: AppConfig): RunAppSettings => {
    const out: RunAppSettings = {};
    for (const k of ['runtime', 'setup', 'command', 'port', 'path', 'image', 'dockerfile', 'compose', 'service'] as const) if (c[k] !== undefined) (out as Record<string, unknown>)[k] = c[k];
    return out;
  };
  const appInfo = (s: AppState): NonNullable<RunApp['app']> => ({
    status: s.status,
    url: s.url,
    port: s.port,
    path: s.path,
    folder: s.folder,
    runtime: s.runtime,
    by: s.by,
    startedAt: s.startedAt,
    ...(s.readyAt ? { readyAt: s.readyAt } : {}),
    ...(s.stoppedAt ? { stoppedAt: s.stoppedAt } : {}),
    ...(s.reason ? { reason: s.reason } : {}),
    settings: settingsOf(s.spec),
    source: s.spec.source,
  });
  let dockerCheck: { at: number; ok: Promise<boolean> } | undefined;
  const dockerAvailable = (): Promise<boolean> => {
    if (!dockerCheck || Date.now() - dockerCheck.at > 30_000) {
      dockerCheck = { at: Date.now(), ok: exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 }).then(() => true, () => false) };
    }
    return dockerCheck.ok;
  };
  /** Settings a person typed in the App panel. */
  const appSettingsBody = (body: unknown): AppConfig => {
    const b = ((body as { settings?: unknown })?.settings ?? {}) as Record<string, unknown>;
    const out: AppConfig = {};
    if (b.runtime === 'sandbox' || b.runtime === 'docker') out.runtime = b.runtime;
    for (const k of ['setup', 'command', 'path', 'image', 'dockerfile', 'compose', 'service'] as const) {
      if (typeof b[k] === 'string' && (b[k] as string).trim()) out[k] = (b[k] as string).trim();
    }
    if (b.port !== undefined && b.port !== null && b.port !== '') {
      const port = Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequest('the port is a number from 1 to 65535');
      out.port = port;
    }
    return out;
  };
  /** Views in front of running apps, by run (see apps/view.ts). */
  const appViews = new Map<string, Promise<AppView>>();
  const viewFor = (project: Project, run: RunRecord, state: AppState): Promise<AppView> => {
    const key = `${project.id}/${run.id}/${state.name}`;
    const known = appViews.get(key);
    if (known) {
      return known.then((v) => {
        if (v.target === state.port) return v;
        appViews.delete(key);
        void v.close();
        return viewFor(project, run, state);
      });
    }
    const view = AppView.start(state.port, { onRequest: () => appHub.touch(project.path, run.id, state.name) });
    view.catch(() => appViews.delete(key));
    appViews.set(key, view);
    return view;
  };
  const viewSweep = setInterval(() => {
    for (const [key, view] of appViews) {
      void view.then((v) => {
        if (Date.now() - v.lastUsed < PREVIEW_IDLE_MS) return;
        appViews.delete(key);
        void v.close();
      }, () => undefined);
    }
  }, 60_000);
  viewSweep.unref();
  /** A file of the run on disk, to open in its own app: the file itself in a folder or checkout, else a copy from the result branch. */
  const fileOnDisk = async (project: Project, run: RunRecord, path: string): Promise<{ file: string; copy: boolean }> => {
    if (inFolder(project, run) || !run.branch) {
      const file = join(project.path, path);
      if (!existsSync(file)) throw new NotFound(`there is no ${path} in the folder`);
      return { file, copy: false };
    }
    const { source } = await filesOf(project, run);
    const data = await source.read(path);
    if (!data) throw new NotFound(`there is no ${path} in ${source.label}`);
    const file = join(covibeHome(), 'opened', project.id, run.id, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return { file, copy: true };
  };

  // Each run's files served as a website on a port of its own (see site.ts).
  const previews = new Map<string, Promise<SiteServer>>();
  const previewFor = (project: Project, run: RunRecord): Promise<SiteServer> => {
    const key = `${project.id}/${run.id}`;
    let site = previews.get(key);
    if (!site) {
      site = filesOf(project, run).then(({ source }) => SiteServer.start(source, { inject: FEEDBACK_BRIDGE }));
      site.catch(() => previews.delete(key));
      previews.set(key, site);
    }
    return site;
  };
  const previewSweep = setInterval(() => {
    for (const [key, site] of previews) {
      void site.then((s) => {
        if (Date.now() - s.lastUsed < PREVIEW_IDLE_MS) return;
        previews.delete(key);
        void s.close();
      }, () => undefined);
    }
  }, 60_000);
  previewSweep.unref();

  /** A member's tab in covibe's browser, open in this process. */
  const tabOf = async (pid: string, rid: string, agent: string) => {
    const { project, store, run } = findRun(pid, rid);
    const live = await browserHub.get(run.id, agent);
    if (!live) throw new NotFound(`${agent} has no browser open in this app`);
    return { project, store, run, live };
  };
  /** People drive a member's browser once they took control, or while the member is not working. */
  const mayDrive = (project: Project, run: RunRecord, live: LiveTab) => {
    if (live.control === 'human') return;
    const state = summary(project, run).agents.find((a) => a.name === live.agent);
    if (state?.status === 'working' || busyIn(run.id).has(live.agent)) throw new BadRequest(`${live.agent} is using this browser. Take control first.`);
  };

  /** A member's tab as live JPEG frames (multipart/x-mixed-replace, so an <img> shows it). */
  const streamBrowser = async (pid: string, rid: string, agent: string, req: IncomingMessage, res: ServerResponse) => {
    const { live } = await tabOf(pid, rid, agent);
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=covibeframe', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    // Each frame is followed at once by the next part's boundary and headers: browsers show a part
    // only once the next one has begun.
    const next = '\r\n--covibeframe\r\ncontent-type: image/jpeg\r\n\r\n';
    res.write(next.slice(2));
    streams.add(res);
    // A slow reader gets the newest frame when it catches up, not a backlog.
    let draining = false;
    let pending: Buffer | undefined;
    const write = (jpeg: Buffer) => {
      if (draining) {
        pending = jpeg;
        return;
      }
      if (!res.write(Buffer.concat([jpeg, Buffer.from(next)]))) {
        draining = true;
        res.once('drain', () => {
          draining = false;
          const next = pending;
          pending = undefined;
          if (next) write(next);
        });
      }
    };
    const end = () => {
      streams.delete(res);
      if (!res.writableEnded) res.end();
    };
    const stop = live.watch(write, end);
    req.on('close', () => {
      stop();
      streams.delete(res);
    });
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
      canRequest: a.canRequest,
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
      if (c.kind === 'codex') {
        // The browser does the sign-in; the app watches the account until it shows up.
        const { url } = await connections.codexSignIn(c.id);
        return { url, opened: await openInBrowser(url) };
      }
      return startLogin(c);
    }],
    ['GET', '/api/connections/:id/login', (p) => {
      if (connections.get(p.id!)?.kind !== 'codex') throw new NotFound(`no ChatGPT account "${p.id}"`);
      return { ...connections.codexSignInState(p.id!), account: connections.codexInfo(p.id!) };
    }],
    ['GET', '/api/connections/:id/account', (p, _b, q) => {
      const kind = connections.get(p.id!)?.kind;
      if (kind === 'codex') return connections.codexInfo(p.id!);
      if (kind !== 'claude') throw new NotFound(`no Claude or ChatGPT account "${p.id}"`);
      return accountInfo(p.id!, q.get('fresh') === '1');
    }],
    // The models a provider offers: for a saved connection (its stored key), or for one being set up.
    ['POST', '/api/connections/models', async (_p, body) => {
      const b = body as { id?: string; kind?: string; baseUrl?: string; apiKey?: string };
      const saved = b.id ? connections.get(b.id) : undefined;
      const kind = (saved?.kind ?? b.kind) as string;
      if (saved?.kind === 'codex') return { models: await connections.codexModels(saved.id) };
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

    // ---- plugins (their programs run in the OS sandbox: see plugins.ts)
    ['GET', '/api/plugins', () => {
      const used = usage('plugins');
      return { library: plugins.listPlugins().map((p) => withUsage(p, used)), sandbox: plugins.sandboxStatus() };
    }],
    ['GET', '/api/plugins/catalog', async () => {
      if (!pluginCatalog || Date.now() - pluginCatalog.at > 3_600_000) {
        pluginCatalog = { at: Date.now(), data: plugins.scanGithub(plugins.ANTHROPIC_PLUGINS) };
        pluginCatalog.data.catch(() => (pluginCatalog = undefined));
      }
      const installed = new Set(plugins.listPlugins().map((p) => p.name));
      const data = await pluginCatalog.data;
      return { source: plugins.ANTHROPIC_PLUGINS, commit: data.commit, plugins: data.plugins.map((p) => ({ ...p, installed: installed.has(p.name) })) };
    }],
    ['POST', '/api/plugins/github/scan', (_p, body) => plugins.scanGithub(str(body, 'url'))],
    ['POST', '/api/plugins/github/review', (_p, body) => plugins.reviewGithub(str(body, 'url'), str(body, 'id', true))],
    ['POST', '/api/plugins/github/install', (_p, body) => plugins.installGithub(str(body, 'url'), str(body, 'id', true), (body as { policy?: unknown }).policy)],
    // MCP servers you add by hand: an address, a command or a JSON snippet, made into a plugin of your own.
    ['POST', '/api/plugins/mcp/review', (_p, body) => plugins.reviewMcp(mcpInput(body))],
    ['POST', '/api/plugins/mcp/add', (_p, body) => {
      const b = body as { policy?: unknown; values?: unknown };
      return withUsage(plugins.addMcpServer(mcpInput(body), b.policy, isRecord(b.values) ? b.values : {}));
    }],
    ['GET', '/api/plugins/:name', (p) => withUsage(plugins.getPlugin(p.name!))],
    ['PUT', '/api/plugins/:name/policy', (p, body) => withUsage(plugins.setPolicy(p.name!, (body as { policy?: unknown }).policy))],
    ['PUT', '/api/plugins/:name/everyone', (p, body) => withUsage(plugins.setEveryone(p.name!, !!(body as { everyone?: unknown }).everyone))],
    ['POST', '/api/plugins/:name/approve', (p) => withUsage(plugins.approvePlugin(p.name!))],
    ['PUT', '/api/plugins/:name/variables', (p, body) => {
      const values = (body as { values?: unknown }).values;
      if (!isRecord(values)) throw new BadRequest('"values" must be an object');
      return withUsage(plugins.setPluginVariables(p.name!, values));
    }],
    ['POST', '/api/plugins/:name/update', async (p) => withUsage(await plugins.updatePlugin(p.name!))],
    ['DELETE', '/api/plugins/:name', (p) => (plugins.deletePlugin(p.name!), { ok: true })],
    // Sign covibe in to a plugin's remote MCP server; the browser does the sign-in and the page watches its status.
    ['POST', '/api/plugins/:name/sign-in/:server', async (p) => {
      const target = plugins.signInTarget(p.name!, p.server!);
      const { url, done } = await startSignIn(p.name!, p.server!, target);
      void done.catch(() => undefined);
      if (!url) return { needed: false };
      return { needed: true, url, opened: await openInBrowser(url) };
    }],
    ['GET', '/api/plugins/:name/sign-in/:server', (p) => signInStatus(p.name!, p.server!)],
    // Your own OAuth app, for servers that do not let covibe register itself.
    ['PUT', '/api/plugins/:name/sign-in/:server/client', (p, body) => {
      plugins.signInTarget(p.name!, p.server!);
      const secret = (body as { clientSecret?: unknown }).clientSecret;
      setClient(p.name!, p.server!, str(body, 'clientId'), typeof secret === 'string' ? secret : undefined);
      return withUsage(plugins.getPlugin(p.name!));
    }],
    ['DELETE', '/api/plugins/:name/sign-in/:server/client', (p) => {
      plugins.signInTarget(p.name!, p.server!);
      forgetClient(p.name!, p.server!);
      return withUsage(plugins.getPlugin(p.name!));
    }],
    ['DELETE', '/api/plugins/:name/sign-in/:server', (p) => {
      plugins.signInTarget(p.name!, p.server!);
      signOut(p.name!, p.server!);
      return withUsage(plugins.getPlugin(p.name!));
    }],

    // ---- voice input (the mic button); recordings come in at POST /api/voice/transcribe
    ['GET', '/api/voice', () => voice.status()],
    ['PUT', '/api/voice', (_p, body) => {
      if (!isRecord(body)) throw new BadRequest('expected an object');
      const text = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
      const key = (k: string) => (body[k] === null ? null : text(k));
      return voice.update({
        engine: text('engine') as VoiceSettings['engine'] | undefined,
        language: text('language'),
        model: text('model'),
        whisperPath: text('whisperPath'),
        openaiConnection: text('openaiConnection'),
        openaiModel: text('openaiModel'),
        openaiKey: key('openaiKey'),
        elevenlabsKey: key('elevenlabsKey'),
      });
    }],
    // A recording: whisper.cpp keeps its model loaded from the first click until it is closed.
    ['POST', '/api/voice/sessions', () => voice.openSession()],
    ['DELETE', '/api/voice/sessions/:id', (p) => (voice.closeSession(p.id!), { ok: true })],
    ['POST', '/api/voice/models/:id', (p) => voice.startDownload(p.id!)],
    ['DELETE', '/api/voice/models/:id', (p) => voice.deleteModel(p.id!)],

    // ---- project brain
    ['GET', '/api/projects/:pid/brain', async (p) => {
      const project = library.project(p.pid!);
      await ensureBrain(project.path);
      const store = storeFor(project);
      const curators = library.teams().flatMap((t) => {
        const doc = rawDoc(library.readFile(t.id, 'team.yaml')) as { brain?: { curator?: string } };
        return doc.brain?.curator ? [{ teamId: t.id, team: t.name, curator: doc.brain.curator }] : [];
      });
      return {
        dir: brainRoot(project.path),
        notes: listNotes(project.path),
        proposals: store.proposals(),
        log: await brainLog(project.path),
        curators,
        summarizing: summarizing.has(project.id),
        load: brainLoad(project.path, recentBrainReads(store, brainRoot(project.path))),
        summarizer: summarizerChoice(library.settings()),
      };
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

    ['POST', '/api/projects/:pid/brain/summarize', async (p) => {
      const project = library.project(p.pid!);
      const store = storeFor(project);
      await ensureBrain(project.path);
      if (brainSize(project.path) < 1024) throw new BadRequest('the brain is too small to summarize (under 1 KB)');
      if (summarizing.has(project.id)) throw new BadRequest('the brain is being summarized already');
      summarizing.add(project.id);
      const run = store.createRun({ id: newRunId(), kind: 'curate', team: SUMMARIZER, teamFile: '', repo: project.path, goal: 'Summarize the project brain so members read less' });
      store.append(run.id, { type: 'run.started', data: { team: SUMMARIZER, goal: run.goal, kind: 'curate', steps: ['summarize'] } });
      let status: 'succeeded' | 'failed' = 'succeeded';
      let reason: string | undefined;
      const settings = library.settings();
      const brainBackend = settings.brainProvider ? { type: 'connection' as const, connection: settings.brainProvider.connection, model: settings.brainProvider.model } : undefined;
      void summarizeBrain({ store, runner, repo: project.path, runId: run.id, model: settings.brainModel ?? undefined, effort: settings.brainEffort ?? undefined, backend: brainBackend, backends: connections })
        .catch((err) => {
          status = 'failed';
          reason = (err as Error).message;
        })
        .finally(() => {
          summarizing.delete(project.id);
          store.finishRun(run.id, status);
          store.append(run.id, { type: 'run.finished', data: { status, ...(reason ? { reason } : {}), loops: 0, cost_usd: null } });
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
    // ---- the git helper (conversations live in the library store, one project each)
    ['GET', '/api/projects/:pid/git-helper', (p) => {
      const project = library.project(p.pid!);
      const latest = libraryStore.listRuns(500).find((r) => r.kind === 'git' && r.team === project.id);
      return { runId: latest?.id ?? null, waiting: latest ? approvals.waiting(latest.id).length : 0, busy: latest ? answering.has(`${latest.id}/${GIT_HELPER}`) : false };
    }],
    ['POST', '/api/projects/:pid/git-helper', async (p, body) => {
      const project = library.project(p.pid!);
      const b = body as { runId?: unknown };
      const previous = typeof b.runId === 'string' && b.runId ? libraryStore.getRun(b.runId) : undefined;
      if (previous && (previous.kind !== 'git' || previous.team !== project.id)) throw new BadRequest('that conversation belongs to another project');
      if (previous && answering.has(`${previous.id}/${GIT_HELPER}`)) throw new BadRequest('the git helper is still answering');
      const stop = new AbortController();
      const { runId, done } = await gitHelp({ store: libraryStore, runner, approvals, project, runId: previous?.id, message: str(body, 'message'), signal: stop.signal });
      answering.add(`${runId}/${GIT_HELPER}`);
      helperStops.set(runId, stop);
      void done.finally(() => {
        answering.delete(`${runId}/${GIT_HELPER}`);
        helperStops.delete(runId);
      });
      return { runId };
    }],
    ['GET', '/api/git-helper/:rid', (p) => {
      const run = libraryStore.getRun(p.rid!);
      if (!run || run.kind !== 'git') throw new NotFound('conversation not found');
      const events = libraryStore.events(run.id);
      return {
        runId: run.id,
        busy: answering.has(`${run.id}/${GIT_HELPER}`),
        thread: helperThread(events, new Set(approvals.waiting(run.id))),
        costUsd: events.filter((e) => e.type === 'agent.finished' || e.type === 'agent.error').reduce((n, e) => n + Number(e.data.cost_usd ?? 0), 0),
      };
    }],
    ['POST', '/api/git-helper/:rid/decide', (p, body) => {
      const b = body as { id?: unknown; run?: unknown };
      if (!approvals.decide(p.rid!, String(b.id ?? ''), b.run === true)) throw new BadRequest('that proposal is no longer waiting');
      return { ok: true };
    }],
    ['POST', '/api/git-helper/:rid/stop', (p) => {
      helperStops.get(p.rid!)?.abort();
      return { ok: true };
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
    ['GET', '/api/projects/:pid/git/diff', (p, _b, q) => gitops.gitFileDiff(library.project(p.pid!).path, q.get('path') ?? '')],
    ['POST', '/api/projects/:pid/git/:op', (p, body) => gitOp(library.project(p.pid!).path, p.op!, (body ?? {}) as Record<string, unknown>)],
    ['POST', '/api/projects/:pid/git/:op/:sub', (p, body) => gitOp(library.project(p.pid!).path, `${p.op}/${p.sub}`, (body ?? {}) as Record<string, unknown>)],
    ['GET', '/api/projects', () => library.projects()],
    ['POST', '/api/projects', (_p, body) => library.addProject(str(body, 'path'), { init: !!(body as { init?: unknown }).init, folder: !!(body as { folder?: unknown }).folder })],
    ['POST', '/api/projects/create', (_p, body) => library.createProject(str(body, 'parent'), str(body, 'name'), { folder: !!(body as { folder?: unknown }).folder })],
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

    // ---- a project's backlog
    ['GET', '/api/projects/:pid/backlog', (p) => backlogView(library.project(p.pid!))],
    ['PUT', '/api/projects/:pid/backlog', (p, body) => {
      const project = library.project(p.pid!);
      library.setBacklog(project.id, (body ?? {}) as Partial<BacklogSettings>);
      backlogChanged(project);
      return backlogView(library.project(project.id));
    }],
    ['POST', '/api/projects/:pid/backlog/next', async (p) => {
      const project = library.project(p.pid!);
      return serially(`backlog:${project.id}`, async () => {
        const store = storeFor(project);
        const goals = store.goals();
        const working = goals.find((g) => liveRunOf(store, g));
        if (working) throw new BadRequest('a goal is being worked on; the next one starts when it finishes');
        const next = goals.find((g) => g.state === 'ready');
        if (!next) throw new BadRequest('no goal is waiting in the backlog');
        return startGoal(project, next);
      });
    }],
    ['POST', '/api/projects/:pid/goals', (p, body) => addGoals(library.project(p.pid!), body)],
    ['PUT', '/api/projects/:pid/goals/:gid', (p, body) => {
      const { project, store, goal } = findGoal(p.pid!, p.gid!);
      if (goal.state === 'started') throw new BadRequest('this goal has started; give the team a new goal instead');
      const b = (body ?? {}) as { text?: unknown; team?: unknown };
      const text = typeof b.text === 'string' ? b.text.trim() : goal.text;
      if (!text) throw new BadRequest('the goal is empty');
      const team = typeof b.team === 'string' && b.team ? b.team : goal.team;
      library.teamDir(team);
      const changed = text !== goal.text || team !== goal.team;
      const updated = store.updateGoal(goal.id, { text, team });
      // A different goal needs a fresh look.
      if (changed) checkGoalNow(project, updated);
      return backlogView(project);
    }],
    ['POST', '/api/projects/:pid/goals/:gid/answer', (p, body) => {
      const { project, store, goal } = findGoal(p.pid!, p.gid!);
      if (goal.state !== 'needs_info' || !goal.check?.questions?.length) throw new BadRequest('this goal has no questions waiting');
      const answers = (body as { answers?: unknown }).answers;
      if (!Array.isArray(answers) || answers.some((a) => typeof a !== 'string')) throw new BadRequest('"answers" is a list of answers, one per question');
      const questions = goal.check.questions.map((q, i) => ({ ...q, ...((answers[i] as string | undefined)?.trim() ? { answer: (answers[i] as string).trim() } : {}) }));
      store.updateGoal(goal.id, { state: 'ready', check: { ...goal.check, questions } });
      backlogChanged(project);
      return backlogView(project);
    }],
    ['POST', '/api/projects/:pid/goals/:gid/check', (p) => {
      const { project, goal } = findGoal(p.pid!, p.gid!);
      if (goal.state === 'started') throw new BadRequest('this goal has started already');
      checkGoalNow(project, goal);
      return backlogView(project);
    }],
    // Into the backlog as it is: questions left open, or a finished goal again.
    ['POST', '/api/projects/:pid/goals/:gid/queue', (p) => {
      const { project, store, goal } = findGoal(p.pid!, p.gid!);
      if (liveRunOf(store, goal)) throw new BadRequest('this goal is being worked on');
      checks.get(`${project.id}/${goal.id}`)?.abort();
      checks.delete(`${project.id}/${goal.id}`);
      store.updateGoal(goal.id, { state: 'ready' });
      backlogChanged(project);
      return backlogView(project);
    }],
    ['POST', '/api/projects/:pid/goals/:gid/start', (p) => {
      const { project } = findGoal(p.pid!, p.gid!);
      return serially(`backlog:${project.id}`, () => {
        const { goal } = findGoal(p.pid!, p.gid!);
        checks.get(`${project.id}/${goal.id}`)?.abort();
        checks.delete(`${project.id}/${goal.id}`);
        return startGoal(project, goal);
      });
    }],
    ['POST', '/api/projects/:pid/goals/:gid/move', (p, body) => {
      const { project, store, goal } = findGoal(p.pid!, p.gid!);
      const index = Number((body as { index?: unknown }).index);
      if (!Number.isInteger(index)) throw new BadRequest('"index" is the place in the backlog, from 0');
      store.moveGoal(goal.id, index);
      backlogChanged(project);
      return backlogView(project);
    }],
    ['DELETE', '/api/projects/:pid/goals/:gid', (p) => {
      const { project, store, goal } = findGoal(p.pid!, p.gid!);
      if (liveRunOf(store, goal)) throw new BadRequest('this goal is being worked on; stop its run first');
      checks.get(`${project.id}/${goal.id}`)?.abort();
      checks.delete(`${project.id}/${goal.id}`);
      store.deleteGoal(goal.id);
      rmSync(attachmentsDir(project.path, goalFilesKey(goal.id)), { recursive: true, force: true });
      backlogChanged(project);
      return backlogView(project);
    }],

    ['GET', '/api/runs', (_p, _b, q) => allRuns(Number(q.get('limit') ?? 100), q.get('project') ?? undefined)],
    ['GET', '/api/runs/:pid/:rid', async (p): Promise<RunDetail> => {
      const { project, store, run } = findRun(p.pid!, p.rid!);
      const events = store.events(run.id);
      const browsers = await Promise.all((await browserHub.list(run.id)).map((t) => t.state()));
      return {
        browsers,
        summary: summary(project, run, events),
        members: membersOf(run),
        events,
        threads: chatThreads(events, [project.path]),
        ...stepReports(events),
        tasks: replayBoard(events, store.isLive(run)),
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
      return launch(project, team, str(body, 'goal'), base, { uploads: uploadIds(body) });
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
    ['POST', '/api/runs/:pid/:rid/continue', async (p) => {
      const { project, run } = findRun(p.pid!, p.rid!);
      return continueStopped(project, run);
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
      const { project, store, run } = findRun(p.pid!, p.rid!);
      const requested = (body as { delivery?: unknown }).delivery;
      const delivery: DeliveryMode = requested === 'steer' || requested === 'interrupt' ? requested : 'queue';
      return chatWith(project, store, run, str(body, 'agent'), str(body, 'message'), delivery, uploadIds(body));
    }],
    ['POST', '/api/ask', async (_p, body) => {
      const project = library.project(str(body, 'project'));
      const team = library.load(str(body, 'team'));
      const ids = uploadIds(body);
      const { runId, done } = await ask({ store: storeFor(project), runner, team, repo: project.path, agent: str(body, 'agent'), question: str(body, 'question'), connections, attach: ids.length ? (rid) => takeUploads(ids, project.path, rid) : undefined });
      done.catch(() => undefined);
      return { runId, projectId: project.id };
    }],
    ['GET', '/api/runs/:pid/:rid/files', async (p): Promise<RunFiles> => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const { source, kind } = await filesOf(project, run);
      const all = (await source.list()).sort((a, b) => a.path.localeCompare(b.path));
      let changed: Set<string>;
      if (run.branch) {
        const names = await exec('git', ['diff', '--name-only', '-z', `${run.base ?? 'HEAD'}...${run.branch}`], { cwd: project.path, maxBuffer: 32 << 20 }).then(
          (r) => r.stdout.split('\0').filter(Boolean),
          () => [] as string[],
        );
        changed = new Set(names);
      } else changed = new Set(summary(project, run).filesChanged);
      // Changed files first, so a cut-off list still has them.
      const ordered = [...all.filter((f) => changed.has(f.path)), ...all.filter((f) => !changed.has(f.path))];
      const files = ordered.slice(0, MAX_LISTED).map((f) => ({ ...f, changed: changed.has(f.path) }));
      return { source: kind, files: files.sort((a, b) => a.path.localeCompare(b.path)), ...(all.length > MAX_LISTED ? { truncated: true } : {}) };
    }],
    ['GET', '/api/runs/:pid/:rid/file', async (p, _b, q): Promise<RunFile> => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const path = relPath(q.get('path') ?? '');
      if (!path) throw new BadRequest('"path" names a file of the run');
      const { source } = await filesOf(project, run);
      const data = await source.read(path);
      if (!data) throw new NotFound(`there is no ${path} in ${source.label}`);
      if (!isText(data)) return { path, size: data.length, binary: true };
      const truncated = data.length > MAX_TEXT;
      return { path, size: data.length, binary: false, content: data.subarray(0, MAX_TEXT).toString('utf8'), ...(truncated ? { truncated } : {}) };
    }],
    ['POST', '/api/runs/:pid/:rid/preview', async (p): Promise<PreviewSite> => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const site = await previewFor(project, run);
      site.lastUsed = Date.now();
      return { port: site.port, key: site.key, label: site.source.label };
    }],
    // ---- members' live browsers
    ['GET', '/api/runs/:pid/:rid/browser/:agent', async (p) => (await tabOf(p.pid!, p.rid!, p.agent!)).live.state()],
    ['POST', '/api/runs/:pid/:rid/browser/:agent/control', async (p, body) => {
      const { live } = await tabOf(p.pid!, p.rid!, p.agent!);
      const by = (body as { by?: unknown }).by;
      if (by !== 'human' && by !== 'member') throw new BadRequest('"by" is human or member');
      live.setControl(by);
      return live.state();
    }],
    ['POST', '/api/runs/:pid/:rid/browser/:agent/navigate', async (p, body) => {
      const { project, run, live } = await tabOf(p.pid!, p.rid!, p.agent!);
      mayDrive(project, run, live);
      live.touch();
      const b = body as { url?: unknown; action?: unknown };
      if (b.action === 'back' || b.action === 'forward' || b.action === 'reload') await live.tab.history(b.action);
      else if (typeof b.url === 'string') {
        try {
          await live.tab.goto(await live.resolve(b.url));
        } catch (err) {
          throw new BadRequest((err as Error).message);
        }
      } else throw new BadRequest('give "url", or "action": back, forward or reload');
      return live.state();
    }],
    ['POST', '/api/runs/:pid/:rid/browser/:agent/input', async (p, body) => {
      const { project, run, live } = await tabOf(p.pid!, p.rid!, p.agent!);
      mayDrive(project, run, live);
      live.touch();
      await browserInput(live, body as Record<string, unknown>);
      return { ok: true };
    }],
    ['DELETE', '/api/runs/:pid/:rid/browser/:agent', async (p) => {
      const { run } = await tabOf(p.pid!, p.rid!, p.agent!);
      await browserHub.close(run.id, p.agent!, 'closed by you');
      return { ok: true };
    }],
    // ---- the run's app
    ['GET', '/api/runs/:pid/:rid/app', async (p): Promise<RunApp> => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const state = appHub.get(project.path, run.id);
      if (state && (state.status === 'running' || state.status === 'starting')) appHub.touch(project.path, run.id);
      const log = state ? tail(appHub.logs(project.path, run.id), 400) : '';
      const out: RunApp = { log, dockerAvailable: await dockerAvailable(), ...(state ? { app: appInfo(state) } : {}), places: appPlaces(project, run) };
      if (state?.status === 'failed') out.problems = diagnoseApp(state, appHub.logs(project.path, run.id));
      const doctor = libraryStore.listRuns(500).find((r) => r.kind === 'doctor' && r.team === doctorKey(project.id, run.id));
      if (doctor) out.doctor = { runId: doctor.id, busy: answering.has(`${doctor.id}/${APP_DOCTOR}`), waiting: approvals.waiting(doctor.id).length };
      let folder: string | undefined;
      try {
        folder = await appFolder(project, run, false);
        out.folder = folder;
      } catch (err) {
        out.unavailable = (err as Error).message;
      }
      if (folder && !existsSync(folder)) {
        out.suggestError = "The run's worktree was removed to free disk space; starting the app puts it back.";
        const runtime = appContext(run).team?.runtime ?? rememberedApp(project.path)?.runtime;
        const remembered = rememberedApp(project.path);
        if (remembered) out.suggested = { ...settingsOf(remembered), source: 'remembered' };
        else if (runtime) out.suggested = { runtime, source: 'team' };
      } else if (folder) {
        const { team } = appContext(run);
        try {
          const spec = resolveApp(folder, { team, remembered: rememberedApp(project.path), allowRuntime: true });
          out.suggested = { ...settingsOf(spec), source: spec.source };
        } catch (err) {
          if (!(err instanceof AppConfigError)) throw err;
          out.suggestError = err.message;
          const runtime = team?.runtime ?? rememberedApp(project.path)?.runtime;
          if (runtime) out.suggested = { runtime, source: 'team' };
        }
      }
      return out;
    }],
    ['POST', '/api/runs/:pid/:rid/app/start', async (p, body) => {
      const { project, store, run } = findRun(p.pid!, p.rid!);
      const { started } = await startApp(project, store, run, appSettingsBody(body), 'you', true);
      // It answers once the app does; the panel follows its state meanwhile.
      await Promise.race([started.catch(() => undefined), new Promise((r) => setTimeout(r, 300))]);
      const state = appHub.get(project.path, run.id);
      return state ? appInfo(state) : { status: 'failed' };
    }],
    ['DELETE', '/api/runs/:pid/:rid/app/memory', (p) => {
      const { project } = findRun(p.pid!, p.rid!);
      return { forgotten: forgetApp(project.path) };
    }],
    // ---- the app doctor (conversations live in the library store, one per run)
    ['POST', '/api/runs/:pid/:rid/app/doctor', async (p, body) => {
      const { project, store, run } = findRun(p.pid!, p.rid!);
      const b = body as { runId?: unknown };
      const key = doctorKey(project.id, run.id);
      const previous = typeof b.runId === 'string' && b.runId ? libraryStore.getRun(b.runId) : undefined;
      if (previous && (previous.kind !== 'doctor' || previous.team !== key)) throw new BadRequest("that conversation is about another run's app");
      if (previous && answering.has(`${previous.id}/${APP_DOCTOR}`)) throw new BadRequest('the app doctor is still working');
      const folder = await appFolder(project, run, true);
      const stop = new AbortController();
      const teamFile = run.teamFile && existsSync(run.teamFile) ? run.teamFile : undefined;
      const { runId, done } = await appDoctor({
        store: libraryStore,
        runner,
        approvals,
        project,
        target: { runId: run.id },
        folder,
        readDirs: teamFile ? [dirname(teamFile)] : undefined,
        runId: previous?.id,
        message: str(body, 'message'),
        signal: stop.signal,
        actions: doctorActions(project, store, run, folder),
      });
      answering.add(`${runId}/${APP_DOCTOR}`);
      helperStops.set(runId, stop);
      void done.finally(() => {
        answering.delete(`${runId}/${APP_DOCTOR}`);
        helperStops.delete(runId);
      });
      return { runId };
    }],
    ['GET', '/api/app-doctor/:did', (p): DoctorDetail => {
      const run = libraryStore.getRun(p.did!);
      if (!run || run.kind !== 'doctor') throw new NotFound('conversation not found');
      const events = libraryStore.events(run.id);
      return {
        runId: run.id,
        busy: answering.has(`${run.id}/${APP_DOCTOR}`),
        thread: doctorThread(events, new Set(approvals.waiting(run.id))),
        costUsd: events.filter((e) => e.type === 'agent.finished' || e.type === 'agent.error').reduce((n, e) => n + Number(e.data.cost_usd ?? 0), 0),
      };
    }],
    ['POST', '/api/app-doctor/:did/decide', (p, body) => {
      const b = body as { id?: unknown; run?: unknown };
      if (!approvals.decide(p.did!, String(b.id ?? ''), b.run === true)) throw new BadRequest('that proposal is no longer waiting');
      return { ok: true };
    }],
    ['POST', '/api/app-doctor/:did/stop', (p) => {
      helperStops.get(p.did!)?.abort();
      return { ok: true };
    }],
    ['POST', '/api/runs/:pid/:rid/app/stop', async (p) => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const state = await appHub.stop(project.path, run.id, 'app', 'stopped by you');
      return state ? appInfo(state) : { ok: true };
    }],
    ['POST', '/api/runs/:pid/:rid/app/view', async (p): Promise<AppViewInfo> => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const state = appHub.get(project.path, run.id);
      if (!state || state.status !== 'running') throw new BadRequest('the app is not running');
      const view = await viewFor(project, run, state);
      view.lastUsed = Date.now();
      return { port: view.port };
    }],
    // ---- feedback on the result
    ['GET', '/api/runs/:pid/:rid/feedback', (p): FeedbackList => {
      const { project, run } = findRun(p.pid!, p.rid!);
      return readFeedback(project.path, run.id);
    }],
    ['POST', '/api/runs/:pid/:rid/feedback', (p, body): FeedbackList => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const list = readFeedback(project.path, run.id);
      return writeFeedback(project.path, run.id, { ...list, items: [...list.items, cleanItem(body)] });
    }],
    ['PUT', '/api/runs/:pid/:rid/feedback', (p, body): FeedbackList => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const list = readFeedback(project.path, run.id);
      return writeFeedback(project.path, run.id, { ...list, items: cleanItems((body as { items?: unknown }).items) });
    }],
    ['POST', '/api/runs/:pid/:rid/feedback/send', async (p, body) => {
      const { project, store, run } = findRun(p.pid!, p.rid!);
      if (run.kind !== 'workflow') throw new BadRequest('feedback goes to a team run');
      if (store.isLive(run)) throw new BadRequest('the run is still going; send your feedback once it has finished');
      const list = readFeedback(project.path, run.id);
      const note = typeof (body as { note?: unknown }).note === 'string' ? (body as { note: string }).note : undefined;
      if (!list.items.length && !note?.trim()) throw new BadRequest('there is no feedback to send yet');
      const team = teamForRun(run).load();
      const keep = run.branch && (await exec('git', ['rev-parse', '--verify', '--quiet', `${run.branch}^{commit}`], { cwd: project.path }).then(() => true, () => false));
      if (run.branch && !keep) throw new BadRequest(`branch ${run.branch} no longer exists, so there is no result to build on`);
      const started = await launch(project, team, feedbackGoal(run.goal, list.items, note), run.branch ?? undefined, { uploads: uploadIds(body) });
      writeFeedback(project.path, run.id, { items: [], sent: [...list.sent, { runId: started.runId, at: new Date().toISOString(), count: list.items.length }] });
      store.append(run.id, { type: 'feedback.sent', data: { run_id: started.runId, count: list.items.length } });
      return started;
    }],
    // ---- a file of the result in its own app (Word, Excel, Keynote…)
    ['POST', '/api/runs/:pid/:rid/open', async (p, body): Promise<OpenedFile> => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const path = relPath(str(body, 'path'));
      if (!path) throw new BadRequest('"path" names a file of the run');
      // Opening a program or a script would run it: only documents, media and images.
      if (!OPENABLE.test(path)) throw new BadRequest(`covibe opens documents, media and images in their own app, not ${extname(path) || 'files without an extension'}`);
      const { file, copy } = await fileOnDisk(project, run, path);
      if (!(body as { launch?: unknown }).launch) return { path: file, copy };
      const launched = await openInBrowser(file);
      if (!launched) throw new BadRequest(`could not open ${path}: no app on this computer opens it`);
      return { path: file, copy, launched };
    }],
    // ---- files people gave a run
    ['GET', '/api/runs/:pid/:rid/attachment', (p, _b, q) => {
      const { project, run } = findRun(p.pid!, p.rid!);
      const rel = relPath(q.get('path') ?? '');
      if (!rel) throw new BadRequest('"path" names a file given to the run');
      const file = join(attachmentsDir(project.path, run.id), rel);
      if (!existsSync(file) || !statSync(file).isFile()) throw new NotFound(`${rel} is not one of the run's files`);
      if (statSync(file).size > 64 << 20) throw new BadRequest(`${rel} is too large to show here; open it from ${file}`);
      return new Raw(readFileSync(file), SITE_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    }],
    ['GET', '/api/runs/:pid/:rid/diff', async (p): Promise<DiffResult> => {
      const { project, run } = findRun(p.pid!, p.rid!);
      if (isFolderRun(project.path, run.id)) return folderDiff(project.path, run.id);
      if (inFolder(project, run)) return { files: [], patch: '', note: 'The copies kept for this run were removed to free disk space, so its changes can no longer be shown or undone.' };
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
    ['POST', '/api/runs/:pid/:rid/undo', async (p): Promise<UndoResult> => {
      const { project, store, run } = findRun(p.pid!, p.rid!);
      if (!isFolderRun(project.path, run.id)) throw new BadRequest('only a run in a plain folder can be undone; a run in a git repository leaves your checkout alone');
      if (store.isLive(run) || busyIn(run.id).size) throw new BadRequest('the run is still working; stop it first');
      const result = await undoFolderRun(project.path, run.id);
      store.append(run.id, { type: 'files.undone', data: { restored: result.restored, removed: result.removed, skipped: result.skipped, kept_in: result.keptIn } });
      return result;
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

      const liveBrowser = /^\/api\/runs\/([^/]+)\/([^/]+)\/browser\/([^/]+)\/live$/.exec(url.pathname);
      if (liveBrowser && req.method === 'GET') {
        const [, pid, rid, agent] = liveBrowser.map((x) => decodeURIComponent(x));
        return await streamBrowser(pid!, rid!, agent!, req, res);
      }

      // A file for a goal, a question or a chat message: raw bytes, streamed to disk (it can be footage).
      if (url.pathname === '/api/uploads' && req.method === 'POST') {
        return send(res, 200, await saveUpload(url.searchParams.get('name') ?? 'file', req));
      }

      // A recording from the mic button, or a piece of one (?session=…): raw WAV, not JSON (it can be minutes long).
      if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') {
        return send(res, 200, await voice.transcribe(await readRaw(req, 64 << 20), url.searchParams.get('session') ?? undefined));
      }

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
            : err instanceof BadRequest || err instanceof ConfigError || err instanceof GitError || err instanceof SkillError || err instanceof plugins.PluginError || err instanceof GithubError || err instanceof BrainError || err instanceof ConnectionError || err instanceof CodexAuthError || err instanceof McpAuthError || err instanceof BackendError || err instanceof VoiceError || err instanceof AppError || err instanceof AppConfigError || err instanceof AttachmentError
              ? 400
              : 500;
      const message = err instanceof ConfigError ? `The team file has problems:\n${err.problems.map((p) => `• ${p}`).join('\n')}` : (err as Error).message;
      if (status === 500) console.error(err);
      const git = err instanceof GitProblem ? { git: { kind: err.kind, hint: err.hint, detail: err.detail, command: err.command } } : {};
      send(res, status, { error: message, ...(err instanceof NeedsGit ? { code: 'needs_git' } : {}), ...git });
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
      clearInterval(backlogTimer);
      clearTimeout(backlogFirst);
      for (const c of checks.values()) c.abort();
      clearInterval(autoCleanTimer);
      clearInterval(previewSweep);
      clearInterval(viewSweep);
      await Promise.all([...previews.values()].map((s) => s.then((x) => x.close(), () => undefined)));
      await Promise.all([...appViews.values()].map((v) => v.then((x) => x.close(), () => undefined)));
      await appHub.shutdown();
      for (const c of active.values()) c.abort();
      for (const res of sse) res.end();
      for (const res of streams) res.end();
      await browserHub.shutdown();
      voice.close();
      await new Promise<void>((r) => server.close(() => r()));
      // Give aborted runs a moment to record their end.
      await new Promise((r) => setTimeout(r, 200));
      for (const s of stores.values()) s.close();
      libraryStore.close();
      await connections.close();
      await stopMcpProxy();
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

/** A person's mouse and keyboard in a member's browser (from the live view). Coordinates are in the page's window. */
async function browserInput(live: LiveTab, b: Record<string, unknown>) {
  const tab = live.tab;
  const coord = (k: string, max: number) => {
    const v = Number(b[k]);
    if (!Number.isFinite(v)) throw new BadRequest(`"${k}" must be a number`);
    return Math.max(0, Math.min(max - 1, v));
  };
  const button = b.button === 'right' || b.button === 'middle' ? b.button : 'left';
  const clickCount = Math.max(1, Math.min(3, Number(b.clickCount) || 1));
  const { width, height } = tab.viewport;
  switch (b.type) {
    case 'click':
      return tab.click(coord('x', width), coord('y', height), { button, clickCount });
    case 'down':
    case 'up':
    case 'move':
      return tab.mouse(b.type, coord('x', width), coord('y', height), { button, clickCount });
    case 'wheel':
      return tab.wheel(coord('x', width), coord('y', height), Number(b.deltaX) || 0, Number(b.deltaY) || 0);
    case 'text':
      if (typeof b.text !== 'string' || !b.text) throw new BadRequest('"text" is required');
      return tab.insertText(b.text.slice(0, 10_000));
    case 'key':
      if (typeof b.key !== 'string' || !b.key) throw new BadRequest('"key" is required');
      try {
        return await tab.press(b.key);
      } catch (err) {
        throw new BadRequest((err as Error).message);
      }
    default:
      throw new BadRequest('"type" is click, down, up, move, wheel, text or key');
  }
}

/** One change at a time per repository, so a double click or two windows never run git over each other. */
const gitQueues = new Map<string, Promise<unknown>>();
function serially<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const next = (gitQueues.get(repo) ?? Promise.resolve()).then(fn, fn);
  gitQueues.set(repo, next.catch(() => undefined));
  return next;
}

/** The Git tab's operations on a project's checkout. */
function gitOp(repo: string, op: string, b: Record<string, unknown>): Promise<unknown> {
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  const opt = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string) : undefined);
  const paths = b.paths;
  const ops: Record<string, () => Promise<unknown>> = {
    fetch: () => gitops.gitFetch(repo),
    pull: () => gitops.gitPull(repo, s('mode') === 'rebase' ? 'rebase' : s('mode') === 'merge' ? 'merge' : 'ff'),
    push: () => gitops.gitPush(repo, opt('branch'), { force: b.force === true }),
    commit: async () => ({ sha: await gitops.gitCommit(repo, s('message'), { all: b.all === true, amend: b.amend === true, paths: Array.isArray(paths) ? paths.map(String) : undefined }) }),
    'commit/undo': () => gitops.gitUndoCommit(repo),
    stage: () => gitops.gitStage(repo, paths),
    unstage: () => gitops.gitUnstage(repo, paths),
    discard: () => gitops.gitDiscard(repo, paths),
    checkout: () => gitops.gitCheckout(repo, s('branch'), b.create === true, opt('from'), { stash: b.stash === true }),
    'branch/delete': () => (b.remote === true ? gitops.gitDeleteRemoteBranch(repo, s('branch')) : gitops.gitDeleteBranch(repo, s('branch'), b.force === true)),
    'branch/rename': () => gitops.gitRenameBranch(repo, s('from'), s('to')),
    merge: () => gitops.gitMerge(repo, s('branch')),
    rebase: () => gitops.gitRebase(repo, s('onto')),
    'cherry-pick': () => gitops.gitCherryPick(repo, s('sha')),
    revert: () => gitops.gitRevert(repo, s('sha')),
    reset: () => gitops.gitReset(repo, s('sha'), s('mode') as 'soft' | 'mixed' | 'hard'),
    operation: () => gitops.gitOperation(repo, s('action') as 'continue' | 'abort' | 'skip'),
    resolve: () => gitops.gitResolve(repo, s('path'), s('how') as 'current' | 'incoming' | 'resolved'),
    stash: () => gitops.gitStash(repo, opt('message')),
    'stash/apply': () => gitops.gitStashApply(repo, Number(b.index), b.pop === true),
    'stash/drop': () => gitops.gitStashDrop(repo, Number(b.index)),
    tag: () => gitops.gitTag(repo, s('name'), opt('sha'), opt('message')),
    'tag/delete': () => gitops.gitDeleteTag(repo, s('name')),
    'tag/push': () => gitops.gitPushTag(repo, s('name')),
    remote: () => gitops.gitRemoteAdd(repo, s('name'), s('url')),
    'remote/remove': () => gitops.gitRemoteRemove(repo, s('name')),
    'remote/url': () => gitops.gitRemoteSetUrl(repo, s('name'), s('url')),
    identity: () => gitops.gitSetIdentity(repo, s('name'), s('email'), b.global === true),
    unlock: async () => ({ removed: await gitops.gitClearLock(repo) }),
    run: async () => {
      const args = gitops.splitCommand(s('command'));
      return { args, ...(await gitops.gitRun(repo, args)) };
    },
    pr: () => gitops.gitPullRequest(repo, { branch: s('branch'), base: s('base'), title: s('title'), body: opt('body') }),
  };
  const fn = ops[op];
  if (!fn) throw new NotFound(`no git operation "${op}"`);
  return serially(repo, async () => (await fn()) ?? { ok: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An MCP server to add, from a request. */
function mcpInput(body: unknown): plugins.McpInput {
  const b = isRecord(body) ? body : {};
  const h = isRecord(b.header) ? b.header : undefined;
  return {
    config: str(b, 'config'),
    name: typeof b.name === 'string' ? b.name : undefined,
    description: typeof b.description === 'string' ? b.description : undefined,
    header: h && typeof h.name === 'string' && typeof h.value === 'string' ? { name: h.name, value: h.value } : undefined,
  };
}

function str(body: unknown, key: string, allowEmpty = false): string {
  const v = (body as Record<string, unknown>)?.[key];
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new BadRequest(`"${key}" is required`);
  return v;
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new BadRequest('request too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
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

/** The uploads a request names (see /api/uploads): `attachments`, a list of ids. */
function uploadIds(body: unknown): string[] {
  const list = (body as { attachments?: unknown } | null)?.attachments;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new BadRequest('"attachments" is a list of upload ids');
  if (list.length > 50) throw new BadRequest('at most 50 files at a time');
  return list as string[];
}

/** How many workflow runs the brain's "read in recent runs" looks at. */
const BRAIN_RUNS = 10;

/** The notes members read (Read calls into the brain folder) in this project's recent workflow runs. */
function recentBrainReads(store: EventStore, dir: string): { runs: number; reads: string[] } {
  const runs = store.listRuns(50).filter((r) => r.kind === 'workflow').slice(0, BRAIN_RUNS);
  const reads: string[] = [];
  for (const r of runs) {
    for (const e of store.events(r.id)) {
      if (e.type !== 'agent.tool' || e.data.tool !== 'Read') continue;
      const file = (e.data.input as { file_path?: unknown } | undefined)?.file_path;
      if (typeof file === 'string' && file.startsWith(dir + sep)) reads.push(file);
    }
  }
  return { runs: runs.length, reads };
}

/** Which model summarizes project brains, as the brain page shows it. */
function summarizerChoice(settings: AppSettings): string {
  if (settings.brainProvider) return `${settings.brainProvider.model} on ${settings.brainProvider.connection}`;
  return settings.brainModel ?? 'sonnet';
}
