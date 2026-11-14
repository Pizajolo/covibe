// Confinement for a run that works on a stranger's input: a market order. The
// order's text and files may carry instructions meant for the members, so the
// team is run as if one of its members could be turned against the owner:
//
// - Every member with a shell is sandboxed, whatever the team file says. The
//   sandbox hides the home folder (keys, tokens, other projects, the
//   Keychain's files) except the working folder and installed toolchains,
//   writes only in the working folder and temp, and reaches only the domains
//   the storefront names (none by default).
// - The file tools read only the working folder, and follow no link out of it.
// - Shell commands get no key or token from the environment, and the
//   environment itself is cut down to what Claude Code needs.
// - No project settings, CLAUDE.md or .mcp.json are loaded from the working
//   folder, and shell commands cannot write them.
// - No browser, no app, no plugins.
//
// What leaves the machine on purpose (the deliverables) is checked separately
// before it is sent (market/delivery.ts).
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentConfig, Confinement, SandboxConfig, TeamConfig } from '../config/types.js';
import type { Env } from '../runner/backend.js';
import { TOOLCHAIN_DIRS } from '../sandbox-policy.js';

/**
 * Toolchains a confined shell may read in the home folder. Narrower than what
 * plugins get: nothing that can hold a login (cargo's credentials sit next to
 * its registry, git's next to its config).
 */
const NOT_FOR_ORDERS = new Set(['.cargo', '.gitconfig', '.config/git']);
export const CONFINED_TOOLCHAINS = [...TOOLCHAIN_DIRS.filter((d) => !NOT_FOR_ORDERS.has(d)), '.cargo/bin'];

/** In the working folder, what would be read as instructions or run outside the sandbox at a later turn. */
export const CONFINED_NO_WRITE = ['CLAUDE.md', 'CLAUDE.local.md', '.claude', '.mcp.json'];

/** Variables a confined member's Claude Code process keeps: the basics, proxies and certificates, and the model provider's own. */
const KEEP_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|TMPDIR|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|(ANTHROPIC|CLAUDE|AWS|GOOGLE|CLOUD_ML)_.*)$/i;
/** Of those, the ones that hold a login: Claude Code needs them, its shell commands do not. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** The team as it runs on a stranger's input. Nothing in the team file can loosen this. */
export function confineTeam(team: TeamConfig, confined: Confinement): TeamConfig {
  const agents: Record<string, AgentConfig> = {};
  for (const [name, a] of Object.entries(team.agents)) {
    agents[name] = {
      ...a,
      confined,
      // Package caches in the home folder are not writable either: a cache is read again by the owner's own builds.
      sandbox: a.tools.includes('Bash') ? { network: [...confined.network], allowWrite: [] } : undefined,
      browser: false,
      app: false,
      plugins: [],
    };
  }
  return { ...team, agents, settingSources: [], app: undefined };
}

/** The variables of a team's backends that name a key in the environment (api_key_env, auth_token_env). */
function backendVars(team: TeamConfig): Set<string> {
  const backends = [...Object.values(team.agents).map((a) => a.backend), ...team.steps.flatMap((s) => (s.kind === 'summary' && s.backend ? [s.backend] : []))];
  return new Set(backends.flatMap((b) => [b.api_key_env, b.auth_token_env]).filter((v): v is string => !!v));
}

/**
 * The parent environment of a confined run: without the owner's other keys
 * (GITHUB_TOKEN, NPM_TOKEN, an SSH agent…), which no order needs.
 */
export function confinedEnv(env: Env, team: TeamConfig): Env {
  const named = backendVars(team);
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (KEEP_ENV.test(k) || named.has(k))) out[k] = v;
  return out;
}

/** The variables of a member's environment its shell commands do not get. */
export function secretEnvNames(env: Env): string[] {
  return Object.keys(env).filter((k) => env[k] !== undefined && SECRET_ENV.test(k));
}

/**
 * A path with every link on the way followed, also when its last parts do not
 * exist yet (a file about to be written): a link inside the working folder
 * must not lead a file tool out of it.
 */
export function realPath(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      const up = dirname(at);
      if (up === at) return join(at, ...rest);
      rest.unshift(basename(at));
      at = up;
    }
  }
}

export function inside(path: string, root: string): boolean {
  const r = relative(root, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Whether a host is one of the allowed domains ("example.com", or "*.example.com" for its subdomains). */
export function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => {
    const want = d.toLowerCase();
    return want.startsWith('*.') ? h.endsWith(want.slice(1)) : h === want;
  });
}

/**
 * The sandbox of a confined member's shell commands: the home folder is
 * hidden except `roots` (its working folder and what covibe gives it to read)
 * and installed toolchains; keys in the environment are taken out.
 */
export function confinedSandbox(sandbox: SandboxConfig, o: { roots: string[]; folders: string[]; home: string; env: Env }): SandboxConfig {
  const toolchains = CONFINED_TOOLCHAINS.map((d) => join(o.home, d)).filter((p) => existsSync(p));
  return {
    ...sandbox,
    denyRead: [o.home],
    // A working folder that holds the home folder would open it again.
    allowRead: [...new Set([...o.roots.filter((r) => !inside(o.home, r)), ...toolchains])],
    denyWrite: [...new Set([...(sandbox.denyWrite ?? []), ...o.folders.flatMap((f) => CONFINED_NO_WRITE.map((n) => join(f, n)))])],
    denyEnv: secretEnvNames(o.env),
  };
}
