// Members' questions. A member that needs a decision calls ask_question and
// waits for the tool's answer. The team lead answers first; if it cannot, the
// question goes to the human and the whole run pauses until they reply.
import type { EventStore } from '../events/store.js';
import type { Question } from '../events/types.js';

export const ASK_TOOL = 'ask_question';
/** The step name on the lead's turns that answer a question (they are not workflow steps). */
export const QUESTION_STEP = 'question';

/** What the lead returns when a teammate's question reaches it. */
export const LEAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { enum: ['answer', 'ask_human'], description: 'answer: you answer it. ask_human: only the human can decide this.' },
    answer: { type: 'string', description: 'Your answer (decision "answer").' },
    question_for_human: { type: 'string', description: 'The question as the human should see it, understandable without other context (decision "ask_human").' },
    reason: { type: 'string', description: 'Why only the human can answer (decision "ask_human").' },
    options_for_human: {
      type: 'array',
      items: { type: 'string' },
      description: 'The answers the human can pick from, if it is a choice (decision "ask_human"). They can still write their own.',
    },
  },
};

export type LeadVerdict = { answer: string } | { forHuman: string; note?: string; options?: string[] };

/** The choices offered with a question: trimmed, distinct, at most 8; undefined when fewer than two. */
export function questionOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const v of value) {
    const text = typeof v === 'string' ? v.trim() : '';
    if (text && seen.size < 8) seen.add(text);
  }
  return seen.size >= 2 ? [...seen] : undefined;
}

/** Read the lead's report; anything unusable passes the question on to the human. */
export function leadVerdict(value: unknown, question: string): LeadVerdict {
  const v = (value ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' && (v[k] as string).trim() ? (v[k] as string).trim() : undefined);
  const answer = str('answer');
  if (v.decision === 'answer' && answer) return { answer };
  if (v.decision === 'ask_human') return { forHuman: str('question_for_human') ?? question, note: str('reason'), options: questionOptions(v.options_for_human) };
  return { forHuman: question, note: 'the lead did not give a usable answer' };
}

export function leadPrompt(p: { goal: string; lead: string; from: string; step: string; question: string; context?: string; options?: string[] }): string {
  return [
    `# Goal\n${p.goal}`,
    `# Question from ${p.from}\n${p.question}`,
    ...(p.options ? [`## Options ${p.from} sees\n${p.options.map((o) => `- ${o}`).join('\n')}`] : []),
    ...(p.context ? [`## Context from ${p.from}\n${p.context}`] : []),
    `You are ${p.lead}, the team lead. ${p.from} is waiting for your answer before it continues step "${p.step}".`,
    `Answer it yourself if the goal, the plan, the code or the project brain settle it, or if it is a call you can make as lead. Pass it to the human only when the decision is theirs: product or scope choices the goal leaves open, trade-offs with real cost, credentials or access, or anything you would be guessing. The whole run pauses while the human answers, so do not pass on what you can decide.`,
    'You can read but not change anything. Return decision "answer" with your answer, or decision "ask_human" with question_for_human and reason, and options_for_human when it is a choice between a few answers.',
  ].join('\n\n');
}

/**
 * Answer a question that waits for the human (from the app or the CLI). The
 * member that asked picks the answer up within a second, even when another
 * process runs the workflow.
 */
export function answerQuestion(store: EventStore, runId: string, id: number, answer: string): Question {
  const q = store.getQuestion(id);
  if (!q || q.runId !== runId) throw new Error(`question #${id} not found in run ${runId}`);
  if (q.status === 'lead') throw new Error(`question #${id} is still with the team lead; it comes to you only if the lead cannot answer it`);
  const text = answer.trim();
  if (!text) throw new Error('the answer is empty');
  const answered = store.answerQuestion(id, text, 'human');
  store.append(runId, { type: 'question.answered', agent: q.from, data: { id, by: 'human', answer: text } });
  return answered;
}

/** Wait until a question is answered, checking the store (the answer may come from another process). */
export async function waitForAnswer(store: EventStore, id: number, signal?: AbortSignal): Promise<Question> {
  for (;;) {
    signal?.throwIfAborted();
    const q = store.getQuestion(id);
    if (!q) throw new Error(`question #${id} disappeared`);
    if (q.status === 'answered') return q;
    if (q.status === 'cancelled') throw new Error(`question #${id} was cancelled`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 300);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

/** A turn's time limit that stops counting while the member waits for an answer or the run is paused. */
export class Deadline {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private remaining: number;
  private since = 0;
  private holds = 0;

  constructor(ms: number) {
    this.remaining = ms;
    this.start();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private start() {
    this.since = Date.now();
    this.timer = setTimeout(() => this.controller.abort(new Error('timed out')), Math.max(0, this.remaining));
  }

  /** Stop the clock until the returned function is called; holds nest. */
  hold(): () => void {
    if (this.holds++ === 0 && !this.signal.aborted) {
      clearTimeout(this.timer);
      this.remaining -= Date.now() - this.since;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0 && !this.signal.aborted) this.start();
    };
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

/**
 * Holds the whole run while a question waits for the human: no new turn
 * starts, working members stop at their next tool call, and their time limits
 * stop counting.
 */
export class RunPause {
  private readonly open = new Set<number>();
  private readonly deadlines = new Map<Deadline, (() => void) | undefined>();
  private waiters: (() => void)[] = [];

  constructor(private readonly onChange: (paused: boolean, questions: number[]) => void) {}

  get paused(): boolean {
    return this.open.size > 0;
  }

  /** A question now waits for the human. */
  add(id: number) {
    const was = this.paused;
    this.open.add(id);
    if (was) return;
    for (const d of this.deadlines.keys()) this.deadlines.set(d, d.hold());
    this.onChange(true, [...this.open]);
  }

  /** The human answered (or the question ended); resume once none are left. */
  remove(id: number) {
    if (!this.open.delete(id) || this.paused) return;
    for (const [d, release] of this.deadlines) {
      release?.();
      this.deadlines.set(d, undefined);
    }
    this.onChange(false, []);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Stop a member's clock whenever the run is paused; call the result when its turn ends. */
  track(deadline: Deadline): () => void {
    this.deadlines.set(deadline, this.paused ? deadline.hold() : undefined);
    return () => {
      this.deadlines.get(deadline)?.();
      this.deadlines.delete(deadline);
    };
  }

  /** Resolves once the run is not paused. */
  async wait(signal?: AbortSignal): Promise<void> {
    while (this.paused) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== done);
          reject(signal!.reason ?? new Error('aborted'));
        };
        const done = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(done);
      });
    }
  }
}
