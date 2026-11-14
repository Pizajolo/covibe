import { isAbsolute, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import type { AgentConfig } from '../config/types.js';
import { hostAllowed, inside, realPath } from './confine.js';

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

/** Tools that read files, and where each keeps the path it reads (unset = the working folder). */
const READ_FIELDS: Record<string, string> = {
  Read: 'file_path',
  NotebookRead: 'notebook_path',
  LS: 'path',
  Grep: 'path',
  Glob: 'path',
};

/** What a confined member (see engine/confine.ts) may read and reach. */
export interface ConfinedScope {
  /** The only folders its file tools read. */
  readRoots: string[];
  /** The only domains WebFetch reaches. */
  network: string[];
}

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
export function makeToolChecker(opts: { root: string; cwd: string; writeScope: string[] | undefined; extraRoots?: string[]; confined?: ConfinedScope }) {
  const inScope = scopeMatcher(opts.writeScope);
  const confined = opts.confined;
  // Compared with links followed, on both sides (a temp folder is itself behind a link on macOS).
  const readRoots = (confined?.readRoots ?? []).map(realPath);
  const writeRoots = [opts.root, ...(opts.extraRoots ?? [])].map(realPath);
  const readable = (path: string) => readRoots.some((r) => inside(realPath(path), r));
  return (tool: string, input: unknown): string | undefined => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (confined) {
      const readField = READ_FIELDS[tool];
      if (readField) {
        const raw = args[readField];
        if (raw !== undefined && typeof raw !== 'string') return `${tool}: ${readField} is not a path`;
        const abs = raw === undefined ? opts.cwd : isAbsolute(raw) ? raw : resolve(opts.cwd, raw);
        if (!readable(abs)) return `${raw ?? abs} is outside your working folder. You can only read files there.`;
        // A pattern can name a folder of its own ("/Users/…/*", "../../*").
        const pattern = tool === 'Glob' ? args.pattern : undefined;
        if (typeof pattern === 'string' && (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..') || pattern.startsWith('~'))) return 'Glob: give a pattern relative to your working folder.';
        return undefined;
      }
      if (tool === 'WebFetch') {
        let host = '';
        try {
          host = new URL(String(args.url)).hostname;
        } catch {
          return 'WebFetch: that is not an address.';
        }
        if (!hostAllowed(host, confined.network)) return `${host} cannot be reached from here (allowed: ${confined.network.join(', ') || 'no website'}).`;
        return undefined;
      }
    }
    const field = PATH_FIELDS[tool];
    if (!field) return undefined;
    const raw = args[field];
    if (typeof raw !== 'string') return `${tool}: missing ${field}`;
    const abs = isAbsolute(raw) ? raw : resolve(opts.cwd, raw);
    // A link inside the working folder (made with a shell command) must not carry a write out of it.
    if (confined && !writeRoots.some((r) => inside(realPath(abs), r))) return `${raw} leads outside your workspace (${opts.root}).`;
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
