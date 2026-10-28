// The Codex half of covibe's OpenAI translator: Claude Code's Messages
// requests become Responses requests to a ChatGPT account's Codex API, and the
// streamed answers (text, reasoning, tool calls) become Messages events again.
// The backend keeps nothing (store: false), so the model's encrypted reasoning
// travels inside the thinking blocks' signatures, which Claude Code sends back
// unchanged with the conversation.
import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { Block, MessagesRequest } from './openai-proxy.js';

/** What the translator needs from a ChatGPT account. */
export interface CodexUpstream {
  /** Request headers with a usable token; `force` refreshes it first (the backend refused the last one). */
  headers(force?: boolean): Promise<Record<string, string>>;
  /** The reasoning efforts a model takes, if known. */
  efforts(model: string): string[] | undefined;
  /** Every answer's headers: they carry the plan's usage. */
  seen?(headers: Headers): void;
  /** The plan's usage limit was reached; it resets then (epoch seconds), if known. */
  limited?(resetsAt?: number): void;
}

type InputItem = Record<string, unknown>;

const SIGNATURE = 'codex:';

/** Reasoning to carry: Responses' encrypted reasoning, packed into a thinking block's signature. */
function packReasoning(id: string | undefined, encrypted: string): string {
  return SIGNATURE + Buffer.from(JSON.stringify({ id, enc: encrypted })).toString('base64url');
}

function unpackReasoning(signature: unknown): { id?: string; enc: string } | undefined {
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE)) return undefined;
  try {
    const r = JSON.parse(Buffer.from(signature.slice(SIGNATURE.length), 'base64url').toString('utf8')) as { id?: string; enc?: string };
    return typeof r.enc === 'string' ? { ...(r.id ? { id: r.id } : {}), enc: r.enc } : undefined;
  } catch {
    return undefined;
  }
}

const imageUrl = (b: Extract<Block, { type: 'image' }>): string => (b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url);

const textOf = (content: string | Block[] | undefined): string =>
  typeof content === 'string' ? content : (content ?? []).filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * The reasoning effort for a request: the member's effort as Claude Code sends
 * it (output_config.effort), or one read from a thinking budget, lowered to
 * the closest one the model takes. Small background requests (no thinking)
 * use the least.
 */
export function effortFor(req: MessagesRequest, supported: string[] | undefined): string {
  const known = (supported ?? []).filter((e) => EFFORTS.includes(e)).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const lowest = known.find((e) => e === 'low') ?? known.find((e) => EFFORTS.indexOf(e) > EFFORTS.indexOf('low')) ?? 'low';
  let wanted = req.output_config?.effort;
  if (!wanted && (req.thinking?.type === 'enabled' || req.thinking?.type === 'adaptive')) {
    const budget = req.thinking.budget_tokens;
    wanted = budget === undefined ? 'medium' : budget <= 4096 ? 'low' : budget <= 16_384 ? 'medium' : 'high';
  }
  if (!wanted || !EFFORTS.includes(wanted)) return lowest;
  // Without the model's list, stay with what every Codex model takes.
  const choices = known.length ? known : ['low', 'medium', 'high', 'xhigh'];
  const at = EFFORTS.indexOf(wanted);
  return [...choices].reverse().find((e) => EFFORTS.indexOf(e) <= at) ?? choices[0]!;
}

/** An Anthropic Messages request as a Responses request for the Codex API. */
export function toResponsesRequest(req: MessagesRequest, opts: { efforts?: string[]; cacheKey?: string } = {}): Record<string, unknown> {
  const input: InputItem[] = [];
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text ?? '').filter(Boolean).join('\n\n');
  if (system) input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: system }] });

  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      input.push(m.role === 'user' ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content }] } : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      // In order: reasoning, then what it said, then its tool calls.
      for (const b of m.content) {
        if (b.type === 'text' && (b as { text: string }).text) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: (b as { text: string }).text }] });
        } else if (b.type === 'tool_use') {
          const t = b as Extract<Block, { type: 'tool_use' }>;
          input.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: JSON.stringify(t.input ?? {}) });
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // Only reasoning that came from the Codex API can go back to it.
          const r = unpackReasoning(b.type === 'thinking' ? b.signature : b.data);
          if (!r) continue;
          const text = b.type === 'thinking' && typeof b.thinking === 'string' ? b.thinking : '';
          input.push({ type: 'reasoning', ...(r.id ? { id: r.id } : {}), summary: text ? [{ type: 'summary_text', text }] : [], encrypted_content: r.enc });
        }
      }
      continue;
    }
    // A user turn: tool results first (they answer the assistant's calls), then the rest.
    const parts: Record<string, unknown>[] = [];
    const resultImages: Record<string, unknown>[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const r = b as Extract<Block, { type: 'tool_result' }>;
        const text = textOf(r.content);
        if (Array.isArray(r.content)) for (const c of r.content) if (c.type === 'image') resultImages.push({ type: 'input_image', image_url: imageUrl(c as Extract<Block, { type: 'image' }>) });
        input.push({ type: 'function_call_output', call_id: r.tool_use_id, output: (r.is_error ? 'Error: ' : '') + (text || (Array.isArray(r.content) && r.content.length ? '(see the image below)' : '(no output)')) });
      } else if (b.type === 'text') parts.push({ type: 'input_text', text: (b as { text: string }).text });
      else if (b.type === 'image') parts.push({ type: 'input_image', image_url: imageUrl(b as Extract<Block, { type: 'image' }>) });
      else if (b.type === 'document') parts.push({ type: 'input_text', text: '[A document was attached here; this model cannot read documents.]' });
    }
    // Tool outputs carry text; their images follow in a user message.
    if (resultImages.length) parts.unshift({ type: 'input_text', text: 'Images from the tool results above:' }, ...resultImages);
    if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
  }

  const out: Record<string, unknown> = {
    model: req.model,
    stream: true,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: effortFor(req, opts.efforts), summary: 'auto' },
    // The backend keeps nothing between requests; reasoning comes back encrypted for the next one.
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(opts.cacheKey ? { prompt_cache_key: opts.cacheKey } : {}),
  };
  // Server tools (web search and the like) are Anthropic's own; only custom tools go along.
  const tools = (req.tools ?? []).filter((t) => t.input_schema);
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description ?? '', parameters: t.input_schema, strict: false }));
    const c = req.tool_choice;
    if (c) out.tool_choice = c.type === 'any' ? 'required' : c.type === 'tool' && c.name ? { type: 'function', name: c.name } : c.type;
  } else delete out.parallel_tool_calls;
  return out;
}

// ---- answers

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

interface ResponsesItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string | null;
  summary?: { text?: string }[];
  content?: { type?: string; text?: string }[];
}

export interface ResponsesEvent {
  type: string;
  output_index?: number;
  summary_index?: number;
  delta?: string;
  item?: ResponsesItem;
  response?: { usage?: ResponsesUsage | null; status?: string; incomplete_details?: { reason?: string } | null; error?: { code?: string; message?: string } | null };
  code?: string;
  message?: string;
  error?: { code?: string; message?: string; type?: string };
}

function usageOf(u: ResponsesUsage | null | undefined) {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: Math.max(0, (u?.input_tokens ?? 0) - cached), output_tokens: u?.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const parseArgs = (s: string | undefined): unknown => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

/** The stream failed partway (response.failed, or an error event). */
export class CodexStreamError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Turns Responses stream events into Messages stream events, and keeps the
 * whole message for answers that were not asked to stream. Feed it each
 * event; it returns the SSE text to send.
 */
export class ResponsesTranslator {
  private started = false;
  private next = 0;
  /** The content block currently open, if any. */
  private open: number | null = null;
  /** Output item → its content block and what has been sent for it. */
  private items = new Map<number, { block?: number; kind: string; sent: boolean; summaries: number }>();
  private sawTool = false;
  private stop: string | undefined;
  private usage: ResponsesUsage | null | undefined;
  readonly content: Record<string, unknown>[] = [];
  readonly id = `msg_${randomBytes(12).toString('hex')}`;
  ended = false;

  constructor(private readonly model: string) {}

  private event(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }

  private start(): string {
    if (this.started) return '';
    this.started = true;
    return this.event('message_start', {
      message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  private close(): string {
    if (this.open === null) return '';
    const out = this.event('content_block_stop', { index: this.open });
    this.open = null;
    return out;
  }

  private openBlock(block: Record<string, unknown>): { out: string; index: number } {
    const out = this.close();
    const index = this.next++;
    this.open = index;
    this.content[index] = { ...block };
    return { out: out + this.event('content_block_start', { index, content_block: block }), index };
  }

  private delta(index: number, delta: Record<string, unknown>): string {
    const b = this.content[index]!;
    if (delta.type === 'text_delta') b.text = String(b.text ?? '') + String(delta.text);
    else if (delta.type === 'thinking_delta') b.thinking = String(b.thinking ?? '') + String(delta.thinking);
    else if (delta.type === 'signature_delta') b.signature = delta.signature;
    else if (delta.type === 'input_json_delta') b.partial = String(b.partial ?? '') + String(delta.partial_json);
    // A delta for a block another one already followed cannot be sent any more.
    return index === this.open ? this.event('content_block_delta', { index, delta }) : '';
  }

  private item(e: ResponsesEvent) {
    const key = e.output_index ?? -1;
    let it = this.items.get(key);
    if (!it) this.items.set(key, (it = { kind: e.item?.type ?? 'message', sent: false, summaries: 0 }));
    return it;
  }

  /** The block for an item's text or reasoning, opened on first use. */
  private blockFor(e: ResponsesEvent, kind: 'text' | 'thinking'): { out: string; index: number } {
    const it = this.item(e);
    if (it.block !== undefined) return { out: '', index: it.block };
    const o = this.openBlock(kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' });
    it.block = o.index;
    return o;
  }

  feed(e: ResponsesEvent): string {
    let out = this.start();
    switch (e.type) {
      case 'response.output_item.added': {
        const it = this.item(e);
        it.kind = e.item?.type ?? it.kind;
        if (it.kind === 'function_call' && e.item) {
          const o = this.openBlock({ type: 'tool_use', id: e.item.call_id ?? `call_${randomBytes(8).toString('hex')}`, name: e.item.name ?? '', input: {} });
          it.block = o.index;
          this.sawTool = true;
          out += o.out;
        }
        break;
      }
      case 'response.output_text.delta': {
        if (!e.delta) break;
        const o = this.blockFor(e, 'text');
        out += o.out + this.delta(o.index, { type: 'text_delta', text: e.delta });
        this.item(e).sent = true;
        break;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (!e.delta) break;
        const it = this.item(e);
        const o = this.blockFor(e, 'thinking');
        out += o.out;
        // Summary parts are paragraphs of one thinking block.
        if (e.summary_index !== undefined && e.summary_index > it.summaries) {
          it.summaries = e.summary_index;
          out += this.delta(o.index, { type: 'thinking_delta', thinking: '\n\n' });
        }
        out += this.delta(o.index, { type: 'thinking_delta', thinking: e.delta });
        it.sent = true;
        break;
      }
      case 'response.function_call_arguments.delta': {
        const it = this.item(e);
        if (!e.delta || it.block === undefined) break;
        out += this.delta(it.block, { type: 'input_json_delta', partial_json: e.delta });
        it.sent = true;
        break;
      }
      case 'response.output_item.done': {
        const it = this.item(e);
        const item = e.item ?? {};
        if (item.type === 'message') {
          if (!it.sent) {
            const text = (item.content ?? []).map((c) => c.text ?? '').join('');
            if (text) {
              const o = this.blockFor(e, 'text');
              out += o.out + this.delta(o.index, { type: 'text_delta', text });
            }
          }
        } else if (item.type === 'reasoning') {
          const enc = item.encrypted_content ?? undefined;
          const summary = (item.summary ?? []).map((s) => s.text ?? '').filter(Boolean).join('\n\n');
          if (it.block === undefined && summary) {
            const o = this.blockFor(e, 'thinking');
            out += o.out + this.delta(o.index, { type: 'thinking_delta', thinking: summary });
          }
          if (it.block !== undefined) {
            out += this.delta(it.block, { type: 'signature_delta', signature: enc ? packReasoning(item.id, enc) : '' });
          } else if (enc) {
            // Reasoning without a summary still has to go back with the conversation.
            const o = this.openBlock({ type: 'redacted_thinking', data: packReasoning(item.id, enc) });
            it.block = o.index;
            out += o.out;
          }
        } else if (item.type === 'function_call') {
          if (it.block === undefined) {
            const o = this.openBlock({ type: 'tool_use', id: item.call_id ?? `call_${randomBytes(8).toString('hex')}`, name: item.name ?? '', input: {} });
            it.block = o.index;
            this.sawTool = true;
            out += o.out;
          }
          if (!it.sent && item.arguments) out += this.delta(it.block, { type: 'input_json_delta', partial_json: item.arguments });
          const b = this.content[it.block]!;
          b.input = parseArgs((b.partial as string | undefined) ?? item.arguments);
          delete b.partial;
        }
        if (it.block !== undefined && it.block === this.open) out += this.close();
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        this.usage = e.response?.usage;
        const reason = e.response?.incomplete_details?.reason;
        this.stop = this.sawTool ? 'tool_use' : reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
        break;
      }
      case 'response.failed': {
        const err = e.response?.error;
        throw new CodexStreamError(err?.message ?? 'the Codex API could not answer', err?.code);
      }
      case 'error':
        throw new CodexStreamError(e.message ?? e.error?.message ?? 'the Codex API sent an error', e.code ?? e.error?.code ?? e.error?.type);
    }
    return out;
  }

  /** The closing events; call after the stream ends. */
  end(): string {
    let out = this.start() + this.close();
    this.ended = true;
    out += this.event('message_delta', { delta: { stop_reason: this.stop ?? (this.sawTool ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: usageOf(this.usage) });
    out += this.event('message_stop', {});
    return out;
  }

  /** The whole answer as one Messages response. */
  message(): Record<string, unknown> {
    const content = this.content.filter(Boolean).map((b) => {
      const { partial, ...rest } = b;
      return rest.type === 'tool_use' && rest.input === undefined ? { ...rest, input: parseArgs(partial as string | undefined) } : rest;
    });
    return {
      id: this.id,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: this.stop ?? (this.sawTool ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: usageOf(this.usage),
    };
  }
}

/** Read an SSE body and hand each event's JSON to `take`. */
async function readEvents(body: ReadableStream<Uint8Array> | null, take: (e: ResponsesEvent) => void): Promise<void> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const lines = (final: boolean) => {
    const parts = buffer.split('\n');
    buffer = final ? '' : (parts.pop() ?? '');
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let e: ResponsesEvent;
      try {
        e = JSON.parse(data) as ResponsesEvent;
      } catch {
        continue; // a malformed event: skip it
      }
      take(e);
    }
  };
  for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    lines(false);
  }
  buffer += decoder.decode();
  lines(true);
}

/** An error the translator answers with: status, Anthropic error type and message, and whether Claude Code should retry. */
export interface CodexFailure {
  status: number;
  message: string;
  retry?: boolean;
}

/** What a failed Codex API answer means for Claude Code (a usage limit stops the turn with its reset time, so covibe can wait for it). */
export function failureOf(status: number, text: string, limited?: (resetsAt?: number) => void): CodexFailure {
  let message = text;
  let type: string | undefined;
  let resetsAt: number | undefined;
  try {
    const j = JSON.parse(text) as { error?: { message?: string; type?: string; code?: string; resets_at?: number; resets_in_seconds?: number } | string; detail?: string | { message?: string } };
    if (typeof j.error === 'string') message = j.error;
    else if (j.error) {
      message = j.error.message ?? message;
      type = j.error.type ?? j.error.code;
      resetsAt = j.error.resets_at ?? (j.error.resets_in_seconds !== undefined ? Math.round(Date.now() / 1000) + j.error.resets_in_seconds : undefined);
    } else if (j.detail) message = typeof j.detail === 'string' ? j.detail : (j.detail.message ?? message);
  } catch {
    // not JSON: keep the text
  }
  if (type === 'usage_not_included') return { status: 403, message: 'This ChatGPT plan does not include Codex; use another account or plan.', retry: false };
  if (status === 429 && type === 'usage_limit_reached') {
    limited?.(resetsAt);
    const when = resetsAt ? `; it resets at ${new Date(resetsAt * 1000).toISOString()}` : '';
    // "usage limit reached|<epoch>" is what covibe reads a turn's reset time from (runner/claude-sdk.ts limitOf).
    const said = `ChatGPT plan usage limit reached${when}${message && message !== text ? ` (${message})` : ''}`;
    return { status: 429, message: resetsAt ? `${said}|${resetsAt}` : said, retry: false };
  }
  return { status, message: message || `the Codex API answered ${status}` };
}

/**
 * Answer one Messages request from a ChatGPT account's Codex API. A refused
 * token is refreshed once and the request sent again.
 */
export async function answerCodex(
  body: MessagesRequest,
  reqHeaders: IncomingHttpHeaders,
  baseUrl: string,
  upstream: CodexUpstream,
  res: ServerResponse,
  signal: AbortSignal,
  fail: (f: CodexFailure) => void,
): Promise<void> {
  const session = reqHeaders['x-claude-code-session-id'];
  const sessionId = typeof session === 'string' && session ? session : undefined;
  const request = JSON.stringify(toResponsesRequest(body, { efforts: upstream.efforts(body.model), cacheKey: sessionId }));
  const url = `${baseUrl.replace(/\/+$/, '')}/responses`;
  let answer: Response | undefined;
  for (const force of [false, true]) {
    let headers: Record<string, string>;
    try {
      headers = await upstream.headers(force);
    } catch (err) {
      return fail({ status: 401, message: (err as Error).message, retry: false });
    }
    answer = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream', ...(sessionId ? { 'session-id': sessionId } : {}) },
      body: request,
      signal,
    });
    upstream.seen?.(answer.headers);
    if (answer.status !== 401 || force) break;
    await answer.body?.cancel().catch(() => undefined);
  }
  if (!answer!.ok) return fail(failureOf(answer!.status, await answer!.text().catch(() => ''), upstream.limited));

  const t = new ResponsesTranslator(body.model);
  if (body.stream) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  try {
    await readEvents(answer!.body, (e) => {
      const out = t.feed(e);
      if (body.stream && out) res.write(out);
    });
  } catch (err) {
    const message = err instanceof CodexStreamError ? err.message : `the Codex API stream broke: ${(err as Error).message}`;
    const code = err instanceof CodexStreamError ? (err.code ?? '') : '';
    if (code === 'usage_limit_reached') return fail(failureOf(429, JSON.stringify({ error: { type: code, message } }), upstream.limited));
    return fail({ status: code === 'rate_limit_exceeded' ? 429 : 502, message });
  }
  if (body.stream) res.end(t.end());
  else {
    t.end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(t.message()));
  }
}
