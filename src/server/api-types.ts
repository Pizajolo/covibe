// Shapes the HTTP API returns. The UI imports these types directly.
import type { RunEvent, RunKind, RunStatus } from '../events/types.js';

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
  /** Model the team architect uses in design chats. */
  designerModel?: string;
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

export type AgentActivity = 'idle' | 'working' | 'done' | 'error' | 'waiting';

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
  updatedAt?: string;
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

export interface RunDetail {
  summary: RunSummary;
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
