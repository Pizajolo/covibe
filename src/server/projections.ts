// Pure functions from the event stream to what the UI shows. Nothing here
// talks to SDKs or git; everything is derived from stored events.
import type { RunEvent, RunRecord } from '../events/types.js';
import { QUESTION_STEP } from '../engine/questions.js';
import type { PlanUsage } from '../runner/types.js';
import type { AgentState, AppNotification, BoardCard, ChatItem, NotificationKind, NotifyChoice, QuestionView, RunSummary, Stats, StepState, UsageReport, UsageWindow } from './api-types.js';

type D = Record<string, any>;

function tokensOf(d: D): number {
  const t = d.tokens as D | null | undefined;
  return t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : 0;
}

/** Worktree paths (…/worktrees/[<repo>/]<run-id>/<agent>/) shown relative to the worktree. */
export const WORKTREE_PATH = /\S*\/worktrees\/(?:[^/\s]+\/)?\d{8}-\d{6}-[0-9a-f]{4}\/[^/\s]+\/?/g;

export function shortenPaths(text: string, roots: string[] = []): string {
  let out = text.replace(WORKTREE_PATH, '');
  for (const r of roots) if (r) out = out.split(r.endsWith('/') ? r : `${r}/`).join('').split(r).join('.');
  return out;
}

export function toolLabel(tool: string, input: unknown, roots: string[] = []): string {
  const i = (input ?? {}) as D;
  const pick = i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.path ?? i.url ?? i.query ?? i.to;
  if (pick === undefined) return tool.replace(/^mcp__team__/, '');
  const shown = shortenPaths(String(pick), roots).replace(/\s+/g, ' ').trim();
  return `${tool.replace(/^mcp__team__/, '')} ${shown.length > 90 ? shown.slice(0, 89) + '…' : shown}`;
}

export function summarizeRun(
  run: RunRecord,
  events: RunEvent[],
  project: { id: string; name: string },
  live: boolean,
  teamAgents: string[] = [],
  /** Members answering a chat right now (after the run itself ended). */
  busy: Set<string> = new Set(),
): RunSummary {
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

  /** member → the running totals of its turn in progress */
  const liveUsage = new Map<string, { costUsd: number; tokens: number }>();
  let loops = 0;
  let maxLoops: number | undefined;
  let costUsd = 0;
  let tokens = 0;
  let errors = 0;
  let reason: string | undefined;
  const files = new Set<string>();
  let worktreesRemoved = false;
  const openCards = new Map<string, BoardCard>();
  const questions = new Map<number, QuestionView>();
  let paused = false;
  let limitEnd: { resetsAt?: string } | undefined;
  /** member → its last limit stop, until it starts again */
  const limited = new Map<string, { resetsAt?: string; until?: string; waiting: boolean }>();
  let restart: RunSummary['restart'];
  /** lead → the member whose question it is answering */
  const answeringFor = new Map<string, string>();

  for (const e of events) {
    const d = e.data as D;
    switch (e.type) {
      case 'run.started':
        for (const id of (d.steps as string[]) ?? []) step(id);
        break;
      case 'run.finished':
        reason = d.reason;
        if (d.limit) limitEnd = { resetsAt: d.limit.resets_at ?? undefined };
        break;
      case 'run.restart_scheduled':
        restart = { at: d.at };
        break;
      case 'run.restart_cancelled':
        restart = undefined;
        break;
      case 'run.restarted':
        restart = { runId: d.run_id };
        break;
      case 'agent.limited': {
        const a = agent(e.agent!);
        liveUsage.delete(e.agent!);
        a.status = 'limited';
        a.turns += d.turns ?? 0;
        a.costUsd += d.cost_usd ?? 0;
        a.tokens += tokensOf(d);
        costUsd += d.cost_usd ?? 0;
        tokens += tokensOf(d);
        if (d.switched_to) {
          // Sharing accounts: it moves on to another one right away.
          a.status = 'working';
          a.activity = `limit reached; continuing on the ${d.switched_to === 'main' ? 'main' : d.switched_to} account`;
          a.updatedAt = e.ts;
          const open = openCards.get(e.agent!);
          if (open) open.costUsd += d.cost_usd ?? 0;
          break;
        }
        a.limitedUntil = d.until ?? undefined;
        a.activity = d.waiting ? "waiting for the plan's limit to reset" : "stopped by the plan's limit";
        a.updatedAt = e.ts;
        limited.set(e.agent!, { resetsAt: d.resets_at ?? undefined, until: d.until ?? undefined, waiting: !!d.waiting });
        const card = openCards.get(e.agent!);
        if (card) {
          card.costUsd += d.cost_usd ?? 0;
          card.summary = d.waiting ? "waiting for the plan's limit to reset" : "stopped by the plan's limit";
          if (!d.waiting) {
            card.status = 'error';
            openCards.delete(e.agent!);
          }
        }
        break;
      }
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
        liveUsage.delete(e.agent!);
        a.status = 'working';
        a.limitedUntil = undefined;
        limited.delete(e.agent!);
        if (e.step !== QUESTION_STEP) a.step = e.step;
        a.activity = e.step === QUESTION_STEP && answeringFor.has(e.agent!) ? `answering ${answeringFor.get(e.agent!)}'s question` : d.resumed ? 'resuming…' : 'starting…';
        a.invocations += 1;
        a.updatedAt = e.ts;
        a.browser = undefined;
        if (e.step && e.step !== 'chat' && e.step !== QUESTION_STEP) {
          const card: BoardCard = { agent: e.agent!, round: loops, status: 'working', costUsd: 0 };
          step(e.step).cards.push(card);
          openCards.set(e.agent!, card);
        }
        break;
      }
      case 'agent.tool': {
        const a = agent(e.agent!);
        a.activity = toolLabel(String(d.tool), d.input, [run.repo]);
        a.updatedAt = e.ts;
        if (d.browser) a.browser = { url: d.browser.url ?? a.browser?.url, since: a.browser?.since ?? e.ts };
        break;
      }
      case 'agent.view': {
        const a = agent(e.agent!);
        a.lastView = d.id;
        a.views = (a.views ?? 0) + 1;
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
      case 'agent.usage':
        // The running total of the turn in progress; counted at the end unless the turn finishes first.
        liveUsage.set(e.agent!, { costUsd: d.cost_usd ?? 0, tokens: tokensOf(d) });
        break;
      case 'agent.finished':
      case 'agent.error': {
        const a = agent(e.agent!);
        liveUsage.delete(e.agent!);
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
      case 'workspace.cleaned':
        worktreesRemoved = true;
        break;
      case 'question.asked': {
        const toLead = d.to !== 'human';
        questions.set(d.id, { id: d.id, from: e.agent!, status: toLead ? 'lead' : 'open', question: d.question, context: d.context ?? undefined, options: d.options ?? undefined, lead: toLead ? d.to : undefined, askedAt: e.ts });
        if (toLead) answeringFor.set(d.to, e.agent!);
        const a = agent(e.agent!);
        a.waitingOn = d.to;
        a.activity = `asked ${toLead ? d.to : 'you'}: ${String(d.question).slice(0, 80)}`;
        a.updatedAt = e.ts;
        break;
      }
      case 'question.escalated': {
        const q = questions.get(d.id);
        if (q) Object.assign(q, { status: 'open', forHuman: d.question, leadNote: d.reason ?? undefined, options: d.options ?? undefined });
        if (d.from) agent(d.from).waitingOn = 'human';
        break;
      }
      case 'question.answered': {
        const q = questions.get(d.id);
        if (q) Object.assign(q, { status: 'answered', answer: d.answer, answeredBy: d.by });
        const a = agent(e.agent!);
        a.waitingOn = undefined;
        a.activity = `got an answer from ${d.by === 'human' ? 'you' : d.by}`;
        a.updatedAt = e.ts;
        break;
      }
      case 'run.paused':
        paused = true;
        break;
      case 'run.resumed':
        paused = false;
        break;
    }
    // A chat after cleanup restores the member's worktree.
    if (e.type === 'agent.started' && e.step === 'chat') worktreesRemoved = false;
  }

  // Turns still running count with their latest running totals.
  for (const [name, u] of liveUsage) {
    const a = agent(name);
    a.costUsd += u.costUsd;
    a.tokens += u.tokens;
    costUsd += u.costUsd;
    tokens += u.tokens;
    const card = openCards.get(name);
    if (card) card.costUsd += u.costUsd;
  }

  // Members waiting for the limit, or what stopped the run.
  let limit: RunSummary['limit'];
  if (live && [...limited.values()].some((l) => l.waiting)) {
    const waiting = [...limited.entries()].filter(([, l]) => l.waiting);
    const until = waiting.map(([, l]) => l.until).filter((u): u is string => !!u).sort()[0];
    limit = { waiting: true, until, resetsAt: waiting.map(([, l]) => l.resetsAt).find(Boolean), agents: waiting.map(([n]) => n) };
  } else if (!live && (limitEnd || limited.size)) {
    limit = { waiting: false, resetsAt: limitEnd?.resetsAt ?? [...limited.values()].map((l) => l.resetsAt).find(Boolean), agents: [...limited.keys()] };
  }

  // A run that is no longer live cannot have working agents or open questions.
  if (!live) {
    paused = false;
    for (const q of questions.values()) if (q.status === 'lead' || q.status === 'open') q.status = 'cancelled';
    for (const a of agents.values()) {
      a.waitingOn = undefined;
      a.limitedUntil = undefined;
      if ((a.status === 'working' || a.status === 'limited') && !busy.has(a.name)) a.status = 'error';
    }
  }
  if (live) {
    for (const a of agents.values()) {
      if (a.waitingOn) a.status = 'asking';
      else if (a.status !== 'working' && a.status !== 'limited' && a.inbox > 0) a.status = 'waiting';
    }
  }

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
    worktreesRemoved,
    paused,
    questions: [...questions.values()],
    ...(limit ? { limit } : {}),
    ...(restart ? { restart } : {}),
  };
}

/** One conversation per agent: your messages, its replies, and compact tool notes. */
export function chatThreads(events: RunEvent[], roots: string[] = []): Record<string, ChatItem[]> {
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
      const item: ChatItem = {
        ...base,
        kind: from === 'human' ? 'human' : 'note',
        text: from === 'human' ? d.text : `Message from ${from}: ${d.text}`,
        pending: true,
        delivery: d.mode ?? 'queue',
      };
      push(d.to, item);
      pending.set(d.id, item);
    } else if (e.type === 'message.delivered') {
      const item = pending.get(d.id);
      if (item) item.pending = false;
      if (item?.kind === 'human' && d.live) push(e.agent!, { ...base, kind: 'note', text: d.mode === 'interrupt' ? 'Stopped what it was doing to read your message' : 'Read your message while working' });
    } else if (e.type === 'agent.started' && e.agent) {
      if (e.step !== 'chat' && lastStep[e.agent] !== `${e.step}`) push(e.agent, { ...base, kind: 'note', text: `Started step "${e.step}"` });
      lastStep[e.agent] = e.step;
    } else if (e.type === 'agent.text' && e.agent) push(e.agent, { ...base, kind: 'agent', text: d.text });
    else if (e.type === 'agent.tool' && e.agent) push(e.agent, { ...base, kind: 'tool', text: toolLabel(String(d.tool), d.input, roots) });
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
    tokens: { today: 0, week: 0, all: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    runs: { total: 0, running: 0, succeeded: 0, escalated: 0, failed: 0, questions: 0 },
    activeAgents: 0,
    daily: [],
    byAgent: [],
    byModel: [],
    byTeam: [],
    byVia: [],
    usage: [],
  };
  const byAgent = new Map<string, Stats['byAgent'][number]>();
  const byModel = new Map<string, Stats['byModel'][number]>();
  const byTeam = new Map<string, Stats['byTeam'][number]>();
  const byVia = new Map<string, Stats['byVia'][number]>();
  const usage = new Map<string, UsageWindow>();
  let gates = 0;
  let gatesPassed = 0;

  /** Count one member turn's spend and tokens: a finished one, or the running total of one in progress. */
  const tally = (e: RunEvent, teamOf: Map<string, string>) => {
    const d = e.data as D;
    const t = Date.parse(e.ts);
    const cost = Number(d.cost_usd ?? 0);
    const tok = tokensOf(d);
    stats.costUsd.all += cost;
    stats.tokens.all += tok;
    stats.tokens.input += d.tokens?.input ?? 0;
    stats.tokens.output += d.tokens?.output ?? 0;
    stats.tokens.cacheRead += d.tokens?.cacheRead ?? 0;
    stats.tokens.cacheWrite += d.tokens?.cacheWrite ?? 0;
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
    // Turns from before connections existed ran on your login (or what the team file said).
    const via = typeof d.via === 'string' ? d.via : 'claude';
    const v = byVia.get(via) ?? { via, label: via, costUsd: 0, tokens: 0, turns: 0 };
    v.costUsd += cost;
    v.tokens += tok;
    v.turns += d.turns ?? 0;
    byVia.set(via, v);
  };

  for (const src of sources) {
    stats.activeAgents += src.activeAgents;
    const teamOf = new Map(src.runs.map((r) => [r.id, r.team]));
    const live = new Map<string, RunEvent>();
    for (const r of src.runs) {
      if (r.kind === 'ask') stats.runs.questions += 1;
      else if (r.kind === 'workflow') {
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
        const window = String(d.window ?? 'plan');
        const account = typeof d.account === 'string' && d.account !== 'main' ? d.account : undefined;
        const key = `${account ?? 'main'}/${window}`;
        const prev = usage.get(key);
        if (!prev || prev.seenAt <= e.ts) usage.set(key, { window, ...(account ? { account } : {}), status: d.status, utilization: d.utilization, resetsAt: d.resetsAt, seenAt: e.ts });
        continue;
      }
      // A turn in progress counts with its latest running total until its end event replaces it.
      const turnKey = `${e.runId}/${e.agent}`;
      if (e.type === 'agent.usage') {
        live.set(turnKey, e);
        continue;
      }
      if (e.type !== 'agent.finished' && e.type !== 'agent.error' && e.type !== 'agent.limited') continue;
      live.delete(turnKey);
      tally(e, teamOf);
    }
    for (const e of live.values()) tally(e, teamOf);
  }
  stats.daily = [...daily.values()];
  stats.byAgent = [...byAgent.values()].sort((a, b) => b.costUsd - a.costUsd);
  stats.byModel = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
  stats.byTeam = [...byTeam.values()].sort((a, b) => b.costUsd - a.costUsd);
  stats.byVia = [...byVia.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
  stats.usage = [...usage.values()].sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.window.localeCompare(b.window));
  stats.gatePassRate = gates ? gatesPassed / gates : undefined;
  return stats;
}

/** The events notifications come from. */
export const NOTIFY_EVENTS = ['question.asked', 'question.escalated', 'question.answered', 'usage.limit', 'agent.limited', 'run.finished'];

const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage',
};

/**
 * What the bell lists, newest first: questions for you, plan limits coming
 * close or reached, and workflow runs that stopped, failed or finished. Kinds
 * switched off for both the bell and system notifications are left out.
 */
export function collectNotifications(
  sources: { projectId: string; events: RunEvent[]; run: (id: string) => RunRecord | undefined; live: (r: RunRecord) => boolean }[],
  settings: Record<NotificationKind, NotifyChoice>,
  limit = 50,
): AppNotification[] {
  const out: AppNotification[] = [];
  const limits = new Set<string>();
  for (const src of sources) {
    const answered = new Set(src.events.filter((e) => e.type === 'question.answered').map((e) => Number((e.data as D).id)));
    for (const e of src.events) {
      const d = e.data as D;
      const run = src.run(e.runId);
      const base = { id: `${src.projectId}:${e.id}`, ts: e.ts, projectId: src.projectId, runId: e.runId, goal: run?.goal };
      const add = (kind: NotificationKind, n: Omit<AppNotification, 'id' | 'ts' | 'projectId' | 'runId' | 'kind' | 'bell' | 'push'>) => {
        const choice = settings[kind];
        if (choice.bell || choice.push) out.push({ ...base, kind, ...n, bell: choice.bell, push: choice.push });
      };
      if (e.type === 'question.escalated' || (e.type === 'question.asked' && d.to === 'human')) {
        const id = Number(d.id);
        const from = e.type === 'question.escalated' ? String(d.from) : e.agent;
        add('question', { title: `${from} asks you`, body: String(d.question), questionId: id, open: !answered.has(id) && !!run && src.live(run) });
      } else if (e.type === 'usage.limit' && (d.status === 'allowed_warning' || d.status === 'rejected')) {
        // Every member reports the same window; one notification per window, state and reset.
        const account = typeof d.account === 'string' && d.account !== 'main' ? d.account : undefined;
        const key = `${account ?? 'main'}/${d.window}/${d.status}/${d.resetsAt}`;
        if (limits.has(key)) continue;
        limits.add(key);
        const name = `${account ? `${account} account's ` : ''}${LIMIT_WINDOWS[String(d.window)] ?? 'plan'}`;
        const used = typeof d.utilization === 'number' ? Math.round(d.utilization > 1 ? d.utilization : d.utilization * 100) : undefined;
        add('limit', {
          title: d.status === 'rejected' ? `Reached your ${name} limit` : `Close to your ${name} limit`,
          body: d.status === 'rejected' ? `Members on ${account ? 'this account' : 'your subscription'} wait until it resets, or move to another account when you share them.` : used !== undefined ? `${used}% used.` : undefined,
        });
      } else if (e.type === 'agent.limited' && d.waiting) {
        // One per run and reset: every member that hits the limit reports it.
        const key = `${e.runId}/${d.resets_at}`;
        if (limits.has(key)) continue;
        limits.add(key);
        add('limit', { title: 'Waiting for the plan limit to reset', body: run ? `${run.goal}: continues on its own${d.until ? ' after the reset' : ''}.` : undefined });
      } else if (e.type === 'run.finished' && run?.kind === 'workflow') {
        if (d.status === 'succeeded') add('done', { title: 'Job done', body: run.goal });
        else if (d.limit) add('stopped', { title: 'Stopped by the plan limit', body: run.goal });
        else if (d.status === 'escalated') add('stopped', { title: 'Stopped: out of fix rounds', body: run.goal });
        else if (d.reason === 'aborted') add('stopped', { title: 'Run stopped', body: run.goal });
        else add('error', { title: 'Run failed', body: d.reason ? `${run.goal}: ${d.reason}` : run.goal });
      }
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

const USAGE_LABELS: Record<string, string> = {
  five_hour: '5-hour session',
  seven_day: 'Weekly (all models)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly (incl. extra usage)',
  overage: 'Extra usage',
};

/** A reset time as ISO: Claude Code reports seconds (or milliseconds) since the epoch on turns, ISO from /usage. */
export function resetIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}

/**
 * The plan's limits: what Claude Code reports when asked (like /usage), and
 * otherwise the last values members' turns reported. A window whose reset
 * time has passed counts as fresh.
 */
export function usageReport(plan: PlanUsage | undefined, allFromRuns: UsageWindow[], now = new Date(), account = 'main'): UsageReport {
  const fromRuns = allFromRuns.filter((u) => (u.account ?? 'main') === account);
  const status = new Map(fromRuns.map((u) => [u.window, u]));
  const fresh = (resetsAt: string | undefined) => !resetsAt || Date.parse(resetsAt) > now.getTime();
  if (plan?.available) {
    return {
      source: 'claude',
      subscription: plan.subscription,
      windows: plan.windows.map((w) => {
        const turn = status.get(w.window);
        const resetsAt = resetIso(w.resetsAt);
        return {
          window: w.window,
          label: w.label,
          utilization: w.utilization === null ? undefined : w.utilization / 100,
          resetsAt,
          status: turn && fresh(resetIso(turn.resetsAt)) && resetIso(turn.resetsAt) === resetsAt ? turn.status : undefined,
        };
      }),
      extra: plan.extra,
      checkedAt: now.toISOString(),
    };
  }
  const windows = fromRuns
    .map((u) => ({ u, resetsAt: resetIso(u.resetsAt) }))
    .filter(({ resetsAt }) => fresh(resetsAt))
    .map(({ u, resetsAt }) => ({
      window: u.window,
      label: USAGE_LABELS[u.window] ?? u.window,
      utilization: typeof u.utilization === 'number' ? (u.utilization > 1 ? u.utilization / 100 : u.utilization) : undefined,
      resetsAt,
      status: u.status,
    }));
  return { source: windows.length ? 'runs' : 'none', subscription: plan?.subscription, windows, checkedAt: now.toISOString() };
}
