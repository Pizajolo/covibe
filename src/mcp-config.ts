// Reading an MCP server you add by hand (Plugins → Add MCP server): its
// address, the command that starts it, or the JSON snippet its maker
// publishes for Claude Code, Claude Desktop, Cursor or VS Code. covibe turns
// it into a small local plugin, so it gets the same review, sandbox, sign-in
// and proxy as any plugin.
//
// Keys written into the snippet (an API key in "env" or a header) are taken
// out of the config: the server gets ${VAR} instead, and the value is saved
// with covibe's other keys.

export class McpConfigError extends Error {}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface McpInput {
  /** An address, a command line, or a JSON snippet. */
  config: string;
  /** The plugin's name; taken from the config when left out. */
  name?: string;
  description?: string;
  /** For an address: a header that carries a key, such as Authorization or xi-api-key. */
  header?: { name: string; value: string };
}

export interface ParsedMcp {
  name: string;
  description: string;
  /** The servers as the plugin's .mcp.json lists them, keys replaced by ${VAR}. */
  servers: Record<string, Json>;
  /** The keys taken out of the config, by variable name. */
  values: Record<string, string>;
}

/** A value that stands for a key you still have to fill in ("<your-api-key>", "YOUR_TOKEN_HERE"). */
const PLACEHOLDER = /^\s*$|^<.*>$|^\[.*\]$|^\{\{.*\}\}$|your|replace|insert|x{4,}|\.\.\.|changeme/i;
/** A variable or header that carries a secret. */
const SECRETY = /key|token|secret|passw|auth|credential|cookie|session/i;
/** Programs that fetch and start a package: the package names the server. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'deno', 'docker', 'podman', 'npm', 'pnpm', 'yarn', 'bun', 'uv']);
const RUNNER_WORDS = new Set(['run', 'exec', 'dlx', 'x', 'tool', '--from', 'mcp']);

function toName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 64);
}

function envName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1');
}

/** Split a command line into words, as a shell would (quotes and backslashes; no expansion). */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new McpConfigError('the command has an unclosed quote');
  if (started) words.push(word);
  return words;
}

/** A name for a server at an address: mcp.elevenlabs.io → elevenlabs. */
function nameFromUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname === 'localhost' || /^[\d.]+$|^\[/.test(u.hostname)) return toName(u.pathname.split('/').filter((p) => p && p !== 'mcp' && p !== 'sse')[0] ?? 'local-mcp') || 'local-mcp';
  const parts = u.hostname.split('.');
  if (parts.length > 1) parts.pop();
  while (parts.length > 1 && ['mcp', 'api', 'www', 'app', 'server'].includes(parts[0]!)) parts.shift();
  return toName(parts.join('-')) || 'mcp';
}

/** A name for a server started by a command: npx -y @elevenlabs/mcp → elevenlabs-mcp. */
function nameFromCommand(command: string, args: string[]): string {
  const base = command.split('/').pop()!;
  let pkg = base;
  if (RUNNERS.has(base)) {
    const words = args.filter((a) => !a.startsWith('-') && !RUNNER_WORDS.has(a) && !a.includes('='));
    pkg = (base === 'docker' || base === 'podman' ? words.at(-1) : words[0]) ?? base;
  }
  const clean = pkg
    .replace(/^(npm|jsr|pypi):/, '')
    .replace(/(.)@[^/]*$/, '$1')
    .replace(/:[\w.-]+$/, '')
    .replace(/^@([^/]+)\/(.+)$/, (_m, scope: string, rest: string) => (rest === scope || rest.startsWith(`${scope}-`) ? rest : `${scope}-${rest}`))
    .replace(/^(mcp|ghcr\.io)\//, '')
    .split('/')
    .pop()!;
  return toName(clean.replace(/\.(js|ts|py|mjs|cjs)$/, '')) || 'mcp';
}

/** The servers in a JSON snippet, in any of the usual shapes. */
function serversFromJson(text: string): { servers: Record<string, Json>; single: boolean } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    try {
      // A snippet copied without its outer braces: "name": { ... }
      v = JSON.parse(`{${text.replace(/,\s*$/, '')}}`);
    } catch (err) {
      throw new McpConfigError(`the JSON is not valid: ${(err as Error).message}`);
    }
  }
  if (!isObj(v)) throw new McpConfigError('the JSON must be an object');
  // { "mcpServers": {...} } (Claude, Cursor), { "servers": {...} } (VS Code), { "mcp": { "servers": {...} } } (VS Code settings).
  const holder = isObj(v.mcpServers) ? v.mcpServers : isObj(v.servers) ? v.servers : isObj(v.mcp) && isObj(v.mcp.servers) ? v.mcp.servers : undefined;
  if (holder) return { servers: Object.fromEntries(Object.entries(holder).filter((e): e is [string, Json] => isObj(e[1]))), single: false };
  if (typeof v.command === 'string' || typeof v.url === 'string' || typeof v.serverUrl === 'string') return { servers: { '': v }, single: true };
  const entries = Object.entries(v).filter((e): e is [string, Json] => isObj(e[1]));
  if (!entries.length) throw new McpConfigError('no MCP server found in the JSON (expected "mcpServers", or a server with "command" or "url")');
  return { servers: Object.fromEntries(entries), single: false };
}

/** One server's config as Claude Code reads it. */
function normalize(cfg: Json, label: string): Json {
  const out: Json = { ...cfg };
  if (typeof out.serverUrl === 'string' && typeof out.url !== 'string') out.url = out.serverUrl;
  delete out.serverUrl;
  if (typeof out.command === 'string') {
    // "command": "npx -y pkg" with no args: split it.
    if (!Array.isArray(out.args) && /\s/.test(out.command.trim())) {
      const [command, ...args] = splitCommand(out.command.trim());
      out.command = command;
      out.args = args;
    }
    if (out.args !== undefined && (!Array.isArray(out.args) || out.args.some((a) => typeof a !== 'string'))) throw new McpConfigError(`server "${label}": "args" must be a list of strings`);
    if (out.type !== undefined && out.type !== 'stdio') delete out.type;
    return out;
  }
  if (typeof out.url !== 'string') throw new McpConfigError(`server "${label}" has neither a "command" nor a "url"`);
  let url: URL;
  try {
    url = new URL(out.url.replace(/\$\{[^}]*\}/g, 'x'));
  } catch {
    throw new McpConfigError(`server "${label}": "${out.url}" is not an address`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new McpConfigError(`server "${label}": only http and https addresses work`);
  const type = String(out.type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  out.type = type === 'sse' || (!type && /\/sse\/?$/.test(url.pathname)) ? 'sse' : 'http';
  return out;
}

/** Take keys out of a server's env and headers: ${VAR} in the config, the value in `values`. */
function extractKeys(server: string, cfg: Json, values: Record<string, string>, forceHeaders: Set<string>) {
  if (isObj(cfg.env)) {
    const env: Json = {};
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v !== 'string' || v.includes('${')) env[k] = v;
      else if (PLACEHOLDER.test(v)) env[k] = `\${${k}}`;
      else if (SECRETY.test(k)) {
        env[k] = `\${${k}}`;
        values[k] = v;
      } else env[k] = v;
    }
    cfg.env = env;
  }
  if (isObj(cfg.headers)) {
    const headers: Json = {};
    for (const [h, v] of Object.entries(cfg.headers)) {
      if (typeof v !== 'string' || v.includes('${') || !(SECRETY.test(h) || forceHeaders.has(h))) {
        headers[h] = v;
        continue;
      }
      const m = /^(Bearer|Basic|Token)\s+(.*)$/i.exec(v.trim());
      const secret = m ? m[2]!.trim() : v.trim();
      const name = envName(`${server}_${/^authorization$/i.test(h) ? 'token' : h}`);
      headers[h] = m ? `${m[1]} \${${name}}` : `\${${name}}`;
      if (!PLACEHOLDER.test(secret)) values[name] = secret;
    }
    cfg.headers = headers;
  }
}

/** Read what you pasted into one or more servers for a plugin. */
export function parseMcpInput(input: McpInput): ParsedMcp {
  const text = (input.config ?? '').trim();
  if (!text) throw new McpConfigError('paste an address, a command or a JSON snippet');
  let raw: Record<string, Json>;
  let guessed: string;
  let what: string;
  if (/^[{"]/.test(text)) {
    const { servers, single } = serversFromJson(text);
    const keys = Object.keys(servers);
    const first = servers[keys[0]!]!;
    guessed = single || keys.length !== 1 ? (typeof first.command === 'string' ? nameFromCommand(...commandOf(first)) : nameFromUrl(String(first.url ?? first.serverUrl))) : toName(keys[0]!);
    // A lone server is named after the plugin.
    raw = single ? { '': first } : servers;
    what = keys.length > 1 ? `${keys.length} MCP servers` : typeof first.command === 'string' ? 'MCP server' : 'Remote MCP server';
  } else if (/^https?:\/\//i.test(text)) {
    if (/\s/.test(text)) throw new McpConfigError('an address cannot contain spaces');
    guessed = nameFromUrl(text);
    raw = { '': { url: text } };
    what = `Remote MCP server at ${new URL(text).host}`;
  } else {
    const words = splitCommand(text);
    const env: Record<string, string> = {};
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
      const w = words.shift()!;
      env[w.slice(0, w.indexOf('='))] = w.slice(w.indexOf('=') + 1);
    }
    const [command, ...args] = words;
    if (!command) throw new McpConfigError('the command is empty');
    guessed = nameFromCommand(command, args);
    raw = { '': { command, args, ...(Object.keys(env).length ? { env } : {}) } };
    what = `MCP server started with ${[command, ...args].join(' ').slice(0, 80)}`;
  }

  const name = toName(input.name?.trim() || guessed);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new McpConfigError(`"${input.name ?? guessed}" is not a usable name (lowercase letters, digits and -)`);
  const values: Record<string, string> = {};
  const servers: Record<string, Json> = {};
  for (const [key, cfg] of Object.entries(raw)) {
    const server = key || name;
    const out = normalize(cfg, server);
    const force = new Set<string>();
    if (input.header?.name.trim() && input.header.value.trim() && typeof out.url === 'string') {
      out.headers = { ...(isObj(out.headers) ? out.headers : {}), [input.header.name.trim()]: input.header.value.trim() };
      force.add(input.header.name.trim());
    }
    extractKeys(server, out, values, force);
    servers[server] = out;
  }
  return { name, description: input.description?.trim() || `${what} (added by hand)`, servers, values };
}

function commandOf(cfg: Json): [string, string[]] {
  if (Array.isArray(cfg.args)) return [String(cfg.command), cfg.args.map(String)];
  const [command, ...args] = splitCommand(String(cfg.command));
  return [command ?? '', args];
}
