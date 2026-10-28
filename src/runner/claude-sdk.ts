// The only module that imports the Claude Agent SDK. SDK upgrades and API
// changes should touch this file and nothing else.
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { claudeConfigDirs, mainConfigDir, priceOf } from '../connections/store.js';
import type { Env } from './backend.js';
import type { AgentInvocation, AgentResult, AgentRunner, CustomTool, EnvironmentInfo, LivePriority, PlanUsage, TokenUsage } from './types.js';

const TEAM_SERVER = 'team';
const SEND_MESSAGE_TOOL = `mcp__${TEAM_SERVER}__send_message`;
const COVIBE_SERVER = 'covibe';
/** After a turn ends with messages still unread, how long to wait for the turn that reads them. */
const FOLLOW_UP_WAIT_MS = 30_000;
/** Longest a member may wait for an answer to its question, or in a paused run. */
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;

/** The prompt stream: the agent's first message, then anything sent while it works. */
class Input implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string, priority?: LivePriority): string {
    const uuid = randomUUID();
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid, ...(priority ? { priority } : {}) } as SDKUserMessage);
    this.wake?.();
    return uuid;
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  get isClosed() {
    return this.closed;
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

export class ClaudeSdkRunner implements AgentRunner {
  discover(env: Env): Promise<EnvironmentInfo> {
    return discoverEnvironment(env);
  }

  usage(env: Env): Promise<PlanUsage> {
    return readPlanUsage(env);
  }

  async run(inv: AgentInvocation): Promise<AgentResult> {
    const result = await this.turn(inv);
    // Claude Code prices every model as Claude; another provider's model gets its own prices.
    if (inv.pricing && result.tokens) result.costUsd = priceOf(inv.pricing, result.tokens);
    return result;
  }

  private async turn(inv: AgentInvocation): Promise<AgentResult> {
    const started = Date.now();
    // A session started on another Claude account lives in that account's
    // config folder; bring it over so this account can pick it up.
    if (inv.resumeSessionId) carrySession(inv.resumeSessionId, mainConfigDir(inv.env), claudeConfigDirs());
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    inv.signal.addEventListener('abort', onAbort, { once: true });

    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      await inv.beforeToolUse?.();
      const reason = inv.checkToolUse(input.tool_name, input.tool_input);
      if (!reason) return {};
      inv.onEvent({ kind: 'denied', tool: input.tool_name, input: input.tool_input, reason });
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      };
    };

    const custom = inv.customTools ?? [];
    const mcpServers: Options['mcpServers'] = {};
    if (inv.canMessage.length) mcpServers[TEAM_SERVER] = teamServer(inv);
    if (custom.length) mcpServers[COVIBE_SERVER] = customServer(custom);
    const skillNames = inv.skills?.names ?? [];
    const tools = skillNames.length ? [...inv.tools, 'Skill'] : inv.tools;

    const options: Options = {
      cwd: inv.cwd,
      additionalDirectories: inv.readDirs,
      plugins: inv.skills?.pluginDirs.map((path) => ({ type: 'local' as const, path, skipMcpDiscovery: true })),
      // Only the listed skills are visible to this agent.
      skills: skillNames.length ? skillNames : undefined,
      // A member waiting for an answer sits in a tool call (ask_question) or a
      // hook (run paused); lift Claude Code's limits on both to the longest wait.
      env: { MCP_TOOL_TIMEOUT: String(MAX_WAIT_MS), ...inv.env },
      model: inv.model,
      effort: inv.effort,
      thinking: inv.thinking === undefined ? undefined : inv.thinking === 'adaptive' ? { type: 'adaptive' } : inv.thinking === 'off' ? { type: 'disabled' } : { type: 'enabled', budgetTokens: inv.thinking },
      abortController,
      resume: inv.resumeSessionId,
      forkSession: inv.forkSession && !!inv.resumeSessionId,
      // Built-in tools are limited to the agent's list and pre-approved; anything
      // else is denied without prompting, since nobody is at the terminal.
      tools,
      allowedTools: [...tools, ...(inv.canMessage.length ? [SEND_MESSAGE_TOOL] : []), ...custom.map((t) => `mcp__${COVIBE_SERVER}__${t.name}`)],
      permissionMode: 'dontAsk',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: inv.systemPrompt },
      settingSources: inv.settingSources,
      maxTurns: inv.maxTurns,
      maxBudgetUsd: inv.maxBudgetUsd,
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: MAX_WAIT_MS / 1000 }] },
      outputFormat: inv.outputSchema ? { type: 'json_schema', schema: inv.outputSchema } : undefined,
      mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
      // Shell commands run in the OS sandbox: writes stay in the working folder,
      // temp and the allowed caches; network only to listed domains; no escape hatch.
      sandbox: inv.sandbox
        ? {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: inv.sandbox.network },
            filesystem: { allowWrite: inv.sandbox.allowWrite },
          }
        : undefined,
    };

    // Streaming input, so messages can reach the agent while it works. Each
    // message is tagged; the run ends once a turn's result shows every tagged
    // message was read (a "now" message ends one turn and starts another).
    const input = new Input();
    const unread = new Set<string>([input.push(inv.prompt)]);
    inv.onControl?.({
      send: (text, priority) => {
        if (input.isClosed) return false;
        unread.add(input.push(text, priority));
        return true;
      },
    });
    let followUp: NodeJS.Timeout | undefined;
    const stop = () => {
      clearTimeout(followUp);
      inv.onControl?.(null);
      input.close();
    };

    let sessionId = inv.resumeSessionId;
    /** Tool calls by id, so an image in a result can say which call showed it. */
    const calls = new Map<string, { tool: string; input: unknown }>();
    let lastText = '';
    /** The plan limit a turn ran into, if any. */
    let rejected: AgentResult['limit'];
    let last: SDKResultMessage | undefined;
    let turns = 0;
    try {
      for await (const msg of query({ prompt: input, options }) as AsyncIterable<SDKMessage>) {
        clearTimeout(followUp);
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id;
          inv.onEvent({ kind: 'session', sessionId });
        } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              lastText = block.text;
              inv.onEvent({ kind: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              calls.set(block.id, { tool: block.name, input: block.input });
              inv.onEvent({ kind: 'tool', tool: block.name, input: block.input });
            }
          }
        } else if (msg.type === 'user' && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
          for (const img of resultImages(msg.message.content)) {
            const call = calls.get(img.toolUseId);
            inv.onEvent({ kind: 'image', tool: call?.tool ?? 'unknown', input: call?.input ?? null, mediaType: img.mediaType, data: img.data });
          }
        } else if (msg.type === 'rate_limit_event') {
          const info = msg.rate_limit_info;
          if (info.status === 'rejected') rejected = { resetsAt: info.resetsAt, window: info.rateLimitType };
          inv.onEvent({ kind: 'rate_limit', info: { status: info.status, window: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt } });
        } else if (msg.type === 'result') {
          last = msg;
          turns += msg.num_turns;
          const consumed = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : null);
          // Older CLIs do not report what a turn read; then the first result ends the run.
          if (consumed) for (const u of consumed) unread.delete(u);
          else unread.clear();
          if (!unread.size) stop();
          else followUp = setTimeout(stop, FOLLOW_UP_WAIT_MS);
        }
      }
    } catch (err) {
      stop();
      const error = inv.signal.aborted ? 'aborted (timeout or cancel)' : (err as Error).message;
      const limit = inv.signal.aborted ? undefined : limitOf(error, rejected);
      return { ok: false, sessionId, text: lastText, error, turns, costUsd: last?.total_cost_usd ?? 0, durationMs: Date.now() - started, ...(limit ? { limit } : {}) };
    } finally {
      stop();
      inv.signal.removeEventListener('abort', onAbort);
    }

    if (!last) {
      const limit = limitOf(lastText, rejected);
      return { ok: false, sessionId, text: lastText, error: limit ? lastText || 'usage limit reached' : 'session ended without a result', turns, costUsd: 0, durationMs: Date.now() - started, ...(limit ? { limit } : {}) };
    }
    // Cost and usage are running totals across the turns of one query().
    const base = { sessionId: last.session_id, turns, costUsd: last.total_cost_usd, durationMs: Date.now() - started, tokens: tokensOf(last) };
    if (last.subtype === 'success' && !last.is_error) return { ...base, ok: true, text: last.result || lastText, structured: last.structured_output };
    const error = last.subtype === 'success' ? last.result : [last.subtype, ...last.errors].join(': ');
    const limit = limitOf(error, rejected);
    return { ...base, ok: false, text: lastText, error, ...(limit ? { limit } : {}) };
  }
}

/**
 * Read Claude Code's built-in skills and the signed-in account. The init
 * message arrives before any model call, and the session is closed right
 * then, so this costs nothing.
 */
export async function discoverEnvironment(env: Env): Promise<EnvironmentInfo> {
  const q = query({ prompt: 'hi', options: { cwd: process.cwd(), env, settingSources: [], tools: ['Skill'], permissionMode: 'dontAsk', maxTurns: 1 } });
  const timer = setTimeout(() => q.close(), 30_000);
  try {
    const [account, commands, models] = await Promise.all([
      q.accountInfo().catch(() => undefined),
      q.supportedCommands().catch(() => []),
      q.supportedModels().catch(() => []),
    ]);
    let names: string[] = [];
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        names = (msg as { skills?: string[] }).skills ?? [];
        break;
      }
    }
    const describe = new Map(commands.map((c) => [c.name, c.description]));
    return {
      skills: names.map((name) => ({ name, description: describe.get(name) ?? '' })),
      account,
      models: models.map((m) => ({
        value: m.value,
        name: m.displayName,
        description: m.description,
        resolved: m.resolvedModel,
        efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
        adaptiveThinking: !!m.supportsAdaptiveThinking,
      })),
    };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour session',
  seven_day: 'Weekly (all models)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_oauth_apps: 'Weekly (apps)',
};

/**
 * The plan's usage windows, read like /usage does: no model call. The SDK
 * marks this API experimental, so anything unexpected reads as "not available"
 * and the app falls back to the usage members' turns reported.
 */
export async function readPlanUsage(env: Env): Promise<PlanUsage> {
  // An empty prompt stream: the session starts and answers control requests, but no message is ever sent.
  const input = new Input();
  const q = query({ prompt: input, options: { cwd: process.cwd(), env, settingSources: [], tools: [], permissionMode: 'dontAsk', maxTurns: 1 } });
  const timer = setTimeout(() => q.close(), 30_000);
  try {
    const read = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<SDKControlGetUsageResponse> })
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (!read) return { available: false, windows: [] };
    const u = await read.call(q, { skipBehaviors: true });
    const limits = u.rate_limits_available ? u.rate_limits : null;
    if (!limits) return { available: false, subscription: u.subscription_type ?? undefined, windows: [] };
    const windows: PlanUsage['windows'] = [];
    for (const [key, label] of Object.entries(WINDOW_LABELS)) {
      const w = (limits as Record<string, { utilization: number | null; resets_at: string | null } | null | undefined>)[key];
      if (w) windows.push({ window: key, label, utilization: w.utilization, resetsAt: w.resets_at });
    }
    for (const m of limits.model_scoped ?? []) windows.push({ window: `model:${m.display_name}`, label: `Weekly (${m.display_name})`, utilization: m.utilization, resetsAt: m.resets_at });
    const x = limits.extra_usage;
    return {
      available: true,
      subscription: u.subscription_type ?? undefined,
      windows,
      extra: x ? { enabled: x.is_enabled, limit: x.monthly_limit, used: x.used_credits, utilization: x.utilization, currency: x.currency ?? undefined } : undefined,
    };
  } catch {
    return { available: false, windows: [] };
  } finally {
    clearTimeout(timer);
    input.close();
    q.close();
  }
}

/**
 * Whether a failed turn ran into the plan's usage limit: Claude Code reported
 * a rejected rate limit, or says so in the error ("Claude AI usage limit
 * reached|<reset epoch>", "5-hour limit reached ∙ resets 3pm").
 */
export function limitOf(error: string, rejected: AgentResult['limit']): AgentResult['limit'] {
  const said = /usage limit|limit reached|rate.?limit/i.test(error);
  if (!rejected && !said) return undefined;
  const epoch = /\|(\d{10,13})\b/.exec(error)?.[1];
  const resetsAt = rejected?.resetsAt ?? (epoch ? Math.round(Number(epoch) / (epoch.length > 10 ? 1000 : 1)) : undefined);
  return { resetsAt, window: rejected?.window };
}

/**
 * Make a session's transcript available in `target` (a Claude Code config
 * folder), copying it from whichever of `dirs` has it. Claude Code keeps
 * sessions under <config>/projects/<folder for the working directory>/<id>.jsonl.
 */
export function carrySession(sessionId: string, target: string, dirs: string[]): boolean {
  const find = (dir: string) => {
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) return undefined;
    for (const p of readdirSync(projects)) if (existsSync(join(projects, p, `${sessionId}.jsonl`))) return p;
    return undefined;
  };
  if (find(target)) return true;
  for (const dir of dirs) {
    if (dir === target) continue;
    const project = find(dir);
    if (!project) continue;
    try {
      const from = join(dir, 'projects', project);
      const to = join(target, 'projects', project);
      mkdirSync(to, { recursive: true });
      copyFileSync(join(from, `${sessionId}.jsonl`), join(to, `${sessionId}.jsonl`));
      // Subagent transcripts and tool output files sit in a folder named after the session.
      if (existsSync(join(from, sessionId))) cpSync(join(from, sessionId), join(to, sessionId), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Base64 images inside tool results: what the agent sees of a screenshot it read or a browser tool returned. */
function resultImages(content: unknown[]): { toolUseId: string; mediaType: string; data: string }[] {
  const out: { toolUseId: string; mediaType: string; data: string }[] = [];
  for (const block of content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue;
    for (const part of block.content as { type?: string; source?: { type?: string; media_type?: string; data?: string } }[]) {
      if (part?.type === 'image' && part.source?.type === 'base64' && part.source.data) {
        out.push({ toolUseId: block.tool_use_id ?? '', mediaType: part.source.media_type ?? 'image/png', data: part.source.data });
      }
    }
  }
  return out;
}

function tokensOf(msg: SDKResultMessage): TokenUsage {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of Object.values(msg.modelUsage ?? {})) {
    tokens.input += u.inputTokens;
    tokens.output += u.outputTokens;
    tokens.cacheRead += u.cacheReadInputTokens;
    tokens.cacheWrite += u.cacheCreationInputTokens;
  }
  return tokens;
}

/** In-process MCP server giving an agent a send_message tool limited to its can_message list. */
function teamServer(inv: AgentInvocation) {
  const [first, ...rest] = inv.canMessage as [string, ...string[]];
  return createSdkMcpServer({
    name: TEAM_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        'Send a message to a teammate. If they are working it reaches them between their tool calls; otherwise at the start of their next turn. It never stops their work.',
        { to: z.enum([first, ...rest]), text: z.string().min(1) },
        async ({ to, text }) => ({ content: [{ type: 'text', text: inv.sendMessage(to, text) }] }),
      ),
    ],
  });
}

/** In-process MCP server for the tools covibe offers an agent. */
function customServer(tools: CustomTool[]) {
  const shape = (t: CustomTool) =>
    Object.fromEntries(
      Object.entries(t.params).map(([k, p]) => {
        let schema: z.ZodTypeAny =
          p.type === 'files'
            ? z.array(z.object({ path: z.string(), content: z.string() }))
            : p.type === 'list'
              ? z.array(z.string())
              : p.type === 'number'
                ? z.number()
                : p.type === 'boolean'
                  ? z.boolean()
                  : p.enum
                    ? z.enum(p.enum as [string, ...string[]])
                    : z.string();
        schema = schema.describe(p.description);
        return [k, p.optional ? schema.optional() : schema];
      }),
    );
  return createSdkMcpServer({
    name: COVIBE_SERVER,
    version: '1.0.0',
    tools: tools.map((t) =>
      tool(t.name, t.description, shape(t), async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: 'text', text: await t.run(args) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
        }
      }),
    ),
  });
}
