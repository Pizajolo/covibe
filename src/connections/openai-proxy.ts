// covibe's OpenAI translator. Claude Code only speaks Anthropic's Messages
// API; this local server takes those requests, sends them to an OpenAI-style
// Chat Completions endpoint (OpenAI, OpenRouter, Groq, Ollama…), and turns the
// answers, streamed or not and with tool calls, back into Messages responses.
// It listens on 127.0.0.1 only and wants a per-start token, so the provider's
// key stays in this process and never reaches the agent's environment.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Upstream {
  baseUrl: string;
  key?: string;
  /** The largest output a model accepts, if known. */
  maxOutput(model: string): number | undefined;
}

// ---- Anthropic request and response shapes (the parts that matter here)

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | Block[]; is_error?: boolean }
  | { type: 'thinking' | 'redacted_thinking' | 'document' | string; [k: string]: unknown };

export interface MessagesRequest {
  model: string;
  system?: string | { type: string; text?: string }[];
  messages: { role: 'user' | 'assistant'; content: string | Block[] }[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: { name: string; description?: string; input_schema?: unknown; type?: string }[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
}

// ---- OpenAI shapes

type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek's name for cached prompt tokens. */
  prompt_cache_hit_tokens?: number;
}

interface ChatResponse {
  id?: string;
  choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: ChatUsage;
}

interface ChatChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: ChatUsage | null;
}

const imageUrl = (b: Extract<Block, { type: 'image' }>): ChatPart => ({
  type: 'image_url',
  image_url: { url: b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url },
});

const textOf = (content: string | Block[] | undefined): string =>
  typeof content === 'string' ? content : (content ?? []).filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');

/** An Anthropic Messages request as an OpenAI Chat Completions request. */
export function toChatRequest(req: MessagesRequest, opts: { maxOutput?: number; openaiHost?: boolean } = {}): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text ?? '').filter(Boolean).join('\n\n');
  if (system) messages.push({ role: 'system', content: system });

  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push(m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      const calls = m.content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) continue;
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results first (they must follow the assistant's calls), then the rest.
    const parts: ChatPart[] = [];
    const resultImages: ChatPart[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const r = b as Extract<Block, { type: 'tool_result' }>;
        const text = textOf(r.content);
        if (Array.isArray(r.content)) for (const c of r.content) if (c.type === 'image') resultImages.push(imageUrl(c as Extract<Block, { type: 'image' }>));
        messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: (r.is_error ? 'Error: ' : '') + (text || (Array.isArray(r.content) && r.content.length ? '(see the image below)' : '(no output)')) });
      } else if (b.type === 'text') parts.push({ type: 'text', text: (b as { text: string }).text });
      else if (b.type === 'image') parts.push(imageUrl(b as Extract<Block, { type: 'image' }>));
      else if (b.type === 'document') parts.push({ type: 'text', text: '[A document was attached here; this model cannot read documents.]' });
    }
    // Tool messages cannot carry images; show them in a user message right after.
    if (resultImages.length) parts.unshift({ type: 'text', text: 'Images from the tool results above:' }, ...resultImages);
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts });
  }

  const out: Record<string, unknown> = { model: req.model, messages };
  if (req.max_tokens) {
    const max = opts.maxOutput ? Math.min(req.max_tokens, opts.maxOutput) : req.max_tokens;
    out[opts.openaiHost ? 'max_completion_tokens' : 'max_tokens'] = max;
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  // Server tools (web search and the like) are Anthropic's own; only custom tools go along.
  const tools = (req.tools ?? []).filter((t) => t.input_schema);
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
    const c = req.tool_choice;
    if (c) out.tool_choice = c.type === 'any' ? 'required' : c.type === 'tool' && c.name ? { type: 'function', function: { name: c.name } } : c.type;
  }
  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

function usageOf(u: ChatUsage | null | undefined) {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return { input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached), output_tokens: u?.completion_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const parseArgs = (s: string | undefined): unknown => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

const msgId = () => `msg_${randomBytes(12).toString('hex')}`;

/** An OpenAI Chat Completions response as an Anthropic Messages response. */
export function fromChatResponse(res: ChatResponse, model: string): Record<string, unknown> {
  const choice = res.choices?.[0];
  const content: Record<string, unknown>[] = [];
  if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const c of choice?.message?.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: c.id ?? `toolu_${randomBytes(8).toString('hex')}`, name: c.function?.name ?? '', input: parseArgs(c.function?.arguments) });
  }
  const tools = content.some((b) => b.type === 'tool_use');
  return {
    id: msgId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: tools ? 'tool_use' : (STOP[choice?.finish_reason ?? 'stop'] ?? 'end_turn'),
    stop_sequence: null,
    usage: usageOf(res.usage),
  };
}

/**
 * Turns a stream of Chat Completions chunks into Messages stream events. Feed
 * it each chunk, then call end(); it returns the SSE text to send.
 */
export class StreamTranslator {
  private started = false;
  private next = 0;
  /** The content block currently open, if any. */
  private open: number | null = null;
  private text: number | null = null;
  private tools = new Map<number, { id: string; name?: string; args: string; block?: number }>();
  private finish: string | undefined;
  private usage: ChatUsage | undefined;
  private sawTool = false;

  constructor(private readonly model: string) {}

  private event(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }

  private start(): string {
    if (this.started) return '';
    this.started = true;
    return this.event('message_start', {
      message: { id: msgId(), type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  private close(): string {
    if (this.open === null) return '';
    const out = this.event('content_block_stop', { index: this.open });
    if (this.open === this.text) this.text = null;
    this.open = null;
    return out;
  }

  private openBlock(block: Record<string, unknown>): { out: string; index: number } {
    const out = this.close();
    const index = this.next++;
    this.open = index;
    return { out: out + this.event('content_block_start', { index, content_block: block }), index };
  }

  chunk(c: ChatChunk): string {
    let out = this.start();
    if (c.usage) this.usage = c.usage;
    const choice = c.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};
    if (delta.content) {
      if (this.text === null || this.open !== this.text) {
        const o = this.openBlock({ type: 'text', text: '' });
        out += o.out;
        this.text = o.index;
      }
      out += this.event('content_block_delta', { index: this.text, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const tc of delta.tool_calls ?? []) {
      const key = tc.index ?? 0;
      let t = this.tools.get(key);
      if (!t) this.tools.set(key, (t = { id: tc.id ?? `toolu_${randomBytes(8).toString('hex')}`, args: '' }));
      if (tc.function?.name && !t.name) t.name = tc.function.name;
      const args = tc.function?.arguments ?? '';
      if (t.block === undefined) {
        // Wait for the name before the block starts; arguments that came first are sent with it.
        t.args += args;
        if (!t.name) continue;
        const o = this.openBlock({ type: 'tool_use', id: t.id, name: t.name, input: {} });
        out += o.out;
        t.block = o.index;
        this.sawTool = true;
        if (t.args) out += this.event('content_block_delta', { index: t.block, delta: { type: 'input_json_delta', partial_json: t.args } });
      } else if (args) {
        out += this.event('content_block_delta', { index: t.block, delta: { type: 'input_json_delta', partial_json: args } });
      }
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  end(): string {
    let out = this.start() + this.close();
    const stop = this.sawTool ? 'tool_use' : (STOP[this.finish ?? 'stop'] ?? 'end_turn');
    out += this.event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: usageOf(this.usage) });
    out += this.event('message_stop', {});
    return out;
  }
}

const ERROR_TYPES: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };

function apiError(status: number, message: string) {
  return { type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The local translator. One instance serves every OpenAI-style connection, each under its own path. */
export class OpenAiTranslator {
  readonly token = randomBytes(24).toString('hex');
  private server?: Server;
  private port = 0;

  constructor(private readonly lookup: (connectionId: string) => Upstream | undefined) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res).catch((err) => this.fail(res, 502, (err as Error).message)));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  /** What an agent's ANTHROPIC_BASE_URL is set to for this connection. */
  url(connectionId: string): string {
    if (!this.server) throw new Error('the OpenAI translator is not running');
    return `http://127.0.0.1:${this.port}/${encodeURIComponent(connectionId)}`;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private fail(res: ServerResponse, status: number, message: string) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify(apiError(status, message))}\n\n`);
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(apiError(status, message)));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const [, id, ...rest] = url.pathname.split('/');
    const path = `/${rest.join('/')}`;
    const auth = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (auth !== this.token) return this.fail(res, 401, 'invalid token for the covibe translator');
    const upstream = id ? this.lookup(decodeURIComponent(id)) : undefined;
    if (!upstream) return this.fail(res, 404, `no OpenAI-style connection "${id}"`);
    if (req.method !== 'POST') return this.fail(res, 404, `${req.method} ${path} is not supported`);

    const body = JSON.parse((await readBody(req)) || '{}') as MessagesRequest;
    if (path === '/v1/messages/count_tokens') {
      // A rough count: providers have no such endpoint, and Claude Code only uses it to estimate.
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) }));
    }
    if (path !== '/v1/messages') return this.fail(res, 404, `${path} is not supported`);

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const base = upstream.baseUrl.replace(/\/+$/, '');
    const chat = toChatRequest(body, { maxOutput: upstream.maxOutput(body.model), openaiHost: /(^|\.)openai\.com$/.test(new URL(base).hostname) });
    const answer = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(upstream.key ? { authorization: `Bearer ${upstream.key}` } : {}) },
      body: JSON.stringify(chat),
      signal: controller.signal,
    });
    if (!answer.ok) {
      const text = await answer.text().catch(() => '');
      let message = text;
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text;
      } catch {
        // not JSON: keep the text
      }
      return this.fail(res, answer.status, message || `the provider answered ${answer.status}`);
    }

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(fromChatResponse((await answer.json()) as ChatResponse, body.model)));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const t = new StreamTranslator(body.model);
    const decoder = new TextDecoder();
    let buffer = '';
    const lines = function* (final: boolean) {
      const parts = buffer.split('\n');
      buffer = final ? '' : (parts.pop() ?? '');
      yield* parts;
    };
    const take = (line: string) => {
      const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
      if (!data || data === '[DONE]') return;
      try {
        const out = t.chunk(JSON.parse(data) as ChatChunk);
        if (out) res.write(out);
      } catch {
        // a malformed chunk: skip it
      }
    };
    for await (const piece of answer.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(piece, { stream: true });
      for (const line of lines(false)) take(line);
    }
    buffer += decoder.decode();
    for (const line of lines(true)) take(line);
    res.end(t.end());
  }
}
