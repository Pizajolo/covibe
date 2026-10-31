import type { AgentConfig, TeamConfig } from '../config/types.js';
import type { EventStore } from '../events/store.js';
import type { DeliveryMode, RunRecord } from '../events/types.js';
import { startMcpProxy } from '../connections/mcp-proxy.js';
import type { Connections } from '../connections/store.js';
import type { Env } from '../runner/backend.js';
import type { AgentRunner } from '../runner/types.js';
import { accountOf, buildInvocation, collectEvents, finishedData, isBalanced, newRunId, resolverOf, writersOf } from './engine.js';
import { readOnly } from './scope.js';
import { Workspace } from './workspace.js';
import { attachmentNote, type Attachment } from './attachments.js';

export type ChatOutcome =
  | { mode: 'queued'; messageId: number; delivery: DeliveryMode }
  | { mode: 'replied'; text: string; ok: boolean; error?: string };

/**
 * Talk to one agent of a run. The rule is fixed so state is never ambiguous:
 * while the run is live the message is queued and delivered at the start of
 * the agent's next turn; once the run has ended, the agent's session is
 * resumed and it answers now (and any files it changes are merged into the
 * run's branch, inside its write scope). In a question ("ask") session, or a
 * backlog goal's check, the agent stays read-only.
 */
export async function chat(opts: {
  store: EventStore;
  runner: AgentRunner;
  team: TeamConfig;
  runId: string;
  agent: string;
  message: string;
  env?: Env;
  connections?: Connections;
  /** For a live run: wait for its next turn (default), steer it while it works, or interrupt it. */
  delivery?: DeliveryMode;
  /** Files sent with the message, already in the run's folder (see attachments.ts). */
  attachments?: Attachment[];
}): Promise<ChatOutcome> {
  const { store, team, runId } = opts;
  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const configured = team.agents[opts.agent];
  if (!configured) throw new Error(`team ${team.name} has no agent "${opts.agent}"`);
  // A question, or a backlog goal's check, stays read-only in follow-ups.
  const agent = run.kind === 'ask' || run.kind === 'check' ? readOnly(configured) : configured;

  const files = opts.attachments ?? [];
  // The member reads the message with where its files are; the log keeps them apart.
  const text = withFiles(opts.message, files);
  const attached = files.length ? { attachments: files } : {};
  if (store.isLive(run)) {
    const delivery = opts.delivery ?? 'queue';
    const m = store.enqueue(runId, agent.name, 'human', text, delivery);
    store.append(runId, { type: 'message.queued', agent: agent.name, step: 'chat', data: { id: m.id, to: agent.name, from: 'human', text: opts.message, mode: delivery, ...attached } });
    return { mode: 'queued', messageId: m.id, delivery };
  }

  const session = store.getSession(runId, agent.name);
  if (!session) throw new Error(`${agent.name} has not run yet in ${runId}, so there is no session to resume`);

  // Messages teammates sent after the run ended are delivered now as well.
  const pending = store.drainInbox(runId, agent.name);
  const prompt = pending.length
    ? `${pending.map((m) => `[message from ${m.from}] ${m.text}`).join('\n')}\n\n[message from human] ${text}`
    : text;
  store.append(runId, { type: 'chat.message', agent: agent.name, step: 'chat', data: { from: 'human', to: agent.name, text: opts.message, ...attached } });

  const isolation = run.branch ? 'worktree' : 'none';
  const workspace = await Workspace.attach(run.repo, runId, isolation, run.branch, writersOf(team));
  await workspace.restore(session.cwd);
  return converse({ store, runner: opts.runner, team, run, agent, prompt, cwd: session.cwd, resume: session.sessionId, env: opts.env, connections: opts.connections, workspace });
}

/**
 * Ask one agent of a team a question about a repository, without running the
 * workflow. The agent works read-only in the repository itself. The answer
 * starts a session you can continue with `chat`.
 */
export async function ask(opts: {
  store: EventStore;
  runner: AgentRunner;
  team: TeamConfig;
  repo: string;
  agent: string;
  question: string;
  env?: Env;
  connections?: Connections;
  /** Files sent with the question: placed in the new run's folder (see attachments.ts). */
  attach?: (runId: string) => Attachment[];
}): Promise<{ runId: string; done: Promise<ChatOutcome> }> {
  const configured = opts.team.agents[opts.agent];
  if (!configured) throw new Error(`team ${opts.team.name} has no agent "${opts.agent}"`);
  const agent = readOnly(configured);
  const id = newRunId();
  const files = opts.attach?.(id) ?? [];
  const attached = files.length ? { attachments: files } : {};
  const run = opts.store.createRun({ id, kind: 'ask', team: opts.team.name, teamFile: opts.team.file, repo: opts.repo, goal: opts.question });
  opts.store.append(run.id, { type: 'run.started', data: { team: opts.team.name, goal: opts.question, kind: 'ask', agent: agent.name, isolation: 'none', steps: [], ...attached } });
  opts.store.append(run.id, { type: 'chat.message', agent: agent.name, step: 'chat', data: { from: 'human', to: agent.name, text: opts.question, ...attached } });
  const prompt = `${withFiles(opts.question, files)}\n\n(You are answering a question about this repository. You can read but not change anything.)`;
  const done = converse({ store: opts.store, runner: opts.runner, team: opts.team, run, agent, prompt, cwd: opts.repo, env: opts.env, connections: opts.connections }).finally(() => {
    const status = opts.store.events(run.id).some((e) => e.type === 'agent.error') ? 'failed' : 'succeeded';
    opts.store.finishRun(run.id, status);
    opts.store.append(run.id, { type: 'run.finished', data: { status, loops: 0, cost_usd: null } });
  });
  return { runId: run.id, done };
}

async function converse(p: {
  store: EventStore;
  runner: AgentRunner;
  team: TeamConfig;
  run: RunRecord;
  agent: AgentConfig;
  prompt: string;
  cwd: string;
  resume?: string;
  env?: Env;
  connections?: Connections;
  workspace?: Workspace;
}): Promise<ChatOutcome> {
  const { store, run, agent } = p;
  await startMcpProxy().catch(() => undefined);
  const account = isBalanced(agent, p.connections) ? await p.connections!.pick() : undefined;
  const built = await resolverOf(p.connections).resolve(account ? { ...agent.backend, account } : agent.backend, p.env ?? process.env);
  const base = { step: 'chat', agent: agent.name };
  store.append(run.id, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: agent.backend.type, via: built.via, cwd: p.cwd, resumed: !!p.resume, chat: true } });

  const inv = buildInvocation(p.team, store, run.id, agent, {
    repo: run.repo,
    cwd: p.cwd,
    root: run.branch ? p.cwd : run.repo,
    folder: !!p.workspace?.folder,
    prompt: p.prompt,
    resume: p.resume,
    env: built.env,
    pricing: built.pricing,
    account: accountOf(built),
    via: built.via,
    step: 'chat',
    signal: AbortSignal.timeout(agent.limits.timeout_min * 60_000),
  });
  const result = await p.runner.run(inv).finally(() => inv.onControl?.(null));
  if (result.sessionId) store.saveSession(run.id, agent.name, result.sessionId, p.cwd);
  store.append(run.id, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result, built.via) });

  if (result.ok && agent.writes && p.workspace) {
    const c = await p.workspace.collect(agent.name, agent.writeScope, `chat: ${agent.name}`);
    for (const e of collectEvents(c, agent, run.branch)) store.append(run.id, { ...base, ...e });
  }
  return { mode: 'replied', text: result.text, ok: result.ok, error: result.error };
}

/** A message with where the files sent with it are. */
export function withFiles(message: string, files: Attachment[]): string {
  return files.length ? `${message}\n\n${attachmentNote(files, 'with this message')}` : message;
}
