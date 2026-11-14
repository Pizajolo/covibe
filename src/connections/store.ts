import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BackendConfig } from '../config/types.js';
import { covibeHome, replaceFile } from '../home.js';
import { backendEnv, BackendError, type BackendEnv, type BackendResolver, type Env, type Link } from '../runner/backend.js';
import type { PlanUsage } from '../runner/types.js';
import { Attestor, attestsByDefault } from './attest.js';
import { CODEX_ENDPOINTS, CODEX_MODELS, CodexAuth, planUsageFromHeaders, startCodexLogin, type CodexEndpoints, type CodexIdentity, type CodexLogin } from './codex-auth.js';
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
  attest?: boolean;
}

export type ConnectionPatch = Partial<Pick<Connection, 'label' | 'baseUrl' | 'models' | 'attest'>> & { apiKey?: string | null };

/** Your own Claude Code config folder, where your `claude login` and its sessions live. */
export function mainConfigDir(parent: Env = process.env): string {
  return parent.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The folder that holds the extra accounts' folders: Claude Code config folders, and ChatGPT accounts' sign-ins. */
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
 * for keys, ~/.covibe/accounts/<id> for each extra Claude account's login and
 * each ChatGPT account's sign-in. It also turns team backends into agent
 * environments, starting the OpenAI translator when a member needs it, and
 * spreads members across Claude accounts when balancing is on.
 */
export class Connections implements BackendResolver {
  private readonly file: string;
  private translator?: OpenAiTranslator;
  private readonly attestors = new Map<string, { id: string; attestor: Attestor }>();
  /** Account → when its limit resets (ms); members avoid it until then. */
  private readonly exhaustedUntil = new Map<string, number>();
  /** Account → members working on it now. */
  private readonly busy = new Map<string, number>();
  private readonly usageCache = new Map<string, { at: number; value: Promise<PlanUsage | undefined> }>();
  /** Reads an account's plan usage (the runner's usage()); set by the app and the CLI. */
  usageReader?: (env: Env) => Promise<PlanUsage>;
  private readonly codexAuths = new Map<string, CodexAuth>();
  /** The ChatGPT sign-in in progress (one at a time: they share the callback port). */
  private codexLogin?: { id: string; login: CodexLogin };
  /** How each account's last sign-in ended, for the app to show. */
  private readonly codexLoginEnded = new Map<string, { error?: string }>();

  constructor(
    readonly home = covibeHome(),
    readonly secrets: SecretStore = defaultSecrets(home),
    /** Where ChatGPT accounts sign in and send requests (tests point these at a fake). */
    readonly codexEndpoints: CodexEndpoints = CODEX_ENDPOINTS,
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
    replaceFile(this.file, JSON.stringify(data, null, 2) + '\n');
  }

  list(): Connection[] {
    return this.read().connections;
  }

  views(): ConnectionView[] {
    return this.list().map((c) => ({ ...c, hasKey: c.kind === 'codex' ? this.codex(c).signedIn() : c.kind !== 'claude' && !!this.secrets.get(c.id) }));
  }

  get(id: string): Connection | undefined {
    return this.list().find((c) => c.id === id);
  }

  accounts(): Connection[] {
    return this.list().filter((c) => c.kind === 'claude');
  }

  /** The provider that offers this model (matched on its id, else its display name), with the id it expects. */
  providerFor(model: string): { connection: string; model: string } | undefined {
    const want = model.trim().toLowerCase();
    const providers = this.list().filter((c) => c.kind !== 'claude');
    for (const match of [(m: ProviderModel) => m.id.toLowerCase() === want, (m: ProviderModel) => m.name?.trim().toLowerCase() === want]) {
      for (const c of providers) {
        const found = c.models?.find(match);
        if (found) return { connection: c.id, model: found.id };
      }
    }
    return undefined;
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
    if (!['claude', 'anthropic', 'openai', 'codex'].includes(input.kind)) throw new ConnectionError(`unknown kind "${input.kind}"`);
    const id = input.id ?? uniqueId(slug(label), new Set(all.connections.map((c) => c.id)));
    if (!ID.test(id)) throw new ConnectionError('the id takes lowercase letters, digits, - and _, starting with a letter');
    if (id === MAIN_ACCOUNT) throw new ConnectionError(`"${MAIN_ACCOUNT}" stands for your own claude login; pick another id`);
    if (all.connections.some((c) => c.id === id)) throw new ConnectionError(`a connection "${id}" already exists`);
    const c: Connection = { id, kind: input.kind, label, createdAt: new Date().toISOString() };
    if (input.kind === 'claude') {
      c.configDir = join(accountsRoot(this.home), id);
      mkdirSync(c.configDir, { recursive: true });
    } else if (input.kind === 'codex') {
      // Signed in from the browser (codexSignIn), not with a key; the account's models replace these once it is.
      c.configDir = join(accountsRoot(this.home), id);
      mkdirSync(c.configDir, { recursive: true, mode: 0o700 });
      c.baseUrl = this.codexEndpoints.baseUrl;
      c.models = cleanModels(input.models?.length ? input.models : CODEX_MODELS);
    } else {
      c.baseUrl = checkUrl(input.baseUrl);
      c.models = cleanModels(input.models ?? []);
      if (input.kind === 'openai' && typeof input.attest === 'boolean') c.attest = input.attest;
    }
    if (input.apiKey && input.kind !== 'claude' && input.kind !== 'codex') this.secrets.set(id, input.apiKey.trim());
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
    if (c.kind === 'codex') {
      if (patch.models !== undefined) c.models = cleanModels(patch.models);
    } else if (c.kind !== 'claude') {
      if (patch.baseUrl !== undefined) c.baseUrl = checkUrl(patch.baseUrl);
      if (patch.models !== undefined) c.models = cleanModels(patch.models);
      if (c.kind === 'openai' && typeof patch.attest === 'boolean') c.attest = patch.attest;
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
    } else if (c.kind === 'codex') {
      if (this.codexLogin?.id === id) this.codexLogin.login.cancel();
      await this.codex(c).signOut();
      if (c.configDir?.startsWith(accountsRoot(this.home))) rmSync(c.configDir, { recursive: true, force: true });
      this.codexAuths.delete(id);
      this.usageCache.delete(id);
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
    if (c.kind === 'codex' && !this.codex(c).signedIn()) throw new BackendError(`ChatGPT account "${c.id}" is not signed in (Settings → Advanced)`);
    const model = c.models?.find((m) => m.id === backend.model);
    const common = { model: backend.model, maxOutput: model?.maxOutput, pricing: model?.price };
    if (c.kind === 'anthropic') {
      const anthropicHost = /(^|\.)anthropic\.com$/.test(new URL(c.baseUrl!).hostname);
      return { ...common, baseUrl: c.baseUrl, token: this.key(c.id), apiKey: anthropicHost };
    }
    const t = await this.openai();
    // A provider that signs its answers: this member's calls go under a tag of their own, and what
    // the provider signed about them is collected when the member is done.
    if (c.kind === 'openai' && this.attests(c)) {
      const tag = randomBytes(8).toString('hex');
      return { ...common, baseUrl: t.url(c.id, tag), token: t.token, attested: () => this.attestor(c).drain(tag) };
    }
    return { ...common, baseUrl: t.url(c.id), token: t.token };
  }

  async resolve(backend: BackendConfig, parent: Env = process.env): Promise<BackendEnv> {
    const built = backendEnv(backend, parent, await this.link(backend));
    // A ChatGPT plan is not paid per token: no price is not a mistake there.
    if (backend.type === 'connection' && !built.pricing && this.get(backend.connection ?? '')?.kind !== 'codex') {
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
      if (c.kind === 'codex' && !this.codex(c).signedIn()) throw new BackendError(`ChatGPT account "${c.id}" is not signed in (Settings → Advanced)`);
    }
  }

  /** Whether a provider's answers are signed and checked: as set on the connection, else by its address. */
  attests(c: Connection): boolean {
    return c.kind === 'openai' && (c.attest ?? attestsByDefault(c.baseUrl));
  }

  private attestor(c: Connection): Attestor {
    const key = this.key(c.id);
    const id = `${c.baseUrl}|${key ?? ''}`;
    const kept = this.attestors.get(c.id);
    if (kept?.id === id) return kept.attestor;
    const attestor = new Attestor(c.baseUrl!.replace(/\/+$/, ''), key);
    this.attestors.set(c.id, { id, attestor });
    return attestor;
  }

  private async openai(): Promise<OpenAiTranslator> {
    this.translator ??= new OpenAiTranslator((id) => {
      const c = this.get(id);
      if (!c || (c.kind !== 'openai' && c.kind !== 'codex') || !c.baseUrl) return undefined;
      const maxOutput = (m: string) => c.models?.find((x) => x.id === m)?.maxOutput;
      if (c.kind === 'openai') return { baseUrl: c.baseUrl, key: this.key(id), maxOutput, ...(this.attests(c) ? { attestor: this.attestor(c) } : {}) };
      const auth = this.codex(c);
      return {
        baseUrl: c.baseUrl,
        maxOutput,
        codex: {
          headers: (force) => auth.headers(force),
          efforts: (m) => c.models?.find((x) => x.id === m)?.efforts,
          // Every answer says how much of the plan is used; keep it for the usage meters.
          seen: (headers) => {
            const u = planUsageFromHeaders(headers);
            if (u) this.usageCache.set(id, { at: Date.now(), value: Promise.resolve({ ...u, subscription: auth.identity()?.plan }) });
          },
          limited: () => this.usageCache.delete(id),
        },
      };
    });
    await this.translator.start();
    return this.translator;
  }

  async close(): Promise<void> {
    await this.translator?.close();
    this.translator = undefined;
  }

  // ---- ChatGPT accounts

  /** A ChatGPT account's sign-in. */
  codex(c: Connection): CodexAuth {
    if (c.kind !== 'codex' || !c.configDir) throw new ConnectionError(`${c.id} is not a ChatGPT account`);
    let auth = this.codexAuths.get(c.id);
    if (!auth) this.codexAuths.set(c.id, (auth = new CodexAuth(c.configDir, this.codexEndpoints)));
    return auth;
  }

  /** Who a ChatGPT account is signed in as. */
  codexInfo(id: string): { loggedIn: boolean; email?: string; subscriptionType?: string } {
    const c = this.get(id);
    if (!c || c.kind !== 'codex') throw new ConnectionError(`no ChatGPT account "${id}"`);
    const auth = this.codex(c);
    if (!auth.signedIn()) return { loggedIn: false };
    const who: CodexIdentity = auth.identity() ?? {};
    return { loggedIn: true, ...(who.email ? { email: who.email } : {}), ...(who.plan ? { subscriptionType: who.plan } : {}) };
  }

  /**
   * Start signing a ChatGPT account in: returns the page to open in a
   * browser. When the sign-in finishes, the account's own model list
   * replaces the one it was added with (prices and caps set by hand stay).
   */
  async codexSignIn(id: string): Promise<{ url: string; done: Promise<CodexIdentity> }> {
    const c = this.get(id);
    if (!c || c.kind !== 'codex') throw new ConnectionError(`no ChatGPT account "${id}"`);
    this.codexLogin?.login.cancel();
    const login = await startCodexLogin(this.codex(c));
    this.codexLogin = { id, login };
    this.codexLoginEnded.delete(id);
    const done = login.done.then(async (who) => {
      this.usageCache.delete(id);
      const models = await this.codexModels(id).catch(() => undefined);
      if (models?.length) {
        const kept = new Map((this.get(id)?.models ?? []).map((m) => [m.id, m]));
        this.update(id, { models: models.map((m) => ({ ...kept.get(m.id), ...m })) });
      }
      return who;
    });
    void done.then(
      () => this.codexLoginEnded.set(id, {}),
      (err: Error) => this.codexLoginEnded.set(id, { error: err.message }),
    ).finally(() => {
      if (this.codexLogin?.login === login) this.codexLogin = undefined;
    });
    return { url: login.url, done };
  }

  /** Whether a ChatGPT account's sign-in is still waiting for the browser, and how the last one ended. */
  codexSignInState(id: string): { pending: boolean; error?: string } {
    if (this.codexLogin?.id === id) return { pending: true };
    return { pending: false, ...this.codexLoginEnded.get(id) };
  }

  /** The models a ChatGPT account may use, from the account. */
  codexModels(id: string): Promise<ProviderModel[]> {
    const c = this.get(id);
    if (!c || c.kind !== 'codex') throw new ConnectionError(`no ChatGPT account "${id}"`);
    return this.codex(c).models();
  }

  private async codexUsage(c: Connection): Promise<PlanUsage | undefined> {
    const auth = this.codex(c);
    if (!auth.signedIn()) return undefined;
    try {
      return await auth.usage();
    } catch {
      return { available: false, windows: [], ...(auth.identity()?.plan ? { subscription: auth.identity()!.plan } : {}) };
    }
  }

  // ---- accounts: usage and balancing

  /** An account's environment for reading its usage or account details. */
  accountEnv(account: string, parent: Env = process.env): Env {
    const a = account === MAIN_ACCOUNT ? undefined : this.get(account);
    return backendEnv({ type: 'subscription', ...(a ? { account } : {}) }, parent, a ? { configDir: a.configDir } : undefined).env;
  }

  /** An account's plan usage, read at most once a minute. */
  usage(account: string, fresh = false): Promise<PlanUsage | undefined> {
    const codex = account === MAIN_ACCOUNT ? undefined : this.get(account);
    if (!this.usageReader && codex?.kind !== 'codex') return Promise.resolve(undefined);
    const cached = this.usageCache.get(account);
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = codex?.kind === 'codex' ? this.codexUsage(codex) : this.usageReader!(this.accountEnv(account)).catch(() => undefined);
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
  // A preset's placeholder that was not filled in (Alibaba's {WorkspaceId}).
  const blank = /\{[^}]*\}/.exec(u)?.[0];
  if (blank) throw new ConnectionError(`replace ${blank} in the base URL with your own value`);
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
    const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string' && /^[a-z]+$/.test(e)) : [];
    if (efforts.length) model.efforts = [...new Set(efforts)];
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

/** Open a page in the default browser; false when that fails (the app then shows the link to open by hand). */
export async function openInBrowser(url: string): Promise<boolean> {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return exec(cmd, args, { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
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
