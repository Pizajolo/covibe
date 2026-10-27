// The only module that imports the Claude Agent SDK. SDK upgrades and API
// changes should touch this file and nothing else.
import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Env } from './backend.js';
import type { AgentInvocation, AgentResult, AgentRunner, CustomTool, EnvironmentInfo, LivePriority, TokenUsage } from './types.js';

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

  async run(inv: AgentInvocation): Promise<AgentResult> {
    const started = Date.now();
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
    let lastText = '';
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
              inv.onEvent({ kind: 'tool', tool: block.name, input: block.input });
            }
          }
        } else if (msg.type === 'rate_limit_event') {
          const info = msg.rate_limit_info;
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
      return { ok: false, sessionId, text: lastText, error, turns, costUsd: last?.total_cost_usd ?? 0, durationMs: Date.now() - started };
    } finally {
      stop();
      inv.signal.removeEventListener('abort', onAbort);
    }

    if (!last) return { ok: false, sessionId, text: lastText, error: 'session ended without a result', turns, costUsd: 0, durationMs: Date.now() - started };
    // Cost and usage are running totals across the turns of one query().
    const base = { sessionId: last.session_id, turns, costUsd: last.total_cost_usd, durationMs: Date.now() - started, tokens: tokensOf(last) };
    if (last.subtype === 'success' && !last.is_error) return { ...base, ok: true, text: last.result || lastText, structured: last.structured_output };
    const error = last.subtype === 'success' ? last.result : [last.subtype, ...last.errors].join(': ');
    return { ...base, ok: false, text: lastText, error };
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
    const [account, commands] = await Promise.all([q.accountInfo().catch(() => undefined), q.supportedCommands().catch(() => [])]);
    let names: string[] = [];
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        names = (msg as { skills?: string[] }).skills ?? [];
        break;
      }
    }
    const describe = new Map(commands.map((c) => [c.name, c.description]));
    return { skills: names.map((name) => ({ name, description: describe.get(name) ?? '' })), account };
  } finally {
    clearTimeout(timer);
    q.close();
  }
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
