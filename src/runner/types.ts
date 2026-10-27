import type { JsonSchema, SandboxConfig, SettingSource } from '../config/types.js';
import type { Env } from './backend.js';

/** What the engine asks a runner to do: one turn of one agent. */
export interface AgentInvocation {
  agentName: string;
  /** The user turn for this invocation. */
  prompt: string;
  /** Role prompt plus team protocol; appended to Claude Code's own system prompt. */
  systemPrompt: string;
  cwd: string;
  /** Resume this session instead of starting a new one. */
  resumeSessionId?: string;
  /** Resume into a copy of the session, leaving the original untouched (the lead answering a question mid-run). */
  forkSession?: boolean;
  model?: string;
  tools: string[];
  outputSchema?: JsonSchema;
  env: Env;
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

/** A tool covibe implements in-process and offers to an agent. */
export interface CustomTool {
  name: string;
  description: string;
  params: Record<string, CustomParam>;
  /** Returns the text the agent sees. Throwing reports the error to the agent. */
  run(args: Record<string, unknown>): Promise<string> | string;
}

/** What Claude Code offers on this machine, read without running a turn. */
export interface EnvironmentInfo {
  skills: { name: string; description: string }[];
  account?: { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string };
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
  | { kind: 'rate_limit'; info: RateLimitInfo };

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
}

/**
 * The seam between the engine and whatever executes agents. The Claude Agent
 * SDK implementation lives in claude-sdk.ts; tests use a scripted fake.
 */
export interface AgentRunner {
  run(invocation: AgentInvocation): Promise<AgentResult>;
  /** Built-in skills and account details (optional; the SDK runner implements it). */
  discover?(env: Env): Promise<EnvironmentInfo>;
}
