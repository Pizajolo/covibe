// The git helper: a chat about the project's own checkout, for when git gets
// in the way. It looks around freely (status, log, diff… run at once) and
// proposes everything that would change the repository, the files or a
// remote; the person runs or declines each proposal in the app. It may edit
// files only while they have merge conflicts, to resolve them.
import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentConfig, Effort } from '../config/types.js';
import { eventSink, finishedData, newRunId } from '../engine/engine.js';
import type { EventStore } from '../events/store.js';
import type { RunEvent } from '../events/types.js';
import { backendEnv, type Env } from '../runner/backend.js';
import type { AgentRunner, CustomTool } from '../runner/types.js';
import type { GitOverview, HelperItem } from './api-types.js';
import { gitOverview, gitRun, runCommand } from './gitops.js';
import { toolLabel } from './projections.js';

export const GIT_HELPER = 'git-helper';
/** How long a proposal waits for the person before it counts as declined. */
const DECISION_TIMEOUT_MS = 30 * 60_000;

const GUIDE = `You are the git helper in covibe, a desktop app where teams of Claude Code agents work on a software project. You help the person with git in their project's own checkout: explain what state it is in, fix what is stuck, and do what they ask (branches, merges, rebases, conflicts, stashes, remotes, history, pushing, pull requests).

# Your tools
- git: runs one git command in the repository (give the arguments after "git", no shell). Commands that only look (status, log, diff, show, branch --list, remote -v, stash list, fetch…) run at once. Anything that changes the repository, the files or a remote is shown to the person as a proposal with your reason; they run it or decline it, and you get the output either way. Propose one step at a time and wait for its result before the next.
- gh: the GitHub CLI, the same way (gh auth status, gh pr view… run at once; the rest is proposed).
- Read, Grep and Glob to read files. Edit and Write only for files that have merge conflicts right now, to resolve them; anything else is refused.

# How to work
- Look first: start from the repository state you are given and check what you need with read-only commands.
- Explain in plain words what is going on and what you propose, briefly. The person may not know git well.
- Prefer the safe way: keep their work. Stash or branch before anything risky. Never discard uncommitted changes, reset --hard, force-push, delete branches with unmerged work, or rewrite commits that are already pushed unless the person clearly wants it, and say plainly what would be lost.
- Use --force-with-lease, never --force. Do not change global git config unless asked.
- Commands run without a terminal: nothing can prompt for a password or open an editor (messages are kept as git writes them). When sign-in fails, explain how the person can fix it in their own terminal (gh auth login and gh auth setup-git for GitHub; ssh-add and ssh -T for SSH keys; a credential helper).
- Resolving conflicts: read both sides, edit the file to the right result (no conflict markers left), then propose git add for it, and the continue step when all are resolved. When it is unclear which side is right, ask.
- Keep answers short. Do not paste whole outputs back; say what matters.`;

/** git subcommands that only read (fetch only updates what is known about the remotes). */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file',
  'merge-base', 'for-each-ref', 'show-ref', 'show-branch', 'grep', 'name-rev', 'check-ignore', 'check-attr', 'count-objects', 'whatchanged',
  'range-diff', 'cherry', 'verify-commit', 'verify-tag', 'version', 'fetch', 'fsck', 'var', 'help', 'diff-tree', 'diff-index', 'diff-files',
]);
/** Options that make a reading command write a file or run a program. */
const UNSAFE_OPTION = /^(--output|--upload-pack|--receive-pack|--exec|--open-files-in-pager|-O|--ext-diff|--run|--config)(=|$)/;

/** Whether a git command (arguments after "git") only reads, so it can run without asking. */
export function gitReadsOnly(args: string[]): boolean {
  const [cmd, ...rest] = args;
  if (!cmd || cmd.startsWith('-')) return false;
  if (rest.some((a) => UNSAFE_OPTION.test(a))) return false;
  if (cmd === 'fetch' && rest.some((a) => a === '-u' || a.startsWith('--upload'))) return false;
  if (READ_ONLY_GIT.has(cmd)) return true;
  const flagsOnly = (allowed: RegExp) => rest.every((a) => allowed.test(a));
  switch (cmd) {
    case 'branch':
      return flagsOnly(/^(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|-l|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--format=.*|--sort=.*|--merged=.*|--contains=.*|--no-color|--color.*|--column.*|--no-column)$/);
    case 'tag':
      return rest.length === 0 || ((rest[0] === '-l' || rest[0] === '--list' || rest[0] === '-n') && rest.slice(1).every((a) => !a.startsWith('-d')));
    case 'remote':
      return rest.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0]!);
    case 'stash':
      return ['list', 'show'].includes(rest[0] ?? '');
    case 'config':
      return rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l|get)$/.test(a)) && !rest.some((a) => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section|set|unset)$/.test(a));
    case 'worktree':
      return rest[0] === 'list';
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show' || (!['expire', 'delete', 'exists'].includes(rest[0]!) && !rest[0]!.startsWith('-'));
    case 'notes':
      return ['list', 'show'].includes(rest[0] ?? '');
    case 'submodule':
      return rest.length === 0 || ['status', 'summary'].includes(rest[0]!);
    case 'lfs':
      return ['ls-files', 'status', 'env', 'version', 'locks'].includes(rest[0] ?? '');
    case 'bisect':
      return ['log', 'visualize', 'view'].includes(rest[0] ?? '');
    default:
      return false;
  }
}

/** gh commands that only read. */
export function ghReadsOnly(args: string[]): boolean {
  const [area, action] = args;
  if (area === 'auth') return action === 'status';
  if (area === 'pr' || area === 'issue') return ['view', 'list', 'status', 'checks', 'diff'].includes(action ?? '');
  if (area === 'repo') return action === 'view';
  if (area === 'run') return ['list', 'view'].includes(action ?? '');
  if (area === '--version' || area === 'version') return true;
  return false;
}

export type Decision = { run: boolean };

/** Proposals waiting for the person, in this app process. */
export class Approvals {
  private readonly pending = new Map<string, { runId: string; resolve: (d: Decision) => void }>();
  private seq = 0;

  /** Wait for the person's decision on a new proposal; declined when it waits too long or the signal aborts. */
  wait(runId: string, signal?: AbortSignal): { id: string; decision: Promise<Decision> } {
    const id = `${Date.now().toString(36)}-${++this.seq}`;
    const decision = new Promise<Decision>((resolve) => {
      const finish = (d: Decision) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(d);
      };
      const onAbort = () => finish({ run: false });
      const timer = setTimeout(onAbort, DECISION_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { runId, resolve: finish });
    });
    return { id, decision };
  }

  /** The person ran or declined a proposal. False when it is no longer waiting. */
  decide(runId: string, id: string, run: boolean): boolean {
    const p = this.pending.get(id);
    if (!p || p.runId !== runId) return false;
    p.resolve({ run });
    return true;
  }

  waiting(runId: string): string[] {
    return [...this.pending].filter(([, p]) => p.runId === runId).map(([id]) => id);
  }
}

export interface HelperStart {
  store: EventStore;
  runner: AgentRunner;
  approvals: Approvals;
  project: { id: string; name: string; path: string };
  message: string;
  runId?: string;
  model?: string;
  effort?: Effort;
  env?: Env;
  signal?: AbortSignal;
}

/** Start a conversation with the git helper (or continue one) and send a message. Returns at once; the reply streams as events. */
export async function gitHelp(opts: HelperStart): Promise<{ runId: string; done: Promise<void> }> {
  const { store, project } = opts;
  let run = opts.runId ? store.getRun(opts.runId) : undefined;
  if (opts.runId && !run) throw new Error(`git helper conversation ${opts.runId} not found`);
  if (!run) {
    run = store.createRun({ id: newRunId(), kind: 'git', team: project.id, teamFile: '', repo: project.path, goal: opts.message });
    store.append(run.id, { type: 'run.started', data: { kind: 'git', project: project.id, agent: GIT_HELPER, steps: [] } });
  } else store.reopenRun(run.id);
  const runId = run.id;
  const repo = project.path;
  const base = { step: 'chat', agent: GIT_HELPER };
  store.append(runId, { ...base, type: 'chat.message', data: { from: 'human', to: GIT_HELPER, text: opts.message } });

  const agent: AgentConfig = {
    name: GIT_HELPER,
    prompt: GUIDE,
    model: opts.model ?? 'sonnet',
    effort: opts.effort,
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    canMessage: [],
    canRequest: [],
    backend: { type: 'subscription' },
    limits: { max_turns: 60, timeout_min: 60 },
    writes: true,
    skills: [],
    browser: false,
  };
  // Files the helper may edit: the ones with conflicts, refreshed after every command it runs.
  let conflicts = new Set<string>();
  const refreshConflicts = async () => {
    const r = await runCommand(repo, ['diff', '--name-only', '--diff-filter=U', '-z'], { read: true });
    conflicts = new Set(r.stdout.split('\0').filter(Boolean));
  };
  await refreshConflicts();

  const session = store.getSession(runId, GIT_HELPER);
  const snapshot = await describe(repo).catch((err) => `(could not read the repository: ${(err as Error).message})`);
  const prompt = `${opts.message}\n\n<repository_state>\n${snapshot}\n</repository_state>`;
  const signal = AbortSignal.any([AbortSignal.timeout(agent.limits.timeout_min * 60_000), ...(opts.signal ? [opts.signal] : [])]);
  const { env } = backendEnv(agent.backend, opts.env ?? process.env);

  store.append(runId, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: 'subscription', cwd: repo, resumed: !!session, chat: true } });
  const done = opts.runner
    .run({
      agentName: GIT_HELPER,
      prompt,
      systemPrompt: `${GUIDE}\n\nThe repository is ${repo} (project "${project.name}"); it is your working folder.`,
      cwd: repo,
      resumeSessionId: session?.sessionId,
      model: agent.model,
      effort: agent.effort,
      tools: agent.tools,
      env,
      maxTurns: agent.limits.max_turns,
      settingSources: [],
      signal,
      canMessage: [],
      customTools: helperTools({ ...opts, runId, signal, afterChange: refreshConflicts }),
      checkToolUse: (tool, input) => {
        if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return undefined;
        const raw = (input as Record<string, unknown> | null)?.file_path ?? (input as Record<string, unknown> | null)?.notebook_path;
        if (typeof raw !== 'string') return `${tool}: missing file_path`;
        const rel = relative(repo, isAbsolute(raw) ? raw : resolve(repo, raw));
        if (rel.startsWith('..') || isAbsolute(rel)) return `${raw} is outside the repository.`;
        if (!conflicts.has(rel)) return `You may only edit files that have merge conflicts right now (${[...conflicts].join(', ') || 'none'}). Propose a git command or tell the person what to change instead.`;
        return undefined;
      },
      sendMessage: () => 'Messaging is not available here.',
      onEvent: eventSink(store, runId, base, { model: agent.model }),
    })
    .then((result) => {
      if (result.sessionId) store.saveSession(runId, GIT_HELPER, result.sessionId, repo);
      store.append(runId, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result) });
    })
    .catch((err) => {
      store.append(runId, { ...base, type: 'agent.error', data: { ok: false, error: (err as Error).message } });
    })
    .finally(() => store.finishRun(runId, 'succeeded'));
  return { runId, done };
}

function helperTools(opts: HelperStart & { runId: string; signal: AbortSignal; afterChange: () => Promise<void> }): CustomTool[] {
  const { store, runId, approvals, signal } = opts;
  const repo = opts.project.path;
  const base = { step: 'chat', agent: GIT_HELPER };
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

  const command = (program: 'git' | 'gh'): CustomTool => ({
    name: program,
    description:
      program === 'git'
        ? 'Run one git command in the repository: the arguments after "git", one per item (["log", "--oneline", "-5"]). Read-only commands run at once; anything that changes something is proposed to the person, who runs or declines it.'
        : 'Run one GitHub CLI command in the repository: the arguments after "gh". Read-only ones (auth status, pr view/list/status/checks…) run at once; the rest is proposed to the person.',
    params: {
      args: { type: 'list', description: `The arguments after "${program}", one per item.` },
      why: { type: 'string', optional: true, description: 'For a command that changes something: what it does and why, in a sentence the person can judge.' },
    },
    run: async (a) => {
      const args = Array.isArray(a.args) ? a.args.map(String) : [];
      if (!args.length) throw new Error('no arguments given');
      // Options before the subcommand (-C, -c, --git-dir…) could point git elsewhere or change how it runs.
      if (args[0]!.startsWith('-')) throw new Error(`start with the ${program} subcommand, without options before it; commands always run in this repository`);
      const why = typeof a.why === 'string' ? a.why.trim() : '';
      if (program === 'git' ? gitReadsOnly(args) : ghReadsOnly(args)) {
        const r = await gitRun(repo, args, program);
        store.append(runId, { ...base, type: 'git.ran', data: { id: null, auto: true, program, args, ok: r.ok, code: r.code, output: clip(r.output, 4000) } });
        return `exit code ${r.code}\n${clip(r.output, 30_000) || '(no output)'}`;
      }
      const { id, decision } = approvals.wait(runId, signal);
      store.append(runId, { ...base, type: 'git.proposed', data: { id, program, args, why: why || null } });
      const d = await decision;
      if (!d.run) {
        store.append(runId, { ...base, type: 'git.skipped', data: { id } });
        return 'The person did not run it. Ask what they would prefer, or suggest another way.';
      }
      const r = await gitRun(repo, args, program);
      await opts.afterChange().catch(() => undefined);
      store.append(runId, { ...base, type: 'git.ran', data: { id, program, args, ok: r.ok, code: r.code, output: clip(r.output, 4000) } });
      return `The person ran it. exit code ${r.code}\n${clip(r.output, 30_000) || '(no output)'}`;
    },
  });
  return [command('git'), command('gh')];
}

/** The repository's state in a few lines, for the helper. */
export async function describe(repo: string): Promise<string> {
  return describeOverview(await gitOverview(repo, 10));
}

export function describeOverview(o: GitOverview): string {
  const current = o.branches.find((b) => b.current);
  const lines = [
    o.detached ? `HEAD is detached at ${o.head?.slice(0, 7) ?? '?'} (not on a branch).` : `On branch ${o.branch}${o.head ? '' : ' (no commits yet)'}.`,
    current?.upstream
      ? `It tracks ${current.upstream}${current.gone ? ', which was deleted on the remote' : ''}: ${current.ahead} commit(s) to push, ${current.behind} to pull${o.fetchedAt ? ` (as of the last fetch, ${o.fetchedAt})` : ' (never fetched)'}.`
      : o.branch
        ? 'It does not track a remote branch.'
        : '',
    o.operation ? `In progress: ${o.operation.kind} (${o.operation.subject}). Conflicts: ${o.operation.conflicts.join(', ') || 'none left'}.` : '',
    o.files.length
      ? `Uncommitted changes (${o.files.length}): ${o.files
          .slice(0, 40)
          .map((f) => `${f.path} [${f.state}${f.staged ? ', staged' : ''}${f.staged && f.unstaged ? ' + unstaged' : ''}]`)
          .join('; ')}${o.files.length > 40 ? '; …' : ''}`
      : 'No uncommitted changes.',
    `Local branches: ${o.branches.filter((b) => !b.run).map((b) => b.name).join(', ') || 'none'}${o.branches.some((b) => b.run) ? ` (plus ${o.branches.filter((b) => b.run).length} covibe/… run result branches)` : ''}.`,
    o.remotes.length ? `Remotes: ${o.remotes.map((r) => `${r.name} ${r.url}`).join('; ')}.` : 'No remotes.',
    o.stashes.length ? `Stashes: ${o.stashes.map((s) => `${s.ref} ${s.message}`).join('; ')}.` : '',
    o.identity.name && o.identity.email ? `Commits are made as ${o.identity.name} <${o.identity.email}>.` : 'git has no user.name/user.email set, so commits fail until they are set.',
    o.defaultBranch ? `Default branch: ${o.defaultBranch}.` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** The conversation as the helper panel shows it: messages, replies, commands it ran and proposals. */
export function helperThread(events: RunEvent[], waiting: Set<string>): HelperItem[] {
  const items: HelperItem[] = [];
  const proposals = new Map<string, Extract<HelperItem, { kind: 'proposal' }>>();
  for (const e of events) {
    const d = e.data as Record<string, any>;
    const at = { id: e.id, ts: e.ts };
    if (e.type === 'chat.message' && d.from === 'human') items.push({ ...at, kind: 'human', text: String(d.text) });
    else if (e.type === 'agent.text') items.push({ ...at, kind: 'agent', text: String(d.text) });
    else if (e.type === 'agent.tool') {
      const tool = String(d.tool);
      // git and gh calls show up as their own items (git.ran / git.proposed).
      if (!/__(git|gh)$/.test(tool)) items.push({ ...at, kind: 'tool', text: toolLabel(tool, d.input) });
    } else if (e.type === 'scope.denied') items.push({ ...at, kind: 'note', text: `Not allowed: ${d.reason}` });
    else if (e.type === 'agent.error') items.push({ ...at, kind: 'error', text: String(d.error ?? 'failed') });
    else if (e.type === 'git.proposed') {
      const item = { ...at, kind: 'proposal' as const, proposal: String(d.id), program: d.program, args: d.args as string[], why: d.why ?? undefined, state: waiting.has(String(d.id)) ? ('waiting' as const) : ('expired' as const) };
      proposals.set(String(d.id), item);
      items.push(item);
    } else if (e.type === 'git.skipped') {
      const p = proposals.get(String(d.id));
      if (p) p.state = 'skipped';
    } else if (e.type === 'git.ran') {
      const p = d.id ? proposals.get(String(d.id)) : undefined;
      if (p) Object.assign(p, { state: 'ran', ok: d.ok, output: d.output });
      else items.push({ ...at, kind: 'command', program: d.program, args: d.args as string[], ok: !!d.ok, output: String(d.output ?? '') });
    }
  }
  return items;
}
