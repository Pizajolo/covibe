import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentInvocation, AgentResult, AgentRunner, AgentStreamEvent } from '../src/runner/types.js';

export function tempDir(prefix = 'covibe-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Keep run worktrees (and any library) out of the real ~/.covibe during tests.
process.env.COVIBE_HOME ??= tempDir('covibe-home-');

/** A git repo with one commit, ready for worktree isolation. */
export function tempRepo(): string {
  const dir = tempDir('covibe-repo-');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# app\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

export function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

export interface ScriptedTurn {
  structured?: unknown;
  text?: string;
  /** Files written through the Write tool (subject to the scope hook). */
  write?: Record<string, string>;
  /** Files written behind the hook's back, as Bash would. */
  bashWrite?: Record<string, string>;
  /** Messages to teammates via send_message. */
  send?: { to: string; text: string }[];
  fail?: string;
  /** The plan's usage limit stopped the turn (with fail as the error). */
  limit?: { resetsAt?: number };
  /** Keep working until this many live messages arrived (or 5 s passed). */
  awaitLive?: number;
  /** Custom (covibe) tools to call, in order. */
  call?: { tool: string; args: Record<string, unknown> }[];
  /** Stream events to send as is (tool calls, images it saw…). */
  stream?: AgentStreamEvent[];
}

export type Script = (inv: AgentInvocation, call: number) => ScriptedTurn;

/** Stands in for the Claude Agent SDK: plays scripted turns and records every invocation. */
export class ScriptedRunner implements AgentRunner {
  calls: AgentInvocation[] = [];
  denied: { agent: string; tool: string; reason: string }[] = [];
  /** Messages delivered to agents while they were working. */
  live: { agent: string; text: string; priority: string }[] = [];
  /** What custom tools answered. */
  toolResults: { agent: string; tool: string; result: string }[] = [];
  /** Resolves when an agent starts working (to time live messages in tests). */
  working = new Map<string, () => void>();
  whenWorking(agent: string) {
    return new Promise<void>((r) => this.working.set(agent, r));
  }
  private counts = new Map<string, number>();

  constructor(private scripts: Record<string, Script>) {}

  async run(inv: AgentInvocation): Promise<AgentResult> {
    this.calls.push(inv);
    const n = this.counts.get(inv.agentName) ?? 0;
    this.counts.set(inv.agentName, n + 1);
    const script = this.scripts[inv.agentName];
    if (!script) throw new Error(`no script for ${inv.agentName}`);
    const turn = script(inv, n);
    const sessionId = inv.resumeSessionId ?? `session-${inv.agentName}`;
    inv.onEvent({ kind: 'session', sessionId });

    for (const [rel, content] of Object.entries(turn.write ?? {})) {
      await inv.beforeToolUse?.();
      const input = { file_path: join(inv.cwd, rel), content };
      const reason = inv.checkToolUse('Write', input);
      if (reason) {
        this.denied.push({ agent: inv.agentName, tool: 'Write', reason });
        inv.onEvent({ kind: 'denied', tool: 'Write', input, reason });
        continue;
      }
      inv.onEvent({ kind: 'tool', tool: 'Write', input });
      writeFiles(inv.cwd, { [rel]: content });
    }
    if (turn.bashWrite) {
      await inv.beforeToolUse?.();
      inv.onEvent({ kind: 'tool', tool: 'Bash', input: { command: 'generate files' } });
      writeFiles(inv.cwd, turn.bashWrite);
    }
    for (const e of turn.stream ?? []) inv.onEvent(e);
    for (const m of turn.send ?? []) inv.sendMessage(m.to, m.text);
    for (const c of turn.call ?? []) {
      const tool = inv.customTools?.find((t) => t.name === c.tool);
      if (!tool) throw new Error(`${inv.agentName} has no tool ${c.tool} (has: ${(inv.customTools ?? []).map((t) => t.name).join(', ') || 'none'})`);
      await inv.beforeToolUse?.();
      let result: string;
      try {
        result = await tool.run(c.args);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }
      this.toolResults.push({ agent: inv.agentName, tool: c.tool, result });
    }
    if (turn.awaitLive) {
      const got: string[] = [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        inv.onControl?.({
          send: (text, priority) => {
            this.live.push({ agent: inv.agentName, text, priority });
            got.push(text);
            if (got.length >= turn.awaitLive!) {
              clearTimeout(timer);
              resolve();
            }
            return true;
          },
        });
        this.working.get(inv.agentName)?.();
      });
      inv.onControl?.(null);
    } else this.working.get(inv.agentName)?.();
    if (turn.text) inv.onEvent({ kind: 'text', text: turn.text });

    const base = { sessionId, turns: 1, costUsd: 0.01, durationMs: 5 };
    if (turn.fail) return { ...base, ok: false, text: '', error: turn.fail, ...(turn.limit ? { limit: turn.limit } : {}) };
    return { ...base, ok: true, text: turn.text ?? '', structured: turn.structured };
  }

  callsFor(agent: string) {
    return this.calls.filter((c) => c.agentName === agent);
  }
}
