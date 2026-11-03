// A summary step (`{ id: report, summary: true }`): covibe writes the run's
// summary for the human from what the run already has, without a member or a
// model. A member writing it would resume its whole session (for a planner on
// Opus, everything it read while planning) just to restate the reports.
//
// Everything comes from the run's event log, so a continued run's summary
// covers its earlier part too.
import type { RunEvent } from '../events/types.js';
import type { BoardTask } from './tasks.js';

type Obj = Record<string, unknown>;
type Ev = Pick<RunEvent, 'type' | 'step' | 'agent' | 'data'>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const one = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** How many files, tasks, decisions or open items the summary lists before saying how many more. */
const LIST = 40;

function list<T>(items: T[], line: (t: T) => string): string {
  const shown = items.slice(0, LIST).map(line);
  if (items.length > LIST) shown.push(`- … and ${items.length - LIST} more`);
  return shown.join('\n');
}

/** A member's report in one line: its summary or text, or else its numbers and how many items its lists hold. */
export function reportLine(value: unknown): string {
  if (typeof value === 'string') return one(value, 500);
  if (!isObj(value)) return value === undefined || value === null ? '' : one(JSON.stringify(value), 300);
  for (const k of ['summary', 'text', 'result', 'message']) if (typeof value[k] === 'string' && (value[k] as string).trim()) return one(value[k] as string, k === 'text' ? 700 : 500);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k} ${v}`);
    else if (typeof v === 'string' && v.length <= 80) parts.push(`${k}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
    if (parts.length >= 8) break;
  }
  return parts.join(' · ');
}

/** Items the reports left open but that did not block: findings with a severity that is not blocking. */
function openItems(value: unknown, by: string, out: string[]) {
  if (!isObj(value)) return;
  for (const v of Object.values(value)) {
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      if (!isObj(item) || typeof item.severity !== 'string' || typeof item.message !== 'string') continue;
      if (/^(blocking|critical|high|error)$/i.test(item.severity)) continue;
      const where = typeof item.file === 'string' ? `${item.file}: ` : '';
      const owner = typeof item.owner === 'string' ? ` (${item.owner})` : '';
      out.push(`- ${where}${one(item.message, 300)}${owner}, from ${by}`);
    }
  }
}

export interface SummaryInput {
  goal: string;
  events: Ev[];
  tasks: BoardTask[];
  /** The planning step, whose report is the plan. */
  planStep?: string;
  /** The summary step itself (and later steps are left out). */
  step: string;
  loops: number;
  costUsd: number;
}

/** The run's summary, as Markdown. */
export function writeSummary(p: SummaryInput): string {
  const reports = new Map<string, { output: unknown; parallel: boolean; agents: string[] }>();
  const gates = new Map<string, { gate: string; passed: boolean }>();
  const files = new Map<string, Set<string>>();
  const asked = new Map<number, { from: string; question: string }>();
  const decisions: string[] = [];
  const requests: string[] = [];
  let selected: { members: string[]; skipped: string[]; reason?: string } | undefined;
  let rounds = p.loops;

  for (const e of p.events) {
    const d = e.data;
    switch (e.type) {
      case 'step.finished':
        if (e.step && e.step !== p.step) reports.set(e.step, { output: d.output, parallel: !!d.parallel, agents: (d.agents as string[]) ?? [] });
        break;
      case 'gate.passed':
      case 'gate.failed':
        if (e.step) gates.set(e.step, { gate: String(d.gate ?? ''), passed: e.type === 'gate.passed' });
        break;
      case 'loop.goto':
        rounds = Math.max(rounds, Number(d.loop ?? 0));
        break;
      case 'git.commit':
      case 'files.changed':
        for (const f of (d.files as string[] | undefined) ?? []) files.set(f, (files.get(f) ?? new Set()).add(e.agent ?? 'someone'));
        break;
      case 'members.selected':
        selected = { members: (d.members as string[]) ?? [], skipped: (d.skipped as string[]) ?? [], ...(typeof d.reason === 'string' ? { reason: d.reason } : {}) };
        break;
      case 'question.asked':
        asked.set(Number(d.id), { from: e.agent ?? 'a member', question: String(d.question ?? '') });
        break;
      case 'question.answered': {
        const q = asked.get(Number(d.id));
        decisions.push(`- ${q?.from ?? e.agent ?? 'A member'} asked "${one(q?.question ?? '', 200)}". ${d.by === 'human' ? 'You' : String(d.by)} answered: ${one(String(d.answer ?? ''), 300)}`);
        break;
      }
      case 'request.done':
        if (d.ok) requests.push(`- ${e.agent} asked ${String(d.to)} for work: ${one(String(d.reply ?? ''), 200)}`);
        break;
    }
  }

  const out: string[] = ['# Summary', `**Goal:** ${one(p.goal, 600)}`];
  const plan = p.planStep ? reports.get(p.planStep)?.output : undefined;
  if (isObj(plan) && typeof plan.summary === 'string') out.push(`**Plan:** ${one(plan.summary, 800)}`);

  if (p.tasks.length) {
    const done = p.tasks.filter((t) => t.status === 'done').length;
    out.push(`## Tasks (${done} of ${p.tasks.length} done)`, list(p.tasks, (t) => `- [${t.status}] ${t.id}: ${t.title}${t.owner ? ` (${t.owner})` : ''}${t.note ? ` — ${one(t.note, 200)}` : ''}`));
  }

  const work: string[] = [];
  const open: string[] = [];
  for (const [step, r] of reports) {
    if (step === p.planStep) continue;
    const entries: [string, unknown][] = r.parallel && isObj(r.output) ? Object.entries(r.output) : [[r.agents[0] ?? step, r.output]];
    for (const [agent, report] of entries) {
      const line = reportLine(report);
      if (line) work.push(`- **${agent}** (${step}): ${line}`);
      openItems(report, agent, open);
    }
  }
  if (work.length) out.push('## What was done', work.join('\n'));

  if (files.size) out.push(`## Files changed (${files.size})`, list([...files.entries()], ([f, by]) => `- ${f} (${[...by].join(', ')})`));
  else out.push('## Files changed', 'None.');

  const checks = [...gates.entries()].map(([step, g]) => `- ${step}: ${g.passed ? 'passed' : 'failed'} (\`${g.gate}\`)`);
  if (checks.length || rounds) out.push('## Checks', [...checks, ...(rounds ? [`- ${rounds} fix round${rounds > 1 ? 's' : ''}`] : [])].join('\n'));

  if (selected?.skipped.length) out.push('## Members left out', `${selected.skipped.join(', ')}${selected.reason ? `: ${selected.reason}` : ''}`);
  if (decisions.length) out.push('## Decisions on the way', list(decisions, (x) => x));
  if (requests.length) out.push('## Help between members', list(requests, (x) => x));

  const unfinished = p.tasks.filter((t) => t.status !== 'done');
  const later = [...unfinished.map((t) => `- ${t.id} ${t.title} is ${t.status}${t.note ? `: ${one(t.note, 200)}` : ''}`), ...open];
  if (later.length) out.push('## Left for later', list(later, (x) => x));

  out.push(`Estimated cost: $${p.costUsd.toFixed(2)}. Written by covibe from the reports, without a model.`);
  return out.join('\n\n');
}
