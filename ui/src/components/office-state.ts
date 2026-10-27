// How the office shows a member, from the run's state. Pure, so tests can check it.
import type { AgentState, QuestionView, RunSummary } from '../../../src/server/api-types.js';
import type { DeskState } from './office-art.js';

export const DESK_LABEL: Record<DeskState, string> = {
  sleeping: 'Asleep',
  working: 'Working',
  asking: 'Asking the lead',
  needs: 'Needs you',
  held: 'On hold',
  done: 'Done',
  stopped: 'Stopped',
};

export const DESK_HELP: Record<DeskState, string> = {
  sleeping: 'Not working right now. Wakes up when its step starts or you message it.',
  working: 'In a turn. The plate shows what it is doing.',
  asking: 'Asked the team lead a question and waits for the answer.',
  needs: 'Asked you a question, or (the lead) passed one on to you. The team is on hold until you answer; click the ? to answer.',
  held: 'Stopped at its next tool call while a question waits for you.',
  done: 'Finished its part of the current step.',
  stopped: 'Its turn failed or was stopped.',
};

/** The desk that holds a question for you: the lead that passed it on, or the member that asked. */
export function questionDesk(run: RunSummary, q: QuestionView): string {
  return q.lead && run.agents.some((a) => a.name === q.lead) ? q.lead : q.from;
}

/** The open question for you that sits on this member's desk, if any. */
export function deskQuestion(a: AgentState, run: RunSummary): QuestionView | undefined {
  if (run.status !== 'running') return undefined;
  return (run.questions ?? []).find((q) => q.status === 'open' && questionDesk(run, q) === a.name);
}

/** How the office shows a member right now. */
export function deskState(a: AgentState, run: RunSummary, answering: boolean): DeskState {
  const live = run.status === 'running';
  if (answering) return 'working';
  if (live && a.waitingOn) return a.waitingOn === 'human' ? 'needs' : 'asking';
  if (deskQuestion(a, run)) return 'needs';
  if (a.status === 'working') return run.paused ? 'held' : 'working';
  if (a.status === 'error') return 'stopped';
  if (a.status === 'done' && live) return 'done';
  return 'sleeping';
}

/** The line under a member's name plate. */
export function deskNote(a: AgentState, state: DeskState, run: RunSummary): string {
  switch (state) {
    case 'working': return a.activity ?? 'thinking…';
    case 'asking': return `asking ${a.waitingOn}`;
    case 'needs': return a.waitingOn === 'human' ? 'needs you' : 'question for you';
    case 'held': return 'on hold';
    case 'done': return a.step ? `done with ${a.step}` : 'done';
    case 'stopped': return 'stopped';
  }
  if (a.inbox) return `${a.inbox} message${a.inbox > 1 ? 's' : ''} waiting`;
  return run.status === 'running' && a.status === 'idle' ? 'waiting for its step' : 'asleep';
}
