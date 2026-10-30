// Everything the system emits at runtime is one of these JSON events. The log
// view, and later the board and chat, are all projections of this stream.

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'escalated';

/** A workflow run, or a read-only question session with one agent. */
export type RunKind = 'workflow' | 'ask' | 'curate' | 'design' | 'git';

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
  | 'agent.view'
  | 'agent.limited'
  | 'scope.denied'
  | 'scope.violation'
  | 'git.commit'
  | 'git.merge'
  | 'files.changed'
  | 'files.undone'
  | 'message.queued'
  | 'message.delivered'
  | 'backend.warning'
  | 'chat.message'
  | 'usage.limit'
  | 'agent.usage'
  | 'workspace.cleaned'
  | 'brain.proposed'
  | 'brain.decided'
  | 'brain.updated'
  | 'team.saved'
  | 'question.asked'
  | 'question.escalated'
  | 'question.answered'
  | 'git.proposed'
  | 'git.ran'
  | 'git.skipped'
  | 'request.sent'
  | 'request.done'
  | 'run.paused'
  | 'run.resumed'
  | 'run.restart_scheduled'
  | 'run.restart_cancelled'
  | 'run.restarted'
  | 'browser.opened'
  | 'browser.page'
  | 'browser.control'
  | 'browser.closed'
  // A project's app (see apps/manager.ts) and feedback people left on a run's result.
  | 'app.starting'
  | 'app.ready'
  | 'app.failed'
  | 'app.stopped'
  | 'feedback.sent';

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

/**
 * A member's question. It goes to the team lead first (status "lead"); if the
 * lead cannot answer, to the human ("open"), and the run pauses until they do.
 */
export type QuestionStatus = 'lead' | 'open' | 'answered' | 'cancelled';

export interface Question {
  id: number;
  runId: string;
  /** The member who asked. */
  from: string;
  /** What the member asked. */
  text: string;
  context?: string;
  /** Answers to pick from, when it is a choice; any other answer is fine too. */
  options?: string[];
  status: QuestionStatus;
  /** The question as put to the human (the lead may rephrase it), and why the lead passed it on. */
  forHuman?: string;
  leadNote?: string;
  answer?: string;
  /** The lead's name, or "human". */
  answeredBy?: string;
  createdAt: string;
  answeredAt?: string;
}
