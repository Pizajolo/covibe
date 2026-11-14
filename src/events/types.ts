// Everything the system emits at runtime is one of these JSON events. The log
// view, and later the board and chat, are all projections of this stream.

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'escalated';

/** A workflow run, or a read-only question session with one agent. */
/** check: the lead looking over a backlog goal before it goes to the team (see engine/backlog.ts). */
/** storefront: the chat that sets up a team's market storefront (see market/assistant.ts). */
export type RunKind = 'workflow' | 'ask' | 'curate' | 'design' | 'git' | 'check' | 'doctor' | 'storefront';

export type EventType =
  | 'run.started'
  | 'run.finished'
  | 'step.started'
  | 'step.finished'
  | 'step.skipped'
  // The planner chose the members the goal needs (see engine/selection.ts).
  | 'members.selected'
  // A model wrote a summary step from covibe's record of the run: its cost and tokens (see Engine.summarize).
  | 'summary.written'
  | 'step.branch_finished'
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
  // A provider that signs its answers (NEAR AI Cloud): what it signed about the member's model calls.
  | 'agent.attested'
  // Claude Code's process stopped mid-turn and the member's session was picked up again.
  | 'agent.restarted'
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
  | 'storefront.saved'
  | 'question.asked'
  | 'question.escalated'
  | 'question.answered'
  | 'git.proposed'
  | 'git.ran'
  | 'git.skipped'
  | 'doctor.proposed'
  | 'doctor.applied'
  | 'doctor.skipped'
  | 'request.sent'
  | 'request.done'
  | 'run.paused'
  | 'run.resumed'
  | 'run.restart_scheduled'
  | 'run.restart_cancelled'
  | 'run.restarted'
  | 'run.continued'
  | 'browser.opened'
  | 'browser.page'
  | 'browser.control'
  | 'browser.closed'
  // A project's app (see apps/manager.ts) and feedback people left on a run's result.
  | 'app.starting'
  | 'app.ready'
  | 'app.failed'
  | 'app.stopped'
  | 'feedback.sent'
  // The run's todo list (see engine/tasks.ts): the planner's tasks, and where each stands.
  | 'tasks.planned'
  | 'task.updated'
  // The check of a backlog goal: ready for the team, or it needs answers from you.
  | 'goal.checked'
  // Sent on the live feed only (never stored): a project's backlog changed.
  | 'backlog.changed';

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

/**
 * A goal in a project's backlog. checking: the lead (or a faster model) is
 * looking it over; needs_info: the check has questions for you; ready: waits
 * its turn; started: a run works on it (its outcome is the run's).
 */
/** Who looks a new backlog goal over before it waits its turn: the team lead, the lead on a faster model, or nobody. */
export type CheckMode = 'lead' | 'fast' | 'off';

export type GoalState = 'checking' | 'needs_info' | 'ready' | 'started';

export interface GoalQuestion {
  question: string;
  /** Answers to pick from, when it is a choice. */
  options?: string[];
  /** Yours, once you answered. */
  answer?: string;
}

export interface GoalCheck {
  /** failed: the check could not run (the goal goes on without it); skipped: checks are off, or you sent it on as it was. */
  verdict: 'ready' | 'needs_info' | 'failed' | 'skipped';
  /** What the team will do, in a sentence or two. */
  summary?: string;
  questions?: GoalQuestion[];
  /** The check's own run (kind "check"), and who made it. */
  runId?: string;
  by?: string;
  error?: string;
  at: string;
}

export interface Goal {
  id: number;
  text: string;
  /** The library team that works on it. */
  team: string;
  state: GoalState;
  /** Order in the backlog (lower first). */
  position: number;
  /** Files given with the goal, kept until it starts (see engine/attachments.ts). */
  attachments: { name: string; path: string; size: number; kind: string }[];
  check?: GoalCheck;
  /** Runs started for it, oldest first; the last one is its outcome. */
  runs: string[];
  createdAt: string;
  updatedAt: string;
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
