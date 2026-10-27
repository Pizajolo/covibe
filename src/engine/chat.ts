import type { AgentConfig, TeamConfig } from '../config/types.js';
import type { EventStore } from '../events/store.js';
import type { RunRecord } from '../events/types.js';
import { backendEnv, type Env } from '../runner/backend.js';
import type { AgentRunner } from '../runner/types.js';
import { buildInvocation, finishedData, newRunId } from './engine.js';
import { Workspace } from './workspace.js';

export type ChatOutcome =
  | { mode: 'queued'; messageId: number }
  | { mode: 'replied'; text: string; ok: boolean; error?: string };

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite']);

/** The agent as it may act in a question session: same role and model, no tools that change anything. */
export function readOnly(agent: AgentConfig): AgentConfig {
  return { ...agent, tools: agent.tools.filter((t) => READ_ONLY_TOOLS.has(t)), writes: false, writeScope: [], canMessage: [] };
}

/**
 * Talk to one agent of a run. The rule is fixed so state is never ambiguous:
 * while the run is live the message is queued and delivered at the start of
 * the agent's next turn; once the run has ended, the agent's session is
 * resumed and it answers now (and any files it changes are merged into the
 * run's branch, inside its write scope). In a question ("ask") session the
 * agent stays read-only.
 */
export async function chat(opts: {
  store: EventStore;
  runner: AgentRunner;
  team: TeamConfig;
  runId: string;
  agent: string;
  message: string;
  env?: Env;
}): Promise<ChatOutcome> {
  const { store, team, runId } = opts;
  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const configured = team.agents[opts.agent];
  if (!configured) throw new Error(`team ${team.name} has no agent "${opts.agent}"`);
  const agent = run.kind === 'ask' ? readOnly(configured) : configured;

  if (store.isLive(run)) {
    const m = store.enqueue(runId, agent.name, 'human', opts.message);
    store.append(runId, { type: 'message.queued', agent: agent.name, step: 'chat', data: { id: m.id, to: agent.name, from: 'human', text: opts.message } });
    return { mode: 'queued', messageId: m.id };
  }

  const session = store.getSession(runId, agent.name);
  if (!session) throw new Error(`${agent.name} has not run yet in ${runId}, so there is no session to resume`);

  // Messages teammates sent after the run ended are delivered now as well.
  const pending = store.drainInbox(runId, agent.name);
  const prompt = pending.length
    ? `${pending.map((m) => `[message from ${m.from}] ${m.text}`).join('\n')}\n\n[message from human] ${opts.message}`
    : opts.message;
  store.append(runId, { type: 'chat.message', agent: agent.name, step: 'chat', data: { from: 'human', to: agent.name, text: opts.message } });

  const isolation = run.branch ? 'worktree' : 'none';
  const workspace = Workspace.attach(run.repo, runId, isolation, run.branch);
  return converse({ store, runner: opts.runner, team, run, agent, prompt, cwd: session.cwd, resume: session.sessionId, env: opts.env, workspace });
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
}): Promise<{ runId: string; done: Promise<ChatOutcome> }> {
  const configured = opts.team.agents[opts.agent];
  if (!configured) throw new Error(`team ${opts.team.name} has no agent "${opts.agent}"`);
  const agent = readOnly(configured);
  const run = opts.store.createRun({ id: newRunId(), kind: 'ask', team: opts.team.name, teamFile: opts.team.file, repo: opts.repo, goal: opts.question });
  opts.store.append(run.id, { type: 'run.started', data: { team: opts.team.name, goal: opts.question, kind: 'ask', agent: agent.name, isolation: 'none', steps: [] } });
  opts.store.append(run.id, { type: 'chat.message', agent: agent.name, step: 'chat', data: { from: 'human', to: agent.name, text: opts.question } });
  const prompt = `${opts.question}\n\n(You are answering a question about this repository. You can read but not change anything.)`;
  const done = converse({ store: opts.store, runner: opts.runner, team: opts.team, run, agent, prompt, cwd: opts.repo, env: opts.env }).finally(() => {
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
  workspace?: Workspace;
}): Promise<ChatOutcome> {
  const { store, run, agent } = p;
  const { env } = backendEnv(agent.backend, p.env ?? process.env);
  const base = { step: 'chat', agent: agent.name };
  store.append(run.id, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: agent.backend.type, cwd: p.cwd, resumed: !!p.resume, chat: true } });

  const result = await p.runner.run(
    buildInvocation(p.team, store, run.id, agent, {
      cwd: p.cwd,
      root: run.branch ? p.cwd : run.repo,
      prompt: p.prompt,
      resume: p.resume,
      env,
      step: 'chat',
      signal: AbortSignal.timeout(agent.limits.timeout_min * 60_000),
    }),
  );
  if (result.sessionId) store.saveSession(run.id, agent.name, result.sessionId, p.cwd);
  store.append(run.id, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result) });

  if (result.ok && agent.writes && p.workspace) {
    const c = await p.workspace.collect(agent.name, agent.writeScope, `chat: ${agent.name}`);
    if (c.reverted.length) store.append(run.id, { ...base, type: 'scope.violation', data: { files: c.reverted, scope: agent.writeScope ?? null } });
    if (c.commit) store.append(run.id, { ...base, type: 'git.commit', data: { commit: c.commit, files: c.files } });
    if (c.merged) store.append(run.id, { ...base, type: 'git.merge', data: { into: run.branch } });
  }
  return { mode: 'replied', text: result.text, ok: result.ok, error: result.error };
}
