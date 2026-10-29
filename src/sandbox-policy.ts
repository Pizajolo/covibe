// What a plugin's programs (hooks, MCP and LSP servers, monitors) may do
// inside the OS sandbox, and what they are told. Shared by the launcher
// (plugin-sandbox.ts), which applies it, and the plugin library, which
// shows it.
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KeysLocation } from './connections/plugin-keys.js';

/** What the user allows one plugin's programs. */
export interface SandboxPolicy {
  /** Domains they may reach (empty: no network). */
  network: string[];
  /** Extra folders they may write, such as a package cache (~ allowed). */
  allowWrite: string[];
  /** May change files in the member's working folder (a formatter hook, say); otherwise they only read it. */
  writeWorkspace: boolean;
}

/** One program the launcher may start: a shell command, or a command and its arguments. */
export interface LaunchEntry {
  command: string;
  args?: string[];
  /** Variables the program is given (an MCP or LSP server's env). */
  env?: string[];
  /** Their values as the server's config gives them: plain text, or ${VAR} filled in from the plugin's keys and the caller's environment. */
  values?: Record<string, string>;
}

/** sandbox.json: everything the launcher needs, written by covibe where the plugin cannot write. */
export interface LaunchSpec {
  plugin: string;
  /** The plugin's folder (CLAUDE_PLUGIN_ROOT). */
  root: string;
  /** The plugin's own writable folder (CLAUDE_PLUGIN_DATA). */
  data: string;
  policy: SandboxPolicy;
  hooks: LaunchEntry[];
  monitors: LaunchEntry[];
  mcp: Record<string, LaunchEntry>;
  lsp: Record<string, LaunchEntry>;
  /** Where the keys saved for this plugin are, when it has any. */
  keys?: KeysLocation;
}

/**
 * Where language toolchains and package caches live in a home folder. The home
 * folder is hidden from plugins (keys, tokens, other projects), except these,
 * so a hook can still run node, python or cargo installed there.
 */
export const TOOLCHAIN_DIRS = [
  '.nvm', '.volta', '.fnm', '.bun', '.deno', '.npm', '.yarn', '.pnpm-store', 'Library/pnpm', '.local/share/pnpm',
  '.local/bin', '.local/lib', '.local/share/mise', '.asdf', '.pyenv', '.rbenv', '.cargo', '.rustup', 'go', '.sdkman',
  '.cache', '.nix-profile', '.gitconfig', '.config/git',
];

/** In a working folder a plugin may change, what it still may not. */
export const PROTECTED = ['.git', '.claude', '.mcp.json'];

/** Variables passed to every program; anything else (API keys, tokens) stays out. */
const SAFE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|TMPDIR|CLAUDE_PROJECT_DIR)$/;

export function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

function within(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** The plugin's own temp folder (TMPDIR), inside its data folder: the shared temp folder is not writable. */
export function tempDirOf(spec: LaunchSpec): string {
  return join(spec.data, 'tmp');
}

/**
 * The sandbox for one program started in `cwd` (the member's working folder).
 * Reads: everything outside the home folder, and inside it only the plugin,
 * its data, toolchains and the working folder. Writes: the plugin's data
 * folder (which holds its temp folder) and the folders the user allowed (plus
 * the working folder if allowed, but never its .git or Claude Code settings).
 * Network: only the allowed domains.
 */
export function sandboxConfig(spec: LaunchSpec, ctx: { cwd: string; home: string }) {
  const { home } = ctx;
  const cwd = resolve(ctx.cwd);
  // A working folder that is the home folder (or holds it) would undo the point.
  const workspace = !within(home, cwd);
  const extraWrite = spec.policy.allowWrite.map((p) => expandHome(p, home));
  const toolchains = TOOLCHAIN_DIRS.map((d) => join(home, d)).filter((p) => existsSync(p));
  const writeWorkspace = workspace && spec.policy.writeWorkspace;
  return {
    network: { allowedDomains: [...spec.policy.network], deniedDomains: [] },
    filesystem: {
      denyRead: [home],
      allowRead: [spec.root, spec.data, ...toolchains, ...extraWrite, ...(workspace ? [cwd] : [])],
      allowWrite: [spec.data, ...extraWrite, ...(writeWorkspace ? [cwd] : [])],
      // What there would run outside the sandbox: git hooks at the next commit,
      // hooks and MCP servers in the project's Claude Code settings at the next turn.
      denyWrite: writeWorkspace ? PROTECTED.map((p) => join(cwd, p)) : [],
    },
  };
}

/** The environment a program gets: the safe basics, its declared variables, and where the plugin lives. */
export function childEnv(env: NodeJS.ProcessEnv, spec: LaunchSpec, declared: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (SAFE_ENV.test(k) || declared.includes(k))) out[k] = v;
  out.CLAUDE_PLUGIN_ROOT = spec.root;
  out.CLAUDE_PLUGIN_DATA = spec.data;
  return out;
}

/** ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, and (for server arguments) ${VAR} / ${VAR:-default} from the environment. */
export function substitute(text: string, spec: LaunchSpec, env?: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback?: string) => {
    if (name === 'CLAUDE_PLUGIN_ROOT') return spec.root;
    if (name === 'CLAUDE_PLUGIN_DATA') return spec.data;
    if (!env) return whole;
    return env[name] ?? fallback ?? '';
  });
}

/**
 * A server's environment: the safe basics, then each variable it declares,
 * its value from its config (${VAR} filled in from `source`) or else taken
 * from `source` as it is.
 */
export function serverEnv(env: NodeJS.ProcessEnv, spec: LaunchSpec, entry: LaunchEntry, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = childEnv(env, spec);
  for (const k of entry.env ?? []) {
    const template = entry.values?.[k];
    const v = template !== undefined ? substitute(template, spec, source) : source[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Quote one word for sh. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
