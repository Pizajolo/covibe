// Pure functions from the event stream to what the UI shows. Nothing here
// talks to SDKs or git; everything is derived from stored events.
import type { RunEvent, RunRecord } from '../events/types.js';
import type { AgentState, BoardCard, ChatItem, RunSummary, Stats, StepState, UsageWindow } from './api-types.js';

type D = Record<string, any>;

function tokensOf(d: D): number {
  const t = d.tokens as D | null | undefined;
  return t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : 0;
}

export function toolLabel(tool: string, input: unknown): string {
  const i = (input ?? {}) as D;
  const pick = i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.path ?? i.url ?? i.to;
  if (pick === undefined) return tool.replace(/^mcp__team__/, '');
  const shown = String(pick).replace(/\S*\/\.covibe\/worktrees\/[^/\s]+\/[^/\s]+\/?/g, '').replace(/\s+/g, ' ').trim();
  return `${tool.replace(/^mcp__team__/, '')} ${shown.length > 90 ? shown.slice(0, 89) + '…' : shown}`;
}

export function summarizeRun(run: RunRecord, events: RunEvent[], project: { id: string; name: string }, live: boolean, teamAgents: string[] = []): RunSummary {
  const agents = new Map<string, AgentState>();
  const agent = (name: string) => {
    let a = agents.get(name);
    if (!a) {
      a = { name, status: 'idle', invocations: 0, turns: 0, costUsd: 0, tokens: 0, inbox: 0 };
      agents.set(name, a);
    }
    return a;
  };
  for (const n of teamAgents) agent(n);

  const stepOrder: string[] = [];
  const steps = new Map<string, StepState>();
  const step = (id: string) => {
    let s = steps.get(id);
    if (!s) {
      s = { id, status: 'pending', rounds: 0, cards: [] };
      steps.set(id, s);
      if (!stepOrder.includes(id)) stepOrder.push(id);
    }
    return s;
  };

  let loops = 0;
  let maxLoops: number | undefined;
  let costUsd = 0;
  let tokens = 0;
  let errors = 0;
  let reason: string | undefined;
  const files = new Set<string>();
  const openCards = new Map<string, BoardCard>();

  for (const e of events) {
    const d = e.data as D;
    switch (e.type) {
      case 'run.started':
        for (const id of (d.steps as string[]) ?? []) step(id);
        break;
      case 'run.finished':
        reason = d.reason;
        break;
      case 'step.started': {
        const s = step(e.step!);
        s.status = 'running';
        s.rounds += 1;
        break;
      }
      case 'step.finished':
        if (step(e.step!).status === 'running') step(e.step!).status = 'done';
        break;
      case 'step.skipped':
        if (e.agent) step(e.step!).cards.push({ agent: e.agent, round: loops, status: 'skipped', costUsd: 0, summary: 'no task for this agent' });
        break;
      case 'gate.passed':
        step(e.step!).status = 'passed';
        step(e.step!).gate = d.gate;
        break;
      case 'gate.failed':
        step(e.step!).status = 'failed';
        step(e.step!).gate = d.gate;
        break;
      case 'loop.goto':
        loops = d.loop;
        maxLoops = d.max_loops;
        // Steps from the goto target on will run again.
        for (const id of stepOrder.slice(stepOrder.indexOf(d.to))) if (step(id).status !== 'failed') step(id).status = 'pending';
        break;
      case 'agent.started': {
        const a = agent(e.agent!);
        a.status = 'working';
        a.step = e.step;
        a.activity = d.resumed ? 'resuming…' : 'starting…';
        a.invocations += 1;
        a.updatedAt = e.ts;
        if (e.step && e.step !== 'chat') {
          const card: BoardCard = { agent: e.agent!, round: loops, status: 'working', costUsd: 0 };
          step(e.step).cards.push(card);
          openCards.set(e.agent!, card);
        }
        break;
      }
      case 'agent.tool': {
        const a = agent(e.agent!);
        a.activity = toolLabel(String(d.tool), d.input);
        a.updatedAt = e.ts;
        break;
      }
      case 'agent.text': {
        const a = agent(e.agent!);
        a.lastText = String(d.text).slice(0, 400);
        a.updatedAt = e.ts;
        const card = openCards.get(e.agent!);
        if (card) card.summary = String(d.text).slice(0, 200);
        break;
      }
      case 'agent.finished':
      case 'agent.error': {
        const a = agent(e.agent!);
        const failed = e.type === 'agent.error';
        a.status = failed ? 'error' : 'done';
        a.activity = failed ? `failed: ${d.error}` : undefined;
        a.turns += d.turns ?? 0;
        a.costUsd += d.cost_usd ?? 0;
        a.tokens += tokensOf(d);
        a.updatedAt = e.ts;
        costUsd += d.cost_usd ?? 0;
        tokens += tokensOf(d);
        if (failed) errors += 1;
        const card = openCards.get(e.agent!);
        if (card) {
          card.status = failed ? 'error' : 'done';
          card.costUsd = d.cost_usd ?? 0;
          if (failed) card.summary = String(d.error);
          openCards.delete(e.agent!);
        }
        break;
      }
      case 'message.queued':
        agent(d.to).inbox += 1;
        break;
      case 'message.delivered':
        agent(e.agent!).inbox = Math.max(0, agent(e.agent!).inbox - 1);
        break;
      case 'git.commit':
        for (const f of (d.files as string[]) ?? []) files.add(f);
        break;
    }
  }

  // A run that is no longer live cannot have working agents.
  if (!live) for (const a of agents.values()) if (a.status === 'working') a.status = 'error';
  if (live) for (const a of agents.values()) if (a.status !== 'working' && a.inbox > 0) a.status = 'waiting';

  const status = run.status === 'running' && !live ? 'failed' : run.status;
  return {
    id: run.id,
    projectId: project.id,
    projectName: project.name,
    kind: run.kind,
    team: run.team,
    goal: run.goal,
    status,
    reason: reason ?? (run.status === 'running' && !live ? 'interrupted' : undefined),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    branch: run.branch,
    base: run.base,
    loops,
    maxLoops,
    costUsd,
    tokens,
    errors,
    agents: [...agents.values()],
    steps: stepOrder.map((id) => steps.get(id)!),
    filesChanged: [...files].sort(),
  };
}

/** One conversation per agent: your messages, its replies, and compact tool notes. */
export function chatThreads(events: RunEvent[]): Record<string, ChatItem[]> {
  const threads: Record<string, ChatItem[]> = {};
  const push = (agent: string, item: ChatItem) => (threads[agent] ??= []).push(item);
  const pending = new Map<number, ChatItem>();
  let lastStep: Record<string, string | undefined> = {};

  for (const e of events) {
    const d = e.data as D;
    const base = { id: e.id, ts: e.ts, step: e.step };
    if (e.type === 'chat.message' && d.from === 'human') push(d.to, { ...base, kind: 'human', text: d.text });
    else if (e.type === 'message.queued') {
      const from = d.from ?? e.agent;
      const item: ChatItem = { ...base, kind: from === 'human' ? 'human' : 'note', text: from === 'human' ? d.text : `Message from ${from}: ${d.text}`, pending: true };
      push(d.to, item);
      pending.set(d.id, item);
    } else if (e.type === 'message.delivered') {
      const item = pending.get(d.id);
      if (item) item.pending = false;
    } else if (e.type === 'agent.started' && e.agent) {
      if (e.step !== 'chat' && lastStep[e.agent] !== `${e.step}`) push(e.agent, { ...base, kind: 'note', text: `Started step "${e.step}"` });
      lastStep[e.agent] = e.step;
    } else if (e.type === 'agent.text' && e.agent) push(e.agent, { ...base, kind: 'agent', text: d.text });
    else if (e.type === 'agent.tool' && e.agent) push(e.agent, { ...base, kind: 'tool', text: toolLabel(String(d.tool), d.input) });
    else if (e.type === 'scope.denied' && e.agent) push(e.agent, { ...base, kind: 'error', text: `Blocked: ${d.reason}` });
    else if (e.type === 'agent.error' && e.agent) push(e.agent, { ...base, kind: 'error', text: `Failed: ${d.error}` });
  }
  return threads;
}

const DAY = 86_400_000;

export function computeStats(
  sources: { runs: RunRecord[]; events: RunEvent[]; live: (r: RunRecord) => boolean; activeAgents: number }[],
  now = new Date(),
): Stats {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayKey = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const daily = new Map<string, { day: string; costUsd: number; tokens: number; runs: number }>();
  for (let i = 13; i >= 0; i--) {
    const k = dayKey(startOfDay - i * DAY);
    daily.set(k, { day: k, costUsd: 0, tokens: 0, runs: 0 });
  }
  const stats: Stats = {
    costUsd: { today: 0, week: 0, month: 0, all: 0 },
    tokens: { today: 0, week: 0, all: 0, input: 0, output: 0, cacheRead: 0 },
    runs: { total: 0, running: 0, succeeded: 0, escalated: 0, failed: 0, questions: 0 },
    activeAgents: 0,
    daily: [],
    byAgent: [],
    byModel: [],
    byTeam: [],
    usage: [],
  };
  const byAgent = new Map<string, Stats['byAgent'][number]>();
  const byModel = new Map<string, Stats['byModel'][number]>();
  const byTeam = new Map<string, Stats['byTeam'][number]>();
  const usage = new Map<string, UsageWindow>();
  let gates = 0;
  let gatesPassed = 0;

  for (const src of sources) {
    stats.activeAgents += src.activeAgents;
    const teamOf = new Map(src.runs.map((r) => [r.id, r.team]));
    for (const r of src.runs) {
      if (r.kind === 'ask') stats.runs.questions += 1;
      else {
        stats.runs.total += 1;
        const st = r.status === 'running' && !src.live(r) ? 'failed' : r.status;
        stats.runs[st] += 1;
      }
      const t = byTeam.get(r.team) ?? { team: r.team, costUsd: 0, runs: 0 };
      t.runs += 1;
      byTeam.set(r.team, t);
      const day = daily.get(dayKey(Date.parse(r.startedAt)));
      if (day) day.runs += 1;
    }
    for (const e of src.events) {
      const d = e.data as D;
      if (e.type === 'gate.passed' || e.type === 'gate.failed') {
        gates += 1;
        if (e.type === 'gate.passed') gatesPassed += 1;
        continue;
      }
      if (e.type === 'usage.limit') {
        const key = String(d.window ?? 'plan');
        const prev = usage.get(key);
        if (!prev || prev.seenAt <= e.ts) usage.set(key, { window: key, status: d.status, utilization: d.utilization, resetsAt: d.resetsAt, seenAt: e.ts });
        continue;
      }
      if (e.type !== 'agent.finished' && e.type !== 'agent.error') continue;
      const t = Date.parse(e.ts);
      const cost = Number(d.cost_usd ?? 0);
      const tok = tokensOf(d);
      stats.costUsd.all += cost;
      stats.tokens.all += tok;
      stats.tokens.input += d.tokens?.input ?? 0;
      stats.tokens.output += d.tokens?.output ?? 0;
      stats.tokens.cacheRead += d.tokens?.cacheRead ?? 0;
      if (t >= startOfDay) {
        stats.costUsd.today += cost;
        stats.tokens.today += tok;
      }
      if (t >= startOfDay - 6 * DAY) {
        stats.costUsd.week += cost;
        stats.tokens.week += tok;
      }
      if (t >= startOfDay - 29 * DAY) stats.costUsd.month += cost;
      const day = daily.get(dayKey(t));
      if (day) {
        day.costUsd += cost;
        day.tokens += tok;
      }
      const team = teamOf.get(e.runId) ?? '?';
      const ak = `${team}/${e.agent}`;
      const a = byAgent.get(ak) ?? { agent: e.agent ?? '?', team, costUsd: 0, tokens: 0, turns: 0 };
      a.costUsd += cost;
      a.tokens += tok;
      a.turns += d.turns ?? 0;
      byAgent.set(ak, a);
      const model = String(d.model ?? 'default');
      const m = byModel.get(model) ?? { model, costUsd: 0, tokens: 0 };
      m.costUsd += cost;
      m.tokens += tok;
      byModel.set(model, m);
      const tm = byTeam.get(team);
      if (tm) tm.costUsd += cost;
    }
  }
  stats.daily = [...daily.values()];
  stats.byAgent = [...byAgent.values()].sort((a, b) => b.costUsd - a.costUsd);
  stats.byModel = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
  stats.byTeam = [...byTeam.values()].sort((a, b) => b.costUsd - a.costUsd);
  stats.usage = [...usage.values()].sort((a, b) => a.window.localeCompare(b.window));
  stats.gatePassRate = gates ? gatesPassed / gates : undefined;
  return stats;
}
