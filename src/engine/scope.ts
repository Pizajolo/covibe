import { isAbsolute, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import type { AgentConfig } from '../config/types.js';

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite']);

/** The agent as it may act in a question session: same role and model, no tools that change anything. */
export function readOnly(agent: AgentConfig): AgentConfig {
  return { ...agent, tools: agent.tools.filter((t) => READ_ONLY_TOOLS.has(t)), writes: false, writeScope: [], canMessage: [], canRequest: [], sandbox: undefined };
}

/** Tools that write files, and where each keeps the path it writes. */
const PATH_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

export function scopeMatcher(writeScope: string[] | undefined): (relPath: string) => boolean {
  if (writeScope === undefined) return () => true;
  if (writeScope.length === 0) return () => false;
  return picomatch(writeScope, { dot: true });
}

/**
 * Pre-tool-use check: file-writing tools may only touch paths inside the
 * agent's worktree that match its write scope. Bash cannot be checked this way;
 * in worktree mode the engine also diffs the worktree after each turn and
 * discards out-of-scope changes (see Workspace.collect).
 */
export function makeToolChecker(opts: { root: string; cwd: string; writeScope: string[] | undefined; extraRoots?: string[] }) {
  const inScope = scopeMatcher(opts.writeScope);
  return (tool: string, input: unknown): string | undefined => {
    const field = PATH_FIELDS[tool];
    if (!field) return undefined;
    const raw = (input as Record<string, unknown> | null)?.[field];
    if (typeof raw !== 'string') return `${tool}: missing ${field}`;
    const abs = isAbsolute(raw) ? raw : resolve(opts.cwd, raw);
    // Folders this agent may write in full (the curator's brain folder).
    for (const extra of opts.extraRoots ?? []) {
      const r = relative(extra, abs);
      if (r && !r.startsWith('..') && !isAbsolute(r)) return r.split(/[\\/]/)[0] === '.git' ? 'Writing inside .git is not allowed.' : undefined;
    }
    const rel = relative(opts.root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return `${raw} is outside your workspace (${opts.root}).`;
    }
    if (rel.split(/[\\/]/)[0] === '.git') return 'Writing inside .git is not allowed.';
    if (!inScope(rel)) {
      return `${rel} is outside your write scope (${(opts.writeScope ?? []).join(', ') || 'none'}). Report the change that is needed instead of making it.`;
    }
    return undefined;
  };
}
