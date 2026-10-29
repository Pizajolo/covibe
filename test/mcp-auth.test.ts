import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { signInStatus, signOut, startSignIn } from '../src/connections/mcp-auth.js';
import { mcpProxyUrl, startMcpProxy, stopMcpProxy } from '../src/connections/mcp-proxy.js';
import { getPlugin, installFromDir, resolvePlugins, signInTarget } from '../src/plugins.js';
import { tempDir, writeFiles } from './helpers.js';

/**
 * An MCP server that wants an OAuth sign-in, with its own authorization
 * server: metadata discovery, client registration, PKCE, tokens and refresh,
 * as Notion's does.
 */
async function oauthServer() {
  const seen: { auth?: string; session?: string }[] = [];
  const valid = new Set<string>();
  const challenges = new Map<string, string>();
  let issued = 0;
  const readBody = async (req: IncomingMessage) => {
    let s = '';
    for await (const c of req) s += c;
    return s;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/mcp') {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      await readBody(req);
      if (!token || !valid.has(token)) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      seen.push({ auth: token, session: req.headers['mcp-session-id'] as string | undefined });
      return json(200, { jsonrpc: '2.0', id: 1, result: { token } }, { 'mcp-session-id': 'session-1' });
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/register') return json(201, { ...JSON.parse(await readBody(req)), client_id: 'covibe-client' });
    if (url.pathname === '/authorize') {
      // The person signs in and agrees; the browser goes back to covibe.
      challenges.set('the-code', url.searchParams.get('code_challenge')!);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = form.get('code_verifier')!;
        if (createHash('sha256').update(verifier).digest('base64url') !== challenges.get(form.get('code')!)) return json(400, { error: 'invalid_grant' });
      } else if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'refresh-1') return json(400, { error: 'invalid_grant' });
      const token = `access-${++issued}`;
      valid.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, valid, close: () => server.close() };
}

afterAll(() => stopMcpProxy());

describe('signing in to a plugin server', () => {
  it('signs in in the browser, reaches the server through the proxy with the token, renews it, and signs out', async () => {
    const fake = await oauthServer();
    const src = tempDir('covibe-plugin-');
    writeFiles(src, {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'notes', description: 'Notes in the cloud' }),
      '.mcp.json': JSON.stringify({ mcpServers: { notes: { type: 'http', url: `${fake.base}/mcp` } } }),
    });
    installFromDir(src, { approve: true });
    expect(getPlugin('notes').contents.remotes[0]!.signIn).toEqual({ signedIn: false });

    const { url, done } = await startSignIn('notes', 'notes', signInTarget('notes', 'notes'));
    expect(url).toMatch(new RegExp(`^${fake.base}/authorize\\?`));
    expect(signInStatus('notes', 'notes').pending).toBe(true);
    // The browser: the sign-in page sends it back to covibe's callback.
    const page = await fetch(url!);
    expect(await page.text()).toContain('Signed in');
    await done;
    expect(signInStatus('notes', 'notes')).toMatchObject({ signedIn: true });
    expect(getPlugin('notes').approved).toBe(true);

    // Members get the proxy's address, and no token.
    await startMcpProxy();
    const [dir] = resolvePlugins(['notes'])!.dirs;
    const config = readFileSync(join(dir!, '.mcp.json'), 'utf8');
    expect(JSON.parse(config).mcpServers.notes).toEqual({ type: 'http', url: mcpProxyUrl('notes', 'notes') });
    expect(config).not.toContain('access-');

    const call = (session?: string) =>
      fetch(mcpProxyUrl('notes', 'notes')!, { method: 'POST', headers: { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    let res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('session-1');
    expect(await res.json()).toMatchObject({ result: { token: 'access-1' } });

    // The server stops taking the token: the proxy renews it and sends the request again.
    fake.valid.delete('access-1');
    res = await call('session-1');
    expect(await res.json()).toMatchObject({ result: { token: 'access-2' } });
    expect(fake.seen.at(-1)).toEqual({ auth: 'access-2', session: 'session-1' });

    // Only with the key in its address.
    expect((await fetch(mcpProxyUrl('notes', 'notes')!.replace(/\/[^/]+\/notes\/notes$/, '/wrong/notes/notes'), { method: 'POST' })).status).toBe(404);

    signOut('notes', 'notes');
    expect(signInStatus('notes', 'notes')).toEqual({ signedIn: false });
    expect(JSON.parse(readFileSync(join(resolvePlugins(['notes'])!.dirs[0]!, '.mcp.json'), 'utf8')).mcpServers.notes.url).toBe(`${fake.base}/mcp`);
    expect((await call()).status).toBe(401);
    fake.close();
  });

  it('says when a server needs no sign-in', async () => {
    const open = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => open.listen(0, '127.0.0.1', () => r()));
    const { url } = await startSignIn('open', 'open', `http://127.0.0.1:${(open.address() as AddressInfo).port}/mcp`);
    expect(url).toBeUndefined();
    open.close();
  });
});
