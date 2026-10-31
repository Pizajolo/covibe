import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CALLBACK_URL, DEFAULT_CLIENT_METADATA_URL, clientMetadataDocument, clientStatus, setClient, signInStatus, startSignIn } from '../src/connections/mcp-auth.js';
import { mcpProxyUrl, startMcpProxy, stopMcpProxy } from '../src/connections/mcp-proxy.js';
import { pluginKeys, readKeys } from '../src/connections/plugin-keys.js';
import { parseMcpInput, splitCommand } from '../src/mcp-config.js';
import { addMcpServer, deletePlugin, getPlugin, installFromDir, pluginsDir, resolvePlugins, reviewMcp, setPluginVariables, signInTarget } from '../src/plugins.js';
import { serverEnv, type LaunchSpec } from '../src/sandbox-policy.js';
import { tempDir, writeFiles } from './helpers.js';

const POLICY = { network: [], allowWrite: [], writeWorkspace: false };

afterAll(() => stopMcpProxy());

describe('reading an MCP server you paste', () => {
  it('takes an address, a command line, or the JSON makers publish', () => {
    expect(parseMcpInput({ config: 'https://mcp.elevenlabs.io/mcp' })).toMatchObject({ name: 'elevenlabs', servers: { elevenlabs: { type: 'http', url: 'https://mcp.elevenlabs.io/mcp' } }, values: {} });
    expect(parseMcpInput({ config: 'https://example.com/sse' }).servers.example).toEqual({ type: 'sse', url: 'https://example.com/sse' });

    expect(parseMcpInput({ config: 'ELEVENLABS_API_KEY=sk_123 uvx elevenlabs-mcp' })).toEqual({
      name: 'elevenlabs-mcp',
      description: 'MCP server started with uvx elevenlabs-mcp (added by hand)',
      servers: { 'elevenlabs-mcp': { command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: '${ELEVENLABS_API_KEY}' } } },
      values: { ELEVENLABS_API_KEY: 'sk_123' },
    });
    expect(parseMcpInput({ config: 'npx -y @modelcontextprotocol/server-everything@latest' }).name).toBe('modelcontextprotocol-server-everything');
    expect(parseMcpInput({ config: 'npx -y @elevenlabs/mcp' }).name).toBe('elevenlabs-mcp');
    expect(parseMcpInput({ config: 'docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server' }).name).toBe('github-mcp-server');
    expect(splitCommand(`node "my server.js" --flag='a b' c\\ d`)).toEqual(['node', 'my server.js', '--flag=a b', 'c d']);

    // Claude Desktop's snippet: a placeholder key becomes a variable to fill in; a real one is taken out.
    const desktop = parseMcpInput({
      config: JSON.stringify({ mcpServers: { ElevenLabs: { command: 'uvx', args: ['elevenlabs-mcp'], env: { ELEVENLABS_API_KEY: '<insert-your-api-key-here>', LOG_LEVEL: 'info' } } } }),
    });
    expect(desktop).toMatchObject({ name: 'elevenlabs', servers: { ElevenLabs: { env: { ELEVENLABS_API_KEY: '${ELEVENLABS_API_KEY}', LOG_LEVEL: 'info' } } }, values: {} });
    // VS Code's shape, a lone server, a snippet without outer braces, and a command in one string.
    expect(Object.keys(parseMcpInput({ config: '{"servers": {"a": {"command": "a"}, "b": {"url": "https://b.dev/mcp"}}}' }).servers)).toEqual(['a', 'b']);
    expect(parseMcpInput({ config: '{"command": "npx -y some-mcp"}', name: 'Some' })).toMatchObject({ name: 'some', servers: { some: { command: 'npx', args: ['-y', 'some-mcp'] } } });
    expect(parseMcpInput({ config: '"notes": {"type": "streamable-http", "url": "https://notes.dev/mcp", "headers": {"Authorization": "Bearer tok_9"}}' })).toMatchObject({
      name: 'notes',
      servers: { notes: { type: 'http', headers: { Authorization: 'Bearer ${NOTES_TOKEN}' } } },
      values: { NOTES_TOKEN: 'tok_9' },
    });
    // A key header given next to an address.
    expect(parseMcpInput({ config: 'https://api.example.com/mcp', header: { name: 'X-Team', value: 'abc' } })).toMatchObject({ servers: { example: { headers: { 'X-Team': '${EXAMPLE_X_TEAM}' } } }, values: { EXAMPLE_X_TEAM: 'abc' } });

    expect(() => parseMcpInput({ config: '' })).toThrow(/paste/);
    expect(() => parseMcpInput({ config: '{"x": {"type": "http"}}' })).toThrow(/neither a "command" nor a "url"/);
    expect(() => parseMcpInput({ config: '{"x": {"url": "ftp://x"}}' })).toThrow(/http and https/);
    expect(() => parseMcpInput({ config: 'node "open' })).toThrow(/unclosed quote/);
  });
});

describe('MCP servers you add', () => {
  it('becomes a plugin of your own whose keys stay out of every file a member can read', () => {
    const config = JSON.stringify({ mcpServers: { voice: { command: 'uvx', args: ['voice-mcp', '--region', '${VOICE_REGION}'], env: { VOICE_API_KEY: 'sk_live_1', LOG_LEVEL: 'info' } } } });
    const review = reviewMcp({ config, name: 'voice' });
    expect(review).toMatchObject({ name: 'voice', installed: false, policy: { network: ['pypi.org', 'files.pythonhosted.org'] } });
    expect(review.variables).toEqual([
      { name: 'VOICE_REGION', servers: ['voice'], saved: false, inEnvironment: false },
      { name: 'VOICE_API_KEY', servers: ['voice'], saved: false, inEnvironment: false, found: true },
    ]);
    expect(JSON.stringify(review)).not.toContain('sk_live_1');

    const p = addMcpServer({ config, name: 'voice' }, POLICY, { VOICE_REGION: 'eu' });
    expect(p).toMatchObject({ name: 'voice', approved: true, mcpServers: { voice: { env: { VOICE_API_KEY: '${VOICE_API_KEY}', LOG_LEVEL: 'info' } } } });
    expect(p.variables.map((v) => [v.name, v.saved])).toEqual([
      ['VOICE_REGION', true],
      ['VOICE_API_KEY', true],
    ]);
    expect(pluginKeys('voice')).toEqual({ VOICE_API_KEY: 'sk_live_1', VOICE_REGION: 'eu' });

    const dir = join(pluginsDir(), 'voice');
    for (const f of ['files/.mcp.json', 'record.json', 'sandbox.json']) expect(readFileSync(join(dir, f), 'utf8')).not.toContain('sk_live_1');
    // The launcher finds the keys from sandbox.json and gives them to this server only.
    const spec = JSON.parse(readFileSync(join(dir, 'sandbox.json'), 'utf8')) as LaunchSpec;
    expect(readKeys(spec.keys!)).toEqual({ VOICE_API_KEY: 'sk_live_1', VOICE_REGION: 'eu' });
    const source = { PATH: '/bin', SECRET_OF_YOURS: 'x', ...readKeys(spec.keys!) };
    expect(serverEnv(source, spec, spec.mcp.voice!, source)).toEqual({ PATH: '/bin', VOICE_API_KEY: 'sk_live_1', LOG_LEVEL: 'info', CLAUDE_PLUGIN_ROOT: spec.root, CLAUDE_PLUGIN_DATA: spec.data });

    // Change or remove a value on its page; a variable it does not use is refused.
    expect(setPluginVariables('voice', { VOICE_REGION: null }).variables.find((v) => v.name === 'VOICE_REGION')!.saved).toBe(false);
    expect(() => setPluginVariables('voice', { OTHER: 'x' })).toThrow(/do not use a variable "OTHER"/);

    // Adding again under the same name replaces it; a GitHub plugin's name is not taken over.
    expect(addMcpServer({ config: 'uvx voice-mcp', name: 'voice' }, POLICY).mcpServers).toEqual({ voice: { command: 'uvx', args: ['voice-mcp'] } });
    const src = tempDir('covibe-plugin-');
    writeFiles(src, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'taken' }) });
    installFromDir(src, { approve: true, install: { url: 'https://github.com/o/taken', id: '' } });
    expect(() => reviewMcp({ config: 'uvx x', name: 'taken' })).toThrow(/already in your library/);

    deletePlugin('voice');
    expect(pluginKeys('voice')).toEqual({});
    deletePlugin('taken');
  });

  it('reaches a remote server that wants a key through the proxy, which adds it', async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers['xi-api-key'] as string | undefined);
      res.writeHead(req.headers['xi-api-key'] === 'xi_secret' ? 200 : 401, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    addMcpServer({ config: url, name: 'speech', header: { name: 'xi-api-key', value: 'xi_secret' } }, POLICY);
    await startMcpProxy();
    const [dir] = resolvePlugins(['speech'])!.dirs;
    const config = readFileSync(join(dir!, '.mcp.json'), 'utf8');
    expect(JSON.parse(config).mcpServers.speech).toEqual({ type: 'http', url: mcpProxyUrl('speech', 'speech') });
    expect(config).not.toContain('xi_secret');

    const res = await fetch(mcpProxyUrl('speech', 'speech')!, { method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': 'from-member' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['xi_secret']);

    // Without the key, Claude Code gets the server's own address again.
    setPluginVariables('speech', { SPEECH_XI_API_KEY: null });
    expect(JSON.parse(readFileSync(join(resolvePlugins(['speech'])!.dirs[0]!, '.mcp.json'), 'utf8')).mcpServers.speech.url).toBe(url);
    deletePlugin('speech');
    server.close();
  });
});

describe('signing in with your own OAuth app', () => {
  it('explains what to do when a server does not let covibe register, then signs in with the app you made', async () => {
    const tokenRequests: URLSearchParams[] = [];
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
        await readBody(req);
        return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        // No registration_endpoint: like GitHub's or Slack's, apps are made by hand.
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      if (url.pathname === '/authorize') {
        expect(url.searchParams.get('client_id')).toBe('app-123');
        expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'the-code');
        back.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === '/token') {
        tokenRequests.push(new URLSearchParams(await readBody(req)));
        return json(200, { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
      }
      json(404, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    addMcpServer({ config: `${base}/mcp`, name: 'workspace' }, POLICY);
    await expect(startSignIn('workspace', 'workspace', signInTarget('workspace', 'workspace'))).rejects.toThrow(/does not let covibe register itself.*127\.0\.0\.1:47815\/callback/);

    setClient('workspace', 'workspace', 'app-123', 'shh');
    expect(clientStatus('workspace', 'workspace')).toEqual({ clientId: 'app-123', hasSecret: true, callbackUrl: CALLBACK_URL });
    expect(getPlugin('workspace').contents.remotes[0]!.client).toEqual({ clientId: 'app-123', hasSecret: true, callbackUrl: CALLBACK_URL });
    expect(readFileSync(join(process.env.COVIBE_HOME!, 'mcp-clients.json'), 'utf8')).not.toContain('shh');

    const { url, done } = await startSignIn('workspace', 'workspace', signInTarget('workspace', 'workspace'));
    expect(await (await fetch(url!)).text()).toContain('Signed in');
    await done;
    expect(signInStatus('workspace', 'workspace').signedIn).toBe(true);
    expect(tokenRequests[0]!.get('client_id')).toBe('app-123');
    expect(tokenRequests[0]!.get('client_secret')).toBe('shh');

    deletePlugin('workspace');
    expect(clientStatus('workspace', 'workspace')).toEqual({ hasSecret: false, callbackUrl: CALLBACK_URL });
    server.close();
  });
});

describe('signing in with covibe\'s client metadata document', () => {
  it('publishes the document the default client id points at', () => {
    expect(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'docs', 'oauth', 'client-metadata.json'), 'utf8'))).toEqual(clientMetadataDocument(DEFAULT_CLIENT_METADATA_URL));
  });

  it('uses the document\'s address as the client id when the server takes one instead of registering covibe', async () => {
    const metadataUrl = 'https://example.com/covibe/client-metadata.json';
    process.env.COVIBE_CLIENT_METADATA_URL = metadataUrl;
    const tokenRequests: URLSearchParams[] = [];
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
        await readBody(req);
        return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        // No registration_endpoint, but a client metadata document will do: like ElevenLabs's.
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: true,
        });
      if (url.pathname === '/authorize') {
        expect(url.searchParams.get('client_id')).toBe(metadataUrl);
        expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'the-code');
        back.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === '/token') {
        tokenRequests.push(new URLSearchParams(await readBody(req)));
        return json(200, { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
      }
      json(404, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      addMcpServer({ config: `${base}/mcp`, name: 'voices' }, POLICY);
      const { url, done } = await startSignIn('voices', 'voices', signInTarget('voices', 'voices'));
      expect(await (await fetch(url!)).text()).toContain('Signed in');
      await done;
      expect(signInStatus('voices', 'voices').signedIn).toBe(true);
      expect(tokenRequests[0]!.get('client_id')).toBe(metadataUrl);
      expect(tokenRequests[0]!.get('redirect_uri')).toBe(CALLBACK_URL);
      deletePlugin('voices');
    } finally {
      delete process.env.COVIBE_CLIENT_METADATA_URL;
      server.close();
    }
  });
});
