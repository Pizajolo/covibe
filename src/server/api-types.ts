// Shapes the HTTP API returns. The UI imports these types directly.
import type { RunEvent, RunKind, RunStatus } from '../events/types.js';
import type { Effort, Thinking } from '../config/types.js';

export type { Effort, Thinking } from '../config/types.js';
export type { EnvironmentInfo, ModelChoice, PlanUsage } from '../runner/types.js';

export type { RunEvent, RunKind, RunStatus };

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: string;
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
  /** When the plan's usage limit stops a member: wait for the reset and continue (default), or stop the run. */
  onLimit?: 'wait' | 'stop';
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

export interface DiffResult {
  files: { path: string; additions: number; deletions: number }[];
  patch: string;
  range?: string;
  note?: string;
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
  /** Set when its latest turn drives a browser (Playwright, Chromium…): the page it last named, if any. */
  browser?: { url?: string; since: string };
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
  /** A question waits for you and the team is on hold until you answer it. */
  paused: boolean;
  questions: QuestionView[];
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
  /** Whether a chat message right now is queued (live run) or answered immediately. */
  chatMode: 'queue' | 'answer';
  /** The run was started by this app and can be stopped from it. */
  canStop: boolean;
  /** Members answering a chat message right now. */
  answering: string[];
  /** Absolute paths the UI shows relative (the project folder). */
  roots: string[];
}

export interface UsageWindow {
  window: string;
  status: string;
  utilization?: number;
  resetsAt?: number;
  seenAt: string;
}

/** The plan's limits as the app shows them (sidebar, Home, run countdowns). */
export interface UsageReport {
  /** "claude": read from Claude Code like /usage does; "runs": the last values members' turns reported; "none": nothing known yet. */
  source: 'claude' | 'runs' | 'none';
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
}

export interface Stats {
  costUsd: { today: number; week: number; month: number; all: number };
  tokens: { today: number; week: number; all: number; input: number; output: number; cacheRead: number };
  runs: { total: number; running: number; succeeded: number; escalated: number; failed: number; questions: number };
  activeAgents: number;
  /** Last 14 days, oldest first. */
  daily: { day: string; costUsd: number; tokens: number; runs: number }[];
  byAgent: { agent: string; team: string; costUsd: number; tokens: number; turns: number }[];
  byModel: { model: string; costUsd: number; tokens: number }[];
  byTeam: { team: string; costUsd: number; runs: number }[];
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

export interface GitOverview {
  /** Checked-out branch; undefined when HEAD is detached. */
  branch?: string;
  detached: boolean;
  /** Uncommitted changes. */
  files: { path: string; staged: boolean; state: 'modified' | 'added' | 'deleted' | 'renamed' | 'new' | 'conflict' }[];
  branches: GitBranch[];
  /** Recent commits of every branch (members' working branches left out), newest first. */
  commits: GitCommit[];
  remotes: { name: string; url: string; web?: string }[];
  defaultBranch?: string;
  /** How pull requests are made: with gh, by opening the forge's page, or not at all (no remote). */
  pullRequests: 'gh' | 'browser' | 'none';
}
