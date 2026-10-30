// What a project's app may do in the OS sandbox and the environment it gets.
// Shared by the launcher (launcher.ts), which applies it, and the manager,
// which writes it.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROTECTED, shellQuote, TOOLCHAIN_DIRS } from '../sandbox-policy.js';

export interface LaunchApp {
  /** The folder the app runs in (writable). */
  folder: string;
  /** The shell command: setup, then the start command. */
  command: string;
  port: number;
  env: Record<string, string>;
  /** Domains it may reach. */
  network: string[];
  /** Extra folders it may write (package caches). */
  allowWrite: string[];
  /** Its own temp folder (TMPDIR). */
  tmp: string;
  /** Linux: the Unix socket the bridge listens on. */
  socket?: string;
}

/** Variables passed through; keys and tokens in the environment stay out. */
const SAFE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ)$/;

export function appEnv(env: NodeJS.ProcessEnv, spec: LaunchApp): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && SAFE_ENV.test(k)) out[k] = v;
  return { ...out, PORT: String(spec.port), HOST: '127.0.0.1', BROWSER: 'none', FORCE_COLOR: '0', ...spec.env };
}

/**
 * What the app may read and write: like a plugin's programs, with its folder
 * writable but not its git data or Claude Code's and covibe's settings there.
 * On Linux a protected path that does not exist would get a placeholder file
 * in the folder for as long as the app runs (bubblewrap needs something to
 * mount over), which git and covibe would then see; so there only existing
 * ones are protected, and the manager creates .claude beforehand.
 */
export function appSandboxConfig(spec: LaunchApp, home = homedir(), linux = process.platform === 'linux', path = process.env.PATH ?? '') {
  const toolchains = [...TOOLCHAIN_DIRS.map((d) => join(home, d)), ...homeTools(path, home)].filter((p) => existsSync(p));
  const socketDir = spec.socket ? [join(spec.socket, '..')] : [];
  return {
    network: {
      allowedDomains: [...spec.network],
      deniedDomains: [],
      allowLocalBinding: true,
      // The bridge (socat) needs a Unix socket; the app's own code could make one too, which only reaches what the sandbox lets it.
      ...(spec.socket ? { allowAllUnixSockets: true } : {}),
    },
    filesystem: {
      denyRead: [home],
      allowRead: [spec.folder, spec.tmp, ...toolchains, ...spec.allowWrite, ...socketDir],
      allowWrite: [spec.folder, spec.tmp, ...spec.allowWrite, ...socketDir],
      denyWrite: [...PROTECTED, '.covibe'].map((p) => join(spec.folder, p)).filter((p) => !linux || existsSync(p)),
    },
  };
}

/**
 * The tools on PATH that live in the home folder (a Node another version
 * manager installed, say): their folder and, for a bin folder, the folder
 * around it (where node finds npm). The rest of the home folder stays hidden.
 */
export function homeTools(path: string, home: string): string[] {
  const out = new Set<string>();
  for (const dir of path.split(':')) {
    if (!dir.startsWith(`${home}/`)) continue;
    out.add(dir);
    if (/\/bin\/?$/.test(dir) && dirname(dir) !== home) out.add(dirname(dir));
  }
  return [...out];
}

/**
 * The command the sandbox runs, in the app's folder (the launcher itself works
 * elsewhere, see launcher.ts); on Linux with the bridge started first.
 */
export function sandboxedCommand(spec: LaunchApp): string {
  const run = `cd ${shellQuote(spec.folder)} && ${spec.command}`;
  if (!spec.socket) return run;
  return `socat UNIX-LISTEN:${shellQuote(spec.socket)},fork,reuseaddr TCP:127.0.0.1:${spec.port} & ${run}`;
}
