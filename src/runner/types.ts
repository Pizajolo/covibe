import type { JsonSchema, SettingSource } from '../config/types.js';
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
  /** Deliver a message to a teammate's inbox; returns the text shown to the agent. */
  sendMessage(to: string, text: string): string;
  onEvent(event: AgentStreamEvent): void;
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
}
