import type { Effort, JsonSchema, SandboxConfig, SettingSource, Thinking } from '../config/types.js';
import type { Pricing } from '../connections/types.js';
import type { Env } from './backend.js';

/** What the engine asks a runner to do: one turn of one agent. */
export interface AgentInvocation {
  agentName: string;
  /** The user turn for this invocation. */
  prompt: string;
  /** Role prompt plus team protocol; appended to Claude Code's own system prompt. */
  systemPrompt: string;
  /** Use systemPrompt instead of Claude Code's own (a turn without tools, such as writing a summary). */
  ownSystemPrompt?: boolean;
  cwd: string;
  /** Resume this session instead of starting a new one. */
  resumeSessionId?: string;
  /** Resume into a copy of the session, leaving the original untouched (the lead answering a question mid-run). */
  forkSession?: boolean;
  model?: string;
  effort?: Effort;
  thinking?: Thinking;
  tools: string[];
  outputSchema?: JsonSchema;
  env: Env;
  /** Prices for the spend estimate when the model is not Claude (Claude Code prices everything as Claude). */
  pricing?: Pricing;
  maxTurns: number;
  maxBudgetUsd?: number;
  settingSources: SettingSource[];
  signal: AbortSignal;
  /** Teammates this agent may message. Empty = no messaging tool. */
  canMessage: string[];
  /** Called before every tool use. Return a reason to deny it, or undefined to allow. */
  checkToolUse(tool: string, input: unknown): string | undefined;
  /** Awaited before every tool use: the engine holds the agent here while its run is paused. */
  beforeToolUse?(): Promise<void>;
  /** Deliver a message to a teammate's inbox; returns the text shown to the agent. */
  sendMessage(to: string, text: string): string;
  onEvent(event: AgentStreamEvent): void;
  /** OS sandbox for shell commands; absent = unsandboxed. */
  sandbox?: SandboxConfig;
  /** Extra folders the agent may read with its file tools (e.g. the project brain). */
  readDirs?: string[];
  /** Skills the agent may use (SDK names, e.g. "covibe:pdf" or a built-in "dataviz"), and the plugin folders that hold them. */
  skills?: { names: string[]; pluginDirs: string[] };
  /**
   * Plugins from the library: folders to load (their hooks and servers already
   * start through the sandbox launcher), their skills, and the permission
   * rules for their MCP servers' tools.
   */
  plugins?: { dirs: string[]; skills: string[]; mcpTools: string[] };
  /** Tools covibe provides to this agent (proposing to the brain, editing a team…). */
  customTools?: CustomTool[];
  /**
   * Called with a control handle once the agent is working, and with null when
   * it can no longer take messages (its turn is over).
   */
  onControl?(control: AgentControl | null): void;
}

/**
 * How a message reaches an agent that is working right now: "next" joins the
 * running turn between tool calls; "now" stops the current turn and starts a
 * new one with the message.
 */
export type LivePriority = 'next' | 'now';

export type CustomParam =
  | { type: 'string' | 'number' | 'boolean'; description: string; optional?: boolean; enum?: string[] }
  | { type: 'files'; description: string; optional?: boolean }
  | { type: 'list'; description: string; optional?: boolean };

/** What a custom tool answers: text, or text with images the agent sees (a screenshot; base64 data). */
export type ToolOutput = string | { text: string; images?: { data: string; mediaType: string }[] };

/** A tool covibe implements in-process and offers to an agent. */
export interface CustomTool {
  name: string;
  description: string;
  params: Record<string, CustomParam>;
  /** Returns what the agent sees. Throwing reports the error to the agent. */
  run(args: Record<string, unknown>): Promise<ToolOutput> | ToolOutput;
}

/** A tool answer as plain text (images dropped). */
export function outputText(out: ToolOutput): string {
  return typeof out === 'string' ? out : out.text;
}

/** What Claude Code offers on this machine, read without running a turn. */
export interface EnvironmentInfo {
  skills: { name: string; description: string }[];
  /** The models Claude Code offers this account, with the effort levels each supports. */
  models?: ModelChoice[];
  account?: { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string };
}

export interface ModelChoice {
  /** What goes in the team file (an alias such as "opus", or a model id). */
  value: string;
  name: string;
  description: string;
  /** The model id the alias stands for right now. */
  resolved?: string;
  efforts: Effort[];
  adaptiveThinking: boolean;
}

/** Plan usage as Claude Code reports it (the data behind /usage), without running a model. */
export interface PlanUsage {
  available: boolean;
  subscription?: string;
  windows: { window: string; label: string; utilization: number | null; resetsAt: string | null }[];
  extra?: { enabled: boolean; limit: number | null; used: number | null; utilization: number | null; currency?: string };
}

export interface AgentControl {
  /** Returns false when the agent can no longer take messages; deliver at its next turn instead. */
  send(text: string, priority: LivePriority): boolean;
}

export type AgentStreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; input: unknown }
  | { kind: 'denied'; tool: string; input: unknown; reason: string }
  /** Subscription plan usage, as reported by Claude Code. */
  | { kind: 'rate_limit'; info: RateLimitInfo }
  /** Tokens used so far in this invocation, and their estimated cost (undefined when the model's prices are unknown). */
  | { kind: 'usage'; tokens: TokenUsage; costUsd?: number }
  /** An image in a tool's result, which the agent sees (a screenshot it read, say); base64 data. */
  | { kind: 'image'; tool: string; input: unknown; mediaType: string; data: string }
  /** Claude Code's process stopped mid-turn (`error` says how); the runner picks the session up again. */
  | { kind: 'restarted'; attempt: number; error: string };

export interface RateLimitInfo {
  status: string;
  window?: string;
  /** Fraction of the window used, 0..1, when reported. */
  utilization?: number;
  resetsAt?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AgentResult {
  ok: boolean;
  sessionId?: string;
  /** Final assistant text. */
  text: string;
  /** Structured output when an output schema was requested. */
  structured?: unknown;
  error?: string;
  turns: number;
  /** Estimated cost in USD (on a subscription this is what the usage would cost on the API). */
  costUsd: number;
  durationMs: number;
  tokens?: TokenUsage;
  /** Set when the plan's usage limit stopped the turn: when it resets (epoch seconds), if known. */
  limit?: { resetsAt?: number; window?: string };
}

/**
 * The seam between the engine and whatever executes agents. The Claude Agent
 * SDK implementation lives in claude-sdk.ts; tests use a scripted fake.
 */
export interface AgentRunner {
  run(invocation: AgentInvocation): Promise<AgentResult>;
  /** Built-in skills and account details (optional; the SDK runner implements it). */
  discover?(env: Env): Promise<EnvironmentInfo>;
  /** The plan's usage windows, when the runner can read them. */
  usage?(env: Env): Promise<PlanUsage>;
}
