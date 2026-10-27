// Everything the system emits at runtime is one of these JSON events. The log
// view, and later the board and chat, are all projections of this stream.

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'escalated';

/** A workflow run, or a read-only question session with one agent. */
export type RunKind = 'workflow' | 'ask';

export type EventType =
  | 'run.started'
  | 'run.finished'
  | 'step.started'
  | 'step.finished'
  | 'step.skipped'
  | 'gate.passed'
  | 'gate.failed'
  | 'loop.goto'
  | 'agent.started'
  | 'agent.text'
  | 'agent.tool'
  | 'agent.finished'
  | 'agent.error'
  | 'scope.denied'
  | 'scope.violation'
  | 'git.commit'
  | 'git.merge'
  | 'message.queued'
  | 'message.delivered'
  | 'backend.warning'
  | 'chat.message'
  | 'usage.limit';

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  type: EventType;
  step?: string;
  agent?: string;
  data: Record<string, unknown>;
}

export type NewEvent = Omit<RunEvent, 'id' | 'ts' | 'runId'>;

export interface RunRecord {
  id: string;
  kind: RunKind;
  team: string;
  teamFile: string;
  repo: string;
  goal: string;
  status: RunStatus;
  pid: number;
  startedAt: string;
  finishedAt?: string;
  /** Branch holding the merged result of a worktree run. */
  branch?: string;
  /** Git ref the run started from. */
  base?: string;
}

export interface InboxMessage {
  id: number;
  runId: string;
  to: string;
  from: string;
  text: string;
  ts: string;
}
