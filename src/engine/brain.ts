// The project brain: a folder of Markdown notes about a project that every
// member reads. Members propose additions; only the team's curator (or you)
// writes. The folder is its own git repository, so every change has history.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentConfig, BackendConfig, Effort, TeamConfig } from '../config/types.js';
import type { EventStore } from '../events/store.js';
import type { BrainProposal } from '../events/types.js';
import { brainRoot } from '../home.js';
import type { Connections } from '../connections/store.js';
import { plainBackends, type Env } from '../runner/backend.js';
import type { AgentRunner, CustomTool } from '../runner/types.js';
import type { BackendResolver } from '../runner/backend.js';
import { makeToolChecker } from './scope.js';

const exec = promisify(execFile);
const README = `# Project brain

Shared knowledge about this project: how things work, decisions and why, conventions, gotchas.
Every team member reads these notes. Members propose additions; the curator maintains them.
`;

export class BrainError extends Error {}

export interface BrainNote {
  path: string;
  title: string;
  size: number;
  updatedAt: string;
}

export interface BrainCommit {
  commit: string;
  author: string;
  date: string;
  message: string;
}

function gitEnv(author: string): NodeJS.ProcessEnv {
  const name = author === 'you' ? 'you' : `covibe/${author}`;
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: 'covibe@localhost', GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: 'covibe@localhost' };
}

async function git(dir: string, args: string[], author = 'covibe') {
  return (await exec('git', args, { cwd: dir, env: gitEnv(author), maxBuffer: 16 << 20 })).stdout;
}

/** The brain folder for a repository, created (with a README and git history) on first use. */
export async function ensureBrain(repo: string): Promise<string> {
  const dir = brainRoot(repo);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'README.md'))) writeFileSync(join(dir, 'README.md'), README);
    await git(dir, ['init', '-q', '-b', 'main']);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'Start the project brain']);
  }
  return dir;
}

function titleOf(text: string, path: string): string {
  const h = /^#\s+(.+)$/m.exec(text);
  return h ? h[1]!.trim() : path.replace(/\.md$/, '').split('/').pop()!.replace(/[-_]/g, ' ');
}

export function listNotes(repo: string): BrainNote[] {
  const dir = brainRoot(repo);
  if (!existsSync(dir)) return [];
  const out: BrainNote[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const rel = relative(dir, p).split(sep).join('/');
        const st = statSync(p);
        out.push({ path: rel, title: titleOf(readFileSync(p, 'utf8').slice(0, 2000), rel), size: st.size, updatedAt: st.mtime.toISOString() });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path === 'README.md' ? -1 : b.path === 'README.md' ? 1 : a.path.localeCompare(b.path)));
}

function notePath(repo: string, rel: string): string {
  const dir = brainRoot(repo);
  const p = resolve(dir, rel);
  if (!p.startsWith(dir + sep) || !p.endsWith('.md') || p.split(sep).includes('.git')) throw new BrainError(`"${rel}" is not a note path (a .md file inside the brain)`);
  return p;
}

export function readNote(repo: string, rel: string): string {
  const p = notePath(repo, rel);
  if (!existsSync(p)) throw new BrainError(`${rel} not found`);
  return readFileSync(p, 'utf8');
}

/** Commit whatever changed in the brain; returns the commit, or undefined when nothing changed. */
export async function commitBrain(repo: string, message: string, author: string): Promise<string | undefined> {
  const dir = await ensureBrain(repo);
  await git(dir, ['add', '-A']);
  const changed = (await git(dir, ['status', '--porcelain'])).trim();
  if (!changed) return undefined;
  await git(dir, ['commit', '-q', '-m', message], author);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

/** Your own edits (the human is above the curator). */
export async function writeNote(repo: string, rel: string, content: string): Promise<string | undefined> {
  await ensureBrain(repo);
  const p = notePath(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return commitBrain(repo, `Edit ${rel}`, 'you');
}

export async function deleteNote(repo: string, rel: string): Promise<void> {
  if (rel === 'README.md') throw new BrainError('README.md is the index of the brain and stays');
  rmSync(notePath(repo, rel), { force: true });
  await commitBrain(repo, `Delete ${rel}`, 'you');
}

export async function brainLog(repo: string, limit = 30): Promise<BrainCommit[]> {
  const dir = brainRoot(repo);
  if (!existsSync(join(dir, '.git'))) return [];
  const out = await git(dir, ['log', `-${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [commit, author, date, message] = l.split('\x1f') as [string, string, string, string];
      return { commit, author, date, message };
    });
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
}

/** Accepting a proposal yourself: append it to a note (new or existing) and commit. */
export async function acceptIntoNote(repo: string, p: BrainProposal, rel?: string): Promise<string> {
  await ensureBrain(repo);
  const target = rel ?? `${slugify(p.title)}.md`;
  const file = notePath(repo, target);
  mkdirSync(dirname(file), { recursive: true });
  // A new note starts with the proposal's title; an existing one gets it as a section.
  const text = existsSync(file) ? `${readFileSync(file, 'utf8').replace(/\s*$/, '')}\n\n## ${p.title}\n\n${p.content.trim()}\n` : `# ${p.title}\n\n${p.content.trim()}\n`;
  writeFileSync(file, text);
  await commitBrain(repo, `Add proposal #${p.id} from ${p.agent}: ${p.title}`, 'you');
  return target;
}

/** The brain section of an agent's system prompt. */
export function brainPrompt(repo: string, agent: AgentConfig, team: TeamConfig): string {
  const dir = brainRoot(repo);
  const notes = listNotes(repo);
  const index = notes.length ? notes.slice(0, 60).map((n) => `- ${n.path}: ${n.title}`).join('\n') : '- (empty so far)';
  const curator = team.brain.curator;
  const role =
    curator === agent.name
      ? `You are the curator of the brain: you may edit these notes directly. Keep them short, accurate and current, merge rather than duplicate, and keep README.md as the index.`
      : `You cannot edit the brain. When you learn something future work should know (a decision and its reason, a convention, a gotcha, how a part works), propose it with the propose_brain_note tool${curator ? `; ${curator} curates the brain` : '; the human reviews proposals'}.`;
  return [
    '# Project brain',
    `Shared knowledge about this project lives in ${dir}. Read the notes that relate to your task before you start. Notes:`,
    index,
    role,
  ].join('\n');
}

/** A rough token count: about four characters a token for English prose and Markdown. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4);

export interface BrainLoad {
  /** The brain's part of every member's system prompt (where it is, the list of notes, what to do with them). Sent with every request. */
  promptTokens: number;
  /** Every note, read in full. */
  notesTokens: number;
  /** Each note, read in full. */
  notes: Record<string, number>;
  /** What members read of the brain in recent runs of this project. */
  recent?: { runs: number; reads: number; tokens: number };
}

/**
 * What the brain costs members, in tokens (estimated, see tokensOf). Every
 * member gets the list of notes in its system prompt; the notes themselves it
 * reads with its file tools when they relate to its task.
 */
export function brainLoad(repo: string, recent?: { runs: number; reads: string[] }): BrainLoad {
  const dir = brainRoot(repo);
  const member = { name: 'member' } as AgentConfig;
  const team = { brain: { curator: 'curator' } } as TeamConfig;
  const notes: Record<string, number> = {};
  for (const n of listNotes(repo)) notes[n.path] = tokensOf(readFileSync(join(dir, n.path), 'utf8'));
  const load: BrainLoad = { promptTokens: tokensOf(brainPrompt(repo, member, team)), notesTokens: Object.values(notes).reduce((a, b) => a + b, 0), notes };
  if (recent) {
    // A read of a note as it is now (it may have been longer or shorter then).
    const read = recent.reads.map((p) => relative(dir, p).split(sep).join('/')).filter((rel) => rel in notes);
    load.recent = { runs: recent.runs, reads: read.length, tokens: read.reduce((n, rel) => n + notes[rel]!, 0) };
  }
  return load;
}

/** propose_brain_note, for every member except the curator. */
export function proposeTool(store: EventStore, runId: string | undefined, agent: string, step?: string): CustomTool {
  return {
    name: 'propose_brain_note',
    description:
      'Propose an addition or correction to the project brain (shared notes every member reads). Use it for durable knowledge: decisions and why, conventions, gotchas, how something works. Not for progress reports.',
    params: {
      title: { type: 'string', description: 'Short title, e.g. "Prices are stored in integer cents"' },
      content: { type: 'string', description: 'The note in Markdown: what future work should know, concisely.' },
      reason: { type: 'string', description: 'Why this matters or where you learned it.', optional: true },
    },
    run: (a) => {
      const p = store.addProposal({ runId, agent, title: String(a.title), content: String(a.content), reason: a.reason ? String(a.reason) : undefined });
      if (runId) store.append(runId, { type: 'brain.proposed', agent, step, data: { id: p.id, title: p.title } });
      return `Proposal #${p.id} recorded. The curator reviews it; you do not need to wait.`;
    },
  };
}

/**
 * Let the curator review pending proposals: it edits the notes directly
 * (inside the brain folder only) and records a decision for each.
 */
export async function curate(opts: {
  team: TeamConfig;
  store: EventStore;
  runner: AgentRunner;
  repo: string;
  /** Run the events go to (the workflow run, or a dedicated curate run). */
  runId: string;
  buildInvocation: typeof import('./engine.js').buildInvocation;
  env?: Env;
  connections?: Connections;
  signal?: AbortSignal;
}): Promise<{ decided: number; commit?: string }> {
  const { team, store, runId } = opts;
  const name = team.brain.curator;
  if (!name) return { decided: 0 };
  const pending = store.proposals('pending').reverse();
  if (!pending.length) return { decided: 0 };
  const dir = await ensureBrain(opts.repo);
  const base = team.agents[name]!;
  // The curator works in the brain folder with file tools only.
  const agent: AgentConfig = { ...base, tools: base.tools.filter((t) => ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob'].includes(t)), writeScope: undefined, writes: true, canMessage: [], canRequest: [], sandbox: undefined };
  let decided = 0;
  const decide: CustomTool = {
    name: 'decide_proposal',
    description: 'Record your decision on one proposal after you have updated the notes (or decided not to).',
    params: {
      id: { type: 'number', description: 'Proposal number' },
      decision: { type: 'string', enum: ['accept', 'reject'], description: 'accept or reject' },
      note: { type: 'string', description: 'One line: what you changed, or why you rejected it.' },
      note_path: { type: 'string', description: 'The note you added it to (when accepted), e.g. decisions.md', optional: true },
    },
    run: (a) => {
      const p = store.decideProposal(Number(a.id), { status: a.decision === 'accept' ? 'accepted' : 'rejected', by: name, note: String(a.note), notePath: a.note_path ? String(a.note_path) : undefined });
      store.append(runId, { type: 'brain.decided', step: 'curate', agent: name, data: { id: p.id, status: p.status, note: p.decisionNote ?? null, note_path: p.notePath ?? null } });
      decided += 1;
      return `Recorded: #${p.id} ${p.status}.`;
    },
  };
  const list = pending
    .map((p) => `## Proposal #${p.id}: ${p.title}\nFrom: ${p.agent}${p.reason ? `\nReason: ${p.reason}` : ''}\n\n${p.content}`)
    .join('\n\n');
  const prompt = `You are curating the project brain in ${dir} (your working folder). Review the ${pending.length} proposal(s) below.

For each one: if it is accurate, durable and useful, merge it into the right note (create a note if none fits; prefer updating over duplicating; keep README.md as an index of the notes). Otherwise reject it. Then call decide_proposal for it. Decide every proposal.

${list}`;
  const built = await (opts.connections ?? plainBackends).resolve(agent.backend, opts.env ?? process.env);
  store.append(runId, { type: 'step.started', step: 'curate', data: { loop: 0, proposals: pending.length } });
  store.append(runId, { type: 'agent.started', step: 'curate', agent: name, data: { model: agent.model ?? null, backend: agent.backend.type, via: built.via, cwd: dir, resumed: false } });
  const inv = opts.buildInvocation(team, store, runId, agent, {
    cwd: dir,
    root: dir,
    prompt,
    env: built.env,
    pricing: built.pricing,
    via: built.via,
    step: 'curate',
    signal: opts.signal ?? AbortSignal.timeout(agent.limits.timeout_min * 60_000),
    repo: opts.repo,
    extraTools: [decide],
    curating: true,
  });
  const result = await opts.runner.run(inv).finally(() => inv.onControl?.(null));
  store.append(runId, {
    type: result.ok ? 'agent.finished' : 'agent.error',
    step: 'curate',
    agent: name,
    data: { ok: result.ok, model: agent.model ?? null, via: built.via, turns: result.turns, cost_usd: result.costUsd, duration_ms: result.durationMs, tokens: result.tokens ?? null, ...(result.ok ? {} : { error: result.error }) },
  });
  const commit = await commitBrain(opts.repo, `Curated ${decided} proposal(s)`, name);
  if (commit) store.append(runId, { type: 'brain.updated', step: 'curate', agent: name, data: { commit } });
  store.append(runId, { type: 'step.finished', step: 'curate', data: { decided } });
  return { decided, commit };
}

/** The member that compresses the brain (not one of a team's). */
export const SUMMARIZER = 'summarizer';

/** How many bytes the brain's notes take. */
export function brainSize(repo: string): number {
  return listNotes(repo).reduce((n, note) => n + note.size, 0);
}

/**
 * Compress the brain: an agent rewrites the notes to say the same in far
 * fewer words (every member reads them, so every word costs tokens), merges
 * notes on the same topic and deletes what becomes redundant. The brain's
 * history keeps what was there before.
 */
export async function summarizeBrain(opts: {
  store: EventStore;
  runner: AgentRunner;
  repo: string;
  /** The run the events go to (a dedicated one, kind "curate"). */
  runId: string;
  /** A Claude model (default sonnet), unless `backend` is a provider's, which names its own model. */
  model?: string;
  effort?: Effort;
  /** Where it runs: your Claude login by default, or a provider from Settings → Advanced. */
  backend?: BackendConfig;
  env?: Env;
  backends?: BackendResolver;
  signal?: AbortSignal;
}): Promise<{ before: number; after: number; commit?: string }> {
  const { store, runId } = opts;
  const dir = await ensureBrain(opts.repo);
  // Whatever was edited by hand is kept in the history first.
  await commitBrain(opts.repo, 'Before summarizing', 'you');
  const notes = listNotes(opts.repo);
  const before = brainSize(opts.repo);
  const base = { step: 'summarize', agent: SUMMARIZER };
  const backend: BackendConfig = opts.backend ?? { type: 'subscription' };
  const model = (backend.type === 'connection' ? backend.model : undefined) ?? opts.model ?? 'sonnet';
  const tools = ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob'];
  let deleted = 0;
  const remove: CustomTool = {
    name: 'delete_note',
    description: 'Delete a note that became redundant (its content merged into another note). README.md stays.',
    params: { path: { type: 'string', description: 'The note, relative to the brain folder, e.g. "old-decisions.md".' } },
    run: (a) => {
      const rel = String(a.path ?? '').trim();
      if (rel === 'README.md') throw new Error('README.md is the index of the brain and stays');
      const file = notePath(opts.repo, rel);
      if (!existsSync(file)) throw new Error(`${rel} not found`);
      rmSync(file);
      deleted += 1;
      return `Deleted ${rel}.`;
    },
  };
  const prompt = `Compress the project brain in ${dir} (your working folder): ${notes.length} note(s), ${Math.round(before / 102.4) / 10} KB.

Every team member reads these notes before it works, so every word costs tokens on every run. Rewrite them to say the same in far fewer words:
- Keep every durable fact a future member needs: decisions and their reasons, conventions, gotchas, how parts work, names, paths, commands, numbers. When in doubt, keep the fact and cut the words around it.
- Cut repetition, filler, narrative, examples that teach nothing new and progress reports. Where two notes contradict each other, keep the newer or more specific statement.
- Prefer terse bullet points to prose. Keep one "# Title" heading per note.
- Merge notes on the same topic into one and delete the rest with delete_note.
- Keep README.md as the index: one line per note.
- Aim for at most half the current size, without losing a fact.

Notes:
${notes.map((n) => `- ${n.path} (${n.size} bytes): ${n.title}`).join('\n')}

When you are done, say in two or three lines what you merged, deleted and shortened.`;

  const built = await (opts.backends ?? plainBackends).resolve(backend, opts.env ?? process.env);
  store.append(runId, { type: 'step.started', step: 'summarize', data: { loop: 0, notes: notes.length, bytes: before } });
  store.append(runId, { ...base, type: 'agent.started', data: { model, backend: backend.type, via: built.via, cwd: dir, resumed: false } });
  const { eventSink, finishedData } = await import('./engine.js');
  const agent: AgentConfig = { name: SUMMARIZER, prompt: '', model, ...(opts.effort ? { effort: opts.effort } : {}), tools, canMessage: [], canRequest: [], backend, limits: { max_turns: 80, timeout_min: 30 }, writes: true, skills: [], plugins: [], browser: false, app: false };
  const result = await opts.runner.run({
    agentName: SUMMARIZER,
    prompt,
    systemPrompt: `You maintain the project brain: a folder of Markdown notes about a project that every member of its agent team reads. You work only in ${dir}, with file tools.`,
    cwd: dir,
    model,
    effort: opts.effort,
    tools,
    env: built.env,
    pricing: built.pricing,
    maxTurns: agent.limits.max_turns,
    settingSources: [],
    signal: opts.signal ?? AbortSignal.timeout(agent.limits.timeout_min * 60_000),
    canMessage: [],
    customTools: [remove],
    checkToolUse: makeToolChecker({ root: dir, cwd: dir, writeScope: ['**/*.md'] }),
    sendMessage: () => 'Messaging is not available here.',
    onEvent: eventSink(store, runId, base, { model, via: built.via }),
  });
  store.append(runId, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result, built.via) });
  if (!result.ok) {
    // A half-rewritten brain is worse than the long one: put it back as it was.
    await git(dir, ['reset', '-q', '--hard', 'HEAD']);
    await git(dir, ['clean', '-q', '-fd']);
    store.append(runId, { type: 'step.finished', step: 'summarize', data: { output: { text: `Failed, and the brain was left as it was: ${result.error}` }, agents: [SUMMARIZER] } });
    throw new BrainError(result.error ?? 'the summarizer failed');
  }
  const after = brainSize(opts.repo);
  const commit = await commitBrain(opts.repo, `Summarized the brain: ${Math.round(before / 1024)} KB to ${Math.round(after / 1024)} KB${deleted ? `, ${deleted} note(s) merged away` : ''}`, SUMMARIZER);
  if (commit) store.append(runId, { ...base, type: 'brain.updated', data: { commit, before_bytes: before, after_bytes: after } });
  store.append(runId, { type: 'step.finished', step: 'summarize', data: { output: { text: result.text, before_bytes: before, after_bytes: after, deleted }, agents: [SUMMARIZER] } });
  return { before, after, commit };
}
