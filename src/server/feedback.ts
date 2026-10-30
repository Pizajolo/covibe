// Feedback a person pins on a run's result: a moment of a video, an area of an
// image, a passage of a document, an element of a page or of the running app.
// It is kept with the project until they send it; sending starts a new goal on
// the result with every comment in it.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackItem, FeedbackList } from './api-types.js';
import { BadRequest } from './library.js';

const KINDS = new Set<FeedbackItem['kind']>(['video', 'audio', 'image', 'pdf', 'page', 'text', 'file']);
const MAX_ITEMS = 200;
const MAX_COMMENT = 4000;

function fileOf(repo: string, runId: string): string {
  return join(repo, '.covibe', 'feedback', `${runId}.json`);
}

export function readFeedback(repo: string, runId: string): FeedbackList {
  try {
    const list = JSON.parse(readFileSync(fileOf(repo, runId), 'utf8')) as FeedbackList;
    return { items: list.items ?? [], sent: list.sent ?? [] };
  } catch {
    return { items: [], sent: [] };
  }
}

export function writeFeedback(repo: string, runId: string, list: FeedbackList): FeedbackList {
  const file = fileOf(repo, runId);
  mkdirSync(join(file, '..'), { recursive: true });
  const covibe = join(repo, '.covibe');
  if (!existsSync(join(covibe, '.gitignore'))) writeFileSync(join(covibe, '.gitignore'), '*\n');
  writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2));
  renameSync(`${file}.tmp`, file);
  return list;
}

const num = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined => {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A comment as the UI sent it, checked and trimmed; throws BadRequest when it is not one. */
export function cleanItem(raw: unknown): FeedbackItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const comment = text(r.comment, MAX_COMMENT);
  if (!comment) throw new BadRequest('a comment needs text');
  const path = text(r.path, 1000);
  if (!path) throw new BadRequest('a comment needs the file or page it is about');
  const kind = KINDS.has(r.kind as FeedbackItem['kind']) ? (r.kind as FeedbackItem['kind']) : 'file';
  const item: FeedbackItem = {
    id: typeof r.id === 'string' && /^[\w-]{4,40}$/.test(r.id) ? r.id : randomBytes(6).toString('hex'),
    target: r.target === 'app' ? 'app' : 'file',
    path,
    kind,
    comment,
    createdAt: typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt)) ? r.createdAt : new Date().toISOString(),
  };
  const at = num(r.at);
  if (at !== undefined) item.at = Math.round(at * 10) / 10;
  const until = num(r.until);
  if (until !== undefined && at !== undefined && until > at) item.until = Math.round(until * 10) / 10;
  const page = num(r.page, 1, 100_000);
  if (page !== undefined) item.page = Math.floor(page);
  const quote = text(r.quote, 2000);
  if (quote) item.quote = quote;
  const g = r.region as Record<string, unknown> | undefined;
  if (g && typeof g === 'object') {
    const [x, y, width, height] = [num(g.x, 0, 1), num(g.y, 0, 1), num(g.width, 0, 1), num(g.height, 0, 1)];
    if (x !== undefined && y !== undefined && width && height) item.region = { x: round3(x), y: round3(y), width: round3(width), height: round3(height) };
  }
  const e = r.element as Record<string, unknown> | undefined;
  if (e && typeof e === 'object' && typeof e.selector === 'string') {
    item.element = { selector: e.selector.slice(0, 500), tag: text(e.tag, 40) ?? '', text: text(e.text, 300) ?? '', ...(text(e.title, 200) ? { title: text(e.title, 200) } : {}) };
  }
  return item;
}

export function cleanItems(raw: unknown): FeedbackItem[] {
  if (!Array.isArray(raw)) throw new BadRequest('"items" is a list of comments');
  if (raw.length > MAX_ITEMS) throw new BadRequest(`at most ${MAX_ITEMS} comments at a time`);
  return raw.map(cleanItem);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 75.4 → "1:15.4" */
export function timecode(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const sec = rest.toFixed(rest % 1 ? 1 : 0).padStart(rest % 1 ? 4 : 2, '0');
  return `${m}:${sec}`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Where in its file or page a comment points, in words. */
export function anchorText(i: FeedbackItem): string {
  const where = i.target === 'app' ? `the running app, page ${i.path}` : i.path;
  const parts: string[] = [];
  if (i.at !== undefined) parts.push(i.until !== undefined ? `from ${timecode(i.at)} to ${timecode(i.until)}` : `at ${timecode(i.at)}`);
  if (i.region) parts.push(`the area from ${pct(i.region.x)} to ${pct(i.region.x + i.region.width)} across and ${pct(i.region.y)} to ${pct(i.region.y + i.region.height)} down${i.at !== undefined ? ' of the frame' : ''}`);
  if (i.page !== undefined) parts.push(`page ${i.page}`);
  if (i.element) parts.push(`the element \`${i.element.selector}\`${i.element.text ? ` ("${i.element.text.slice(0, 120)}")` : ''}`);
  return parts.length ? `${where}, ${parts.join(', ')}` : where;
}

/** The goal of the run that answers the feedback. */
export function feedbackGoal(previousGoal: string, items: FeedbackItem[], note?: string): string {
  const first = previousGoal.trim().split('\n')[0]!;
  const title = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const count = items.length ? ` (${items.length} comment${items.length === 1 ? '' : 's'})` : '';
  const lines = [
    `Feedback on "${title}"${count}`,
    '',
    'The human reviewed the result of the previous run and left feedback. Address every point below, then check the result again (for a video, look at the frames at those moments; for a web page or the app, open it and look).',
    '',
    `The previous run's goal was: ${previousGoal.trim()}`,
  ];
  if (note?.trim()) lines.push('', `Overall note from the human: ${note.trim()}`);
  if (items.length) lines.push('', 'Feedback:');
  items.forEach((i, n) => {
    lines.push(`${n + 1}. On ${anchorText(i)}:`);
    if (i.quote) lines.push(`   About this passage: "${i.quote.replace(/\s+/g, ' ').slice(0, 600)}"`);
    for (const l of i.comment.split('\n')) lines.push(`   ${l}`);
  });
  return lines.join('\n');
}
