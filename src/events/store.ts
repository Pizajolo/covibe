import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DeliveryMode, InboxMessage, NewEvent, RunEvent, RunRecord, RunStatus } from './types.js';

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
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  delivered_at TEXT
);
`;

type Row = Record<string, string | number | null>;
type Listener = (e: RunEvent) => void;

/** SQLite-backed store for runs, the event stream, agent sessions and inboxes. */
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
