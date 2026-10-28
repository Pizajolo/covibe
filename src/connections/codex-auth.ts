// ChatGPT accounts (the sign-in Codex uses): signing in through the browser,
// keeping the tokens fresh, and reading the plan's usage and models. Each
// account keeps its sign-in in its own folder, in an auth.json shaped like
// Codex's own (~/.codex/auth.json), readable only by you. The tokens never
// reach an agent: covibe's translator adds them to the requests it forwards.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { PlanUsage } from '../runner/types.js';
import type { ProviderModel } from './types.js';

export interface CodexEndpoints {
  /** The OpenAI sign-in service. */
  issuer: string;
  /** The ChatGPT backend's Codex API; Responses requests go to <baseUrl>/responses. */
  baseUrl: string;
  /** Where the browser comes back to after signing in (default: the ports Codex's sign-in knows). */
  callbackPorts?: number[];
}

export const CODEX_ENDPOINTS: CodexEndpoints = { issuer: 'https://auth.openai.com', baseUrl: 'https://chatgpt.com/backend-api/codex' };

/** Codex's public OAuth client (PKCE, no secret); its sign-in only knows this client's callback ports. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CALLBACK_PORTS = [1455, 1457];
/** The Codex release whose model list we ask for: the backend leaves out models that need a newer client. */
const CLIENT_VERSION = '0.165.0';
const ORIGINATOR = 'covibe';
/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** The models a ChatGPT plan offered when this was written; the account's own list replaces them once it is signed in. */
export const CODEX_MODELS: ProviderModel[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

export class CodexAuthError extends Error {}

/** auth.json, as Codex writes it. */
interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token: string; access_token: string; refresh_token: string; account_id?: string | null };
  last_refresh?: string;
}

/** Who an account is signed in as, from its tokens. */
export interface CodexIdentity {
  email?: string;
  /** The ChatGPT plan: plus, pro, business… */
  plan?: string;
  accountId?: string;
}

/** A JWT's claims, unverified (they come from our own token response). */
export function claimsOf(jwt: string | undefined): Record<string, unknown> | undefined {
  const part = jwt?.split('.')[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const authClaims = (jwt: string | undefined) => (claimsOf(jwt)?.['https://api.openai.com/auth'] ?? {}) as { chatgpt_plan_type?: string; chatgpt_account_id?: string };

export function identityOf(tokens: AuthFile['tokens']): CodexIdentity {
  const id = claimsOf(tokens?.id_token) ?? {};
  const profile = (id['https://api.openai.com/profile'] ?? {}) as { email?: string };
  const auth = { ...authClaims(tokens?.access_token), ...authClaims(tokens?.id_token) };
  const email = (typeof id.email === 'string' ? id.email : undefined) ?? profile.email;
  const accountId = tokens?.account_id ?? auth.chatgpt_account_id;
  return { ...(email ? { email } : {}), ...(auth.chatgpt_plan_type ? { plan: auth.chatgpt_plan_type } : {}), ...(accountId ? { accountId } : {}) };
}

/** When a JWT expires (ms), if it says. */
export function expiryOf(jwt: string | undefined): number | undefined {
  const exp = claimsOf(jwt)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

function readAuth(dir: string): AuthFile | undefined {
  const file = join(dir, 'auth.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AuthFile;
  } catch {
    return undefined;
  }
}

/** Written whole and then renamed, so the app and the CLI never read half a file. */
function writeAuth(dir: string, auth: AuthFile) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `auth.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, join(dir, 'auth.json'));
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

async function tokenRequest(url: string, body: string, contentType: string): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new CodexAuthError(`could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let reason = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string | { message?: string; code?: string }; error_description?: string };
      reason = j.error_description ?? (typeof j.error === 'string' ? j.error : (j.error?.message ?? j.error?.code)) ?? reason;
    } catch {
      // not JSON: keep the text
    }
    const err = new CodexAuthError(`the sign-in service answered ${res.status}${reason ? `: ${reason}` : ''}`);
    // A refresh token that was used up, revoked or expired: only signing in again helps.
    (err as CodexAuthError & { permanent?: boolean }).permanent = res.status === 400 || res.status === 401;
    throw err;
  }
  return JSON.parse(text) as TokenResponse;
}

/**
 * One ChatGPT account's sign-in. Every read goes to auth.json, so the app and
 * the CLI share it; refreshes happen once at a time, and a token another
 * process refreshed in the meantime is used rather than refreshed again
 * (refresh tokens are single use).
 */
export class CodexAuth {
  private refreshing?: Promise<NonNullable<AuthFile['tokens']>>;

  constructor(
    readonly dir: string,
    readonly endpoints: CodexEndpoints = CODEX_ENDPOINTS,
  ) {}

  signedIn(): boolean {
    return !!readAuth(this.dir)?.tokens?.refresh_token;
  }

  identity(): CodexIdentity | undefined {
    const tokens = readAuth(this.dir)?.tokens;
    return tokens ? identityOf(tokens) : undefined;
  }

  /** Store the tokens from a finished sign-in. */
  save(tokens: TokenResponse): CodexIdentity {
    if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) throw new CodexAuthError('the sign-in service sent no tokens');
    const t = { id_token: tokens.id_token, access_token: tokens.access_token, refresh_token: tokens.refresh_token };
    const identity = identityOf(t);
    writeAuth(this.dir, { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { ...t, account_id: identity.accountId ?? null }, last_refresh: new Date().toISOString() });
    return identity;
  }

  /** A usable access token: the stored one, or a fresh one when it is about to run out (or `force`, after the backend refused it). */
  async tokens(force = false): Promise<NonNullable<AuthFile['tokens']>> {
    const current = readAuth(this.dir)?.tokens;
    if (!current?.refresh_token) throw new CodexAuthError('this ChatGPT account is not signed in (Settings → Advanced)');
    const exp = expiryOf(current.access_token);
    if (!force && exp !== undefined && exp - REFRESH_MARGIN_MS > Date.now()) return current;
    this.refreshing ??= this.refresh(current.access_token).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(stale: string): Promise<NonNullable<AuthFile['tokens']>> {
    const auth = readAuth(this.dir);
    const current = auth?.tokens;
    if (!current?.refresh_token) throw new CodexAuthError('this ChatGPT account is not signed in (Settings → Advanced)');
    // Another process (the CLI, or the app) refreshed already.
    if (current.access_token !== stale && (expiryOf(current.access_token) ?? 0) - REFRESH_MARGIN_MS > Date.now()) return current;
    let fresh: TokenResponse;
    try {
      fresh = await tokenRequest(`${this.endpoints.issuer}/oauth/token`, JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: current.refresh_token }), 'application/json');
    } catch (err) {
      if ((err as { permanent?: boolean }).permanent) throw new CodexAuthError(`this ChatGPT account's sign-in expired; sign it in again (Settings → Advanced). ${(err as Error).message}`);
      throw err;
    }
    const tokens = {
      id_token: fresh.id_token ?? current.id_token,
      access_token: fresh.access_token ?? current.access_token,
      refresh_token: fresh.refresh_token ?? current.refresh_token,
      account_id: current.account_id ?? identityOf({ ...current, ...fresh } as NonNullable<AuthFile['tokens']>).accountId ?? null,
    };
    writeAuth(this.dir, { ...auth, tokens, last_refresh: new Date().toISOString() });
    return tokens;
  }

  /** The headers a request to the ChatGPT backend needs. */
  async headers(force = false): Promise<Record<string, string>> {
    const t = await this.tokens(force);
    const accountId = t.account_id ?? identityOf(t).accountId;
    return {
      authorization: `Bearer ${t.access_token}`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      originator: ORIGINATOR,
      'user-agent': `${ORIGINATOR} (${process.platform}; node ${process.versions.node})`,
    };
  }

  /** Sign out: revoke the refresh token (best effort) and forget the sign-in. */
  async signOut(): Promise<void> {
    const token = readAuth(this.dir)?.tokens?.refresh_token;
    if (token) {
      await fetch(`${this.endpoints.issuer}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, token_type_hint: 'refresh_token', client_id: CODEX_CLIENT_ID }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    rmSync(join(this.dir, 'auth.json'), { force: true });
  }

  /** GET from the ChatGPT backend; one retry with a fresh token when the stored one is refused. */
  private async get(url: string): Promise<unknown> {
    for (const force of [false, true]) {
      const res = await fetch(url, { headers: { ...(await this.headers(force)), accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 && !force) continue;
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new CodexAuthError(`${new URL(url).pathname} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      return JSON.parse(text) as unknown;
    }
    throw new CodexAuthError('the ChatGPT backend refused the sign-in');
  }

  /** The plan's 5-hour and weekly windows, as Codex's /status shows them: no model call. */
  async usage(): Promise<PlanUsage> {
    const body = (await this.get(usageUrl(this.endpoints.baseUrl))) as UsagePayload;
    return planUsageOf(body);
  }

  /** The models the account may use. */
  async models(): Promise<ProviderModel[]> {
    const body = (await this.get(`${this.endpoints.baseUrl.replace(/\/+$/, '')}/models?client_version=${CLIENT_VERSION}`)) as {
      models?: { slug?: string; display_name?: string; visibility?: string; supported_reasoning_levels?: { effort?: string }[] }[];
    };
    return (body.models ?? [])
      .filter((m) => typeof m.slug === 'string' && (m.visibility ?? 'list') === 'list')
      .map((m) => {
        const efforts = (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is string => typeof e === 'string');
        return { id: m.slug!, ...(m.display_name ? { name: m.display_name } : {}), ...(efforts.length ? { efforts } : {}) };
      });
  }
}

/** The usage endpoint sits next to the Codex API: …/backend-api/codex → …/backend-api/wham/usage. */
export function usageUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/codex$/.test(base) ? base.replace(/\/codex$/, '/wham/usage') : `${base}/usage`;
}

interface UsageWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

interface UsagePayload {
  plan_type?: string;
  rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null } | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
}

/** "five_hour" and "seven_day" like Claude's windows, so the app shows both kinds the same way. */
function windowOf(seconds: number | undefined): { window: string; label: string } {
  const minutes = seconds === undefined ? undefined : Math.round(seconds / 60);
  if (minutes === 300) return { window: 'five_hour', label: '5-hour' };
  if (minutes === 10_080) return { window: 'seven_day', label: 'Weekly' };
  if (minutes === undefined) return { window: 'codex', label: 'Usage' };
  return minutes % 1440 === 0 ? { window: `codex_${minutes}`, label: `${minutes / 1440}-day` } : { window: `codex_${minutes}`, label: minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute` };
}

const iso = (epochSeconds: number | undefined) => (epochSeconds ? new Date(epochSeconds * 1000).toISOString() : null);

export function planUsageOf(body: UsagePayload): PlanUsage {
  const windows: PlanUsage['windows'] = [];
  for (const w of [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]) {
    if (!w) continue;
    const resetAt = w.reset_at ?? (w.reset_after_seconds !== undefined ? Math.round(Date.now() / 1000) + w.reset_after_seconds : undefined);
    windows.push({ ...windowOf(w.limit_window_seconds), utilization: typeof w.used_percent === 'number' ? w.used_percent : null, resetsAt: iso(resetAt) });
  }
  return { available: true, ...(body.plan_type ? { subscription: body.plan_type } : {}), windows };
}

/** The same windows from a Responses answer's x-codex-* headers, which come with every request. */
export function planUsageFromHeaders(headers: Headers): PlanUsage | undefined {
  const windows: PlanUsage['windows'] = [];
  for (const which of ['primary', 'secondary']) {
    const used = headers.get(`x-codex-${which}-used-percent`);
    if (used === null || !Number.isFinite(Number(used))) continue;
    const minutes = Number(headers.get(`x-codex-${which}-window-minutes`));
    const reset = Number(headers.get(`x-codex-${which}-reset-at`));
    windows.push({ ...windowOf(Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : undefined), utilization: Number(used), resetsAt: iso(Number.isFinite(reset) && reset > 0 ? reset : undefined) });
  }
  return windows.length ? { available: true, windows } : undefined;
}

// ---- signing in

const page = (title: string, text: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f6f4;color:#222}
main{max-width:420px;text-align:center}@media(prefers-color-scheme:dark){body{background:#1d1d1b;color:#eee}}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface CodexLogin {
  /** Open this in a browser to sign in. */
  url: string;
  /** Settles when the sign-in finishes, fails, times out or is cancelled. */
  done: Promise<CodexIdentity>;
  cancel(): void;
}

/**
 * Sign an account in: a callback server on 127.0.0.1 (the ports Codex's
 * sign-in knows), then the browser does the rest. PKCE, so there is no client
 * secret; `state` ties the answer to this attempt.
 */
export async function startCodexLogin(auth: CodexAuth, opts: { timeoutMs?: number } = {}): Promise<CodexLogin> {
  const ports = auth.endpoints.callbackPorts ?? CALLBACK_PORTS;
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  let server: Server | undefined;
  let lastError: Error | undefined;
  for (const port of ports) {
    const s = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve());
      });
      server = s;
      break;
    } catch (err) {
      lastError = err as Error;
    }
  }
  if (!server) throw new CodexAuthError(`could not start the sign-in callback on port ${ports.join(' or ')} (${lastError?.message}); close other sign-ins (codex login) and try again`);
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`;
  const url = `${auth.endpoints.issuer}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  })}`;

  let settle!: { resolve(v: CodexIdentity): void; reject(e: Error): void };
  const done = new Promise<CodexIdentity>((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => undefined);
  let finished = false;
  const finish = (err?: Error, identity?: CodexIdentity) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server!.close();
    server!.closeAllConnections?.();
    if (err) settle.reject(err);
    else settle.resolve(identity!);
  };
  const timer = setTimeout(() => finish(new CodexAuthError('the sign-in timed out; start it again')), opts.timeoutMs ?? 10 * 60_000);
  timer.unref();

  server.on('request', (req, res) => {
    const u = new URL(req.url ?? '/', redirectUri);
    const reply = (status: number, title: string, text: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(page(title, text));
    };
    // Codex's own sign-in stops a callback server it finds on its port this way.
    if (u.pathname === '/cancel') {
      reply(200, 'Cancelled', 'This sign-in was cancelled.');
      return finish(new CodexAuthError('the sign-in was cancelled (another sign-in took its place)'));
    }
    if (u.pathname !== '/auth/callback') return reply(404, 'Not found', 'Nothing here.');
    const q = u.searchParams;
    if (q.get('state') !== state) return reply(400, 'Sign-in failed', 'This answer does not belong to the sign-in covibe started. Start it again from covibe.');
    if (q.get('error')) {
      const reason = q.get('error_description') ?? q.get('error')!;
      reply(400, 'Sign-in failed', escape(reason));
      return finish(new CodexAuthError(`the sign-in failed: ${reason}`));
    }
    const code = q.get('code');
    if (!code) return reply(400, 'Sign-in failed', 'No authorization code came back. Start the sign-in again from covibe.');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: verifier }).toString();
    tokenRequest(`${auth.endpoints.issuer}/oauth/token`, body, 'application/x-www-form-urlencoded')
      .then((tokens) => {
        const identity = auth.save(tokens);
        reply(200, 'Signed in', `covibe can now use ${identity.email ? escape(identity.email) : 'this ChatGPT account'}. You can close this tab.`);
        finish(undefined, identity);
      })
      .catch((err: Error) => {
        reply(500, 'Sign-in failed', escape(err.message));
        finish(err);
      });
  });

  return { url, done, cancel: () => finish(new CodexAuthError('the sign-in was cancelled')) };
}
