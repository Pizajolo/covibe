// The only module that imports the Claude Agent SDK. SDK upgrades and API
// changes should touch this file and nothing else.
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentInvocation, AgentResult, AgentRunner } from './types.js';

const TEAM_SERVER = 'team';
const SEND_MESSAGE_TOOL = `mcp__${TEAM_SERVER}__send_message`;

export class ClaudeSdkRunner implements AgentRunner {
  async run(inv: AgentInvocation): Promise<AgentResult> {
    const started = Date.now();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    inv.signal.addEventListener('abort', onAbort, { once: true });

    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const reason = inv.checkToolUse(input.tool_name, input.tool_input);
      if (!reason) return {};
      inv.onEvent({ kind: 'denied', tool: input.tool_name, input: input.tool_input, reason });
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      };
    };

    const options: Options = {
      cwd: inv.cwd,
      env: inv.env,
      model: inv.model,
      abortController,
      resume: inv.resumeSessionId,
      // Built-in tools are limited to the agent's list and pre-approved; anything
      // else is denied without prompting, since nobody is at the terminal.
      tools: inv.tools,
      allowedTools: [...inv.tools, ...(inv.canMessage.length ? [SEND_MESSAGE_TOOL] : [])],
      permissionMode: 'dontAsk',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: inv.systemPrompt },
      settingSources: inv.settingSources,
      maxTurns: inv.maxTurns,
      maxBudgetUsd: inv.maxBudgetUsd,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      outputFormat: inv.outputSchema ? { type: 'json_schema', schema: inv.outputSchema } : undefined,
      mcpServers: inv.canMessage.length ? { [TEAM_SERVER]: teamServer(inv) } : undefined,
    };

    let sessionId = inv.resumeSessionId;
    let lastText = '';
    try {
      for await (const msg of query({ prompt: inv.prompt, options }) as AsyncIterable<SDKMessage>) {
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
          const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          for (const u of Object.values(msg.modelUsage ?? {})) {
            tokens.input += u.inputTokens;
            tokens.output += u.outputTokens;
            tokens.cacheRead += u.cacheReadInputTokens;
            tokens.cacheWrite += u.cacheCreationInputTokens;
          }
          const base = { sessionId: msg.session_id, turns: msg.num_turns, costUsd: msg.total_cost_usd, durationMs: Date.now() - started, tokens };
          if (msg.subtype === 'success' && !msg.is_error) {
            return { ...base, ok: true, text: msg.result, structured: msg.structured_output };
          }
          const error = msg.subtype === 'success' ? msg.result : [msg.subtype, ...msg.errors].join(': ');
          return { ...base, ok: false, text: lastText, error };
        }
      }
      return { ok: false, sessionId, text: lastText, error: 'session ended without a result', turns: 0, costUsd: 0, durationMs: Date.now() - started };
    } catch (err) {
      const error = inv.signal.aborted ? 'aborted (timeout or cancel)' : (err as Error).message;
      return { ok: false, sessionId, text: lastText, error, turns: 0, costUsd: 0, durationMs: Date.now() - started };
    } finally {
      inv.signal.removeEventListener('abort', onAbort);
    }
  }
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
        'Send a message to a teammate. It is delivered at the start of their next turn; it does not interrupt them.',
        { to: z.enum([first, ...rest]), text: z.string().min(1) },
        async ({ to, text }) => ({ content: [{ type: 'text', text: inv.sendMessage(to, text) }] }),
      ),
    ],
  });
}
