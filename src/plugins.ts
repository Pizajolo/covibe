// The plugin library: Claude Code plugins (skills, commands, agents, hooks,
// MCP and LSP servers, monitors) installed from GitHub and given to members.
//
// Nothing a plugin runs on this computer runs unconfined. covibe keeps the
// plugin's hook, server and monitor configuration to itself and hands Claude
// Code a version in which every one of them starts through the sandbox
// launcher (plugin-sandbox.ts), with the permissions you approved for that
// plugin: no network but its domains, no writes but its own folder (and the
// working folder if allowed), and no reading your home folder.
//
//   ~/.covibe/plugins/<name>/record.json   where it came from, what it runs, what it may do
//   ~/.covibe/plugins/<name>/files/        the plugin as Claude Code loads it
//   ~/.covibe/plugins/<name>/sandbox.json  the launcher's commands and policy (outside files/, out of the plugin's reach)
//   ~/.covibe/plugin-data/<name>/          the plugin's own writable folder (CLAUDE_PLUGIN_DATA)
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { clientStatus, forgetClient, signedInUrl, signInStatus, signOut, type McpClientStatus, type McpSignInStatus } from './connections/mcp-auth.js';
import { mcpProxyUrl, setKeyedTarget } from './connections/mcp-proxy.js';
import { forgetPluginKeys, keysLocation, pluginKeys, setPluginKeys } from './connections/plugin-keys.js';
import { checkout, fetchLfs, forgetCheckout, git, parseGithub, sparse, type GithubRef } from './github.js';
import { covibeHome } from './home.js';
import { McpConfigError, parseMcpInput, type McpInput, type ParsedMcp } from './mcp-config.js';
import { expandHome, shellQuote, substitute, type LaunchSpec, type SandboxPolicy } from './sandbox-policy.js';
import { parseSkillMd, SKILL_PLUGIN } from './skills.js';

export type { McpInput, SandboxPolicy };
export class PluginError extends Error {}

type Json = Record<string, unknown>;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Anthropic's plugin directory, as a catalog to install from. */
export const ANTHROPIC_PLUGINS = 'https://github.com/anthropics/claude-plugins-official';

export interface PluginOrigin {
  /** owner/repo the plugin's files came from. */
  repo: string;
  ref?: string;
  path: string;
  commit: string;
  /** owner/repo of the marketplace that listed it. */
  marketplace?: string;
}

/** Something the plugin runs on this computer (always in the sandbox). */
export interface PluginProgram {
  kind: 'hook' | 'mcp' | 'lsp' | 'monitor';
  /** The hook's event (and matcher), or the server's or monitor's name. */
  name: string;
  command: string;
  /** Environment variables it is given (by name, and yours it pulls in with ${VAR}). */
  env?: string[];
}

/** Something that sends data off this computer without running here: a remote MCP server or an HTTP hook. */
export interface PluginRemote {
  kind: 'mcp' | 'hook';
  name: string;
  url: string;
  /** Your environment variables it uses (in its address or headers). */
  env?: string[];
  /**
   * A remote MCP server covibe can sign in to (OAuth in the browser), and
   * whether it is; members then reach it through covibe's proxy. Absent for
   * hooks and for servers on the older SSE transport.
   */
  signIn?: McpSignInStatus;
  /** Your own OAuth app for signing in, for servers that do not let covibe register itself. */
  client?: McpClientStatus;
}

/** A variable a plugin's servers need (an API key, say), and whether covibe has a value for it. */
export interface PluginVariable {
  name: string;
  /** The servers that use it. */
  servers: string[];
  /** Saved on the plugin's page (with covibe's other keys). */
  saved: boolean;
  /** Set in the environment covibe runs in. */
  inEnvironment: boolean;
}

export interface PluginDoc {
  name: string;
  description: string;
}

export interface PluginContents {
  skills: PluginDoc[];
  commands: PluginDoc[];
  agents: PluginDoc[];
  programs: PluginProgram[];
  remotes: PluginRemote[];
  /** Parts covibe does not load, and why. */
  ignored: string[];
}

export interface LibraryPlugin {
  name: string;
  description: string;
  version?: string;
  origin?: PluginOrigin;
  /** Given to every member of every team. */
  everyone: boolean;
  policy: SandboxPolicy;
  /** False after an update changed what it runs, until you approve it again. */
  approved: boolean;
  contents: PluginContents;
  /** Keys and other values its servers need. */
  variables: PluginVariable[];
  /** You added it as an MCP server (not from GitHub): its servers' config, to change it. */
  mcpServers?: Record<string, Json>;
  updatedAt: string;
}

interface PluginRecord {
  name: string;
  /** The manifest fields Claude Code gets (content only: no hooks, servers or settings). */
  manifest: Json;
  /** How to fetch it again: the location you gave and the plugin chosen there. */
  install?: { url: string; id: string };
  origin?: PluginOrigin;
  everyone?: boolean;
  /** You added it as an MCP server (Plugins → Add MCP server). */
  added?: boolean;
  policy: SandboxPolicy;
  /** Fingerprint of the programs and remotes you approved. */
  approved?: string;
  hooks: Record<string, Json[]>;
  mcpServers: Record<string, Json>;
  lspServers: Record<string, Json>;
  monitors: Json[];
  ignored: string[];
  updatedAt: string;
}

export function pluginsDir(): string {
  return join(covibeHome(), 'plugins');
}

function pluginDir(name: string): string {
  if (!NAME.test(name)) throw new PluginError(`"${name}" is not a valid plugin name (lowercase letters, digits and -)`);
  return join(pluginsDir(), name);
}

function dataDir(name: string): string {
  return join(covibeHome(), 'plugin-data', name);
}

function readRecord(name: string): PluginRecord | undefined {
  try {
    return JSON.parse(readFileSync(join(pluginDir(name), 'record.json'), 'utf8')) as PluginRecord;
  } catch {
    return undefined;
  }
}

function writeRecord(r: PluginRecord) {
  writeFileSync(join(pluginDir(r.name), 'record.json'), JSON.stringify(r, null, 2) + '\n');
}

function records(): PluginRecord[] {
  if (!existsSync(pluginsDir())) return [];
  return readdirSync(pluginsDir())
    .filter((d) => NAME.test(d))
    .sort()
    .map((d) => readRecord(d))
    .filter((r): r is PluginRecord => !!r);
}

// ---------------------------------------------------------------- reading a plugin

interface Parsed extends Omit<PluginRecord, 'install' | 'origin' | 'everyone' | 'policy' | 'approved' | 'updatedAt'> {
  /** Config files taken into the record, left out of the copy Claude Code loads. */
  consumed: string[];
}

/** Manifest fields Claude Code gets as they are: they only point at content. */
const CONTENT_FIELDS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'commands', 'agents', 'skills', 'outputStyles'];
/** Fields covibe takes over (and re-wires through the sandbox). */
const PROGRAM_FIELDS = ['hooks', 'mcpServers', 'lspServers', 'monitors'];
/** Marketplace-entry fields that describe the listing, not the plugin. */
const LISTING_FIELDS = ['source', 'strict', 'category', 'tags', 'displayName', '$schema'];

// Skills, commands and agents can declare hooks (agents also MCP servers) in
// their frontmatter, which Claude Code would run itself, outside the sandbox.
// covibe takes those keys out of every Markdown file in the plugin.
const FRONTMATTER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const isProgramKey = (k: string) => ['hooks', 'mcpservers'].includes(k.toLowerCase().replace(/[^a-z]/g, ''));

/** The Markdown text without program keys in its frontmatter, or undefined if it has none. */
function scrubbed(text: string): string | undefined {
  const m = FRONTMATTER.exec(text);
  if (!m) return undefined;
  let front: unknown;
  try {
    front = parseYaml(m[2]!);
  } catch {
    // Unreadable here but perhaps not to Claude Code: drop it if it could declare programs.
    return /hooks|mcp/i.test(m[2]!) ? text.slice(m[0].length) : undefined;
  }
  if (!isObj(front) || !Object.keys(front).some(isProgramKey)) return undefined;
  const kept = Object.fromEntries(Object.entries(front).filter(([k]) => !isProgramKey(k)));
  return `---\n${Object.keys(kept).length ? stringifyYaml(kept) : ''}---\n${text.slice(m[0].length)}`;
}

/** Every Markdown file in a folder (linked files included; linked folders are never copied). */
function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name) && (e.isFile() || (e.isSymbolicLink() && existsSync(p) && statSync(p).isFile()))) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Take program keys out of the frontmatter of every Markdown file in the copy Claude Code loads. */
function scrubCopy(root: string) {
  for (const f of markdownFiles(root)) {
    const clean = scrubbed(readFileSync(f, 'utf8'));
    if (clean !== undefined) writeFileSync(f, clean);
  }
}

/** A path from the manifest, if it stays inside the plugin. */
function inside(root: string, p: string): string | undefined {
  const abs = resolve(root, p);
  const r = relative(root, abs);
  return r.startsWith('..') || isAbsolute(r) ? undefined : abs;
}

function toName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** Read a plugin folder (and the marketplace entry that listed it, if any) into a record. */
function parsePlugin(root: string, entry?: Json): Parsed {
  const rel = (p: string) => relative(root, p).split(sep).join('/');
  const load = (p: string): unknown => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      throw new PluginError(`${rel(p)} is not valid JSON`);
    }
  };
  const own = existsSync(join(root, '.claude-plugin', 'plugin.json')) ? load(join(root, '.claude-plugin', 'plugin.json')) : {};
  if (!isObj(own)) throw new PluginError('.claude-plugin/plugin.json is not a JSON object');
  const listed: Json = Object.fromEntries(Object.entries(entry ?? {}).filter(([k]) => !LISTING_FIELDS.includes(k)));
  // A strict: false entry is the plugin's whole definition; otherwise plugin.json wins.
  const manifest: Json = entry?.strict === false ? { ...own, ...listed } : { ...listed, ...own };
  const name = toName(String(manifest.name ?? basename(root)));
  if (!NAME.test(name)) throw new PluginError(`the plugin has no usable name`);
  if (name === SKILL_PLUGIN) throw new PluginError(`"${SKILL_PLUGIN}" is reserved for your skill library; this plugin cannot be installed under that name`);

  const consumed: string[] = [];
  const ignored: string[] = [];
  // Config from the default file and from the manifest (paths, inline objects, or lists of either).
  const sources = (field: string, defaultFile: string): unknown[] => {
    const out: unknown[] = [];
    const def = join(root, defaultFile);
    if (existsSync(def)) {
      out.push(load(def));
      consumed.push(def);
    }
    const v = manifest[field];
    for (const item of v === undefined ? [] : Array.isArray(v) ? v : [v]) {
      if (typeof item === 'string') {
        const p = inside(root, item);
        if (!p || !existsSync(p)) ignored.push(`${field}: ${item} (not found in the plugin)`);
        else if (p !== def) {
          out.push(load(p));
          consumed.push(p);
        }
      } else if (isObj(item)) out.push(item);
    }
    return out;
  };

  const hooks: Record<string, Json[]> = {};
  for (const src of sources('hooks', 'hooks/hooks.json')) {
    if (!isObj(src)) continue;
    const events = isObj(src.hooks) ? src.hooks : src;
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!isObj(g) || !Array.isArray(g.hooks)) continue;
        const handlers = g.hooks.filter((h): h is Json => {
          if (isObj(h) && ['command', 'prompt', 'agent', 'http'].includes(String(h.type))) return true;
          ignored.push(`a ${event} hook of type "${isObj(h) ? String(h.type) : typeof h}" (not supported)`);
          return false;
        });
        if (handlers.length) (hooks[event] ??= []).push({ ...g, hooks: handlers });
      }
    }
  }

  const servers = (field: string, defaultFile: string, kind: 'MCP' | 'LSP'): Record<string, Json> => {
    const out: Record<string, Json> = {};
    for (const src of sources(field, defaultFile)) {
      if (!isObj(src)) continue;
      for (const [n, cfg] of Object.entries(isObj(src[field]) ? (src[field] as Json) : src)) {
        if (!isObj(cfg)) continue;
        const local = typeof cfg.command === 'string';
        if (local || (kind === 'MCP' && typeof cfg.url === 'string')) out[n] = cfg;
        else ignored.push(`${kind} server "${n}" (neither a command nor${kind === 'MCP' ? ' an address' : ''} given)`);
      }
    }
    return out;
  };
  const mcpServers = servers('mcpServers', '.mcp.json', 'MCP');
  const lspServers = servers('lspServers', '.lsp.json', 'LSP');

  const monitors: Json[] = [];
  for (const src of sources('monitors', 'monitors/monitors.json')) {
    for (const m of Array.isArray(src) ? src : isObj(src) && Array.isArray(src.monitors) ? src.monitors : [src]) {
      if (isObj(m) && typeof m.command === 'string' && typeof m.name === 'string') monitors.push(m);
    }
  }

  // Settings a plugin would merge into Claude Code's (permissions, env…) are not covibe's to give.
  if (existsSync(join(root, 'settings.json'))) {
    consumed.push(join(root, 'settings.json'));
    ignored.push('settings.json (settings it would apply to Claude Code)');
  }
  for (const k of Object.keys(manifest)) {
    if (!CONTENT_FIELDS.includes(k) && !PROGRAM_FIELDS.includes(k) && k !== '$schema') ignored.push(`manifest field "${k}"`);
  }
  for (const f of markdownFiles(root)) {
    if (scrubbed(readFileSync(f, 'utf8')) !== undefined) ignored.push(`hooks or MCP servers declared in ${rel(f)} (they would run outside the sandbox)`);
  }
  const kept = Object.fromEntries(Object.entries(manifest).filter(([k]) => CONTENT_FIELDS.includes(k)));
  return { name, manifest: { ...kept, name }, hooks, mcpServers, lspServers, monitors, ignored, consumed };
}

/** ${VAR} references to your environment in a piece of config (the plugin's own folders aside). */
function envRefs(v: unknown): string[] {
  const refs = [...JSON.stringify(v ?? '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
  return [...new Set(refs.filter((r) => !r.startsWith('CLAUDE_PLUGIN_')))];
}

function commandLine(cfg: Json): string {
  return [String(cfg.command), ...strings(cfg.args)].join(' ');
}

/** A server's variables: the ones it declares, and yours its config pulls in (Claude Code fills ${VAR} in from your environment). */
function serverEnv(cfg: Json): string[] {
  return [...new Set([...Object.keys(isObj(cfg.env) ? cfg.env : {}), ...envRefs([cfg.command, cfg.args, cfg.env])])];
}

/** The variables a server needs a value for: ${VAR}s in its config, and declared ones it gives no value. */
function neededVars(cfg: Json): string[] {
  const env = isObj(cfg.env) ? cfg.env : {};
  const unset = Object.entries(env).filter(([, v]) => typeof v !== 'string' || !v).map(([k]) => k);
  return [...new Set([...envRefs([cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers]), ...unset])];
}

function variablesOf(r: Pick<PluginRecord, 'mcpServers' | 'lspServers'>, saved: Record<string, string>): PluginVariable[] {
  const out = new Map<string, PluginVariable>();
  for (const [server, cfg] of [...Object.entries(r.mcpServers), ...Object.entries(r.lspServers)]) {
    for (const name of neededVars(cfg)) {
      const v = out.get(name) ?? { name, servers: [], saved: name in saved, inEnvironment: !!process.env[name] };
      v.servers.push(server);
      out.set(name, v);
    }
  }
  return [...out.values()];
}

function programsOf(r: Pick<PluginRecord, 'hooks' | 'mcpServers' | 'lspServers' | 'monitors'>): { programs: PluginProgram[]; remotes: PluginRemote[] } {
  const programs: PluginProgram[] = [];
  const remotes: PluginRemote[] = [];
  for (const [event, groups] of Object.entries(r.hooks)) {
    for (const g of groups) {
      const name = typeof g.matcher === 'string' && g.matcher ? `${event} (${g.matcher})` : event;
      for (const h of g.hooks as Json[]) {
        if (h.type === 'command') programs.push({ kind: 'hook', name, command: String(h.command) });
        else if (h.type === 'http') remotes.push({ kind: 'hook', name, url: String(h.url), env: envRefs(h) });
      }
    }
  }
  for (const [name, cfg] of Object.entries(r.mcpServers)) {
    if (typeof cfg.command === 'string') programs.push({ kind: 'mcp', name, command: commandLine(cfg), env: serverEnv(cfg) });
    else remotes.push({ kind: 'mcp', name, url: String(cfg.url), env: envRefs([cfg.url, cfg.headers]) });
  }
  for (const [name, cfg] of Object.entries(r.lspServers)) programs.push({ kind: 'lsp', name, command: commandLine(cfg), env: serverEnv(cfg) });
  for (const m of r.monitors) programs.push({ kind: 'monitor', name: String(m.name), command: String(m.command) });
  return { programs, remotes };
}

/** What you approve: the programs it runs and the places it sends data. */
function fingerprint(r: Pick<PluginRecord, 'hooks' | 'mcpServers' | 'lspServers' | 'monitors'>): string {
  return createHash('sha256').update(JSON.stringify(programsOf(r))).digest('hex');
}

/** Skills, commands and agents: Markdown files Claude reads, found where the manifest (or the default folder) says. */
function docsOf(root: string, manifest: Json): Pick<PluginContents, 'skills' | 'commands' | 'agents'> {
  const places = (field: string, def: string) => [join(root, def), ...strings(manifest[field] === undefined ? [] : Array.isArray(manifest[field]) ? manifest[field] : [manifest[field]]).map((p) => inside(root, p)).filter((p): p is string => !!p)];
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  const dedupe = (docs: PluginDoc[]) => docs.filter((d, i) => docs.findIndex((x) => x.name === d.name) === i);
  // Named as Claude Code names them: a skill folder listed itself by its SKILL.md name, one in a skills folder by its folder.
  const skill = (dir: string, listed: boolean): PluginDoc => {
    const parsed = parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
    const own = listed ? (parsed.name ?? '').trim().replace(new RegExp(`^${String(manifest.name)}:`), '') : '';
    return { name: (own || basename(dir)).replace(/[^a-zA-Z0-9_-]/g, '-'), description: parsed.description ?? '' };
  };
  const skills: PluginDoc[] = [];
  for (const p of places('skills', 'skills')) {
    if (!isDir(p)) continue;
    if (existsSync(join(p, 'SKILL.md'))) skills.push(skill(p, true));
    else for (const d of readdirSync(p).sort()) if (existsSync(join(p, d, 'SKILL.md'))) skills.push(skill(join(p, d), false));
  }
  const markdown = (field: string, def: string): PluginDoc[] => {
    const out: PluginDoc[] = [];
    const add = (f: string) => out.push({ name: basename(f, '.md'), description: parseSkillMd(readFileSync(f, 'utf8')).description ?? '' });
    for (const p of places(field, def)) {
      if (isDir(p)) for (const f of readdirSync(p).sort()) f.endsWith('.md') && statSync(join(p, f)).isFile() && add(join(p, f));
      else if (p.endsWith('.md') && existsSync(p)) add(p);
    }
    return out;
  };
  return { skills: dedupe(skills), commands: dedupe(markdown('commands', 'commands')), agents: dedupe(markdown('agents', 'agents')) };
}

/** Sensible permissions to start from: package registries for npx/uvx-style servers, and hosts named in commands. */
function suggestPolicy(programs: PluginProgram[]): SandboxPolicy {
  const network = new Set<string>();
  const allowWrite = new Set<string>();
  const tools: Record<string, { domains: string[]; cache: string }> = {
    npx: { domains: ['registry.npmjs.org'], cache: '~/.npm' },
    npm: { domains: ['registry.npmjs.org'], cache: '~/.npm' },
    pnpm: { domains: ['registry.npmjs.org'], cache: '~/.pnpm-store' },
    pnpx: { domains: ['registry.npmjs.org'], cache: '~/.pnpm-store' },
    yarn: { domains: ['registry.yarnpkg.com', 'registry.npmjs.org'], cache: '~/.yarn' },
    bunx: { domains: ['registry.npmjs.org'], cache: '~/.bun/install/cache' },
    uvx: { domains: ['pypi.org', 'files.pythonhosted.org'], cache: '~/.cache/uv' },
    uv: { domains: ['pypi.org', 'files.pythonhosted.org'], cache: '~/.cache/uv' },
    pipx: { domains: ['pypi.org', 'files.pythonhosted.org'], cache: '~/.cache/pip' },
  };
  for (const p of programs) {
    for (const word of p.command.split(/\s+/)) {
      const t = tools[basename(word.replace(/^["']|["']$/g, ''))];
      if (t) {
        t.domains.forEach((d) => network.add(d));
        allowWrite.add(t.cache);
      }
    }
    for (const m of p.command.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) network.add(m[1]!.toLowerCase());
  }
  return { network: [...network], allowWrite: [...allowWrite], writeWorkspace: false };
}

// ---------------------------------------------------------------- what Claude Code loads

/** How to start the launcher: this Node (or Electron as Node), with tsx when covibe runs from source. */
function launcher(): string[] {
  const ts = import.meta.url.endsWith('.ts');
  const script = fileURLToPath(new URL(ts ? './plugin-sandbox.ts' : './plugin-sandbox.js', import.meta.url));
  return [process.execPath, ...(ts ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : []), script];
}

/** Write a file whole (a Claude Code starting meanwhile never reads half of it), or remove it. */
function writeOrRemove(path: string, value: unknown) {
  if (value === undefined) return rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * (Re)write what Claude Code loads from the record: the manifest, and hook,
 * server and monitor configs whose every command is the sandbox launcher.
 * Done before each use, so a policy change applies at once and nothing
 * written to these files in the meantime survives.
 */
function prepare(r: PluginRecord): string {
  const dir = pluginDir(r.name);
  const files = join(dir, 'files');
  const specPath = join(dir, 'sandbox.json');
  const data = dataDir(r.name);
  mkdirSync(data, { recursive: true });
  const L = launcher();
  const saved = pluginKeys(r.name);
  const spec: LaunchSpec = { plugin: r.name, root: files, data, policy: r.policy, hooks: [], monitors: [], mcp: {}, lsp: {}, ...(Object.keys(saved).length ? { keys: keysLocation(r.name) } : {}) };
  const shell = (kind: string, key: string) => `ELECTRON_RUN_AS_NODE=1 ${[...L, specPath, kind, key].map(shellQuote).join(' ')}`;
  const argv = (kind: string, key: string) => ({ command: L[0]!, args: [...L.slice(1), specPath, kind, key] });
  // A server's variables are filled in by the launcher (from the saved keys and the environment), not by Claude Code.
  const entry = (cfg: Json) => {
    const env = isObj(cfg.env) ? cfg.env : {};
    const values = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
    return { command: String(cfg.command), args: strings(cfg.args), env: Object.keys(env), ...(Object.keys(values).length ? { values } : {}) };
  };
  const launcherEnv = { ELECTRON_RUN_AS_NODE: '1' };

  const hooks: Record<string, Json[]> = {};
  for (const [event, groups] of Object.entries(r.hooks)) {
    hooks[event] = groups.map((g) => ({
      ...g,
      hooks: (g.hooks as Json[]).map((h) => {
        if (h.type !== 'command') return h;
        spec.hooks.push({ command: String(h.command) });
        return { ...h, command: shell('hook', String(spec.hooks.length - 1)) };
      }),
    }));
  }
  const mcp: Record<string, Json> = {};
  for (const [n, cfg] of Object.entries(r.mcpServers)) {
    if (typeof cfg.command !== 'string') {
      // Signed in, or needing a saved key: the member's Claude Code goes through covibe's proxy, which adds them.
      // (Another covibe process may rewrite this with its own proxy; both work while they run.)
      const withKeys = canSignIn(cfg) && envRefs([cfg.url, cfg.headers]).some((v) => v in saved);
      const target = remoteTarget(r.name, cfg, saved);
      setKeyedTarget(r.name, n, withKeys ? target : undefined);
      const proxied = canSignIn(cfg) && (withKeys || signedInUrl(r.name, n) === target.url) ? mcpProxyUrl(r.name, n) : undefined;
      if (!proxied) mcp[n] = cfg;
      else if (withKeys) {
        const { headers: _, ...rest } = cfg;
        mcp[n] = { ...rest, type: 'http', url: proxied };
      } else mcp[n] = { ...cfg, type: 'http', url: proxied };
      continue;
    }
    spec.mcp[n] = entry(cfg);
    mcp[n] = { type: 'stdio', ...argv('mcp', n), env: launcherEnv };
  }
  const lsp: Record<string, Json> = {};
  for (const [n, cfg] of Object.entries(r.lspServers)) {
    spec.lsp[n] = entry(cfg);
    lsp[n] = { ...cfg, ...argv('lsp', n), env: launcherEnv };
  }
  const monitors = r.monitors.map((m) => {
    spec.monitors.push({ command: String(m.command) });
    return { ...m, command: shell('monitor', String(spec.monitors.length - 1)) };
  });

  writeOrRemove(join(files, '.claude-plugin', 'plugin.json'), r.manifest);
  writeOrRemove(join(files, 'hooks', 'hooks.json'), Object.keys(hooks).length ? { hooks } : undefined);
  writeOrRemove(join(files, '.mcp.json'), Object.keys(mcp).length ? { mcpServers: mcp } : undefined);
  writeOrRemove(join(files, '.lsp.json'), Object.keys(lsp).length ? lsp : undefined);
  writeOrRemove(join(files, 'monitors', 'monitors.json'), monitors.length ? monitors : undefined);
  writeOrRemove(join(files, 'settings.json'), undefined);
  writeOrRemove(specPath, spec);
  return files;
}

/** A remote server's real address and headers, with the plugin's saved keys (then covibe's environment) filled in. */
function remoteTarget(plugin: string, cfg: Json, saved = pluginKeys(plugin)): { url: string; headers: Record<string, string> } {
  const source = { ...process.env, ...saved };
  const spec = { root: join(pluginDir(plugin), 'files'), data: dataDir(plugin) } as LaunchSpec;
  const headers = Object.fromEntries(Object.entries(isObj(cfg.headers) ? cfg.headers : {}).map(([k, v]) => [k, substitute(String(v), spec, source)]));
  return { url: substitute(String(cfg.url), spec, source), headers };
}

// ---------------------------------------------------------------- the library

function toPlugin(r: PluginRecord): LibraryPlugin {
  const files = join(pluginDir(r.name), 'files');
  const { programs, remotes } = programsOf(r);
  const signInable = (x: PluginRemote) => x.kind === 'mcp' && canSignIn(r.mcpServers[x.name] ?? {});
  return {
    name: r.name,
    description: typeof r.manifest.description === 'string' ? r.manifest.description : '',
    version: typeof r.manifest.version === 'string' ? r.manifest.version : undefined,
    origin: r.origin,
    everyone: !!r.everyone,
    policy: r.policy,
    approved: r.approved === fingerprint(r),
    contents: {
      ...docsOf(files, r.manifest),
      programs,
      remotes: remotes.map((x) => (signInable(x) ? { ...x, signIn: signInStatus(r.name, x.name), client: clientStatus(r.name, x.name) } : x)),
      ignored: r.ignored,
    },
    variables: variablesOf(r, pluginKeys(r.name)),
    ...(r.added ? { mcpServers: r.mcpServers } : {}),
    updatedAt: r.updatedAt,
  };
}

/** A remote MCP server on the streamable HTTP transport (https, or http on this computer), which covibe's sign-in and proxy support. */
function canSignIn(cfg: Json): boolean {
  return typeof cfg.url === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(cfg.url) && cfg.type !== 'sse';
}

/** A plugin's remote MCP server covibe can sign in to: its address, or an error saying why not. */
export function signInTarget(name: string, server: string): string {
  const r = readRecord(name);
  if (!r) throw new PluginError(`plugin ${name} not found`);
  const cfg = r.mcpServers[server];
  if (!cfg || typeof cfg.command === 'string') throw new PluginError(`plugin ${name} has no remote server "${server}"`);
  if (!canSignIn(cfg)) throw new PluginError(`covibe can only sign in to servers on https (or on this computer) that use the streamable HTTP transport; ${server} does not`);
  return remoteTarget(name, cfg).url;
}

export function listPlugins(): LibraryPlugin[] {
  return records().map(toPlugin);
}

export function getPlugin(name: string): LibraryPlugin {
  const r = readRecord(name);
  if (!r) throw new PluginError(`plugin ${name} not found`);
  return toPlugin(r);
}

function update(name: string, change: (r: PluginRecord) => void): LibraryPlugin {
  const r = readRecord(name);
  if (!r) throw new PluginError(`plugin ${name} not found`);
  change(r);
  r.updatedAt = new Date().toISOString();
  writeRecord(r);
  prepare(r);
  return toPlugin(r);
}

export function setEveryone(name: string, everyone: boolean): LibraryPlugin {
  return update(name, (r) => (r.everyone = everyone));
}

/** Approve what the plugin runs now (after an update changed it). */
export function approvePlugin(name: string): LibraryPlugin {
  return update(name, (r) => (r.approved = fingerprint(r)));
}

/** Check and tidy a policy from the UI. */
export function checkPolicy(input: unknown): SandboxPolicy {
  if (!isObj(input)) throw new PluginError('the sandbox policy must be an object');
  const network = [...new Set(strings(input.network).map((d) => d.trim().toLowerCase()).filter(Boolean))];
  for (const d of network) {
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(d) && !/^\[[0-9a-f:]+\](:\d{1,5})?$/.test(d)) throw new PluginError(`"${d}" is not a domain (like api.example.com or *.example.com)`);
  }
  const home = homedir();
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  const allowWrite = [...new Set(strings(input.allowWrite).map((p) => p.trim()).filter(Boolean))];
  for (const p of allowWrite) {
    const abs = resolve(expandHome(p, home));
    if (!isAbsolute(expandHome(p, home))) throw new PluginError(`"${p}" must be a full path or start with ~/`);
    if (abs === '/' || abs === home || home.startsWith(abs + sep)) throw new PluginError(`"${p}" would let the plugin write your whole home folder`);
    // Writing covibe's or Claude Code's own settings would let it change its sandbox or add hooks that run outside it.
    for (const own of [covibeHome(), join(home, '.claude'), join(home, '.claude.json')]) {
      if (overlaps(abs, resolve(own))) throw new PluginError(`"${p}" would let the plugin change ${own.startsWith(covibeHome()) ? "covibe's" : "Claude Code's"} settings, and so its own sandbox`);
    }
  }
  return { network, allowWrite, writeWorkspace: input.writeWorkspace === true };
}

export function setPolicy(name: string, policy: unknown): LibraryPlugin {
  const checked = checkPolicy(policy);
  return update(name, (r) => (r.policy = checked));
}

export function deletePlugin(name: string) {
  const r = readRecord(name);
  for (const server of Object.keys(r?.mcpServers ?? {})) {
    if (signInStatus(name, server).at) signOut(name, server);
    forgetClient(name, server);
    setKeyedTarget(name, server, undefined);
  }
  forgetPluginKeys(name);
  rmSync(pluginDir(name), { recursive: true, force: true });
  rmSync(dataDir(name), { recursive: true, force: true });
}

/**
 * Copy a plugin folder as plain files: no .git, and no symbolic links. A
 * linked file inside the plugin is copied as a file; links that lead out of it
 * (Claude Code would read through them) and linked folders are left out.
 */
function copyPlugin(src: string, dest: string) {
  const real = realpathSync(src);
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (p) => {
      if (p.split(sep).includes('.git')) return false;
      if (!lstatSync(p).isSymbolicLink()) return true;
      try {
        const target = realpathSync(p);
        return target.startsWith(real + sep) && statSync(target).isFile();
      } catch {
        return false;
      }
    },
  });
}

/** Put a plugin folder into the library. Without `approve`, an update that changes what it runs waits for approval. */
export function installFromDir(src: string, opts: { entry?: Json; install?: PluginRecord['install']; origin?: PluginOrigin; policy?: SandboxPolicy; approve: boolean; added?: boolean }): LibraryPlugin {
  const parsed = parsePlugin(src, opts.entry);
  const dir = pluginDir(parsed.name);
  const previous = readRecord(parsed.name);
  if (previous && (previous.install?.url !== opts.install?.url || previous.install?.id !== opts.install?.id)) {
    throw new PluginError(`a different plugin named ${parsed.name} is already in your library`);
  }
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, 'files.new');
  rmSync(staged, { recursive: true, force: true });
  copyPlugin(src, staged);
  for (const c of parsed.consumed) rmSync(join(staged, relative(src, c)), { force: true });
  scrubCopy(staged);
  rmSync(join(dir, 'files'), { recursive: true, force: true });
  renameSync(staged, join(dir, 'files'));

  const { consumed: _, ...rest } = parsed;
  const r: PluginRecord = {
    ...rest,
    install: opts.install,
    origin: opts.origin,
    everyone: previous?.everyone ?? false,
    ...(opts.added ?? previous?.added ? { added: true } : {}),
    policy: opts.policy ?? previous?.policy ?? suggestPolicy(programsOf(parsed).programs),
    updatedAt: new Date().toISOString(),
  };
  const print = fingerprint(r);
  r.approved = opts.approve || previous?.approved === print ? print : undefined;
  writeRecord(r);
  prepare(r);
  return toPlugin(r);
}

/** What installing a plugin folder would add, without installing it. */
export function reviewDir(src: string, entry?: Json): Omit<LibraryPlugin, 'everyone' | 'approved' | 'updatedAt'> {
  const parsed = parsePlugin(src, entry);
  const { programs, remotes } = programsOf(parsed);
  const previous = readRecord(parsed.name);
  return {
    name: parsed.name,
    description: typeof parsed.manifest.description === 'string' ? parsed.manifest.description : '',
    version: typeof parsed.manifest.version === 'string' ? parsed.manifest.version : undefined,
    policy: previous?.policy ?? suggestPolicy(programs),
    contents: { ...docsOf(src, parsed.manifest), programs, remotes, ignored: parsed.ignored },
    variables: variablesOf(parsed, previous ? pluginKeys(parsed.name) : {}),
  };
}

/** Save, replace or (null) remove values of a plugin's variables; they apply from the next turn. */
export function setPluginVariables(name: string, values: Record<string, unknown>): LibraryPlugin {
  const r = readRecord(name);
  if (!r) throw new PluginError(`plugin ${name} not found`);
  const known = new Set(variablesOf(r, {}).map((v) => v.name));
  const change: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!known.has(k)) throw new PluginError(`${name}'s servers do not use a variable "${k}"`);
    if (v !== null && typeof v !== 'string') throw new PluginError(`the value of ${k} must be text`);
    change[k] = typeof v === 'string' ? v.trim() : null;
  }
  setPluginKeys(name, change);
  return update(name, () => undefined);
}

// ---------------------------------------------------------------- MCP servers you add

/** Read what you pasted, or explain what is wrong with it. */
function parseMcp(input: McpInput): ParsedMcp {
  try {
    return parseMcpInput(input);
  } catch (err) {
    if (err instanceof McpConfigError) throw new PluginError(err.message);
    throw err;
  }
}

/** The plugin folder for servers you added: a manifest and an .mcp.json. */
function writeMcpPlugin(p: ParsedMcp): string {
  const dir = mkdtempSync(join(tmpdir(), 'covibe-mcp-'));
  mkdirSync(join(dir, '.claude-plugin'));
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: p.name, description: p.description }, null, 2) + '\n');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: p.servers }, null, 2) + '\n');
  return dir;
}

function checkAddable(name: string) {
  const previous = readRecord(name);
  if (previous && !previous.added) throw new PluginError(`a plugin named ${name} is already in your library; choose another name`);
  if (name === SKILL_PLUGIN) throw new PluginError(`"${SKILL_PLUGIN}" is reserved for your skill library; choose another name`);
  return previous;
}

/** What adding these servers would add and run, and the keys found in what you pasted (by name only). */
export function reviewMcp(input: McpInput) {
  const parsed = parseMcp(input);
  const previous = checkAddable(parsed.name);
  const dir = writeMcpPlugin(parsed);
  try {
    const review = reviewDir(dir);
    return {
      ...review,
      mcpServers: parsed.servers,
      variables: review.variables.map((v) => (v.name in parsed.values ? { ...v, found: true } : v)),
      installed: !!previous,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Add MCP servers as a plugin of your own, with the permissions you approved.
 * Keys found in the config and the values you entered are saved with covibe's
 * other keys; adding again under the same name replaces it.
 */
export function addMcpServer(input: McpInput, policy: unknown, values: Record<string, unknown> = {}): LibraryPlugin {
  const checked = checkPolicy(policy);
  const parsed = parseMcp(input);
  checkAddable(parsed.name);
  const dir = writeMcpPlugin(parsed);
  try {
    installFromDir(dir, { policy: checked, approve: true, added: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const given = Object.fromEntries(Object.entries(values).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()));
  return setPluginVariables(parsed.name, { ...parsed.values, ...given });
}

// ---------------------------------------------------------------- for members

export interface ResolvedPlugins {
  /** Plugin folders for Claude Code to load. */
  dirs: string[];
  /** Their skills and commands, plugin-qualified ("name:skill"), for the member's skill list. */
  skills: string[];
  /** Permission rules for their MCP servers' tools. */
  mcpTools: string[];
}

let status: { at: number; value: { available: boolean; problems: string[]; warnings: string[] } } | undefined;

/** Whether this computer can run plugin programs in the OS sandbox (macOS; Linux with bubblewrap, socat and ripgrep). */
export function sandboxStatus(): { available: boolean; problems: string[]; warnings: string[] } {
  if (status && Date.now() - status.at < 60_000) return status.value;
  let value: { available: boolean; problems: string[]; warnings: string[] };
  if (!SandboxManager.isSupportedPlatform()) value = { available: false, problems: ['this system has no OS sandbox covibe can use (macOS or Linux)'], warnings: [] };
  else {
    const deps = SandboxManager.checkDependencies();
    value = { available: !deps.errors.length, problems: deps.errors, warnings: deps.warnings };
  }
  status = { at: Date.now(), value };
  return value;
}

/** Claude Code's permission rule for all tools of a plugin's MCP server. */
export function mcpToolRule(plugin: string, server: string): string {
  return `mcp__${`plugin:${plugin}:${server}`.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * The plugins a member gets (its own, its team's, and those given to
 * everyone), ready to load. Throws if one is missing, waits for approval,
 * or runs programs on a computer without the OS sandbox: a plugin never
 * runs unconfined.
 */
export function resolvePlugins(requested: string[]): ResolvedPlugins | undefined {
  const all = new Map(records().map((r) => [r.name, r]));
  const wanted = [...new Set([...requested, ...[...all.values()].filter((r) => r.everyone).map((r) => r.name)])];
  if (!wanted.length) return undefined;
  const out: ResolvedPlugins = { dirs: [], skills: [], mcpTools: [] };
  for (const name of wanted) {
    const r = all.get(name);
    if (!r) throw new PluginError(`plugin "${name}" is not in your plugin library`);
    if (r.approved !== fingerprint(r)) throw new PluginError(`plugin ${name} changed what it runs in its last update; approve it on its Plugins page first`);
    if (programsOf(r).programs.length) {
      const s = sandboxStatus();
      if (!s.available) throw new PluginError(`plugin ${name} runs programs, and the OS sandbox they must run in is not available here: ${s.problems.join('; ')}`);
    }
    const dir = prepare(r);
    const docs = docsOf(dir, r.manifest);
    out.dirs.push(dir);
    out.skills.push(...[...docs.skills, ...docs.commands].map((d) => `${name}:${d.name}`));
    out.mcpTools.push(...Object.keys(r.mcpServers).map((s) => mcpToolRule(name, s)));
  }
  return out;
}

// ---------------------------------------------------------------- GitHub

export interface PluginCandidate {
  /** What to install it by: its folder in the repository, or its name in a marketplace. */
  id: string;
  name: string;
  description: string;
  version?: string;
  /** Where its files are, for people (owner/repo/path). */
  from: string;
  installed: boolean;
  /** Why it cannot be installed from here. */
  unsupported?: string;
}

interface Located {
  candidate: PluginCandidate;
  ref?: GithubRef;
  entry?: Json;
  marketplace?: string;
}

/** owner/repo from a GitHub clone address. */
function githubRepo(url: unknown): { owner: string; repo: string } | undefined {
  const m = typeof url === 'string' ? /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim()) : null;
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

/** Where a marketplace entry's files are. */
function locate(entry: Json, market: { ref: GithubRef; pluginRoot?: string }): { ref: GithubRef } | { unsupported: string } {
  const s = entry.source;
  if (typeof s === 'string') {
    const rel = s.startsWith('./') || s.startsWith('../') || !market.pluginRoot ? s : posix.join(market.pluginRoot, s);
    const path = posix.normalize(posix.join(market.ref.path || '.', rel)).replace(/^\.\/?|\/$/g, '');
    if (path.startsWith('..')) return { unsupported: 'its folder is outside the marketplace' };
    return { ref: { ...market.ref, path: path === '.' ? '' : path } };
  }
  if (isObj(s)) {
    const pin = { ref: typeof s.ref === 'string' ? s.ref : undefined, sha: typeof s.sha === 'string' ? s.sha : undefined };
    const sub = typeof s.path === 'string' ? s.path.replace(/^\.?\/+|\/+$/g, '') : '';
    if (s.source === 'github' && typeof s.repo === 'string' && s.repo.includes('/')) {
      const [owner, repo] = s.repo.split('/') as [string, string];
      return { ref: { owner, repo, path: sub, ...pin } };
    }
    if (s.source === 'url' || s.source === 'git-subdir') {
      const gh = githubRepo(s.url);
      if (gh) return { ref: { ...gh, path: s.source === 'git-subdir' ? sub : '', ...pin } };
      return { unsupported: 'only plugins hosted on GitHub can be installed' };
    }
    if (s.source === 'npm') return { unsupported: 'plugins published as npm packages are not supported yet' };
  }
  return { unsupported: 'its source is not one covibe understands' };
}

async function locateAll(url: string): Promise<{ repo: string; commit: string; marketplace?: string; found: Located[] }> {
  const ref = parseGithub(url);
  const { dir, commit } = await checkout(ref);
  const repo = `${ref.owner}/${ref.repo}`;
  const installed = new Set(records().map((r) => r.name));
  const tree = (await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD', ...(ref.path ? ['--', ref.path] : [])])).split('\n').filter(Boolean);
  const marketFile = posix.join(ref.path || '.', '.claude-plugin/marketplace.json').replace(/^\.\//, '');

  if (tree.includes(marketFile)) {
    await sparse(dir, [marketFile]);
    let market: unknown;
    try {
      market = JSON.parse(readFileSync(join(dir, marketFile), 'utf8'));
    } catch {
      throw new PluginError(`${marketFile} is not valid JSON`);
    }
    if (!isObj(market) || !Array.isArray(market.plugins)) throw new PluginError(`${marketFile} lists no plugins`);
    const pluginRoot = isObj(market.metadata) && typeof market.metadata.pluginRoot === 'string' ? market.metadata.pluginRoot : undefined;
    const found = market.plugins.filter(isObj).filter((e) => typeof e.name === 'string').map((entry): Located => {
      const where = locate(entry, { ref, pluginRoot });
      const name = toName(String(entry.name));
      const candidate: PluginCandidate = {
        id: String(entry.name),
        name,
        description: typeof entry.description === 'string' ? entry.description : '',
        version: typeof entry.version === 'string' ? entry.version : undefined,
        from: 'ref' in where ? [`${where.ref.owner}/${where.ref.repo}`, where.ref.path].filter(Boolean).join('/') : repo,
        installed: installed.has(name),
        unsupported: 'unsupported' in where ? where.unsupported : undefined,
      };
      return { candidate, ref: 'ref' in where ? where.ref : undefined, entry, marketplace: String(market.name ?? repo) };
    });
    return { repo, commit, marketplace: typeof market.name === 'string' ? market.name : repo, found };
  }

  // Plugin folders: any with a manifest, or the location itself if it has plugin parts.
  let roots = tree.filter((p) => /(^|\/)\.claude-plugin\/plugin\.json$/.test(p)).map((p) => posix.dirname(posix.dirname(p))).map((p) => (p === '.' ? '' : p));
  if (!roots.length && tree.some((p) => /^(skills|commands|agents|hooks)\/|^\.mcp\.json$/.test(ref.path ? p.slice(ref.path.length + 1) : p))) roots = [ref.path];
  roots = roots.slice(0, 100);
  if (!roots.length) return { repo, commit, found: [] };
  await sparse(dir, roots.map((r) => posix.join(r || '.', '.claude-plugin/plugin.json').replace(/^\.\//, '')));
  const found = roots.map((root): Located => {
    let manifest: Json = {};
    try {
      const m: unknown = JSON.parse(readFileSync(join(dir, root, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (isObj(m)) manifest = m;
    } catch {
      // no manifest: named after its folder
    }
    const name = toName(String(manifest.name ?? posix.basename(root || ref.repo)));
    return {
      candidate: {
        id: root,
        name,
        description: typeof manifest.description === 'string' ? manifest.description : '',
        version: typeof manifest.version === 'string' ? manifest.version : undefined,
        from: [repo, root].filter(Boolean).join('/'),
        installed: installed.has(name),
      },
      ref: { ...ref, path: root },
    };
  });
  return { repo, commit, found };
}

/** Find the plugins at a GitHub location: a marketplace, a plugin, or a repository holding plugins. */
export async function scanGithub(url: string): Promise<{ repo: string; commit: string; marketplace?: string; plugins: PluginCandidate[] }> {
  const { repo, commit, marketplace, found } = await locateAll(url);
  return { repo, commit, marketplace, plugins: found.map((f) => f.candidate) };
}

/** Fetch one plugin's files. */
async function fetchPlugin(url: string, id: string): Promise<{ src: string; entry?: Json; origin: PluginOrigin }> {
  const { found } = await locateAll(url);
  const hit = found.find((f) => f.candidate.id === id);
  if (!hit) throw new PluginError(`no plugin "${id}" at ${url}`);
  if (!hit.ref) throw new PluginError(`${hit.candidate.name} cannot be installed: ${hit.candidate.unsupported}`);
  const { dir, commit } = await checkout(hit.ref);
  await sparse(dir, [hit.ref.path ? `${hit.ref.path}/` : '']);
  await fetchLfs(dir, [hit.ref.path]);
  const src = join(dir, hit.ref.path);
  if (!existsSync(src)) throw new PluginError(`${hit.candidate.from} was not found`);
  return { src, entry: hit.entry, origin: { repo: `${hit.ref.owner}/${hit.ref.repo}`, ref: hit.ref.ref, path: hit.ref.path, commit, marketplace: hit.marketplace } };
}

/** What a plugin at a GitHub location contains and runs, before you install it. */
export async function reviewGithub(url: string, id: string) {
  const { src, entry, origin } = await fetchPlugin(url, id);
  return { ...reviewDir(src, entry), origin, installed: !!readRecord(parsePlugin(src, entry).name) };
}

/** Install a plugin from GitHub with the permissions you approved. */
export async function installGithub(url: string, id: string, policy: unknown): Promise<LibraryPlugin> {
  const checked = checkPolicy(policy);
  const { src, entry, origin } = await fetchPlugin(url, id);
  return installFromDir(src, { entry, origin, install: { url, id }, policy: checked, approve: true });
}

/** Re-install a plugin from the latest commit of its source. Changes to what it runs wait for your approval. */
export async function updatePlugin(name: string): Promise<LibraryPlugin> {
  const r = readRecord(name);
  if (!r?.install) throw new PluginError(`${name} was not installed from GitHub`);
  forgetCheckout(parseGithub(r.install.url));
  if (r.origin) {
    const [owner, repo] = r.origin.repo.split('/') as [string, string];
    forgetCheckout({ owner, repo, ref: r.origin.ref });
  }
  const { src, entry, origin } = await fetchPlugin(r.install.url, r.install.id);
  return installFromDir(src, { entry, origin, install: r.install, approve: false });
}
