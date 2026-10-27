import type { TeamConfig } from '../config/types.js';
import type { EventStore } from '../events/store.js';
import { backendEnv, type Env } from '../runner/backend.js';
import type { AgentRunner } from '../runner/types.js';
import { buildInvocation } from './engine.js';
import { Workspace } from './workspace.js';

export type ChatOutcome =
  | { mode: 'queued'; messageId: number }
  | { mode: 'replied'; text: string; ok: boolean; error?: string };

/**
 * Talk to one agent of a run. The rule is fixed so state is never ambiguous:
 * while the run is live the message is queued and delivered at the start of
 * the agent's next turn; once the run has ended, the agent's session is
 * resumed and it answers now (and any files it changes are merged into the
 * run's branch, inside its write scope).
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
  const agent = team.agents[opts.agent];
  if (!agent) throw new Error(`team ${team.name} has no agent "${opts.agent}"`);

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

  const isolation = run.branch ? 'worktree' : 'none';
  const workspace = Workspace.attach(run.repo, runId, isolation, run.branch);
  const { env } = backendEnv(agent.backend, opts.env ?? process.env);
  const base = { step: 'chat', agent: agent.name };
  store.append(runId, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: agent.backend.type, cwd: session.cwd, resumed: true, chat: true } });

  const result = await opts.runner.run(
    buildInvocation(team, store, runId, agent, {
      cwd: session.cwd,
      root: isolation === 'none' ? run.repo : session.cwd,
      prompt,
      resume: session.sessionId,
      env,
      step: 'chat',
      signal: AbortSignal.timeout(agent.limits.timeout_min * 60_000),
    }),
  );
  if (result.sessionId) store.saveSession(runId, agent.name, result.sessionId, session.cwd);
  const finished = { ok: result.ok, turns: result.turns, cost_usd: result.costUsd, duration_ms: result.durationMs };
  store.append(runId, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: result.ok ? finished : { ...finished, error: result.error } });

  if (result.ok && agent.writes) {
    const c = await workspace.collect(agent.name, agent.writeScope, `chat: ${agent.name}`);
    if (c.reverted.length) store.append(runId, { ...base, type: 'scope.violation', data: { files: c.reverted, scope: agent.writeScope ?? null } });
    if (c.commit) store.append(runId, { ...base, type: 'git.commit', data: { commit: c.commit, files: c.files } });
    if (c.merged) store.append(runId, { ...base, type: 'git.merge', data: { into: run.branch } });
  }
  return { mode: 'replied', text: result.text, ok: result.ok, error: result.error };
}
