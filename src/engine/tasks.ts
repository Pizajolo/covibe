// The run's todo list: the tasks the planner wrote, each for one member, and
// where each one stands (open, being worked on, done, blocked). The plan's
// report fills it (any step report with a tasks[] list), or the planner writes
// it with the plan_tasks tool. Members mark progress with update_task; the
// engine also marks a member's tasks as worked on while its step runs and done
// when it hands the step in. Everything is kept as events, so the board can be
// rebuilt from a run's log (to continue it, or to show it).
import type { NewEvent } from '../events/types.js';
import type { CustomTool } from '../runner/types.js';

export type TaskStatus = 'open' | 'working' | 'done' | 'blocked';
export const TASK_STATUSES: TaskStatus[] = ['open', 'working', 'done', 'blocked'];

export interface BoardTask {
  id: string;
  /** The member it is for. */
  owner?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** The last word on it: why it is blocked, what was done. */
  note?: string;
}

export const PLAN_TASKS_TOOL = 'plan_tasks';
export const UPDATE_TASK_TOOL = 'update_task';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The task list in a step's report: its tasks[] when they are objects (with a title, a description or an owner) or plain strings. */
export function planTasksOf(output: unknown): unknown[] | undefined {
  if (!isObj(output) || !Array.isArray(output.tasks) || !output.tasks.length) return undefined;
  const ok = output.tasks.every((t) => typeof t === 'string' || (isObj(t) && (text(t.title) ?? text(t.description) ?? text(t.name) ?? text(t.owner))));
  return ok ? output.tasks : undefined;
}

/** A plan's tasks as the board keeps them: an id each (T1, T2… when they have none), an owner when it names one. */
export function normalizeTasks(raw: unknown[]): Omit<BoardTask, 'status'>[] {
  const seen = new Set<string>();
  return raw.map((t, i) => {
    const o: Obj = isObj(t) ? t : { title: String(t) };
    let id = text(o.id) ?? (typeof o.id === 'number' ? String(o.id) : `T${i + 1}`);
    while (seen.has(id)) id = `${id}'`;
    seen.add(id);
    const description = text(o.description) ?? text(o.details);
    const title = text(o.title) ?? text(o.name) ?? (description ? clip(description.split('\n')[0]!, 160) : `Task ${id}`);
    const owner = text(o.owner) ?? text(o.agent) ?? text(o.assignee) ?? text(o.member);
    return { id, title, ...(owner ? { owner } : {}), ...(description && description !== title ? { description } : {}) };
  });
}

/**
 * Replay a run's task events into its board. `live` false: a run that is no
 * longer going has nobody working on anything, so those tasks read as open.
 */
export function replayBoard(events: { type: string; ts?: string; agent?: string | null; data: Record<string, unknown> }[], live = true): (BoardTask & { updatedAt?: string; by?: string })[] {
  const board = new Map<string, BoardTask & { updatedAt?: string; by?: string }>();
  for (const e of events) {
    if (e.type === 'tasks.planned') {
      const before = new Map(board);
      board.clear();
      for (const t of (e.data.tasks as Omit<BoardTask, 'status'>[]) ?? []) {
        const was = before.get(t.id);
        board.set(t.id, { ...t, status: was?.status ?? 'open', ...(was?.note ? { note: was.note } : {}), updatedAt: was?.updatedAt ?? e.ts, by: was?.by });
      }
    } else if (e.type === 'task.updated') {
      const t = board.get(String(e.data.id));
      if (!t) continue;
      t.status = e.data.status as TaskStatus;
      if (typeof e.data.note === 'string') t.note = e.data.note;
      t.updatedAt = e.ts;
      t.by = e.agent ?? undefined;
    }
  }
  const out = [...board.values()];
  if (!live) for (const t of out) if (t.status === 'working') t.status = 'open';
  return out;
}

/** The board of a running workflow; every change goes out as an event. */
export class TaskBoard {
  private readonly tasks = new Map<string, BoardTask>();

  constructor(
    private readonly emit: (e: NewEvent) => void,
    initial: BoardTask[] = [],
  ) {
    for (const t of initial) this.tasks.set(t.id, { ...t, status: t.status === 'working' ? 'open' : t.status });
  }

  get list(): BoardTask[] {
    return [...this.tasks.values()];
  }

  get size(): number {
    return this.tasks.size;
  }

  get(id: string): BoardTask | undefined {
    return this.tasks.get(id);
  }

  /** Set the todo list from a plan. Tasks that keep their id keep where they stand. */
  plan(raw: unknown[], by: { step?: string; agent?: string }, source: 'report' | 'tool'): BoardTask[] {
    const tasks = normalizeTasks(raw);
    const before = new Map(this.tasks);
    this.tasks.clear();
    for (const t of tasks) {
      const was = before.get(t.id);
      this.tasks.set(t.id, { ...t, status: was?.status ?? 'open', ...(was?.note ? { note: was.note } : {}) });
    }
    this.emit({ ...by, type: 'tasks.planned', data: { tasks, source } });
    return this.list;
  }

  /** Change where tasks stand (only those that change are reported). */
  set(ids: string[], status: TaskStatus, by: { step?: string; agent?: string }, note?: string, auto = false): void {
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (!t || (t.status === status && (note === undefined || note === t.note))) continue;
      t.status = status;
      if (note !== undefined) t.note = note;
      this.emit({ ...by, type: 'task.updated', data: { id, status, ...(note !== undefined ? { note } : {}), ...(auto ? { auto: true } : {}) } });
    }
  }

  /** The tasks of a member. */
  owned(agent: string): BoardTask[] {
    return this.list.filter((t) => t.owner === agent);
  }

  /** The board's tasks a step's task value hands a member (by id, or by title when the plan gave no ids). */
  match(value: unknown): string[] {
    const found = new Set<string>();
    const byTitle = new Map(this.list.map((t) => [t.title, t.id]));
    const visit = (v: unknown, depth: number) => {
      if (depth > 3) return;
      if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
      else if (isObj(v)) {
        const id = text(v.id) ?? (typeof v.id === 'number' ? String(v.id) : undefined);
        const title = text(v.title);
        if (id && this.tasks.has(id) && (!title || this.tasks.get(id)!.title === title || !byTitle.has(title))) found.add(id);
        else if (title && byTitle.has(title)) found.add(byTitle.get(title)!);
        else for (const x of Object.values(v)) if (Array.isArray(x) || isObj(x)) visit(x, depth + 1);
      }
    };
    visit(value, 0);
    return [...found];
  }
}

/** The todo list as a member reads it at the start of a turn. */
export function boardPrompt(board: TaskBoard, agent: string, canUpdate: boolean): string | undefined {
  if (!board.size) return undefined;
  const mine = board.owned(agent);
  const line = (t: BoardTask) => `- [${t.status}] ${t.id}: ${t.title}${t.owner && t.owner !== agent ? ` (${t.owner})` : ''}${t.note ? ` — ${t.note}` : ''}`;
  const parts = ['## Todo list'];
  if (mine.length) parts.push(`Your tasks:\n${mine.map(line).join('\n')}`);
  const others = board.list.filter((t) => t.owner !== agent);
  if (others.length) parts.push(`${mine.length ? 'The rest of the team' : 'The team'}:\n${others.map(line).join('\n')}`);
  if (canUpdate) parts.push(`Keep your tasks current with ${UPDATE_TASK_TOOL}: "working" when you start one, "done" when it is finished, "blocked" (with a note why) when you cannot finish it. People watch this list live.`);
  return parts.join('\n\n');
}

/** For the planner: write the run's todo list, each task for one member. */
export function planTasksTool(board: TaskBoard, members: { name: string; description?: string }[], by: { step: string; agent: string }): CustomTool {
  const names = members.map((m) => m.name);
  return {
    name: PLAN_TASKS_TOOL,
    description: `Write the run's todo list: the tasks the goal breaks into, each for one member (${members.map((m) => (m.description ? `${m.name}: ${m.description}` : m.name)).join('; ')}). People watch it live as members work through it. Calling it again replaces the list; tasks that keep their id keep their progress.`,
    params: {
      tasks: {
        type: 'list',
        description: `One line per task: "<owner>: <title>", e.g. "${names[0] ?? 'builder'}: Add the login form". The owner is one of ${names.join(', ')}. Order them as they should be done.`,
      },
    },
    run: (a) => {
      const lines = (Array.isArray(a.tasks) ? a.tasks : []).map((x) => String(x).trim()).filter(Boolean);
      if (!lines.length) throw new Error('the list is empty');
      const raw = lines.map((l, i) => {
        const m = /^([^:]{1,60}):\s*(.+)$/s.exec(l);
        const owner = m && names.includes(m[1]!.trim()) ? m[1]!.trim() : undefined;
        return { id: `T${i + 1}`, title: owner ? m![2]!.trim() : l, ...(owner ? { owner } : {}) };
      });
      const unowned = raw.filter((t) => !t.owner).length;
      const list = board.plan(raw, by, 'tool');
      return `The todo list has ${list.length} task(s)${unowned ? `; ${unowned} name no member (start a line with one of ${names.join(', ')} and a colon)` : ''}:\n${list.map((t) => `- ${t.id} (${t.owner ?? 'nobody'}): ${t.title}`).join('\n')}`;
    },
  };
}

/** For members: mark where a task stands. Members change their own tasks; the lead any. */
export function updateTaskTool(board: TaskBoard, agent: string, isLead: boolean, step: string): CustomTool {
  return {
    name: UPDATE_TASK_TOOL,
    description: `Mark where a task on the run's todo list stands, so people watching see progress live: "working" when you start it, "done" when it is finished, "blocked" with a note when you cannot finish it, "open" to hand it back.${isLead ? ' As the lead you may update any task.' : ' You update your own tasks.'}`,
    params: {
      id: { type: 'string', description: 'The task id, e.g. T2.' },
      status: { type: 'string', enum: TASK_STATUSES, description: 'Where it stands now.' },
      note: { type: 'string', optional: true, description: 'One line: what was done, or why it is blocked.' },
    },
    run: (a) => {
      const id = String(a.id ?? '').trim();
      const t = board.get(id);
      if (!t) throw new Error(`there is no task ${id || '(empty id)'}; the tasks are ${board.list.map((x) => x.id).join(', ') || 'none yet'}`);
      if (!isLead && t.owner && t.owner !== agent) throw new Error(`${id} is ${t.owner}'s task; update your own (${board.owned(agent).map((x) => x.id).join(', ') || 'you have none'})`);
      const status = String(a.status) as TaskStatus;
      if (!TASK_STATUSES.includes(status)) throw new Error(`status must be one of ${TASK_STATUSES.join(', ')}`);
      const note = typeof a.note === 'string' && a.note.trim() ? clip(a.note.trim(), 500) : undefined;
      board.set([id], status, { step, agent }, note);
      return `${id} is now ${status}.`;
    },
  };
}
