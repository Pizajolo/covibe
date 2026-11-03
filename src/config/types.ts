// The typed model the engine runs on. Team files are YAML on disk; the loader
// validates them against schemas/team.schema.json and resolves them into these
// shapes (prompt text loaded, output schemas parsed, defaults applied).
import type { AppConfig } from '../apps/config.js';

export type BackendType = 'subscription' | 'api_key' | 'gateway' | 'bedrock' | 'vertex' | 'connection';

export interface BackendConfig {
  type: BackendType;
  /** subscription: one of the Claude accounts in Settings → Advanced (unset = your own claude login). */
  account?: string;
  /** connection: a provider set up in Settings → Advanced. */
  connection?: string;
  base_url?: string;
  model?: string;
  api_key_env?: string;
  auth_token_env?: string;
  region?: string;
  project?: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Extended thinking: Claude decides (adaptive), none, or a fixed token budget. */
export type Thinking = 'adaptive' | 'off' | number;
/** How long Claude keeps a member's prompt cache. */
export type CacheTtl = '5m' | '1h';

export interface Limits {
  max_turns: number;
  timeout_min: number;
  max_budget_usd?: number;
}

export type Isolation = 'worktree' | 'none';
export type SettingSource = 'user' | 'project' | 'local';

/** OS-level confinement for a member's shell commands. Absent = not sandboxed. */
export interface SandboxConfig {
  /** Domains shell commands may reach. */
  network: string[];
  /** Extra absolute folders shell commands may write (besides the working folder and temp). */
  allowWrite: string[];
  /** Absolute paths shell commands may not write, even inside the working folder (a plain folder outside the write scope). */
  denyWrite?: string[];
}

export interface AgentConfig {
  name: string;
  description?: string;
  /** Resolved prompt text. */
  prompt: string;
  /** File the prompt came from, if any (for error messages and the UI). */
  promptFile?: string;
  model?: string;
  /** Unset = the model's default. */
  effort?: Effort;
  thinking?: Thinking;
  /** Unset = Claude Code decides (1 hour on a subscription, 5 minutes on an API key). */
  cacheTtl?: CacheTtl;
  tools: string[];
  canMessage: string[];
  /** Teammates it may ask to do work for it (request_work); they run a turn of their own and reply. */
  canRequest: string[];
  /** Globs relative to the repo root. `undefined` = whole worktree, `[]` = nothing. */
  writeScope?: string[];
  outputSchema?: JsonSchema;
  backend: BackendConfig;
  limits: Limits;
  /** True when the agent can change files (an edit tool or Bash). */
  writes: boolean;
  /** Set when the agent has Bash and sandboxing is on. */
  sandbox?: SandboxConfig;
  /** Skill names (team defaults plus the agent's own). */
  skills: string[];
  /** Plugin names from the plugin library (team defaults plus the agent's own). */
  plugins: string[];
  /** Has covibe's browser tools (see browser/tools.ts). */
  browser: boolean;
  /** Has the app tools: run the project's app (see apps/tools.ts). */
  app: boolean;
}

export interface BrainConfig {
  curator?: string;
  curate: 'after_run' | 'manual';
  /** With after_run: review once at least this many proposals are waiting. */
  minProposals: number;
}

export interface GateFailPolicy {
  goto: string;
  maxLoops: number;
  feed: string[];
  then: 'escalate_to_human' | 'fail';
}

export interface Branch {
  agent: string;
  task?: string;
  outputSchema?: JsonSchema;
}

interface StepBase {
  id: string;
  instructions?: string;
  gate?: string;
  onGateFail?: GateFailPolicy;
  /** Runs in full whatever the planner chose (see engine/selection.ts): the planner cannot leave it out, and a fix round reruns all its branches. */
  required?: boolean;
}

export interface AgentStep extends StepBase {
  kind: 'agent';
  agent: string;
  task?: string;
  outputSchema?: JsonSchema;
}

export interface ParallelStep extends StepBase {
  kind: 'parallel';
  branches: Branch[];
}

export type Step = AgentStep | ParallelStep;

export interface TeamConfig {
  name: string;
  description?: string;
  /** Absolute path of the team file. */
  file: string;
  isolation: Isolation;
  maxParallel: number;
  settingSources: SettingSource[];
  agents: Record<string, AgentConfig>;
  steps: Step[];
  brain: BrainConfig;
  /** The member other members ask first when they need a decision; unset = questions go straight to the human. */
  lead?: string;
  /** How to run the project's app (the `app:` section); unset = worked out from the project. */
  app?: AppConfig;
}

export type JsonSchema = Record<string, unknown>;
