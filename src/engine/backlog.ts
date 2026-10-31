// A project's backlog: goals you line up for the team. Each new goal is looked
// over first by the team lead (or the lead on a faster model), read-only in the
// project: is it clear enough to carry out without asking you? If not, its
// questions wait for you; if so, the goal waits its turn and the server starts
// it when the team is free and the plan has room (see server/app.ts).
import { dirname } from 'node:path';
import type { AgentConfig, TeamConfig } from '../config/types.js';
import type { Connections } from '../connections/store.js';
import type { EventStore } from '../events/store.js';
import type { CheckMode, Goal, GoalCheck, GoalQuestion } from '../events/types.js';
import type { Env } from '../runner/backend.js';
import type { AgentRunner } from '../runner/types.js';
import { attachmentNote, type Attachment } from './attachments.js';
import { accountOf, buildInvocation, extractJson, finishedData, isBalanced, newRunId, resolverOf } from './engine.js';
import { questionOptions } from './questions.js';
import { readOnly } from './scope.js';


/** The model "fast" checks run on (members on a provider's model keep theirs). */
export const FAST_CHECK_MODEL = 'haiku';
/** The step the check's turn runs as: a conversation, so its run reads like a question's. */
const CHECK_STEP = 'chat';
const CHECK_TIMEOUT_MS = 10 * 60_000;
const CHECK_MAX_TURNS = 30;
const MAX_QUESTIONS = 5;

/** What the check returns. */
export const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary'],
  properties: {
    verdict: { enum: ['ready', 'needs_info'], description: 'ready: the team can carry it out as it is. needs_info: only the human can settle something it needs.' },
    summary: { type: 'string', description: 'What the team will do, in one or two sentences, as you understand the goal.' },
    questions: {
      type: 'array',
      description: `With needs_info: what the human must answer first, at most ${MAX_QUESTIONS}, each understandable on its own.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question'],
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: 'The answers to pick from, if it is a choice between a few.' },
        },
      },
    },
  },
};

/** The member that checks goals: the lead, else the first member of the workflow, else the first member. */
export function checkerOf(team: TeamConfig, mode: Exclude<CheckMode, 'off'>): AgentConfig {
  const first = team.steps[0];
  const name = team.lead ?? (first ? (first.kind === 'agent' ? first.agent : first.branches[0]?.agent) : undefined) ?? Object.keys(team.agents)[0];
  const member = name ? team.agents[name] : undefined;
  if (!member) throw new Error(`team ${team.name} has no members`);
  const base: AgentConfig = { ...readOnly(member), browser: false, app: false, limits: { ...member.limits, max_turns: Math.min(member.limits.max_turns, CHECK_MAX_TURNS) } };
  if (mode !== 'fast' || base.backend.type === 'connection') return base;
  const { effort: _effort, thinking: _thinking, ...rest } = base;
  return { ...rest, model: FAST_CHECK_MODEL };
}

export function checkPrompt(goal: Pick<Goal, 'text'>, files: Attachment[] = []): string {
  return [
    `# Goal for the team\n${goal.text}`,
    ...(files.length ? [attachmentNote(files)] : []),
    `Before the team starts on this goal, decide whether it can be carried out without asking the human. Look at the project as far as you need to (you can read but not change anything), and at the project brain.`,
    `Return verdict "ready" when the goal, the code and sensible defaults settle how to do it; the team makes ordinary design and implementation calls itself. Return "needs_info" only for what the human alone can decide: what they actually want when the goal can be read in clearly different ways, product or scope choices with real consequences, credentials, accounts or access, or facts that are nowhere in the project. Ask at most ${MAX_QUESTIONS} short questions, each understandable on its own, with options when it is a choice. Do not ask about anything you could look up or decide.`,
    'In either case, say in summary what the team will do.',
  ].join('\n\n');
}

/** Read the check's report; anything unusable lets the goal through, with nothing asked. */
export function checkVerdict(value: unknown): Pick<GoalCheck, 'verdict' | 'summary' | 'questions'> {
  const v = (value ?? {}) as Record<string, unknown>;
  const summary = typeof v.summary === 'string' && v.summary.trim() ? v.summary.trim() : undefined;
  const questions: GoalQuestion[] = [];
  for (const q of Array.isArray(v.questions) ? v.questions : []) {
    const text = typeof (q as { question?: unknown })?.question === 'string' ? (q as { question: string }).question.trim() : '';
    if (!text || questions.length >= MAX_QUESTIONS) continue;
    const options = questionOptions((q as { options?: unknown }).options);
    questions.push({ question: text, ...(options ? { options } : {}) });
  }
  if (v.verdict === 'needs_info' && questions.length) return { verdict: 'needs_info', ...(summary ? { summary } : {}), questions };
  return { verdict: 'ready', ...(summary ? { summary } : {}) };
}

function verdictText(check: GoalCheck): string {
  const summary = check.summary ? `\n\n${check.summary}` : '';
  if (check.verdict !== 'needs_info') return `Ready for the team.${summary}`;
  return `It needs you first.${summary}\n\n${(check.questions ?? []).map((q) => `- ${q.question}${q.options ? ` (${q.options.join(' / ')})` : ''}`).join('\n')}`;
}

/** The goal as the team gets it: what you wrote, and your answers to the check's questions. */
export function goalPrompt(goal: Pick<Goal, 'text' | 'check'>): string {
  const answered = (goal.check?.questions ?? []).filter((q) => q.answer?.trim());
  if (!answered.length) return goal.text;
  return `${goal.text}\n\n## Answers to questions asked before the work started\n${answered.map((q) => `- ${q.question}\n  ${q.answer!.trim()}`).join('\n')}`;
}

/** Where a goal's files wait until it starts (the attachments folder of a run that is the goal's). */
export const goalFilesKey = (id: number) => `goal-${id}`;

/**
 * Look a goal over (see checkPrompt) in a run of its own (kind "check"), so its
 * reading and its cost show like any other turn. Never throws: a check that
 * cannot run returns verdict "failed" with the error.
 */
export async function checkGoal(opts: {
  store: EventStore;
  runner: AgentRunner;
  team: TeamConfig;
  repo: string;
  goal: Goal;
  mode: Exclude<CheckMode, 'off'>;
  connections?: Connections;
  env?: Env;
  signal?: AbortSignal;
}): Promise<GoalCheck> {
  const { store, team, goal } = opts;
  const agent = checkerOf(team, opts.mode);
  const run = store.createRun({ id: newRunId(), kind: 'check', team: team.name, teamFile: team.file, repo: opts.repo, goal: goal.text });
  const base = { step: CHECK_STEP, agent: agent.name };
  store.append(run.id, { type: 'run.started', data: { team: team.name, goal: goal.text, kind: 'check', agent: agent.name, goal_id: goal.id, isolation: 'none', steps: [] } });
  store.append(run.id, { type: 'chat.message', ...base, data: { from: 'human', to: agent.name, text: `Is this goal ready for the team, or does it need more from me?\n\n${goal.text}` } });
  let check: GoalCheck;
  try {
    const account = isBalanced(agent, opts.connections) ? await opts.connections!.pick() : undefined;
    const built = await resolverOf(opts.connections).resolve(account ? { ...agent.backend, account } : agent.backend, opts.env ?? process.env);
    store.append(run.id, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: agent.backend.type, via: built.via, cwd: opts.repo, resumed: false, chat: true } });
    const files = goal.attachments as Attachment[];
    const inv = buildInvocation(team, store, run.id, agent, {
      repo: opts.repo,
      cwd: opts.repo,
      root: opts.repo,
      prompt: checkPrompt(goal, files),
      env: built.env,
      pricing: built.pricing,
      account: accountOf(built),
      via: built.via,
      step: CHECK_STEP,
      outputSchema: CHECK_SCHEMA,
      signal: opts.signal ?? AbortSignal.timeout(Math.min(CHECK_TIMEOUT_MS, agent.limits.timeout_min * 60_000)),
    });
    if (files.length) inv.readDirs = [...(inv.readDirs ?? []), ...new Set(files.map((f) => dirname(f.path)))];
    const result = await opts.runner.run(inv).finally(() => inv.onControl?.(null));
    // You can ask the checker about its verdict afterwards (read-only, see chat.ts).
    if (result.sessionId) store.saveSession(run.id, agent.name, result.sessionId, opts.repo);
    store.append(run.id, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result, built.via) });
    if (!result.ok) throw new Error(result.error || 'the check did not finish');
    check = { ...checkVerdict(result.structured ?? extractJson(result.text)), runId: run.id, by: agent.name, at: new Date().toISOString() };
    // The verdict in the conversation, where the structured report would not show.
    store.append(run.id, { ...base, type: 'agent.text', data: { text: verdictText(check) } });
  } catch (err) {
    check = { verdict: 'failed', error: (err as Error).message, runId: run.id, by: agent.name, at: new Date().toISOString() };
  }
  store.append(run.id, { type: 'goal.checked', agent: agent.name, data: { goal_id: goal.id, verdict: check.verdict, summary: check.summary ?? null, questions: check.questions?.length ?? 0, ...(check.error ? { error: check.error } : {}) } });
  const status = check.verdict === 'failed' ? 'failed' : 'succeeded';
  store.finishRun(run.id, status);
  store.append(run.id, { type: 'run.finished', data: { status, loops: 0, cost_usd: null, ...(check.error ? { reason: check.error } : {}) } });
  return check;
}
