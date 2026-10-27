import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrainProposal, DeliveryMode, InboxMessage, NewEvent, ProposalStatus, Question, QuestionStatus, RunEvent, RunRecord, RunStatus } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  team_file TEXT NOT NULL,
  repo TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  branch TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  step TEXT,
  agent TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS sessions (
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  PRIMARY KEY (run_id, agent)
);
CREATE TABLE IF NOT EXISTS brain_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  note_path TEXT
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  from_agent TEXT NOT NULL,
  text TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL,
  for_human TEXT,
  lead_note TEXT,
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_run ON questions(run_id, status);
`;

type Row = Record<string, string | number | null>;
type Listener = (e: RunEvent) => void;

/** SQLite-backed store for runs, the event stream, agent sessions, inboxes and members' questions. */
export class EventStore {
  private db: DatabaseSync;
  private listeners = new Set<Listener>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets `covibe log --follow` and `covibe chat` read while a run writes.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // Columns added after the first release; ALTER is a no-op once present.
    const cols = new Set((this.db.prepare('PRAGMA table_info(runs)').all() as Row[]).map((r) => String(r.name)));
    if (!cols.has('kind')) this.db.exec("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'workflow'");
    if (!cols.has('base')) this.db.exec('ALTER TABLE runs ADD COLUMN base TEXT');
    const inboxCols = new Set((this.db.prepare('PRAGMA table_info(inbox)').all() as Row[]).map((r) => String(r.name)));
    if (!inboxCols.has('mode')) this.db.exec("ALTER TABLE inbox ADD COLUMN mode TEXT NOT NULL DEFAULT 'queue'");
    const questionCols = new Set((this.db.prepare('PRAGMA table_info(questions)').all() as Row[]).map((r) => String(r.name)));
    if (!questionCols.has('options')) this.db.exec('ALTER TABLE questions ADD COLUMN options TEXT');
  }

  close() {
    this.db.close();
  }

  createRun(run: Omit<RunRecord, 'status' | 'startedAt' | 'pid' | 'kind'> & { kind?: RunRecord['kind'] }): RunRecord {
    const record: RunRecord = { ...run, kind: run.kind ?? 'workflow', status: 'running', pid: process.pid, startedAt: now() };
    this.db
      .prepare(
        'INSERT INTO runs (id, kind, team, team_file, repo, goal, status, pid, started_at, branch, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.kind, record.team, record.teamFile, record.repo, record.goal, record.status, record.pid, record.startedAt, record.branch ?? null, record.base ?? null);
    return record;
  }

  /** Mark runs whose owning process died as failed, so they stop showing as live. */
  reapDeadRuns(): string[] {
    const dead = (this.db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as Row[]).map(toRun).filter((r) => !this.isLive(r));
    for (const r of dead) {
      this.cancelQuestions(r.id);
      this.finishRun(r.id, 'failed');
      this.append(r.id, { type: 'run.finished', data: { status: 'failed', reason: 'interrupted: the process running it exited', loops: null, cost_usd: null } });
    }
    return dead.map((r) => r.id);
  }

  /** Events of one type across all runs (stats). */
  eventsOfType(types: string[], since?: string): RunEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE type IN (${types.map(() => '?').join(',')}) AND ts >= ? ORDER BY id`)
      .all(...types, since ?? '') as Row[];
    return rows.map(toEvent);
  }

  /** Highest event id in the store (live feed cursor). */
  lastEventId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM events').get() as Row;
    return Number(row.id ?? 0);
  }

  /** Events of every run after a global cursor (live feed). */
  eventsAfter(afterId: number, limit = 500): RunEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as Row[]).map(toEvent);
  }

  /** Mark a run live again in this process (a design conversation getting a new message). */
  reopenRun(id: string) {
    this.db.prepare("UPDATE runs SET status = 'running', pid = ?, finished_at = NULL WHERE id = ?").run(process.pid, id);
  }

  finishRun(id: string, status: RunStatus) {
    this.db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(status, now(), id);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Accepts a full id or a unique prefix, like git. */
  findRun(idOrPrefix: string): RunRecord | undefined {
    const rows = this.db.prepare('SELECT * FROM runs WHERE id LIKE ? ORDER BY started_at DESC LIMIT 2').all(`${idOrPrefix}%`) as Row[];
    return rows.length === 1 ? toRun(rows[0]!) : this.getRun(idOrPrefix);
  }

  listRuns(limit = 20): RunRecord[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]).map(toRun);
  }

  /** A run is live only if its status says so and the process that owns it still exists. */
  isLive(run: RunRecord): boolean {
    if (run.status !== 'running') return false;
    if (run.pid === process.pid) return true;
    try {
      process.kill(run.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  append(runId: string, event: NewEvent): RunEvent {
    const ts = now();
    const result = this.db
      .prepare('INSERT INTO events (run_id, ts, type, step, agent, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, ts, event.type, event.step ?? null, event.agent ?? null, JSON.stringify(event.data));
    const full: RunEvent = { ...event, id: Number(result.lastInsertRowid), ts, runId };
    for (const l of this.listeners) l(full);
    return full;
  }

  /** In-process subscription (the CLI's live printer; later the SSE feed). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  events(runId: string, afterId = 0): RunEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id').all(runId, afterId) as Row[];
    return rows.map(toEvent);
  }

  saveSession(runId: string, agent: string, sessionId: string, cwd: string) {
    this.db
      .prepare(
        'INSERT INTO sessions (run_id, agent, session_id, cwd) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, agent) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd',
      )
      .run(runId, agent, sessionId, cwd);
  }

  getSession(runId: string, agent: string): { sessionId: string; cwd: string } | undefined {
    const row = this.db.prepare('SELECT session_id, cwd FROM sessions WHERE run_id = ? AND agent = ?').get(runId, agent) as Row | undefined;
    return row ? { sessionId: String(row.session_id), cwd: String(row.cwd) } : undefined;
  }

  enqueue(runId: string, to: string, from: string, text: string, mode: DeliveryMode = 'queue'): InboxMessage {
    const ts = now();
    const r = this.db.prepare('INSERT INTO inbox (run_id, to_agent, from_agent, text, ts, mode) VALUES (?, ?, ?, ?, ?, ?)').run(runId, to, from, text, ts, mode);
    return { id: Number(r.lastInsertRowid), runId, to, from, text, ts, mode };
  }

  /** Undelivered steer/interrupt messages for an agent that is working (not marked delivered). */
  liveMessages(runId: string, to: string): InboxMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE run_id = ? AND to_agent = ? AND delivered_at IS NULL AND mode IN ('steer', 'interrupt') ORDER BY id")
      .all(runId, to) as Row[];
    return rows.map((r) => toInbox(r, runId, to));
  }

  addProposal(p: { runId?: string; agent: string; title: string; content: string; reason?: string }): BrainProposal {
    const ts = now();
    const r = this.db
      .prepare('INSERT INTO brain_proposals (run_id, agent, title, content, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.runId ?? null, p.agent, p.title, p.content, p.reason ?? null, ts);
    return this.getProposal(Number(r.lastInsertRowid))!;
  }

  getProposal(id: number): BrainProposal | undefined {
    const row = this.db.prepare('SELECT * FROM brain_proposals WHERE id = ?').get(id) as Row | undefined;
    return row ? toProposal(row) : undefined;
  }

  proposals(status?: ProposalStatus, limit = 200): BrainProposal[] {
    const rows = status
      ? (this.db.prepare('SELECT * FROM brain_proposals WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit) as Row[])
      : (this.db.prepare('SELECT * FROM brain_proposals ORDER BY id DESC LIMIT ?').all(limit) as Row[]);
    return rows.map(toProposal);
  }

  decideProposal(id: number, d: { status: 'accepted' | 'rejected'; by: string; note?: string; notePath?: string }): BrainProposal {
    const current = this.getProposal(id);
    if (!current) throw new Error(`proposal #${id} not found`);
    if (current.status !== 'pending') throw new Error(`proposal #${id} was already ${current.status}`);
    this.db
      .prepare('UPDATE brain_proposals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, note_path = ? WHERE id = ?')
      .run(d.status, now(), d.by, d.note ?? null, d.notePath ?? null, id);
    return this.getProposal(id)!;
  }

  addQuestion(q: { runId: string; from: string; text: string; context?: string; options?: string[]; status: 'lead' | 'open' }): Question {
    const r = this.db
      .prepare('INSERT INTO questions (run_id, from_agent, text, context, options, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(q.runId, q.from, q.text, q.context ?? null, q.options ? JSON.stringify(q.options) : null, q.status, now());
    return this.getQuestion(Number(r.lastInsertRowid))!;
  }

  getQuestion(id: number): Question | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined;
    return row ? toQuestion(row) : undefined;
  }

  /** A run's questions, oldest first; only those with one of the given statuses if any are given. */
  questions(runId: string, ...status: QuestionStatus[]): Question[] {
    const rows = status.length
      ? (this.db.prepare(`SELECT * FROM questions WHERE run_id = ? AND status IN (${status.map(() => '?').join(',')}) ORDER BY id`).all(runId, ...status) as Row[])
      : (this.db.prepare('SELECT * FROM questions WHERE run_id = ? ORDER BY id').all(runId) as Row[]);
    return rows.map(toQuestion);
  }

  /** The lead could not answer: the question now waits for the human. */
  escalateQuestion(id: number, forHuman: string, leadNote?: string, options?: string[]): Question {
    this.db
      .prepare("UPDATE questions SET status = 'open', for_human = ?, lead_note = ?, options = ? WHERE id = ? AND status = 'lead'")
      .run(forHuman, leadNote ?? null, options ? JSON.stringify(options) : null, id);
    return this.getQuestion(id)!;
  }

  answerQuestion(id: number, answer: string, by: string): Question {
    const current = this.getQuestion(id);
    if (!current) throw new Error(`question #${id} not found`);
    if (current.status === 'answered') throw new Error(`question #${id} was already answered by ${current.answeredBy}`);
    if (current.status === 'cancelled') throw new Error(`question #${id} was cancelled because its run ended`);
    this.db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(answer, by, now(), id);
    return this.getQuestion(id)!;
  }

  /** Close a run's unanswered questions (the run ended). */
  cancelQuestions(runId: string) {
    this.db.prepare("UPDATE questions SET status = 'cancelled' WHERE run_id = ? AND status IN ('lead', 'open')").run(runId);
  }

  markDelivered(ids: number[]) {
    if (!ids.length) return;
    this.db.prepare(`UPDATE inbox SET delivered_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(now(), ...ids);
  }

  /** Take every undelivered message for an agent and mark it delivered. */
  drainInbox(runId: string, to: string): InboxMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM inbox WHERE run_id = ? AND to_agent = ? AND delivered_at IS NULL ORDER BY id')
      .all(runId, to) as Row[];
    if (rows.length) {
      this.db
        .prepare(`UPDATE inbox SET delivered_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`)
        .run(now(), ...rows.map((r) => Number(r.id)));
    }
    return rows.map((r) => toInbox(r, runId, to));
  }
}

function toProposal(r: Row): BrainProposal {
  const opt = (v: string | number | null | undefined) => (v == null ? undefined : String(v));
  return {
    id: Number(r.id),
    runId: opt(r.run_id),
    agent: String(r.agent),
    title: String(r.title),
    content: String(r.content),
    reason: opt(r.reason),
    status: r.status as ProposalStatus,
    createdAt: String(r.created_at),
    decidedAt: opt(r.decided_at),
    decidedBy: opt(r.decided_by),
    decisionNote: opt(r.decision_note),
    notePath: opt(r.note_path),
  };
}

function toQuestion(r: Row): Question {
  const opt = (v: string | number | null | undefined) => (v == null ? undefined : String(v));
  return {
    id: Number(r.id),
    runId: String(r.run_id),
    from: String(r.from_agent),
    text: String(r.text),
    context: opt(r.context),
    options: r.options == null ? undefined : (JSON.parse(String(r.options)) as string[]),
    status: r.status as QuestionStatus,
    forHuman: opt(r.for_human),
    leadNote: opt(r.lead_note),
    answer: opt(r.answer),
    answeredBy: opt(r.answered_by),
    createdAt: String(r.created_at),
    answeredAt: opt(r.answered_at),
  };
}

function toInbox(r: Row, runId: string, to: string): InboxMessage {
  return { id: Number(r.id), runId, to, from: String(r.from_agent), text: String(r.text), ts: String(r.ts), mode: (r.mode ?? 'queue') as DeliveryMode };
}

function now() {
  return new Date().toISOString();
}

function toEvent(r: Row): RunEvent {
  return {
    id: Number(r.id),
    runId: String(r.run_id),
    ts: String(r.ts),
    type: r.type as RunEvent['type'],
    step: r.step == null ? undefined : String(r.step),
    agent: r.agent == null ? undefined : String(r.agent),
    data: JSON.parse(String(r.data)),
  };
}

function toRun(r: Row): RunRecord {
  return {
    id: String(r.id),
    kind: (r.kind ?? 'workflow') as RunRecord['kind'],
    team: String(r.team),
    teamFile: String(r.team_file),
    repo: String(r.repo),
    goal: String(r.goal),
    status: r.status as RunStatus,
    pid: Number(r.pid),
    startedAt: String(r.started_at),
    finishedAt: r.finished_at == null ? undefined : String(r.finished_at),
    branch: r.branch == null ? undefined : String(r.branch),
    base: r.base == null ? undefined : String(r.base),
  };
}
