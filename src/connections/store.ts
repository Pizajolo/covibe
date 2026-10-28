import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BackendConfig } from '../config/types.js';
import { covibeHome } from '../home.js';
import { backendEnv, BackendError, type BackendEnv, type BackendResolver, type Env, type Link } from '../runner/backend.js';
import type { PlanUsage } from '../runner/types.js';
import { OpenAiTranslator } from './openai-proxy.js';
import { defaultSecrets, type SecretStore } from './secrets.js';
import { MAIN_ACCOUNT, type Connection, type ConnectionKind, type ConnectionsFile, type ConnectionView, type Pricing, type ProviderModel } from './types.js';

const exec = promisify(execFile);
const ID = /^[a-z][a-z0-9_-]{0,63}$/;

export class ConnectionError extends Error {}

export interface NewConnection {
  kind: ConnectionKind;
  label: string;
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: ProviderModel[];
}

export type ConnectionPatch = Partial<Pick<Connection, 'label' | 'baseUrl' | 'models'>> & { apiKey?: string | null };

/** Your own Claude Code config folder, where your `claude login` and its sessions live. */
export function mainConfigDir(parent: Env = process.env): string {
  return parent.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The folder that holds the extra accounts' Claude Code config folders. */
export function accountsRoot(home = covibeHome()): string {
  return join(home, 'accounts');
}

/** Every Claude Code config folder covibe uses: yours, then each account's. Sessions are looked up across them. */
export function claudeConfigDirs(parent: Env = process.env, home = covibeHome()): string[] {
  const dirs = [mainConfigDir(parent)];
  const file = join(home, 'connections.json');
  if (existsSync(file)) {
    try {
      for (const c of (JSON.parse(readFileSync(file, 'utf8')) as ConnectionsFile).connections ?? []) if (c.kind === 'claude' && c.configDir) dirs.push(c.configDir);
    } catch {
      // unreadable: just yours
    }
  }
  return dirs;
}

/** Usage of one window as a fraction, from Claude Code's 0..100. */
const frac = (u: PlanUsage | undefined, w: string) => {
  const v = u?.windows.find((x) => x.window === w)?.utilization;
  return typeof v === 'number' ? v / 100 : undefined;
};

/**
 * The connections from Settings → Advanced, shared by the app and the CLI:
 * ~/.covibe/connections.json for the list, the Keychain (or a private file)
 * for keys, ~/.covibe/accounts/<id> for each extra Claude account's login.
 * It also turns team backends into agent environments, starting the OpenAI
 * translator when a member needs it, and spreads members across Claude
 * accounts when balancing is on.
 */
export class Connections implements BackendResolver {
  private readonly file: string;
  private translator?: OpenAiTranslator;
  /** Account → when its limit resets (ms); members avoid it until then. */
  private readonly exhaustedUntil = new Map<string, number>();
  /** Account → members working on it now. */
  private readonly busy = new Map<string, number>();
  private readonly usageCache = new Map<string, { at: number; value: Promise<PlanUsage | undefined> }>();
  /** Reads an account's plan usage (the runner's usage()); set by the app and the CLI. */
  usageReader?: (env: Env) => Promise<PlanUsage>;

  constructor(
    readonly home = covibeHome(),
    readonly secrets: SecretStore = defaultSecrets(home),
  ) {
    this.file = join(home, 'connections.json');
    mkdirSync(home, { recursive: true });
  }

  private read(): ConnectionsFile {
    if (!existsSync(this.file)) return { connections: [] };
    try {
      return { connections: [], ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ConnectionsFile>) };
    } catch {
      return { connections: [] };
    }
  }

  private write(data: ConnectionsFile) {
    writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n');
  }

  list(): Connection[] {
    return this.read().connections;
  }

  views(): ConnectionView[] {
    return this.list().map((c) => ({ ...c, hasKey: c.kind !== 'claude' && !!this.secrets.get(c.id) }));
  }

  get(id: string): Connection | undefined {
    return this.list().find((c) => c.id === id);
  }

  accounts(): Connection[] {
    return this.list().filter((c) => c.kind === 'claude');
  }

  get balance(): boolean {
    return !!this.read().balance;
  }

  setBalance(on: boolean) {
    this.write({ ...this.read(), balance: on });
  }

  add(input: NewConnection): Connection {
    const all = this.read();
    const label = input.label?.trim();
    if (!label) throw new ConnectionError('a name is required');
    if (!['claude', 'anthropic', 'openai'].includes(input.kind)) throw new ConnectionError(`unknown kind "${input.kind}"`);
    const id = input.id ?? uniqueId(slug(label), new Set(all.connections.map((c) => c.id)));
    if (!ID.test(id)) throw new ConnectionError('the id takes lowercase letters, digits, - and _, starting with a letter');
    if (id === MAIN_ACCOUNT) throw new ConnectionError(`"${MAIN_ACCOUNT}" stands for your own claude login; pick another id`);
    if (all.connections.some((c) => c.id === id)) throw new ConnectionError(`a connection "${id}" already exists`);
    const c: Connection = { id, kind: input.kind, label, createdAt: new Date().toISOString() };
    if (input.kind === 'claude') {
      c.configDir = join(accountsRoot(this.home), id);
      mkdirSync(c.configDir, { recursive: true });
    } else {
      c.baseUrl = checkUrl(input.baseUrl);
      c.models = cleanModels(input.models ?? []);
    }
    if (input.apiKey && input.kind !== 'claude') this.secrets.set(id, input.apiKey.trim());
    this.write({ ...all, connections: [...all.connections, c] });
    return c;
  }

  update(id: string, patch: ConnectionPatch): Connection {
    const all = this.read();
    const c = all.connections.find((x) => x.id === id);
    if (!c) throw new ConnectionError(`no connection "${id}"`);
    if (patch.label !== undefined) {
      if (!patch.label.trim()) throw new ConnectionError('a name is required');
      c.label = patch.label.trim();
    }
    if (c.kind !== 'claude') {
      if (patch.baseUrl !== undefined) c.baseUrl = checkUrl(patch.baseUrl);
      if (patch.models !== undefined) c.models = cleanModels(patch.models);
      if (patch.apiKey === null) this.secrets.delete(id);
      else if (patch.apiKey) this.secrets.set(id, patch.apiKey.trim());
    }
    this.write(all);
    return c;
  }

  /** Remove a connection, its key, and for an account its login (signed out first, best effort). */
  async remove(id: string): Promise<void> {
    const all = this.read();
    const c = all.connections.find((x) => x.id === id);
    if (!c) throw new ConnectionError(`no connection "${id}"`);
    if (c.kind === 'claude' && c.configDir) {
      await exec('claude', ['auth', 'logout'], { env: { ...backendEnv({ type: 'subscription' }).env, CLAUDE_CONFIG_DIR: c.configDir }, timeout: 20_000 }).catch(() => undefined);
      if (c.configDir.startsWith(accountsRoot(this.home))) rmSync(c.configDir, { recursive: true, force: true });
    } else this.secrets.delete(id);
    this.write({ ...all, connections: all.connections.filter((x) => x.id !== id) });
  }

  key(id: string): string | undefined {
    return this.secrets.get(id);
  }

  // ---- agent environments

  /** What a connection or account adds to an agent's environment. */
  async link(backend: BackendConfig): Promise<Link | undefined> {
    if (backend.type === 'subscription') {
      if (!backend.account || backend.account === MAIN_ACCOUNT) return undefined;
      const a = this.get(backend.account);
      if (!a || a.kind !== 'claude') throw new BackendError(`Claude account "${backend.account}" is not set up (Settings → Advanced)`);
      return { configDir: a.configDir };
    }
    if (backend.type !== 'connection') return undefined;
    const c = backend.connection ? this.get(backend.connection) : undefined;
    if (!c || c.kind === 'claude') throw new BackendError(`connection "${backend.connection}" is not set up (Settings → Advanced)`);
    const model = c.models?.find((m) => m.id === backend.model);
    const common = { model: backend.model, maxOutput: model?.maxOutput, pricing: model?.price };
    if (c.kind === 'anthropic') {
      const anthropicHost = /(^|\.)anthropic\.com$/.test(new URL(c.baseUrl!).hostname);
      return { ...common, baseUrl: c.baseUrl, token: this.key(c.id), apiKey: anthropicHost };
    }
    const t = await this.openai();
    return { ...common, baseUrl: t.url(c.id), token: t.token };
  }

  async resolve(backend: BackendConfig, parent: Env = process.env): Promise<BackendEnv> {
    const built = backendEnv(backend, parent, await this.link(backend));
    if (backend.type === 'connection' && !built.pricing) {
      built.warnings.push(`no price set for ${backend.model ?? 'this model'} on ${backend.connection}; its spend shows as $0 (Settings → Advanced).`);
    }
    return built;
  }

  /** Throws when a team uses an account or connection that is not set up, so a run fails before it starts. */
  check(backend: BackendConfig): void {
    if (backend.type === 'subscription' && backend.account && backend.account !== MAIN_ACCOUNT && this.get(backend.account)?.kind !== 'claude') {
      throw new BackendError(`Claude account "${backend.account}" is not set up (Settings → Advanced)`);
    }
    if (backend.type === 'connection') {
      const c = backend.connection ? this.get(backend.connection) : undefined;
      if (!c || c.kind === 'claude') throw new BackendError(`connection "${backend.connection}" is not set up (Settings → Advanced)`);
      if (!backend.model) throw new BackendError(`connection "${backend.connection}": no model chosen`);
    }
  }

  private async openai(): Promise<OpenAiTranslator> {
    this.translator ??= new OpenAiTranslator((id) => {
      const c = this.get(id);
      if (!c || c.kind !== 'openai' || !c.baseUrl) return undefined;
      return { baseUrl: c.baseUrl, key: this.key(id), maxOutput: (m) => c.models?.find((x) => x.id === m)?.maxOutput };
    });
    await this.translator.start();
    return this.translator;
  }

  async close(): Promise<void> {
    await this.translator?.close();
    this.translator = undefined;
  }

  // ---- accounts: usage and balancing

  /** An account's environment for reading its usage or account details. */
  accountEnv(account: string, parent: Env = process.env): Env {
    const a = account === MAIN_ACCOUNT ? undefined : this.get(account);
    return backendEnv({ type: 'subscription', ...(a ? { account } : {}) }, parent, a ? { configDir: a.configDir } : undefined).env;
  }

  /** An account's plan usage, read at most once a minute. */
  usage(account: string, fresh = false): Promise<PlanUsage | undefined> {
    if (!this.usageReader) return Promise.resolve(undefined);
    const cached = this.usageCache.get(account);
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = this.usageReader(this.accountEnv(account)).catch(() => undefined);
    this.usageCache.set(account, { at: Date.now(), value });
    return value;
  }

  /**
   * The account a member on the subscription (with no account of its own)
   * should use, when balancing is on: the one with the most room in its
   * 5-hour and weekly windows, counting members already working on it, and
   * none whose limit was hit until it resets. Undefined = balancing is off,
   * or there is only one account. Null = every account is at its limit.
   */
  async pick(exclude: ReadonlySet<string> = new Set()): Promise<string | null | undefined> {
    if (!this.balance) return undefined;
    const ids = [MAIN_ACCOUNT, ...this.accounts().map((a) => a.id)];
    if (ids.length < 2) return undefined;
    const now = Date.now();
    const open = ids.filter((id) => !exclude.has(id) && (this.exhaustedUntil.get(id) ?? 0) <= now);
    if (!open.length) return null;
    const scored = await Promise.all(
      open.map(async (id) => {
        const u = await this.usage(id);
        const five = frac(u, 'five_hour');
        const week = frac(u, 'seven_day');
        if ((five ?? 0) >= 1 || (week ?? 0) >= 1) return { id, score: Infinity };
        // Unknown usage counts as half used, so known-empty accounts go first.
        const used = five === undefined && week === undefined ? 0.5 : Math.max(five ?? 0, week ?? 0);
        return { id, score: used + 0.1 * (this.busy.get(id) ?? 0) };
      }),
    );
    const best = scored.filter((s) => s.score !== Infinity).sort((a, b) => a.score - b.score)[0];
    return best ? best.id : null;
  }

  /** A member started on an account; call the returned function when it stops. */
  claim(account: string): () => void {
    this.busy.set(account, (this.busy.get(account) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.busy.set(account, Math.max(0, (this.busy.get(account) ?? 1) - 1));
    };
  }

  /** An account hit its limit: avoid it until it resets (or for 30 minutes when the reset time is unknown). */
  exhausted(account: string, resetsAt?: number): void {
    const ms = resetsAt ? (resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : Date.now() + 30 * 60_000;
    this.exhaustedUntil.set(account, ms);
    this.usageCache.delete(account);
  }

  /** The earliest time an account comes free again, for waiting when all are at their limit. */
  nextFree(): number | undefined {
    const times = [...this.exhaustedUntil.values()].filter((t) => t > Date.now());
    return times.length ? Math.min(...times) : undefined;
  }
}

function slug(label: string): string {
  const s = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(s) ? s : `c-${s || 'connection'}`;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base === MAIN_ACCOUNT ? `${base}-2` : base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

function checkUrl(url: string | undefined): string {
  const u = url?.trim().replace(/\/+$/, '');
  if (!u || !/^https?:\/\/[^/]+/.test(u)) throw new ConnectionError('the base URL starts with http:// or https://');
  return u;
}

function cleanModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const out: ProviderModel[] = [];
  for (const m of models) {
    const id = String(m.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model: ProviderModel = { id };
    if (m.name?.trim()) model.name = m.name.trim();
    const price = cleanPrice(m.price);
    if (price) model.price = price;
    if (m.maxOutput && Number.isFinite(m.maxOutput) && m.maxOutput > 0) model.maxOutput = Math.round(m.maxOutput);
    out.push(model);
  }
  return out;
}

function cleanPrice(p: Partial<Pricing> | undefined): Pricing | undefined {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = n(p?.input);
  const output = n(p?.output);
  if (input === undefined || output === undefined) return undefined;
  const out: Pricing = { input, output };
  if (n(p?.cacheRead) !== undefined) out.cacheRead = n(p?.cacheRead);
  if (n(p?.cacheWrite) !== undefined) out.cacheWrite = n(p?.cacheWrite);
  return out;
}

/** Estimated USD for a turn's tokens at a connection's prices. */
export function priceOf(p: Pricing, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return (t.input * p.input + t.output * p.output + t.cacheRead * (p.cacheRead ?? p.input / 10) + t.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}

/**
 * The models a provider offers, from its model list (OpenAI: GET /models;
 * Anthropic-compatible: GET /v1/models). Not every provider has one; the
 * error says so and models can be added by hand.
 */
export async function listModels(kind: 'anthropic' | 'openai', baseUrl: string, key: string | undefined): Promise<{ id: string; name?: string }[]> {
  const base = checkUrl(baseUrl);
  const anthropicHost = /(^|\.)anthropic\.com$/.test(new URL(base).hostname);
  const url = kind === 'openai' ? `${base}/models` : `${base}/v1/models?limit=100`;
  const headers: Record<string, string> =
    kind === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(key ? (anthropicHost ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }) : {}) } : key ? { authorization: `Bearer ${key}` } : {};
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new ConnectionError(`could not reach ${base}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ConnectionError(`${url} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: string; display_name?: string; name?: string }[] };
  return (body.data ?? []).filter((m) => typeof m.id === 'string').map((m) => ({ id: m.id!, ...(m.display_name || m.name ? { name: m.display_name ?? m.name } : {}) }));
}

/** The shell command that signs a Claude account in, in its own config folder. */
export function loginCommand(configDir: string): string {
  return `CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, `'\\''`)}' claude auth login`;
}

/**
 * Sign an account in. On a Mac this opens Terminal with `claude auth login`
 * for the account's config folder (the login is interactive and opens the
 * browser); elsewhere it returns the command to run.
 */
export async function startLogin(c: Connection): Promise<{ command: string; opened: boolean }> {
  if (c.kind !== 'claude' || !c.configDir) throw new ConnectionError(`${c.id} is not a Claude account`);
  mkdirSync(c.configDir, { recursive: true });
  const command = loginCommand(c.configDir);
  if (process.platform !== 'darwin') return { command, opened: false };
  const script = join(c.configDir, 'covibe-login.command');
  writeFileSync(
    script,
    `#!/bin/zsh -l
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDECODE
echo "Signing in a Claude account for covibe: ${c.label.replace(/["$`\\]/g, '')}"
echo
${command}
echo
echo "Done. You can close this window and go back to covibe."
`,
    { mode: 0o755 },
  );
  await exec('open', ['-a', 'Terminal', script]);
  return { command, opened: true };
}
