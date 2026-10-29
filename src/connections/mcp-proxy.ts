import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { accessToken, signedInUrl } from './mcp-auth.js';

// Members reach a signed-in plugin MCP server (see mcp-auth.ts) through this
// proxy on 127.0.0.1: their Claude Code sends its MCP requests here, and the
// proxy forwards them to the real server with covibe's token, renewing it when
// it runs out. The token never reaches a member's environment or files. The
// address carries a random key, so other programs on this computer cannot use it.

let proxy: { server: Server; base: string } | undefined;
let starting: Promise<string> | undefined;

/** Request headers that belong to this hop, or that the proxy sets itself. */
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'authorization', 'accept-encoding', 'proxy-authorization', 'upgrade']);
/** Response headers that no longer hold once fetch has read (and decompressed) the body. */
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'content-length', 'content-encoding', 'transfer-encoding']);

/** Start the proxy (once per process); resolves to its base address. */
export function startMcpProxy(): Promise<string> {
  if (proxy) return Promise.resolve(proxy.base);
  starting ??= new Promise<string>((resolve, reject) => {
    const key = randomBytes(24).toString('base64url');
    const server = createServer((req, res) => void handle(key, req, res));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // A member's session is the only user; it never keeps covibe running.
      server.unref();
      proxy = { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${key}` };
      resolve(proxy.base);
    });
  }).finally(() => (starting = undefined));
  return starting;
}

export async function stopMcpProxy() {
  const p = proxy;
  proxy = undefined;
  if (!p) return;
  p.server.closeAllConnections?.();
  await new Promise<void>((resolve) => p.server.close(() => resolve()));
}

/** Where a member's Claude Code reaches a plugin's server through the proxy; undefined until the proxy runs. */
export function mcpProxyUrl(plugin: string, server: string): string | undefined {
  return proxy ? `${proxy.base}/${encodeURIComponent(plugin)}/${encodeURIComponent(server)}` : undefined;
}

async function handle(key: string, req: IncomingMessage, res: ServerResponse) {
  const fail = (status: number, message: string) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }));
  };
  try {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return fail(403, 'forbidden host');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const [, given, plugin, server, ...rest] = url.pathname.split('/').map(decodeURIComponent);
    if (given !== key || !plugin || !server || rest.length) return fail(404, 'not found');
    const target = signedInUrl(plugin, server);
    if (!target) return fail(401, `covibe is not signed in to ${plugin}'s ${server} server; sign in on its Plugins page`);

    // MCP requests are small JSON; keeping the body lets a refused token be renewed and the request sent again.
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !DROP_REQUEST.has(name)) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    const upstream = new URL(target);
    for (const [k, v] of url.searchParams) upstream.searchParams.append(k, v);

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const send = (token: string) => fetch(upstream, { method: req.method, headers: { ...headers, authorization: `Bearer ${token}` }, body, signal: abort.signal, redirect: 'manual' });
    let token: string;
    try {
      token = await accessToken(plugin, server);
    } catch (err) {
      return fail(401, (err as Error).message);
    }
    let answer = await send(token);
    if (answer.status === 401) {
      void answer.body?.cancel();
      try {
        answer = await send(await accessToken(plugin, server, { force: true }));
      } catch (err) {
        return fail(401, (err as Error).message);
      }
    }
    const out: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.has(name) && name !== 'www-authenticate') out[name] = value;
    });
    res.writeHead(answer.status, out);
    if (!answer.body) return res.end();
    // Streamed as it comes: a server may answer with a stream of events.
    Readable.fromWeb(answer.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    if ((err as Error).name !== 'AbortError') fail(502, `covibe could not reach the server: ${(err as Error).message}`);
  }
}
