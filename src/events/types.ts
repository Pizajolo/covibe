// Everything the system emits at runtime is one of these JSON events. The log
// view, and later the board and chat, are all projections of this stream.

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'escalated';

/** A workflow run, or a read-only question session with one agent. */
export type RunKind = 'workflow' | 'ask' | 'curate' | 'design';

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
  | 'usage.limit'
  | 'workspace.cleaned'
  | 'brain.proposed'
  | 'brain.decided'
  | 'brain.updated'
  | 'team.saved';

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

/**
 * How a message to an agent is delivered. queue: at the start of its next
 * turn. steer: while it works, between tool calls, without stopping it.
 * interrupt: stop its current turn and answer this first. steer and interrupt
 * fall back to queue when the agent is not working.
 */
export type DeliveryMode = 'queue' | 'steer' | 'interrupt';

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface BrainProposal {
  id: number;
  runId?: string;
  agent: string;
  title: string;
  content: string;
  reason?: string;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  notePath?: string;
}

export interface InboxMessage {
  id: number;
  runId: string;
  to: string;
  from: string;
  text: string;
  ts: string;
  mode: DeliveryMode;
}
