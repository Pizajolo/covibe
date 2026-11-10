// The only module that imports the Claude Agent SDK. SDK upgrades and API
// changes should touch this file and nothing else.
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { claudePrice } from './prices.js';
import type { AgentInvocation, AgentResult, AgentRunner, CustomTool, EnvironmentInfo, LivePriority, PlanUsage, TokenUsage } from './types.js';

const TEAM_SERVER = 'team';
const SEND_MESSAGE_TOOL = `mcp__${TEAM_SERVER}__send_message`;
const COVIBE_SERVER = 'covibe';
/** After a turn ends with messages still unread, how long to wait for the turn that reads them. */
const FOLLOW_UP_WAIT_MS = 30_000;
/** Longest a member may wait for an answer to its question, or in a paused run. */
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
/** How often a working member reports its running token use and spend. */
const USAGE_EVERY_MS = 3_000;
/** How many times a member whose Claude Code process stopped mid-turn picks its session up again. */
const CRASH_RESUMES = 2;

/**
 * A member's environment for Claude Code, with what covibe turns off unless
 * the environment covibe was started in says otherwise:
 * - MCP_TOOL_TIMEOUT: a member waiting for an answer sits in a tool call
 *   (ask_question) or a hook (run paused); both may take the longest wait.
 * - claude.ai connectors (Gmail, Drive, Notion…): Claude Code would load the
 *   account's connectors into every member, where their tools are not allowed
 *   and only make each request longer.
 * - Claude Code's own memory: it is kept per repository, so members would read
 *   the person's private notes and write theirs into them. The team's memory
 *   is the project brain.
 */
export function memberEnv(env: Env): Env {
  return { MCP_TOOL_TIMEOUT: String(MAX_WAIT_MS), ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...env };
}

/** The prompt that picks a session up again after Claude Code's process stopped mid-turn. */
export function crashResumePrompt(unread: string[]): string {
  const note =
    'Your previous turn was cut off: the Claude Code process running it stopped unexpectedly (not because of anything you did). What you did before is still in your working folder and above. Pick up where you left off: check what is already done, finish the rest, and report as your task asks. Do not start over.';
  return unread.length ? `${note}\n\nThese messages reached you just before it stopped:\n\n${unread.join('\n\n')}` : note;
}

/** What one query() of a turn ended with, beyond its result: whether its process stopped mid-turn, and the messages it never read. */
type TurnResult = AgentResult & { crashed?: boolean; unread?: string[] };

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
    let { crashed, unread, ...result } = await this.turn(inv);
    // Claude Code's process stopped in the middle of the turn (it exits now and
    // then without saying why): pick the session up again rather than failing
    // the step, carrying over the messages it had not read.
    for (let attempt = 1; crashed && result.sessionId && !result.limit && !inv.signal.aborted && attempt <= CRASH_RESUMES; attempt++) {
      inv.onEvent({ kind: 'restarted', attempt, error: result.error ?? 'Claude Code stopped' });
      const { crashed: again, unread: missed, ...next } = await this.turn({ ...inv, prompt: crashResumePrompt(unread ?? []), resumeSessionId: result.sessionId, forkSession: false });
      crashed = again;
      unread = missed;
      result = {
        ...next,
        sessionId: next.sessionId ?? result.sessionId,
        text: next.text || result.text,
        turns: result.turns + next.turns,
        costUsd: result.costUsd + next.costUsd,
        durationMs: result.durationMs + next.durationMs,
        tokens: addTokens(result.tokens, next.tokens),
      };
    }
    // Claude Code prices every model as Claude; another provider's model gets its own prices.
    if (inv.pricing && result.tokens) result.costUsd = priceOf(inv.pricing, result.tokens);
    return result;
  }

  private async turn(inv: AgentInvocation): Promise<TurnResult> {
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
    const skillNames = [...(inv.skills?.names ?? []), ...(inv.plugins?.skills ?? [])];
    const tools = skillNames.length ? [...inv.tools, 'Skill'] : inv.tools;
    const plugins = [
      ...(inv.skills?.pluginDirs ?? []).map((path) => ({ type: 'local' as const, path, skipMcpDiscovery: true })),
      // Their hooks and MCP servers start through covibe's sandbox launcher.
      ...(inv.plugins?.dirs ?? []).map((path) => ({ type: 'local' as const, path })),
    ];

    const options: Options = {
      cwd: inv.cwd,
      additionalDirectories: inv.readDirs,
      plugins: plugins.length ? plugins : undefined,
      // Only the listed skills are visible to this agent.
      skills: skillNames.length ? skillNames : undefined,
      env: memberEnv(inv.env),
      // Nothing but covibe's own servers and the member's plugins: MCP servers from the
      // person's own Claude Code setup would only add their tool lists to every request
      // (their tools are not on the member's allow list). Plugins bring servers of their
      // own, and a team that reads settings files may allow a project's servers there.
      strictMcpConfig: !inv.plugins?.dirs.length && !inv.settingSources.length,
      // Named here, so Claude Code does not ask a model for a title.
      title: inv.resumeSessionId ? undefined : `covibe: ${inv.agentName}`,
      model: inv.model,
      effort: inv.effort,
      thinking: inv.thinking === undefined ? undefined : inv.thinking === 'adaptive' ? { type: 'adaptive' } : inv.thinking === 'off' ? { type: 'disabled' } : { type: 'enabled', budgetTokens: inv.thinking },
      abortController,
      // Stream events carry each response's growing token count, for the live spend.
      includePartialMessages: true,
      resume: inv.resumeSessionId,
      forkSession: inv.forkSession && !!inv.resumeSessionId,
      // Built-in tools are limited to the agent's list and pre-approved; anything
      // else is denied without prompting, since nobody is at the terminal.
      tools,
      allowedTools: [...tools, ...(inv.canMessage.length ? [SEND_MESSAGE_TOOL] : []), ...custom.map((t) => `mcp__${COVIBE_SERVER}__${t.name}`), ...(inv.plugins?.mcpTools ?? [])],
      permissionMode: 'dontAsk',
      systemPrompt: inv.ownSystemPrompt ? inv.systemPrompt : { type: 'preset', preset: 'claude_code', append: inv.systemPrompt },
      settingSources: inv.settingSources,
      maxTurns: inv.maxTurns,
      maxBudgetUsd: inv.maxBudgetUsd,
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: MAX_WAIT_MS / 1000 }] },
      outputFormat: inv.outputSchema ? { type: 'json_schema', schema: forClaudeCode(inv.outputSchema) } : undefined,
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
            filesystem: { allowWrite: inv.sandbox.allowWrite, ...(inv.sandbox.denyWrite?.length ? { denyWrite: inv.sandbox.denyWrite } : {}) },
          }
        : undefined,
    };

    // Streaming input, so messages can reach the agent while it works. Each
    // message is tagged; the run ends once a turn's result shows every tagged
    // message was read (a "now" message ends one turn and starts another).
    const input = new Input();
    const unread = new Set<string>([input.push(inv.prompt)]);
    /** Messages sent while it works, by id: carried over if its process stops before reading them. */
    const sent = new Map<string, string>();
    inv.onControl?.({
      send: (text, priority) => {
        if (input.isClosed) return false;
        const uuid = input.push(text, priority);
        unread.add(uuid);
        sent.set(uuid, text);
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
    const usage = new LiveUsage(inv.pricing, (tokens, costUsd) => inv.onEvent({ kind: 'usage', tokens, ...(costUsd === undefined ? {} : { costUsd }) }));
    /** What Claude Code said on the way, for a useful error when its process stops unexpectedly. */
    const clues = new ExitClues();
    options.stderr = (text) => clues.stderr(text);
    // Claude Code writes why it stopped to its debug log, often nowhere else.
    const debugFile = join(tmpdir(), `covibe-claude-${randomUUID()}.log`);
    options.debugFile = debugFile;
    try {
      for await (const msg of query({ prompt: input, options }) as AsyncIterable<SDKMessage>) {
        clearTimeout(followUp);
        // Every API response (subagents' too) counts toward the running total.
        if (msg.type === 'stream_event') {
          usage.stream(msg.event as Parameters<LiveUsage['stream']>[0], msg.parent_tool_use_id ?? '');
          continue;
        }
        if (msg.type === 'assistant') usage.add(msg.message);
        clues.see(msg);
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
      // The turn had finished and nothing was left to read: the work is done,
      // whatever the process did on its way out.
      if (!inv.signal.aborted && last && last.subtype === 'success' && !last.is_error && !unread.size) {
        return { sessionId: last.session_id, turns, costUsd: last.total_cost_usd, durationMs: Date.now() - started, tokens: tokensOf(last), ok: true, text: last.result || lastText, structured: last.structured_output };
      }
      const message = (err as Error).message;
      const crashed = !inv.signal.aborted && ExitClues.isExit(message);
      if (crashed) clues.log(readTail(debugFile, DEBUG_TAIL_BYTES));
      const error = inv.signal.aborted ? 'aborted (timeout or cancel)' : clues.explain(message, lastText);
      const limit = inv.signal.aborted ? undefined : limitOf(error, rejected);
      // What the turn used up to the stop: its last result, or the running count when it stopped mid-turn.
      const spent = usage.totals();
      const costUsd = Math.max(last?.total_cost_usd ?? 0, spent.costUsd ?? 0);
      return {
        ok: false,
        sessionId,
        text: lastText,
        error,
        turns,
        costUsd,
        durationMs: Date.now() - started,
        tokens: last ? tokensOf(last) : spent.tokens,
        ...(limit ? { limit } : {}),
        ...(crashed ? { crashed: true, unread: [...unread].flatMap((u) => (sent.has(u) ? [sent.get(u)!] : [])) } : {}),
      };
    } finally {
      stop();
      usage.close();
      inv.signal.removeEventListener('abort', onAbort);
      rmSync(debugFile, { force: true });
    }

    if (!last) {
      const limit = limitOf(lastText, rejected);
      // Without a limit, its process stopped before the turn was over: like a crash.
      return { ok: false, sessionId, text: lastText, error: limit ? lastText || 'usage limit reached' : 'session ended without a result', turns, costUsd: 0, durationMs: Date.now() - started, ...(limit ? { limit } : inv.signal.aborted ? {} : { crashed: true, unread: [] }) };
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
 * message (which lists the skills) only comes with a first prompt, so one is
 * sent, and a hook blocks it before it reaches the model: this costs nothing.
 * (Closing the session at init was not enough; the request was often already
 * on its way.)
 */
export async function discoverEnvironment(env: Env): Promise<EnvironmentInfo> {
  const block: HookCallback = async () => ({ continue: false, stopReason: 'covibe reads the environment only' });
  const q = query({
    prompt: 'hi',
    options: { cwd: process.cwd(), env, settingSources: [], tools: ['Skill'], permissionMode: 'dontAsk', maxTurns: 1, hooks: { UserPromptSubmit: [{ hooks: [block] }] } },
  });
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
/**
 * Lines Claude Code prints on stderr that never explain a failure: its note
 * that a model is not one of Claude's (true of every provider model) and that
 * claude.ai connectors are off while another sign-in is in use.
 */
const STDERR_NOTICES = [/\[claude-code:unrecognized_model\]/, /claude\.ai connectors are disabled/];
const STDERR_KEEP = 4096;
/** How much of the end of Claude Code's debug log is read when its process stops, and how many of its lines are kept. */
const DEBUG_TAIL_BYTES = 256 * 1024;
const LOG_LINES = 6;

/** The last `bytes` of a file, or '' when it cannot be read. */
export function readTail(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    // Drop a partial first line.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * What Claude Code reported before its process stopped: the last API error
 * and retry, a sign-in problem, why it shut down, and stderr without its usual
 * notices. The SDK's own message keeps only the end of stderr, which is often
 * nothing but those notices.
 */
export class ExitClues {
  private err = '';
  private logged: string[] = [];
  private apiError?: string;
  private retry?: { attempt: number; max: number; status: number | null; error: string };
  private auth?: string;
  private shutdown?: string;

  stderr(text: string) {
    this.err = (this.err + text).slice(-4 * STDERR_KEEP);
  }

  see(msg: SDKMessage) {
    if (msg.type === 'assistant' && msg.message.model === '<synthetic>') {
      const text = msg.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
      if (text) this.apiError = text;
    } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
      this.retry = { attempt: msg.attempt, max: msg.max_retries, status: msg.error_status, error: String(msg.error) };
    } else if (msg.type === 'system' && msg.subtype === 'worker_shutting_down') {
      this.shutdown = msg.reason;
    } else if (msg.type === 'auth_status' && msg.error) {
      this.auth = msg.error;
    }
  }

  /** Whether the SDK's error says Claude Code's process stopped (rather than reporting a failed turn). */
  static isExit(message: string): boolean {
    return /^Claude Code process (exited|terminated)/.test(message);
  }

  /** The end of Claude Code's debug log: the errors it logged, without timestamps. */
  log(text: string) {
    this.logged = text
      .split('\n')
      .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim())
      .filter((l) => l.startsWith('[ERROR]') && !STDERR_NOTICES.some((n) => n.test(l)))
      .slice(-LOG_LINES)
      .map((l) => clip(l.replace(/^\[ERROR\]\s*/, ''), 400));
  }

  /** The error to report for `message` (the SDK's), with what explains it. */
  explain(message: string, lastText = ''): string {
    if (!ExitClues.isExit(message)) return message;
    const base = message.replace(/\. stderr: [\s\S]*$/, '');
    const lines = this.err
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !STDERR_NOTICES.some((n) => n.test(l)));
    const parts = [base];
    if (this.apiError) parts.push(`last API error: ${clip(this.apiError, 500)}`);
    if (this.retry) parts.push(`the provider's last failed answer: ${this.retry.status ?? 'no response'} (${this.retry.error}), retry ${this.retry.attempt} of ${this.retry.max}`);
    if (this.auth) parts.push(`sign-in error: ${clip(this.auth, 300)}`);
    if (this.shutdown) parts.push(`Claude Code shut down: ${this.shutdown}`);
    if (lines.length) parts.push(`stderr: ${clip(lines.join(' | ').slice(-STDERR_KEEP), STDERR_KEEP)}`);
    if (this.logged.length) parts.push(`Claude Code's log: ${this.logged.join(' | ')}`);
    if (parts.length === 1) {
      parts.push('Claude Code gave no reason (it printed only its usual notices)');
      if (lastText.trim()) parts.push(`the member's last message: "${clip(lastText.trim(), 300)}"`);
    }
    return parts.join('; ');
  }
}

export function limitOf(error: string, rejected: AgentResult['limit']): AgentResult['limit'] {
  const said = /usage limit|limit reached|rate.?limit/i.test(error);
  if (!rejected && !said) return undefined;
  const epoch = /\|(\d{10,13})\b/.exec(error)?.[1];
  const resetsAt = rejected?.resetsAt ?? (epoch ? Math.round(Number(epoch) / (epoch.length > 10 ? 1000 : 1)) : undefined);
  return { resetsAt, window: rejected?.window };
}

type ApiUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
};
type Counts = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; cache_1h: number };

/**
 * The running token count of one invocation, reported every few seconds while
 * it works. Each API response reports its usage at the start of its stream
 * (input and cache) and grows it in message_delta events (output); assistant
 * messages repeat an early snapshot. Counts only grow, so each response keeps
 * the largest value seen per field.
 */
export class LiveUsage {
  private readonly responses = new Map<string, { model?: string; usage: Counts }>();
  /** The response each stream (the main one, or a subagent's) is on. */
  private readonly current = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private sent = '';

  constructor(
    private readonly pricing: AgentInvocation['pricing'],
    private readonly report: (tokens: TokenUsage, costUsd: number | undefined) => void,
  ) {}

  /** A complete assistant message (one content block of a response). */
  add(message: { id?: string; model?: string; usage?: ApiUsage | null }) {
    if (message.usage) this.merge(message.id ?? `#${this.responses.size}`, message.model, message.usage);
  }

  /** A raw stream event; `stream` tells the main conversation and subagents apart. */
  stream(event: { type: string; message?: { id?: string; model?: string; usage?: ApiUsage | null }; usage?: ApiUsage | null }, stream: string) {
    if (event.type === 'message_start' && event.message?.id) {
      this.current.set(stream, event.message.id);
      if (event.message.usage) this.merge(event.message.id, event.message.model, event.message.usage);
    } else if (event.type === 'message_delta' && event.usage) {
      const id = this.current.get(stream);
      if (id) this.merge(id, undefined, event.usage);
    }
  }

  private merge(id: string, model: string | undefined, u: ApiUsage) {
    const r = this.responses.get(id) ?? { model, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_1h: 0 } };
    r.model ??= model;
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) r.usage[k] = Math.max(r.usage[k], u[k] ?? 0);
    r.usage.cache_1h = Math.max(r.usage.cache_1h, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    this.responses.set(id, r);
    this.timer ??= setTimeout(() => this.flush(), USAGE_EVERY_MS);
  }

  /** Report now (normally on a timer). */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const { tokens, costUsd } = this.totals();
    const key = JSON.stringify(tokens);
    if (key === this.sent) return;
    this.sent = key;
    this.report(tokens, costUsd);
  }

  /** Tokens so far, and their estimated cost (undefined when a model's prices are unknown). */
  totals(): { tokens: TokenUsage; costUsd: number | undefined } {
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    let priced = true;
    for (const { model, usage: u } of this.responses.values()) {
      const t = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens };
      tokens.input += t.input;
      tokens.output += t.output;
      tokens.cacheRead += t.cacheRead;
      tokens.cacheWrite += t.cacheWrite;
      const price = this.pricing ?? claudePrice(model);
      // 1-hour cache writes (Claude Code's default on a subscription) cost twice the input price.
      if (price) cost += priceOf(price, { ...t, cacheWrite: t.cacheWrite - u.cache_1h }) + (u.cache_1h * price.input * 2) / 1e6;
      else priced = false;
    }
    return { tokens, costUsd: priced ? cost : undefined };
  }

  /** The turn is over: its result carries the exact figures. */
  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
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

function addTokens(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a || !b) return b ?? a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
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

/**
 * A report schema as Claude Code takes it: without the $schema line, which its
 * validator does not know for draft 2020-12 (it refuses to start) and which
 * means nothing to the model. covibe validates reports against the full schema.
 */
export function forClaudeCode(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema;
  return rest;
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
          const out = await t.run(args);
          if (typeof out === 'string') return { content: [{ type: 'text' as const, text: out }] };
          return { content: [{ type: 'text' as const, text: out.text }, ...(out.images ?? []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mediaType }))] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
        }
      }),
    ),
  });
}
