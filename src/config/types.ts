// The typed model the engine runs on. Team files are YAML on disk; the loader
// validates them against schemas/team.schema.json and resolves them into these
// shapes (prompt text loaded, output schemas parsed, defaults applied).

export type BackendType = 'subscription' | 'api_key' | 'gateway' | 'bedrock' | 'vertex';

export interface BackendConfig {
  type: BackendType;
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
  tools: string[];
  canMessage: string[];
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
}

export interface BrainConfig {
  curator?: string;
  curate: 'after_run' | 'manual';
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
}

export type JsonSchema = Record<string, unknown>;
