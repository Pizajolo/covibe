// Shapes the HTTP API returns. The UI imports these types directly.
import type { CheckMode, Goal, GoalCheck, GoalQuestion, GoalState, RunEvent, RunKind, RunStatus } from '../events/types.js';
import type { Effort, Thinking } from '../config/types.js';

export type { Effort, Thinking } from '../config/types.js';
export type { EnvironmentInfo, ModelChoice, PlanUsage } from '../runner/types.js';
export type { Connection, ConnectionKind, ConnectionView, Pricing, ProviderModel } from '../connections/types.js';
import type { ConnectionView } from '../connections/types.js';

export type { CheckMode, Goal, GoalCheck, GoalQuestion, GoalState, RunEvent, RunKind, RunStatus };
export type { Earnings, Hire, IntakeDecision, Listing, ListingStats, LocalOrder, MarketSettings, MarketTeam, MarketView, Order, OrderStatus, Precheck, Stage } from '../market/types.js';

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  /**
   * A plain folder has no git: members work in the folder itself, and a run
   * can be undone instead of merged. Unset = a git repository.
   */
  kind?: 'git' | 'folder';
  /** How the project's backlog is worked off (see BacklogSettings); unset fields take the defaults. */
  backlog?: Partial<BacklogSettings>;
}

export interface BacklogSettings {
  /** Start the next goal on its own whenever the team is free (and the plan has room). Off = paused: goals start only when you start them. */
  auto: boolean;
  /** The team new goals go to, unless you pick another. */
  team?: string;
  check: CheckMode;
  /** In a git project, each goal starts from the result of the last goal that succeeded (unless that is already in your branch). */
  chain: boolean;
}

export interface TeamFileInfo {
  path: string;
  size: number;
}

export interface TeamListing {
  id: string;
  name: string;
  description?: string;
  dir: string;
  valid: boolean;
  problems: string[];
  agents: string[];
  steps: string[];
}

export type EditOp =
  | { op: 'set'; path: (string | number)[]; value: unknown }
  | { op: 'delete'; path: (string | number)[] }
  /** Move an item of the list at `path` from one index to another (comments travel with it). */
  | { op: 'move'; path: (string | number)[]; from: number; to: number }
  /** Insert a new item into the list at `path` before `index` (or at the end). */
  | { op: 'insert'; path: (string | number)[]; index?: number; value: unknown };

export interface AppSettings {
  /** Remove worktrees of runs finished this many days ago; null = never automatically. */
  autoCleanDays: number | null;
  /** Model and effort the team architect uses in design chats. */
  designerModel?: string;
  designerEffort?: Effort;
  /** What summarizes project brains: a Claude model (default sonnet) and effort, or a provider's model. */
  brainModel?: string | null;
  brainEffort?: Effort | null;
  brainProvider?: { connection: string; model: string } | null;
  /** When the plan's usage limit stops a member: wait for the reset and continue (default), or stop the run. */
  onLimit?: 'wait' | 'stop';
  /**
   * Backlogs do not start their next goal while your plan's 5-hour or weekly
   * usage is at or above this percentage; they wait for it to reset (you can
   * still start one yourself). null = never wait.
   */
  backlogMaxUsage: number | null;
  /** Which notifications show under the bell and which also go out as system notifications. */
  notifications: Record<NotificationKind, NotifyChoice>;
}

/**
 * question: a member asks you. limit: the plan's usage is close to or at its
 * limit. stopped: a run stopped or ran out of fix rounds. error: a run failed.
 * done: a run finished with every gate passed.
 */
export type NotificationKind = 'question' | 'limit' | 'stopped' | 'error' | 'done';

export interface NotifyChoice {
  /** List it under the bell. */
  bell: boolean;
  /** Also send a system notification. */
  push: boolean;
}

export interface AppNotification {
  /** Stable across reloads: project and event. */
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  ts: string;
  projectId: string;
  runId: string;
  /** The run's goal. */
  goal?: string;
  /** For a question: its id, and whether it still waits for you. */
  questionId?: number;
  /** For a backlog goal the check has questions about. */
  goalId?: number;
  open?: boolean;
  /** Show under the bell / send as a system notification, from the settings. */
  bell: boolean;
  push: boolean;
}

export interface Overview {
  projects: Project[];
  teams: TeamListing[];
  runs: RunSummary[];
  stats: Stats;
  /** Library folder (teams, settings). */
  home: string;
  /** Where new projects go by default. */
  defaultParent: string;
}

export interface Template {
  id: string;
  name: string;
  description?: string;
}

/** A run's files, as the Preview tab lists them. */
export interface RunFiles {
  /** Where they come from: the run's result branch, or your checkout when the run worked there. */
  source: { kind: 'branch'; ref: string } | { kind: 'checkout' } | { kind: 'folder' };
  files: { path: string; size: number; changed: boolean }[];
  /** Set when the listing was cut short. */
  truncated?: boolean;
}

/** One file of a run, for the code view. */
export interface RunFile {
  path: string;
  size: number;
  binary: boolean;
  /** Text content (binary files have none). */
  content?: string;
  truncated?: boolean;
}

/** A run's files served as a website on a port of its own (see server/site.ts). */
export interface PreviewSite {
  port: number;
  /** Traded for a cookie on the first request: open `/?covibe_key=<key>` on the port. */
  key: string;
  label: string;
}

/** How to run the app, as the App panel edits it (see apps/config.ts). */
export interface RunAppSettings {
  runtime?: 'sandbox' | 'docker';
  setup?: string;
  command?: string;
  port?: number;
  path?: string;
  image?: string;
  dockerfile?: string;
  compose?: string;
  service?: string;
}

/** A run's app as the App panel shows it. */
export interface RunApp {
  /** The app, once someone started it. */
  app?: {
    status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
    url: string;
    port: number;
    path: string;
    folder: string;
    runtime: 'sandbox' | 'docker';
    by: string;
    startedAt: string;
    readyAt?: string;
    stoppedAt?: string;
    reason?: string;
    settings: RunAppSettings;
    source: 'given' | 'team' | 'remembered' | 'detected';
  };
  /** The end of its log. */
  log: string;
  /** How Start would run it now (team file, last time, or detected), or why covibe cannot tell. */
  suggested?: RunAppSettings & { source: 'given' | 'team' | 'remembered' | 'detected' };
  suggestError?: string;
  /** Where Start runs it from. */
  folder?: string;
  /** Why it cannot be started from here (the run's files are gone, say). */
  unavailable?: string;
  dockerAvailable: boolean;
  /** Where the settings live, so people can see and change them. */
  places: {
    /** What worked last time in this project (<repo>/.covibe/app.json), if anything. */
    memory?: { file: string; settings: RunAppSettings };
    /** The team file the run uses, and its app: section if it has one. */
    teamFile?: string;
    team?: RunAppSettings;
  };
  /** What went wrong, when it did not start (see apps/diagnose.ts). */
  problems?: AppProblemInfo[];
  /** The app doctor's latest conversation about this run's app. */
  doctor?: { runId: string; busy: boolean; waiting: number };
}

export type AppFixPlace = 'settings' | 'team' | 'memory' | 'code' | 'sandbox' | 'computer';

export interface AppProblemInfo {
  kind: string;
  title: string;
  detail: string;
  fixes: { where: AppFixPlace; text: string }[];
}

/** One item of the app doctor's conversation. */
export type DoctorItem =
  | { id: number; ts: string; kind: 'human' | 'agent' | 'tool' | 'note' | 'error'; text: string }
  /** A change it proposes, waiting for the person (or applied, declined, or no longer waiting). */
  | {
      id: number;
      ts: string;
      kind: 'proposal';
      proposal: string;
      action: 'start' | 'forget' | 'message';
      /** What it would do, in a line. */
      title: string;
      why?: string;
      settings?: RunAppSettings;
      to?: string;
      message?: string;
      state: 'waiting' | 'applied' | 'skipped' | 'expired';
      ok?: boolean;
      output?: string;
    };

export interface DoctorDetail {
  runId: string;
  busy: boolean;
  thread: DoctorItem[];
  costUsd: number;
}

/** Where the app panel shows the app: a view in front of it (see apps/view.ts). */
export interface AppViewInfo {
  port: number;
}

/** One comment a person pinned on a run's result. */
export interface FeedbackItem {
  id: string;
  /** What it is about: a file of the result, or a page of the running app. */
  target: 'file' | 'app';
  /** The file (target file) or the page's address (target app, e.g. "/pricing"). */
  path: string;
  kind: 'video' | 'audio' | 'image' | 'pdf' | 'page' | 'text' | 'file';
  /** Video or audio: the moment, and the end of a stretch, in seconds. */
  at?: number;
  until?: number;
  /** Image (or a video's frame): the area, as fractions of the width and height. */
  region?: { x: number; y: number; width: number; height: number };
  /** PDF: the page. */
  page?: number;
  /** Text: the passage it is about. */
  quote?: string;
  /** Web page: the element picked. */
  element?: { selector: string; tag: string; text: string; title?: string };
  comment: string;
  createdAt: string;
}

export interface FeedbackList {
  items: FeedbackItem[];
  /** Earlier feedback sent from this run: the runs it started. */
  sent: { runId: string; at: string; count: number }[];
}

/** A file of the result put on disk to open in its own app. */
export interface OpenedFile {
  path: string;
  /** True when it is a copy from the result branch (edits there do not change the run). */
  copy: boolean;
  /** The server opened it itself (no desktop app to do it). */
  launched?: boolean;
}

export interface DiffResult {
  /** status and by: a run in a plain folder (added, modified or deleted, and by whom). */
  files: { path: string; additions: number; deletions: number; status?: 'added' | 'modified' | 'deleted'; by?: string[] }[];
  patch: string;
  range?: string;
  note?: string;
  /** A run in a plain folder: its changes were undone at this time. */
  undoneAt?: string;
}

/** What undoing a run in a plain folder did. */
export interface UndoResult {
  restored: string[];
  removed: string[];
  skipped: { path: string; reason: string }[];
  /** Where the run's versions of those files were moved. */
  keptIn: string;
}

/** waiting: has messages for its next turn. asking: waits for the answer to its question. */
/** limited: the plan's usage limit stopped its turn; it continues once the limit resets. */
export type AgentActivity = 'idle' | 'working' | 'done' | 'error' | 'waiting' | 'asking' | 'limited';

export interface AgentState {
  name: string;
  status: AgentActivity;
  /** Step the agent is in (or was last in). */
  step?: string;
  /** What it is doing right now, e.g. "Edit web/app.tsx". */
  activity?: string;
  lastText?: string;
  invocations: number;
  turns: number;
  costUsd: number;
  tokens: number;
  /** Messages waiting for its next turn. */
  inbox: number;
  /** Who it waits on for an answer to its question (the lead's name, or "human"). */
  waitingOn?: string;
  /** While limited: when it continues. */
  limitedUntil?: string;
  /**
   * Set when its latest turn drives a browser (Playwright, Chromium…): the page it last named, if any.
   * live: it has an open tab in covibe's browser (see browser.* events), which people can watch;
   * control: who acts in it.
   */
  browser?: { url?: string; since: string; live?: boolean; control?: 'member' | 'human' };
  /** The newest image it saw this run (a screenshot it read; see agent.view), and how many it saw. */
  lastView?: number;
  views?: number;
  updatedAt?: string;
}

/** A member's question as the run shows it (see the question.* events). */
export interface QuestionView {
  id: number;
  from: string;
  /** "lead": the lead is answering; "open": waits for you. */
  status: 'lead' | 'open' | 'answered' | 'cancelled';
  question: string;
  context?: string;
  /** Answers to pick from, when it is a choice (the lead's, once it passed the question on). */
  options?: string[];
  /** Set when the lead passed it on: the question as put to you, and why. */
  forHuman?: string;
  leadNote?: string;
  lead?: string;
  answer?: string;
  answeredBy?: string;
  askedAt: string;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'passed' | 'failed' | 'skipped';

export interface BoardCard {
  agent: string;
  round: number;
  status: 'working' | 'done' | 'error' | 'skipped';
  costUsd: number;
  summary?: string;
  /** Set when the member worked on a teammate's request (request_work) rather than its own step. */
  requestedBy?: string;
}

/** A member asking a teammate for work (see the request.* events). */
export interface RequestView {
  id: number;
  from: string;
  to: string;
  /** The step the asking member was in. */
  step?: string;
  status: 'working' | 'done' | 'failed';
  request: string;
  context?: string;
  reply?: string;
  error?: string;
  files: string[];
  sentAt: string;
  doneAt?: string;
}

/** The latest report of a workflow step: the plan, a review, test results… */
/** A task on a run's todo list. */
export interface TaskView {
  id: string;
  /** The member it is for. */
  owner?: string;
  title: string;
  description?: string;
  status: 'open' | 'working' | 'done' | 'blocked';
  note?: string;
  updatedAt?: string;
  /** Who changed it last. */
  by?: string;
}

export interface StepReport {
  step: string;
  /** The fix round it came from. */
  round: number;
  ts: string;
  /** Who wrote it. A parallel step's output has one report per member, keyed by name. */
  agents: string[];
  parallel: boolean;
  output: unknown;
}

export interface StepState {
  id: string;
  status: StepStatus;
  rounds: number;
  gate?: string;
  cards: BoardCard[];
}

export interface RunSummary {
  id: string;
  projectId: string;
  projectName: string;
  kind: RunKind;
  team: string;
  goal: string;
  status: RunStatus;
  reason?: string;
  startedAt: string;
  finishedAt?: string;
  branch?: string;
  base?: string;
  loops: number;
  maxLoops?: number;
  costUsd: number;
  tokens: number;
  errors: number;
  agents: AgentState[];
  steps: StepState[];
  filesChanged: string[];
  /** The run's worktrees were removed to free disk space (chat recreates them on demand). */
  worktreesRemoved: boolean;
  /** The run worked directly in a plain folder (no git); `undone`: its changes were undone. */
  folder?: { undone: boolean };
  /** A question waits for you and the team is on hold until you answer it. */
  paused: boolean;
  questions: QuestionView[];
  requests: RequestView[];
  /**
   * The plan's usage limit: members waiting for it to reset (waiting, until
   * when they continue), or the run stopped because of it (resetsAt).
   */
  limit?: { waiting: boolean; resetsAt?: string; until?: string; agents: string[] };
  /** A restart of this run: scheduled for `at`, or done as run `runId`. */
  restart?: { at?: string; runId?: string };
}

export interface ChatItem {
  id: number;
  ts: string;
  kind: 'human' | 'agent' | 'tool' | 'note' | 'error';
  text: string;
  step?: string;
  /** Human message still waiting to be read. */
  pending?: boolean;
  /** How a human message is delivered: next turn, while working, or by interrupting. */
  delivery?: 'queue' | 'steer' | 'interrupt';
  /** Files sent with a human message. */
  attachments?: SentFile[];
}

/** A file a person gave a run (see engine/attachments.ts). */
export interface SentFile {
  name: string;
  /** Where it is on this computer. */
  path: string;
  size: number;
  kind: 'image' | 'pdf' | 'video' | 'audio' | 'document' | 'text' | 'file';
}

/** A member as the team file defines it (member details in the office). */
export interface MemberInfo {
  name: string;
  description?: string;
  model?: string;
  effort?: Effort;
  thinking?: Thinking;
  tools: string[];
  /** Globs it may change; undefined = anything in its worktree. */
  writeScope?: string[];
  writes: boolean;
  canMessage: string[];
  canRequest: string[];
  /** Answers teammates' questions first. */
  lead: boolean;
  /** Maintains the project brain. */
  curator: boolean;
}

export interface RunDetail {
  summary: RunSummary;
  /** The team's members as its file defines them now; empty when the file cannot be loaded. */
  members: MemberInfo[];
  events: RunEvent[];
  threads: Record<string, ChatItem[]>;
  /** The latest report of every step that finished, in workflow order. */
  reports: StepReport[];
  /** The step that plans the work (a step named "plan", or the first whose report lists tasks), if any. */
  planStep?: string;
  /** The run's todo list: the planner's tasks, each for one member, and where each stands now. */
  tasks: TaskView[];
  /** Whether a chat message right now is queued (live run) or answered immediately. */
  chatMode: 'queue' | 'answer';
  /** The run was started by this app and can be stopped from it. */
  canStop: boolean;
  /** Members answering a chat message right now. */
  answering: string[];
  /** Absolute paths the UI shows relative (the project folder). */
  roots: string[];
  /** Members with a tab open in covibe's browser in this app (watch and control them live). */
  browsers: LiveBrowser[];
}

/** A member's tab in covibe's browser, as the live view shows it. */
export interface LiveBrowser {
  agent: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** Who acts in the tab: the member, or a person who took control. */
  control: 'member' | 'human';
  /** Which browser runs it ("covibe’s built-in Chromium", "Chromium (Playwright)"). */
  provider: string;
}

export interface UsageWindow {
  window: string;
  /** The Claude account the report came from ("main" or unset: your own login). */
  account?: string;
  status: string;
  utilization?: number;
  resetsAt?: number;
  seenAt: string;
}

/** The plan's limits as the app shows them (sidebar, Home, run countdowns). */
export interface UsageReport {
  /** "claude": read from Claude Code like /usage does; "codex": read from the ChatGPT account; "runs": the last values members' turns reported; "none": nothing known yet. */
  source: 'claude' | 'codex' | 'runs' | 'none';
  subscription?: string;
  windows: {
    window: string;
    label: string;
    /** Fraction used, 0..1. */
    utilization?: number;
    /** ISO time the window resets. */
    resetsAt?: string;
    /** allowed | allowed_warning | rejected, when a turn reported it. */
    status?: string;
  }[];
  extra?: { enabled: boolean; limit: number | null; used: number | null; utilization: number | null; currency?: string };
  checkedAt: string;
  /** Your other Claude accounts and your ChatGPT accounts (Settings → Advanced); the fields above are your own login's. */
  accounts?: AccountUsage[];
  /** Members share work across the Claude accounts. */
  balance?: boolean;
}

export interface AccountUsage {
  id: string;
  label: string;
  /** A Claude account, or a ChatGPT account (Codex). */
  kind: 'claude' | 'codex';
  email?: string;
  usage: Omit<UsageReport, 'accounts' | 'balance'>;
}

/** A Claude account's sign-in, as Claude Code reports it; a ChatGPT account's, from its tokens (subscriptionType is the ChatGPT plan). */
export interface AccountInfo {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  organization?: string;
}

/** Settings → Advanced. */
export interface ConnectionsInfo {
  connections: (ConnectionView & { account?: AccountInfo })[];
  /** Your own claude login. */
  main?: AccountInfo;
  balance: boolean;
  /** Where keys are kept: the macOS Keychain, or a private file. */
  secretStore: 'keychain' | 'file';
}

export interface Stats {
  costUsd: { today: number; week: number; month: number; all: number };
  tokens: { today: number; week: number; all: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  runs: { total: number; running: number; succeeded: number; escalated: number; failed: number; questions: number };
  activeAgents: number;
  /** Last 14 days, oldest first. */
  daily: { day: string; costUsd: number; tokens: number; runs: number }[];
  byAgent: { agent: string; team: string; costUsd: number; tokens: number; turns: number }[];
  byModel: { model: string; costUsd: number; tokens: number }[];
  byTeam: { team: string; costUsd: number; runs: number }[];
  /** Spend per account or provider: "claude" (your login), "claude:<account>", a connection id, or a backend type. */
  byVia: { via: string; label: string; costUsd: number; tokens: number; turns: number }[];
  /** Plan usage windows reported by Claude Code (subscription). */
  usage: UsageWindow[];
  gatePassRate?: number;
}

export interface TeamSummaryAgent {
  name: string;
  description?: string;
  model?: string;
  tools: string[];
  writeScope?: string[];
  backend: string;
  canMessage: string[];
  writes: boolean;
  promptFile?: string;
  outputSchema: boolean;
}

export interface TeamDetail {
  id: string;
  dir: string;
  yaml: string;
  /** team.yaml as plain data (even when invalid), for the form editors. */
  doc: Record<string, unknown>;
  problems: string[];
  files: { path: string; size: number }[];
  /** What applies when the team file leaves the sandbox lists out. */
  sandboxDefaults: { network: string[]; allowWrite: string[] };
}

// ---- git (the project's own checkout; see server/gitops.ts)

export interface GitCommit {
  sha: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  /** Branch and tag names pointing at it, as git log %D prints them ("HEAD -> main", "origin/main", "tag: v1"). */
  refs: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Its upstream was deleted on the remote. */
  gone: boolean;
  date: string;
  sha: string;
  subject: string;
  /** A run's result branch (covibe/<run>). */
  run: boolean;
}

export interface GitFile {
  path: string;
  /** Some of its change is staged (goes into the next commit). */
  staged: boolean;
  /** Some of its change is not staged yet (new files count as unstaged). */
  unstaged: boolean;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'new' | 'conflict';
  /** A renamed file's old path. */
  from?: string;
}

export interface GitRemoteBranch {
  /** As git names it: "origin/feature". */
  name: string;
  remote: string;
  /** The branch's name on the remote: "feature". */
  branch: string;
  date: string;
  sha: string;
  subject: string;
  /** A local branch tracks it. */
  tracked: boolean;
}

/** A merge, rebase, cherry-pick, revert, bisect, or a stash that did not apply cleanly, still in progress. */
export interface GitOperation {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | 'stash';
  subject: string;
  /** Files with conflicts still to resolve. */
  conflicts: string[];
  /** What "current" and "incoming" mean for this operation (a rebase swaps them). */
  labels: { current: string; incoming: string };
  /** It can skip the commit it stopped at (rebase, cherry-pick, revert). */
  canSkip: boolean;
}

export interface GitOverview {
  /** Checked-out branch; undefined when HEAD is detached. */
  branch?: string;
  detached: boolean;
  /** The current commit; undefined before the first one. */
  head?: string;
  /** Uncommitted changes. */
  files: GitFile[];
  branches: GitBranch[];
  /** Branches on the remotes ("origin/feature"). */
  remoteBranches: GitRemoteBranch[];
  /** Recent commits of every branch (members' working branches left out), newest first. */
  commits: GitCommit[];
  remotes: { name: string; url: string; web?: string }[];
  stashes: { index: number; ref: string; message: string; date: string }[];
  tags: { name: string; sha: string }[];
  operation?: GitOperation;
  /** The name and email commits record; missing ones make commits fail. */
  identity: { name?: string; email?: string };
  /** When the remotes were last fetched. */
  fetchedAt?: string;
  defaultBranch?: string;
  /** How pull requests are made: with gh, by opening the forge's page, or not at all (no remote). */
  pullRequests: 'gh' | 'browser' | 'none';
}

/** What kind of trouble a git command ran into (see gitops.ts problem()). */
export type GitProblemKind =
  | 'auth'
  | 'network'
  | 'lock'
  | 'identity'
  | 'signing'
  | 'dirty'
  | 'in_progress'
  | 'conflict'
  | 'diverged'
  | 'rejected'
  | 'no_upstream'
  | 'no_remote'
  | 'detached'
  | 'unmerged'
  | 'hook'
  | 'nothing'
  | 'timeout'
  | 'not_found'
  | 'invalid'
  | 'other';

/** One entry in a conversation with the git helper. */
export type HelperItem =
  | { id: number; ts: string; kind: 'human' | 'agent' | 'tool' | 'note' | 'error'; text: string }
  /** A read-only command it ran by itself. */
  | { id: number; ts: string; kind: 'command'; program: 'git' | 'gh'; args: string[]; ok: boolean; output: string }
  /** A command that changes something, waiting for the person (or run, declined, or no longer waiting). */
  | { id: number; ts: string; kind: 'proposal'; proposal: string; program: 'git' | 'gh'; args: string[]; why?: string; warning?: string; state: 'waiting' | 'ran' | 'skipped' | 'expired'; ok?: boolean; output?: string };

export interface HelperDetail {
  runId: string;
  busy: boolean;
  thread: HelperItem[];
  costUsd: number;
}

/** The body of an error response from a git operation. */
export interface GitProblemInfo {
  kind: GitProblemKind;
  hint?: string;
  detail?: string;
  command?: string;
}

/** A backlog goal as the app shows it: where it stands, and its latest run. */
export interface GoalView extends Goal {
  status: 'checking' | 'needs_info' | 'ready' | 'running' | 'succeeded' | 'failed' | 'escalated';
  run?: RunSummary;
}

/** Why the backlog's next goal has not started. */
export type BacklogState =
  | { kind: 'idle' }
  | { kind: 'working'; goalId: number }
  | { kind: 'paused' }
  /** Plan usage is at or above Settings' threshold: the next goal starts after `until` (when known). */
  | { kind: 'waiting'; until?: string; window: string; label: string; used: number; account?: string };

export interface BacklogView {
  settings: BacklogSettings;
  /** The usage threshold from Settings (percent), or null. */
  maxUsage: number | null;
  goals: GoalView[];
  state: BacklogState;
}
