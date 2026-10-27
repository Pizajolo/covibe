import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentInvocation, AgentResult, AgentRunner } from '../src/runner/types.js';

export function tempDir(prefix = 'covibe-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
}

export type Script = (inv: AgentInvocation, call: number) => ScriptedTurn;

/** Stands in for the Claude Agent SDK: plays scripted turns and records every invocation. */
export class ScriptedRunner implements AgentRunner {
  calls: AgentInvocation[] = [];
  denied: { agent: string; tool: string; reason: string }[] = [];
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
      inv.onEvent({ kind: 'tool', tool: 'Bash', input: { command: 'generate files' } });
      writeFiles(inv.cwd, turn.bashWrite);
    }
    for (const m of turn.send ?? []) inv.sendMessage(m.to, m.text);
    if (turn.text) inv.onEvent({ kind: 'text', text: turn.text });

    const base = { sessionId, turns: 1, costUsd: 0.01, durationMs: 5 };
    if (turn.fail) return { ...base, ok: false, text: '', error: turn.fail };
    return { ...base, ok: true, text: turn.text ?? '', structured: turn.structured };
  }

  callsFor(agent: string) {
    return this.calls.filter((c) => c.agentName === agent);
  }
}
