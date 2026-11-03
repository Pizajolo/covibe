import { statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planUsageFromHeaders, planUsageOf, usageUrl } from '../src/connections/codex-auth.js';
import { effortFor, failureOf, ResponsesTranslator, toResponsesRequest, type ResponsesEvent } from '../src/connections/codex-proxy.js';
import type { MessagesRequest } from '../src/connections/openai-proxy.js';
import { FileSecrets } from '../src/connections/secrets.js';
import { Connections } from '../src/connections/store.js';
import { BackendError } from '../src/runner/backend.js';
import { limitOf } from '../src/runner/claude-sdk.js';
import { tempDir } from './helpers.js';

const parent = { PATH: '/usr/bin', HOME: '/home/me' };

/** An unsigned JWT with these claims (covibe reads claims, it does not verify them). */
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/** The Messages events in an SSE text, in order. */
const events = (sse: string) =>
  sse
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, any>);

describe('Messages → Responses', () => {
  it('turns a conversation with reasoning, tool calls and results into Responses input', () => {
    const signature = `codex:${Buffer.from(JSON.stringify({ id: 'rs_1', enc: 'ENC' })).toString('base64url')}`;
    const req: MessagesRequest = {
      model: 'gpt-6.1-sol',
      system: [{ type: 'text', text: 'You are the builder.' }, { type: 'text', text: 'Be brief.' }],
      messages: [
        { role: 'user', content: 'Fix the bug' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Look at the file first.', signature },
            { type: 'thinking', thinking: 'From Claude', signature: 'claude-signature' },
            { type: 'text', text: 'Reading it.' },
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'const a = 1' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
            { type: 'text', text: 'Go on' },
          ],
        },
      ],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }, { name: 'web_search', type: 'web_search_20250305' }],
      tool_choice: { type: 'any' },
      output_config: { effort: 'max' },
      stream: true,
    };
    const out = toResponsesRequest(req, { efforts: ['low', 'medium', 'high', 'xhigh'], cacheKey: 'session-1' });
    expect(out).toMatchObject({
      model: 'gpt-6.1-sol',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-1',
      // "max" is more than this model takes: the highest it does take.
      reasoning: { effort: 'xhigh', summary: 'auto' },
      tool_choice: 'required',
      tools: [{ type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object' }, strict: false }],
    });
    expect(out.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are the builder.\n\nBe brief.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] },
      // Only reasoning that came from the Codex API goes back to it.
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Look at the file first.' }], encrypted_content: 'ENC' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading it.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'const a = 1' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Images from the tool results above:' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          { type: 'input_text', text: 'Go on' },
        ],
      },
    ]);
  });

  it("maps a member's effort to one the model takes", () => {
    const req = (r: Partial<MessagesRequest>): MessagesRequest => ({ model: 'm', messages: [], ...r });
    expect(effortFor(req({ output_config: { effort: 'high' } }), ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('high');
    expect(effortFor(req({ output_config: { effort: 'max' } }), ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
    // Without the model's list, never more than every Codex model takes.
    expect(effortFor(req({ output_config: { effort: 'max' } }), undefined)).toBe('xhigh');
    expect(effortFor(req({ thinking: { type: 'enabled', budget_tokens: 2000 } }), undefined)).toBe('low');
    expect(effortFor(req({ thinking: { type: 'enabled', budget_tokens: 32_000 } }), undefined)).toBe('high');
    // Claude Code's small background requests (no thinking) use the least.
    expect(effortFor(req({}), ['low', 'medium'])).toBe('low');
    expect(effortFor(req({ output_config: { effort: 'low' } }), ['medium', 'high'])).toBe('medium');
  });
});

describe('Responses → Messages', () => {
  const stream: ResponsesEvent[] = [
    { type: 'response.created' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_9' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Plan: ' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'read.' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: 'Then edit.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_9', encrypted_content: 'SECRET', summary: [{ text: 'Plan: read.' }, { text: 'Then edit.' }] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Let me ' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'look.' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', content: [{ type: 'output_text', text: 'Let me look.' }] } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_7', name: 'Read' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"file_path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"a.ts"}' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', call_id: 'call_7', name: 'Read', arguments: '{"file_path":"a.ts"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } } } },
  ];

  it('streams reasoning, text and tool calls as Messages events', () => {
    const t = new ResponsesTranslator('gpt-6.1-sol');
    const sse = stream.map((e) => t.feed(e)).join('') + t.end();
    const ev = events(sse);
    expect(ev.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(ev[1]).toMatchObject({ index: 0, content_block: { type: 'thinking' } });
    expect(ev.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('')).toBe('Plan: read.\n\nThen edit.');
    expect(ev[6]!.delta.type).toBe('signature_delta');
    expect(ev[8]).toMatchObject({ index: 1, content_block: { type: 'text' } });
    expect(ev[12]).toMatchObject({ index: 2, content_block: { type: 'tool_use', id: 'call_7', name: 'Read' } });
    expect(ev.at(-2)).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 60 } });

    // The message Claude Code keeps goes back to the Codex API with its reasoning.
    const message = t.message() as { content: Record<string, unknown>[]; stop_reason: string };
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content[2]).toEqual({ type: 'tool_use', id: 'call_7', name: 'Read', input: { file_path: 'a.ts' } });
    const again = toResponsesRequest({ model: 'gpt-6.1-sol', messages: [{ role: 'assistant', content: message.content as never }] });
    expect(again.input).toEqual([
      { type: 'reasoning', id: 'rs_9', summary: [{ type: 'summary_text', text: 'Plan: read.\n\nThen edit.' }], encrypted_content: 'SECRET' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me look.' }] },
      { type: 'function_call', call_id: 'call_7', name: 'Read', arguments: '{"file_path":"a.ts"}' },
    ]);
  });

  it('keeps reasoning without a summary, and ends on max_tokens when the answer was cut', () => {
    const t = new ResponsesTranslator('m');
    t.feed({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } });
    t.feed({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'E', summary: [] } });
    t.feed({ type: 'response.output_text.delta', output_index: 1, delta: 'partial' });
    t.feed({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } });
    t.end();
    const m = t.message() as { content: Record<string, unknown>[]; stop_reason: string };
    expect(m.stop_reason).toBe('max_tokens');
    expect(m.content[0]).toMatchObject({ type: 'redacted_thinking' });
    expect(toResponsesRequest({ model: 'm', messages: [{ role: 'assistant', content: m.content as never }] }).input).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'E' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
    ]);
  });

  it('stops a turn on the plan limit with its reset time, without retries', () => {
    const resets = Math.round(Date.now() / 1000) + 3600;
    let limited: number | undefined;
    const f = failureOf(429, JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: resets } }), (r) => (limited = r));
    expect(f).toMatchObject({ status: 429, retry: false });
    expect(limited).toBe(resets);
    // What covibe's runner reads a turn's limit from.
    expect(limitOf(`API Error: 429 ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: f.message } })}`, undefined)).toEqual({ resetsAt: resets, window: undefined });
    expect(failureOf(429, JSON.stringify({ error: { type: 'usage_not_included' } }))).toMatchObject({ status: 403, retry: false });
    expect(failureOf(400, JSON.stringify({ detail: 'Unsupported model' }))).toEqual({ status: 400, message: 'Unsupported model' });
  });
});

describe('ChatGPT plan usage', () => {
  it('reads the 5-hour and weekly windows from the usage endpoint and from response headers', () => {
    expect(usageUrl('https://chatgpt.com/backend-api/codex')).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(
      planUsageOf({
        plan_type: 'pro',
        rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_900_000_000 }, secondary_window: { used_percent: 7, limit_window_seconds: 604_800, reset_at: 1_900_500_000 } },
      }),
    ).toEqual({
      available: true,
      subscription: 'pro',
      windows: [
        { window: 'five_hour', label: '5-hour', utilization: 42, resetsAt: new Date(1_900_000_000_000).toISOString() },
        { window: 'seven_day', label: 'Weekly', utilization: 7, resetsAt: new Date(1_900_500_000_000).toISOString() },
      ],
    });
    const h = new Headers({ 'x-codex-primary-used-percent': '12.5', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': '1900000000' });
    expect(planUsageFromHeaders(h)).toEqual({ available: true, windows: [{ window: 'five_hour', label: '5-hour', utilization: 12.5, resetsAt: new Date(1_900_000_000_000).toISOString() }] });
    expect(planUsageFromHeaders(new Headers())).toBeUndefined();
  });
});

// ---- end to end, against a fake sign-in service and ChatGPT backend

interface Fake {
  base: string;
  seen: { path: string; headers: IncomingMessage['headers']; body: any }[];
  refreshes: number;
  revoked: string[];
  /** The next Responses request is refused once as unauthorized. */
  refuseOnce: boolean;
  close(): void;
}

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

async function fakeOpenAi(): Promise<Fake> {
  const auth = { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' };
  const access = (n: number, exp = Math.round(Date.now() / 1000) + 3600) => jwt({ exp, n, 'https://api.openai.com/auth': auth });
  const fake: Fake = { base: '', seen: [], refreshes: 0, revoked: [], refuseOnce: false, close: () => server.close() };
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const text = await read(req);
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text));
    fake.seen.push({ path: url.pathname, headers: req.headers, body });
    if (url.pathname === '/oauth/authorize') {
      // The browser signs in and comes back to covibe's callback.
      res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=the-code&state=${url.searchParams.get('state')}` });
      return res.end();
    }
    if (url.pathname === '/oauth/token') {
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'the-code' || !body.code_verifier) return json(res, 400, { error: 'invalid_grant' });
        // Already expired: the first request refreshes it.
        return json(res, 200, { id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': auth }), access_token: access(0, 1), refresh_token: 'r0' });
      }
      if (body.grant_type === 'refresh_token' && body.refresh_token === `r${fake.refreshes}`) {
        fake.refreshes++;
        return json(res, 200, { access_token: access(fake.refreshes), refresh_token: `r${fake.refreshes}` });
      }
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/oauth/revoke') {
      fake.revoked.push(body.token);
      return json(res, 200, {});
    }
    if (url.pathname === '/backend-api/codex/models') {
      return json(res, 200, {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
          { slug: 'internal', visibility: 'hide' },
        ],
      });
    }
    if (url.pathname === '/backend-api/wham/usage') {
      return json(res, 200, { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_900_000_000 } } });
    }
    if (url.pathname === '/backend-api/codex/responses') {
      if (fake.refuseOnce) {
        fake.refuseOnce = false;
        return json(res, 401, { error: { message: 'token expired' } });
      }
      if (body.model === 'limited') return json(res, 429, { error: { type: 'usage_limit_reached', message: 'limit', resets_at: 1_900_000_000 } });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '55', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': '1900000000' });
      const send = (e: Record<string, unknown>) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      send({ type: 'response.created' });
      send({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } });
      send({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' });
      send({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] } });
      send({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } });
      return res.end();
    }
    json(res, 404, { detail: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const open: { c: Connections; fake: Fake }[] = [];
afterEach(async () => {
  for (const { c, fake } of open.splice(0)) {
    await c.close();
    fake.close();
  }
});

async function setup() {
  const fake = await fakeOpenAi();
  const home = tempDir('covibe-codex-');
  const c = new Connections(home, new FileSecrets(home), { issuer: fake.base, baseUrl: `${fake.base}/backend-api/codex`, callbackPorts: [0] });
  open.push({ c, fake });
  return { c, fake };
}

describe('ChatGPT accounts', () => {
  it('signs in through the browser, keeps the tokens private, and lists the account models', async () => {
    const { c, fake } = await setup();
    const a = c.add({ kind: 'codex', label: 'ChatGPT Pro' });
    expect(a).toMatchObject({ id: 'chatgpt-pro', kind: 'codex', baseUrl: `${fake.base}/backend-api/codex` });
    expect(a.models!.length).toBeGreaterThan(0);
    expect(c.views()[0]!.hasKey).toBe(false);
    expect(() => c.check({ type: 'connection', connection: 'chatgpt-pro', model: 'gpt-6.1-sol' })).toThrow(BackendError);

    const { url, done } = await c.codexSignIn('chatgpt-pro');
    expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256');
    expect(c.codexSignInState('chatgpt-pro')).toEqual({ pending: true });
    // The browser: the fake sign-in redirects to covibe's callback, which answers with a page.
    const page = await fetch(url);
    expect(await page.text()).toContain('me@example.com');
    expect(await done).toEqual({ email: 'me@example.com', plan: 'pro', accountId: 'acct-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(c.codexSignInState('chatgpt-pro')).toEqual({ pending: false });

    expect(c.codexInfo('chatgpt-pro')).toEqual({ loggedIn: true, email: 'me@example.com', subscriptionType: 'pro' });
    expect(c.views()[0]!.hasKey).toBe(true);
    expect(statSync(join(a.configDir!, 'auth.json')).mode & 0o777).toBe(0o600);
    // The account's own list replaces the one it was added with; hidden models stay out.
    expect(c.get('chatgpt-pro')!.models).toEqual([{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'high'] }]);
    const exchange = fake.seen.find((s) => s.path === '/oauth/token')!;
    expect(exchange.body).toMatchObject({ grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });

    expect(await c.usage('chatgpt-pro')).toEqual({
      available: true,
      subscription: 'pro',
      windows: [{ window: 'five_hour', label: '5-hour', utilization: 30, resetsAt: new Date(1_900_000_000_000).toISOString() }],
    });

    await c.remove('chatgpt-pro');
    expect(fake.revoked.length).toBe(1);
    expect(c.list()).toEqual([]);
  });

  it("runs a member's requests on the account through the translator, refreshing the sign-in", async () => {
    const { c, fake } = await setup();
    c.add({ kind: 'codex', label: 'gpt' });
    const { url, done } = await c.codexSignIn('gpt');
    await fetch(url);
    await done;

    const built = await c.resolve({ type: 'connection', connection: 'gpt', model: 'gpt-6.1-sol' }, parent);
    // No price is no mistake on a plan; the agent only gets the translator's token.
    expect(built.warnings).toEqual([]);
    expect(built.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/gpt$/);
    expect(JSON.stringify(built.env)).not.toContain('r0');
    const call = (body: Record<string, unknown>) =>
      fetch(`${built.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { authorization: `Bearer ${built.env.ANTHROPIC_AUTH_TOKEN}`, 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1' },
        body: JSON.stringify(body),
      });

    const streamed = await (await call({ model: 'gpt-6.1-sol', max_tokens: 100, stream: true, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] })).text();
    expect(streamed).toContain('"text_delta","text":"Hello"');
    expect(streamed).toContain('event: message_stop');
    // The stored token had run out: refreshed first, then used.
    expect(fake.refreshes).toBe(1);
    const sent = fake.seen.filter((s) => s.path === '/backend-api/codex/responses').at(-1)!;
    expect(sent.headers).toMatchObject({ 'chatgpt-account-id': 'acct-1', 'session-id': 'sess-1', originator: 'covibe' });
    expect(sent.headers.authorization).toMatch(/^Bearer e30\./);
    expect(sent.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, prompt_cache_key: 'sess-1', reasoning: { effort: 'high' } });
    // The answer's headers update the usage meters.
    expect((await c.usage('gpt'))!.windows[0]).toMatchObject({ window: 'five_hour', utilization: 55 });

    // A refused token is refreshed once and the request sent again.
    fake.refuseOnce = true;
    const plain = await call({ model: 'gpt-6.1-sol', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(await plain.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
    expect(fake.refreshes).toBe(2);

    const limited = await call({ model: 'limited', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-should-retry')).toBe('false');
    expect(((await limited.json()) as { error: { message: string } }).error.message).toMatch(/usage limit reached.*\|1900000000$/);
  });
});

describe('context Claude Code sends as a system message', () => {
  it('reaches the model as instructions, not as something it said', () => {
    const req = { model: 'm', messages: [{ role: 'user' as const, content: 'Hi' }, { role: 'system' as const, content: '# Environment\nLinux' }] };
    expect(toResponsesRequest(req).input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '# Environment\nLinux' }] },
    ]);
  });
});
