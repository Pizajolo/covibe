import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeam, validateTeamDocument } from '../src/config/load.js';
import { FileSecrets } from '../src/connections/secrets.js';
import { fromChatResponse, StreamTranslator, toChatRequest } from '../src/connections/openai-proxy.js';
import { Connections, priceOf } from '../src/connections/store.js';
import { runTeam } from '../src/engine/engine.js';
import { EventStore } from '../src/events/store.js';
import { BackendError } from '../src/runner/backend.js';
import { carrySession } from '../src/runner/claude-sdk.js';
import type { PlanUsage } from '../src/runner/types.js';
import { computeStats, summarizeRun } from '../src/server/projections.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const TEAM = new URL('../examples/build-and-review/team.yaml', import.meta.url).pathname;
const pass = { blocking_count: 0, findings: [] };
const parent = { PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CODE_OAUTH_TOKEN: 'mine', ANTHROPIC_API_KEY: 'sk-stray' };

const open: Connections[] = [];
function connections() {
  const home = tempDir('covibe-conn-');
  const c = new Connections(home, new FileSecrets(home));
  open.push(c);
  return c;
}
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

const usage = (five: number, week = 0): PlanUsage => ({
  available: true,
  windows: [
    { window: 'five_hour', label: '5-hour', utilization: five, resetsAt: null },
    { window: 'seven_day', label: 'Weekly', utilization: week, resetsAt: null },
  ],
});

describe('connections', () => {
  it('stores accounts and providers, with keys kept out of the list', () => {
    const c = connections();
    const work = c.add({ kind: 'claude', label: 'Work account' });
    expect(work.id).toBe('work-account');
    expect(statSync(work.configDir!).isDirectory()).toBe(true);
    const ds = c.add({ kind: 'anthropic', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic/', apiKey: 'sk-ds', models: [{ id: 'deepseek-chat', price: { input: 0.3, output: 1.2 } }, { id: 'deepseek-chat' }, { id: ' ' }] });
    expect(ds).toMatchObject({ baseUrl: 'https://api.deepseek.com/anthropic', models: [{ id: 'deepseek-chat', price: { input: 0.3, output: 1.2 } }] });

    const listed = JSON.stringify(c.views());
    expect(listed).not.toContain('sk-ds');
    expect(readFileSync(join(c.home, 'connections.json'), 'utf8')).not.toContain('sk-ds');
    expect(c.views().find((v) => v.id === 'deepseek')!.hasKey).toBe(true);
    expect(c.key('deepseek')).toBe('sk-ds');
    // The fallback key file is private.
    expect(statSync(join(c.home, 'secrets.json')).mode & 0o777).toBe(0o600);

    c.update('deepseek', { apiKey: null, label: 'DeepSeek V3' });
    expect(c.views().find((v) => v.id === 'deepseek')).toMatchObject({ label: 'DeepSeek V3', hasKey: false });
    expect(() => c.add({ kind: 'claude', label: 'x', id: 'main' })).toThrow(/your own claude login/);
    expect(() => c.add({ kind: 'openai', label: 'Bad', baseUrl: 'ftp://x' })).toThrow(/base URL/);
  });

  it('builds agent environments for accounts and providers', async () => {
    const c = connections();
    const work = c.add({ kind: 'claude', label: 'work' });
    c.add({ kind: 'anthropic', label: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-ds', models: [{ id: 'deepseek-chat', maxOutput: 8192, price: { input: 1, output: 2 } }] });
    c.add({ kind: 'anthropic', label: 'console', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant' });
    c.add({ kind: 'openai', label: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-oa' });

    const mine = await c.resolve({ type: 'subscription' }, parent);
    expect(mine.via).toBe('claude');
    expect(mine.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('mine');

    const acct = await c.resolve({ type: 'subscription', account: 'work' }, parent);
    expect(acct).toMatchObject({ via: 'claude:work', env: { CLAUDE_CONFIG_DIR: work.configDir } });
    // Your own token would win over the account's login.
    expect(acct.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(acct.env.ANTHROPIC_API_KEY).toBeUndefined();

    const ds = await c.resolve({ type: 'connection', connection: 'deepseek', model: 'deepseek-chat' }, parent);
    expect(ds.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-ds',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
    });
    expect(ds.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(ds.pricing).toEqual({ input: 1, output: 2 });
    expect(ds.via).toBe('deepseek');

    // Anthropic's own API takes the key as x-api-key.
    const console_ = await c.resolve({ type: 'connection', connection: 'console', model: 'claude-sonnet-5-5' }, parent);
    expect(console_.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(console_.warnings.join()).toMatch(/no price set/);

    // OpenAI-style providers go through the local translator; the real key stays in covibe.
    const oa = await c.resolve({ type: 'connection', connection: 'openai', model: 'gpt-5' }, parent);
    expect(oa.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openai$/);
    expect(oa.env.ANTHROPIC_AUTH_TOKEN).not.toBe('sk-oa');
    expect(JSON.stringify(oa.env)).not.toContain('sk-oa');

    await expect(c.resolve({ type: 'subscription', account: 'nope' }, parent)).rejects.toThrow(BackendError);
    await expect(c.resolve({ type: 'connection', connection: 'nope', model: 'x' }, parent)).rejects.toThrow(/not set up/);
    expect(() => c.check({ type: 'connection', connection: 'deepseek' })).toThrow(/no model/);
  });

  it('spreads members across accounts by how much room each has', async () => {
    const c = connections();
    c.add({ kind: 'claude', label: 'work' });
    c.add({ kind: 'claude', label: 'spare' });
    const reported: Record<string, PlanUsage> = { main: usage(80), work: usage(20, 40), spare: usage(10, 95) };
    c.usageReader = async (env) => reported[env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR.split('/').at(-1)! : 'main']!;

    expect(await c.pick()).toBeUndefined(); // balancing is off
    c.setBalance(true);
    expect(await c.pick()).toBe('work'); // max(20, 40) beats main's 80 and spare's 95 weekly
    c.exhausted('work', Math.floor(Date.now() / 1000) + 3600);
    expect(await c.pick()).toBe('main');
    c.exhausted('main');
    c.exhausted('spare');
    expect(await c.pick()).toBeNull();
    expect(c.nextFree()).toBeGreaterThan(Date.now());
  });

  it('accepts accounts and providers in team files', () => {
    const team = (backend: unknown) => ({ version: 1, name: 't', agents: { a: { prompt: 'x\ny', tools: ['Read'], backend } }, workflow: { steps: [{ id: 's', agent: 'a' }] } });
    expect(validateTeamDocument(team({ type: 'subscription', account: 'work' }))).toEqual([]);
    expect(validateTeamDocument(team({ type: 'connection', connection: 'deepseek', model: 'deepseek-chat' }))).toEqual([]);
    expect(validateTeamDocument(team({ type: 'connection', connection: 'deepseek' })).join()).toMatch(/model/);
    expect(validateTeamDocument(team({ type: 'subscription', account: 'Not An Id' })).join()).toMatch(/pattern/);
  });

  it('prices tokens at a provider\'s rates', () => {
    expect(priceOf({ input: 1, output: 4 }, { input: 1_000_000, output: 500_000, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(1 + 2 + 0.1);
  });

  it('carries a session to the account that picks it up', () => {
    const a = tempDir();
    const b = tempDir();
    writeFiles(a, { 'projects/-repo-x/s1.jsonl': '{"type":"user"}\n', 'projects/-repo-x/s1/tool-results/r.txt': 'out' });
    expect(carrySession('s1', b, [a, b])).toBe(true);
    expect(readFileSync(join(b, 'projects/-repo-x/s1.jsonl'), 'utf8')).toContain('user');
    expect(readFileSync(join(b, 'projects/-repo-x/s1/tool-results/r.txt'), 'utf8')).toBe('out');
    expect(carrySession('missing', b, [a, b])).toBe(false);
  });
});

describe('account balancing in a run', () => {
  it('moves a member to another account when its limit is hit, and carries on', async () => {
    const c = connections();
    const work = c.add({ kind: 'claude', label: 'work' });
    c.setBalance(true);
    c.usageReader = async (env) => (env.CLAUDE_CONFIG_DIR ? usage(50) : usage(10));
    const later = Math.floor(Date.now() / 1000) + 3600;
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({
      builder: (inv) => (inv.env.CLAUDE_CONFIG_DIR ? { write: { 'src/a.js': 'export const a = 1;' }, text: 'Built.' } : { fail: 'Claude AI usage limit reached', limit: { resetsAt: later } }),
      reviewer: () => ({ structured: pass }),
    });
    const outcome = await runTeam({ team: loadTeam(TEAM), repo: tempRepo(), goal: 'Add a', store, runner, connections: c });

    expect(outcome.status).toBe('succeeded');
    const [first, second] = runner.callsFor('builder');
    expect(first!.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(second!.env.CLAUDE_CONFIG_DIR).toBe(work.configDir);
    expect(second!.resumeSessionId).toBe('session-builder');
    expect(second!.prompt).toContain('another account');
    const events = store.events(outcome.runId);
    expect(events.find((e) => e.type === 'agent.limited')).toMatchObject({ data: { switched_to: 'work', waiting: false, via: 'claude' } });
    expect(events.find((e) => e.type === 'agent.finished' && e.agent === 'builder')).toMatchObject({ data: { via: 'claude:work' } });
    // The reviewer starts on the account with the most room; main is still at its limit.
    expect(runner.callsFor('reviewer')[0]!.env.CLAUDE_CONFIG_DIR).toBe(work.configDir);
    expect(summarizeRun(store.getRun(outcome.runId)!, events, { id: 'p', name: 'p' }, false).limit).toBeUndefined();

    const stats = computeStats([{ runs: store.listRuns(10), events, live: () => false, activeAgents: 0 }]);
    expect(stats.byVia.map((v) => v.via).sort()).toEqual(['claude', 'claude:work']);
  });

  it('fails a run up front when a member names a provider that is not set up', async () => {
    const team = loadTeam(TEAM);
    team.agents.reviewer!.backend = { type: 'connection', connection: 'deepseek', model: 'deepseek-chat' };
    const store = new EventStore(':memory:');
    const runner = new ScriptedRunner({ builder: () => ({ text: 'x' }), reviewer: () => ({ structured: pass }) });
    const outcome = await runTeam({ team, repo: tempRepo(), goal: 'x', store, runner, connections: connections() });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/reviewer: connection "deepseek" is not set up/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('OpenAI translator', () => {
  it('turns a Messages request into Chat Completions, tool calls and results included', () => {
    const chat = toChatRequest(
      {
        model: 'gpt-5',
        system: [{ type: 'text', text: 'You are a builder.' }],
        max_tokens: 32000,
        stream: true,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }, { name: 'web_search', type: 'web_search_20250305' }],
        tool_choice: { type: 'any' },
        messages: [
          { role: 'user', content: 'Fix it' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'const a = 1' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
              { type: 'text', text: 'go on' },
            ],
          },
        ],
      },
      { maxOutput: 16000, openaiHost: true },
    );
    expect(chat).toMatchObject({
      model: 'gpt-5',
      max_completion_tokens: 16000,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'required',
      tools: [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object' } } }],
    });
    const messages = chat.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a builder.' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Reading.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.js"}' } }] });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'const a = 1' });
    expect(messages[4]).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: 'go on' }] });
  });

  it('turns answers back into Messages, streamed or not', () => {
    const whole = fromChatResponse(
      { choices: [{ message: { content: 'Done', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } } },
      'gpt-5',
    );
    expect(whole).toMatchObject({
      type: 'message',
      content: [{ type: 'text', text: 'Done' }, { type: 'tool_use', id: 'c1', name: 'Write', input: { x: 1 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40 },
    });

    const t = new StreamTranslator('gpt-5');
    const sse =
      t.chunk({ choices: [{ delta: { content: 'Hel' } }] }) +
      t.chunk({ choices: [{ delta: { content: 'lo' } }] }) +
      t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: '' } }] } }] }) +
      t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Read', arguments: '{"file' } }] } }] }) +
      t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"a"}' } }] }, finish_reason: 'tool_calls' }] }) +
      t.chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
      t.end();
    const events = sse
      .trim()
      .split('\n\n')
      .map((block) => JSON.parse(block.split('\n')[1]!.slice(6)) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
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
    expect(events[5]).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'Read' } });
    expect(events[6]).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '{"file' } });
    expect(events[9]).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it('serves Claude Code requests from an OpenAI-style provider', async () => {
    const seen: { auth?: string; body: Record<string, unknown> }[] = [];
    const upstream = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      seen.push({ auth: req.headers.authorization, body });
      if (body.model === 'broken') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'slow down' } }));
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    try {
      const c = connections();
      c.add({ kind: 'openai', label: 'local', baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, apiKey: 'sk-up' });
      const { env } = await c.resolve({ type: 'connection', connection: 'local', model: 'm' }, parent);
      const call = (body: Record<string, unknown>, token = env.ANTHROPIC_AUTH_TOKEN) =>
        fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

      const plain = await call({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
      expect(await plain.json()).toMatchObject({ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' });
      expect(seen[0]).toMatchObject({ auth: 'Bearer sk-up', body: { model: 'm', max_tokens: 100 } });

      const streamed = await (await call({ model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
      expect(streamed).toContain('"text_delta","text":"Hi"');
      expect(streamed).toContain('event: message_stop');

      const limited = await call({ model: 'broken', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });

      expect((await call({ model: 'm', messages: [] }, 'wrong')).status).toBe(401);
    } finally {
      upstream.close();
    }
  });
});
