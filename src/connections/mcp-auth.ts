import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { auth, discoverOAuthServerInfo, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { covibeHome } from '../home.js';
import { defaultSecrets, type SecretStore } from './secrets.js';

// Signing covibe in to a plugin's remote MCP server (Notion's, say). Such a
// server signs in with OAuth: covibe registers itself as a client with the
// server's authorization server, the browser does the sign-in, and the tokens
// stay with covibe's other keys. Members never get them: their Claude Code
// reaches the server through covibe's local proxy (mcp-proxy.ts), which adds
// the token and refreshes it.
//
// Some servers do not let covibe register itself. Those that take a client
// metadata document instead (ElevenLabs's, say) get covibe's: its address is
// the client id, and the server reads covibe's name and callback from it.
// For the rest you create an OAuth app in the service's developer settings,
// with CALLBACK_URL as its callback, and give covibe its client id (and
// secret, if it has one).

export class McpAuthError extends Error {}

/** What is kept for one server (as a secret: it holds the tokens). */
interface Saved {
  serverUrl: string;
  /** The sign-in's callback address, registered with the server; refreshing needs it too. */
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When the access token runs out (ms since epoch), if the server said. */
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
}

/** What anyone may read about a server's sign-in (no tokens): ~/.covibe/mcp-sign-ins.json. */
interface IndexEntry {
  url: string;
  at: string;
  /** Set when the sign-in stopped working (a refresh was refused). */
  problem?: string;
}

/** The callback address of sign-ins with your own OAuth app: it must match what the app has registered. */
export const CALLBACK_PORT = 47815;
export const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

/**
 * Where covibe's client metadata document is published: servers that take one
 * (instead of registering covibe) use this address as covibe's client id and
 * fetch it. It must be public https, and the document's client_id must be this
 * address exactly (see clientMetadataDocument). COVIBE_CLIENT_METADATA_URL
 * points at a copy published elsewhere.
 */
export const DEFAULT_CLIENT_METADATA_URL = 'https://raw.githubusercontent.com/Pizajolo/covibe/main/docs/oauth/client-metadata.json';

export function clientMetadataUrl(): string {
  return process.env.COVIBE_CLIENT_METADATA_URL?.trim() || DEFAULT_CLIENT_METADATA_URL;
}

/** covibe's client metadata document, to publish at `url`: sign-ins with it come back to CALLBACK_URL. */
export function clientMetadataDocument(url = clientMetadataUrl()) {
  return {
    client_id: url,
    client_name: 'covibe',
    redirect_uris: [CALLBACK_URL],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/** Your own OAuth app for a server (no secret: that stays with the keys). */
export interface McpClientStatus {
  clientId?: string;
  hasSecret: boolean;
  /** The callback address to register with the app. */
  callbackUrl: string;
}

export interface McpSignInStatus {
  signedIn: boolean;
  at?: string;
  problem?: string;
  /** A sign-in started here is waiting for the browser. */
  pending?: boolean;
  /** How the last sign-in started here ended, when it failed. */
  error?: string;
}

const key = (plugin: string, server: string) => `${plugin}/${server}`;
/** The secret's name; Keychain account names stay plain. */
const secretId = (plugin: string, server: string) => `mcp.${plugin}.${server}`.replace(/[^\w.@-]/g, '_');
const clientSecretId = (plugin: string, server: string) => `mcp-client.${plugin}.${server}`.replace(/[^\w.@-]/g, '_');

let secrets: SecretStore | undefined;
const store = () => (secrets ??= defaultSecrets(covibeHome()));

/** For tests: keep secrets somewhere else. */
export function useSecretStore(s: SecretStore) {
  secrets = s;
}

function indexFile() {
  return join(covibeHome(), 'mcp-sign-ins.json');
}

function readIndex(): Record<string, IndexEntry> {
  try {
    return existsSync(indexFile()) ? (JSON.parse(readFileSync(indexFile(), 'utf8')) as Record<string, IndexEntry>) : {};
  } catch {
    return {};
  }
}

function writeIndex(change: (all: Record<string, IndexEntry>) => void) {
  const all = readIndex();
  change(all);
  mkdirSync(covibeHome(), { recursive: true });
  const tmp = `${indexFile()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  renameSync(tmp, indexFile());
}

function clientsFile() {
  return join(covibeHome(), 'mcp-clients.json');
}

/** Client ids of your own OAuth apps, by plugin/server (ids are not secret; their secrets are kept as keys). */
function readClients(): Record<string, { clientId: string; hasSecret?: boolean }> {
  try {
    return existsSync(clientsFile()) ? (JSON.parse(readFileSync(clientsFile(), 'utf8')) as Record<string, { clientId: string; hasSecret?: boolean }>) : {};
  } catch {
    return {};
  }
}

function writeClients(change: (all: Record<string, { clientId: string; hasSecret?: boolean }>) => void) {
  const all = readClients();
  change(all);
  mkdirSync(covibeHome(), { recursive: true });
  const tmp = `${clientsFile()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  renameSync(tmp, clientsFile());
}

export function clientStatus(plugin: string, server: string): McpClientStatus {
  const c = readClients()[key(plugin, server)];
  return { ...(c ? { clientId: c.clientId } : {}), hasSecret: !!c?.hasSecret, callbackUrl: CALLBACK_URL };
}

/** Sign in to this server with your own OAuth app from now on (a secret of undefined keeps the saved one; empty removes it). */
export function setClient(plugin: string, server: string, clientId: string, clientSecret?: string) {
  const id = clientId.trim();
  if (!id) throw new McpAuthError('the client id is required');
  const k = key(plugin, server);
  if (clientSecret !== undefined) {
    if (clientSecret.trim()) store().set(clientSecretId(plugin, server), clientSecret.trim());
    else store().delete(clientSecretId(plugin, server));
  }
  const hasSecret = clientSecret !== undefined ? !!clientSecret.trim() : !!readClients()[k]?.hasSecret;
  writeClients((all) => (all[k] = { clientId: id, ...(hasSecret ? { hasSecret } : {}) }));
}

/** Go back to covibe registering itself with the server. */
export function forgetClient(plugin: string, server: string) {
  const k = key(plugin, server);
  if (!readClients()[k]) return;
  store().delete(clientSecretId(plugin, server));
  writeClients((all) => delete all[k]);
}

/** The OAuth app to sign in with, if you gave one. */
function ownClient(plugin: string, server: string): OAuthClientInformationMixed | undefined {
  const c = readClients()[key(plugin, server)];
  if (!c) return undefined;
  const secret = c.hasSecret ? store().get(clientSecretId(plugin, server)) : undefined;
  return { client_id: c.clientId, ...(secret ? { client_secret: secret } : {}) };
}

/** In-memory copies, so the proxy does not read the Keychain on every request. */
const cache = new Map<string, Saved>();

function load(plugin: string, server: string): Saved | undefined {
  const k = key(plugin, server);
  const hit = cache.get(k);
  if (hit) return hit;
  const raw = store().get(secretId(plugin, server));
  if (!raw) return undefined;
  try {
    const saved = JSON.parse(raw) as Saved;
    cache.set(k, saved);
    return saved;
  } catch {
    return undefined;
  }
}

function persist(plugin: string, server: string, saved: Saved) {
  cache.set(key(plugin, server), saved);
  store().set(secretId(plugin, server), JSON.stringify(saved));
}

/** The address the server was signed in at, when covibe holds a working sign-in for it. */
export function signedInUrl(plugin: string, server: string): string | undefined {
  const e = readIndex()[key(plugin, server)];
  return e && !e.problem ? e.url : undefined;
}

const pending = new Map<string, { cancel(): void }>();
const ended = new Map<string, { error?: string }>();

export function signInStatus(plugin: string, server: string): McpSignInStatus {
  const k = key(plugin, server);
  const e = readIndex()[k];
  return {
    signedIn: !!e && !e.problem,
    ...(e ? { at: e.at } : {}),
    ...(e?.problem ? { problem: e.problem } : {}),
    ...(pending.has(k) ? { pending: true } : {}),
    ...(ended.get(k)?.error ? { error: ended.get(k)!.error } : {}),
  };
}

/** Forget a server's sign-in. */
export function signOut(plugin: string, server: string) {
  const k = key(plugin, server);
  pending.get(k)?.cancel();
  cache.delete(k);
  store().delete(secretId(plugin, server));
  writeIndex((all) => delete all[k]);
  ended.delete(k);
}

/** covibe as an OAuth client of one server; everything it learns is saved as it goes. */
class Client implements OAuthClientProvider {
  authorizationUrl?: URL;
  private verifier?: string;

  constructor(
    private readonly plugin: string,
    private readonly server: string,
    private readonly saved: Saved,
    private readonly stateValue?: string,
    /** Set when the server takes covibe's client metadata document instead of registering it. */
    readonly clientMetadataUrl?: string,
  ) {}

  get redirectUrl() {
    return this.saved.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'covibe',
      client_uri: 'https://github.com/pizajolo/covibe',
      redirect_uris: [this.saved.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.saved.client && 'client_secret' in this.saved.client && this.saved.client.client_secret ? 'client_secret_post' : 'none',
    };
  }

  state() {
    return this.stateValue ?? '';
  }

  clientInformation() {
    return this.saved.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.saved.client = client;
    this.save();
  }

  tokens() {
    return this.saved.tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    // A refresh may leave the refresh token out: the old one still stands.
    this.saved.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? this.saved.tokens?.refresh_token };
    this.saved.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
    this.save();
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) throw new McpAuthError('the sign-in lost its PKCE verifier; start it again');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') this.saved.client = undefined;
    if (scope === 'all' || scope === 'tokens') this.saved.tokens = undefined;
    if (scope === 'all' || scope === 'discovery') this.saved.discovery = undefined;
    this.save();
  }

  discoveryState() {
    return this.saved.discovery;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.saved.discovery = state;
    this.save();
  }

  private save() {
    // Nothing is kept until the sign-in has tokens.
    if (this.saved.tokens) persist(this.plugin, this.server, this.saved);
  }
}

/**
 * Whether the server wants a sign-in: an MCP request without a token. A
 * server that answers it needs none; one that wants a sign-in answers 401,
 * often saying where its OAuth metadata is.
 */
async function probe(serverUrl: string): Promise<{ needed: false } | { needed: true; resourceMetadataUrl?: URL; scope?: string }> {
  let res: Response;
  try {
    res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'covibe', version: '0' } } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new McpAuthError(`could not reach ${serverUrl}: ${(err as Error).message}`);
  }
  void res.body?.cancel();
  if (res.status === 401 || res.status === 403) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
    return { needed: true, resourceMetadataUrl, scope };
  }
  return { needed: false };
}

export interface McpSignIn {
  /** Open this in a browser to sign in; absent when the server needs no sign-in. */
  url?: string;
  /** Settles when the sign-in finishes, fails, times out or is cancelled. */
  done: Promise<void>;
}

/**
 * Sign covibe in to a plugin's remote MCP server: a callback server on
 * 127.0.0.1, a fresh client registration for its address, then the browser
 * does the rest (PKCE; `state` ties the answer to this attempt).
 */
export async function startSignIn(plugin: string, server: string, serverUrl: string, opts: { timeoutMs?: number } = {}): Promise<McpSignIn> {
  const k = key(plugin, server);
  pending.get(k)?.cancel();
  ended.delete(k);
  const need = await probe(serverUrl);
  if (!need.needed) return { done: Promise.resolve() };

  const own = ownClient(plugin, server);
  // Without your own app, a server that takes a client metadata document gets covibe's.
  const metadataUrl = own ? undefined : await takesMetadataDocument(serverUrl, need.resourceMetadataUrl).then((yes) => (yes ? clientMetadataUrl() : undefined));
  // With your own OAuth app or covibe's metadata document the callback address is fixed (it is registered there); otherwise any free port.
  const fixed = !!own || !!metadataUrl;
  const callback = createServer();
  await new Promise<void>((resolve, reject) => {
    callback.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' && fixed ? new McpAuthError(`port ${CALLBACK_PORT} for the sign-in callback is in use (another sign-in in progress?); try again in a moment`) : err),
    );
    callback.listen(fixed ? CALLBACK_PORT : 0, '127.0.0.1', () => resolve());
  });
  const redirectUrl = fixed ? CALLBACK_URL : `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`;
  const state = randomBytes(24).toString('base64url');
  // Registered afresh for this callback address: some servers hold a client to the exact address it registered.
  const saved: Saved = { serverUrl, redirectUrl, ...(own ? { client: own } : {}) };
  const client = new Client(plugin, server, saved, state, metadataUrl);
  const options = { serverUrl, resourceMetadataUrl: need.resourceMetadataUrl, scope: need.scope };
  let first: Awaited<ReturnType<typeof auth>>;
  try {
    first = await auth(client, options);
  } catch (err) {
    close(callback);
    const message = (err as Error).message;
    if (!own && /dynamic client registration|registration/i.test(message)) {
      throw new McpAuthError(
        `this server does not let covibe register itself (${message}). Create an OAuth app in the service's developer settings with the callback ${CALLBACK_URL}, then enter its client id (and secret) under "Use your own OAuth app"`,
      );
    }
    throw new McpAuthError(`could not start the sign-in: ${message}`);
  }
  if (first === 'AUTHORIZED' || !client.authorizationUrl) {
    close(callback);
    throw new McpAuthError('the server did not ask for a browser sign-in, which is the only kind covibe can do');
  }

  let settle!: { resolve(): void; reject(e: Error): void };
  const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => undefined);
  let finished = false;
  const finish = (err?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    close(callback);
    pending.delete(k);
    ended.set(k, err ? { error: err.message } : {});
    if (err) settle.reject(err);
    else settle.resolve();
  };
  const timer = setTimeout(() => finish(new McpAuthError('the sign-in timed out; start it again')), opts.timeoutMs ?? 10 * 60_000);
  timer.unref();
  pending.set(k, { cancel: () => finish(new McpAuthError('the sign-in was cancelled')) });

  callback.on('request', (req, res) => {
    const u = new URL(req.url ?? '/', redirectUrl);
    const reply = (status: number, title: string, text: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(page(title, text));
    };
    if (u.pathname !== '/callback') return reply(404, 'Not found', 'Nothing here.');
    const q = u.searchParams;
    if (q.get('state') !== state) return reply(400, 'Sign-in failed', 'This answer does not belong to the sign-in covibe started. Start it again from covibe.');
    if (q.get('error')) {
      const reason = q.get('error_description') ?? q.get('error')!;
      reply(400, 'Sign-in failed', escape(reason));
      return finish(new McpAuthError(`the sign-in failed: ${reason}`));
    }
    const code = q.get('code');
    if (!code) return reply(400, 'Sign-in failed', 'No authorization code came back. Start the sign-in again from covibe.');
    auth(client, { ...options, authorizationCode: code })
      .then(() => {
        if (!saved.tokens) throw new McpAuthError('the server sent no tokens');
        persist(plugin, server, saved);
        writeIndex((all) => (all[k] = { url: serverUrl, at: new Date().toISOString() }));
        reply(200, 'Signed in', `covibe's members can now use ${escape(plugin)}. You can close this tab.`);
        finish();
      })
      .catch((err: Error) => {
        reply(500, 'Sign-in failed', escape(err.message));
        finish(err);
      });
  });

  return { url: client.authorizationUrl.href, done };
}

/** Whether the server's authorization server takes a client metadata document as the client id. */
async function takesMetadataDocument(serverUrl: string, resourceMetadataUrl?: URL): Promise<boolean> {
  try {
    const info = await discoverOAuthServerInfo(serverUrl, { resourceMetadataUrl });
    return info.authorizationServerMetadata?.client_id_metadata_document_supported === true;
  } catch {
    // auth() discovers again and reports what went wrong.
    return false;
  }
}

function close(server: Server) {
  server.close();
  server.closeAllConnections?.();
}

/** Refreshes in flight, so concurrent requests share one. */
const refreshing = new Map<string, Promise<string>>();

/**
 * A working access token for a signed-in server, refreshed when it has run
 * out (or `force`: the server just refused it). Throws when there is no
 * sign-in, or the server refused the refresh (then the UI asks to sign in again).
 */
export async function accessToken(plugin: string, server: string, opts: { force?: boolean } = {}): Promise<string> {
  const k = key(plugin, server);
  const saved = load(plugin, server);
  if (!saved?.tokens) throw new McpAuthError(`covibe is not signed in to ${plugin}'s ${server} server`);
  const fresh = !saved.expiresAt || saved.expiresAt - Date.now() > 60_000;
  if (fresh && !opts.force) return saved.tokens.access_token;
  let job = refreshing.get(k);
  if (!job) {
    job = (async () => {
      if (!saved.tokens!.refresh_token) throw new McpAuthError('the sign-in ran out and cannot be renewed');
      const client = new Client(plugin, server, saved);
      const result = await auth(client, { serverUrl: saved.serverUrl }).catch((err: Error) => {
        throw new McpAuthError(`could not renew the sign-in: ${err.message}`);
      });
      // A refused refresh falls through to a new browser sign-in, which only you can do.
      if (result !== 'AUTHORIZED') throw new McpAuthError('the server refused to renew the sign-in');
      return saved.tokens!.access_token;
    })()
      .catch((err: Error) => {
        writeIndex((all) => {
          if (all[k]) all[k]!.problem = `${err.message}; sign in again`;
        });
        throw err;
      })
      .finally(() => refreshing.delete(k));
    refreshing.set(k, job);
  }
  return job;
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function page(title: string, text: string) {
  return `<!doctype html><meta charset="utf-8"><title>${title} · covibe</title><body style="font:15px -apple-system,system-ui,sans-serif;max-width:460px;margin:80px auto;color:#222"><h2>${title}</h2><p>${text}</p></body>`;
}
