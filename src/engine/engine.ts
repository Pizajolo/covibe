import { randomBytes } from 'node:crypto';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { AgentConfig, Branch, JsonSchema, Step, TeamConfig } from '../config/types.js';
import type { EventStore } from '../events/store.js';
import type { InboxMessage, NewEvent, RunStatus } from '../events/types.js';
import type { Connections } from '../connections/store.js';
import { MAIN_ACCOUNT } from '../connections/types.js';
import { BackendError, plainBackends, type BackendEnv, type BackendResolver, type Env } from '../runner/backend.js';
import { brainRoot } from '../home.js';
import { startMcpProxy } from '../connections/mcp-proxy.js';
import { resolvePlugins } from '../plugins.js';
import { resolveSkills } from '../skills.js';
import type { AgentInvocation, AgentResult, AgentRunner, AgentStreamEvent, CustomTool } from '../runner/types.js';
import { brainPrompt, commitBrain, curate, ensureBrain, proposeTool } from './brain.js';
import { evaluate, evaluateGate } from './expr.js';
import { systemPrompt, turnPrompt } from './prompts.js';
import { browserActivity } from './browser.js';
import { browserHub } from '../browser/hub.js';
import { browserTools } from '../browser/tools.js';
import { appHub } from '../apps/manager.js';
import { appTools } from '../apps/tools.js';
import { ASK_TOOL, Deadline, LEAD_SCHEMA, leadPrompt, leadVerdict, QUESTION_STEP, questionOptions, RunPause, waitForAnswer, type LeadVerdict } from './questions.js';
import { REQUEST_TOOL, RequestChains, requestPrompt } from './requests.js';
import { makeToolChecker, readOnly } from './scope.js';
import { denyWritePaths, type Writer } from './folder.js';
import { Workspace, type CollectResult } from './workspace.js';
import { attachFiles, attachmentNote, ensureAttachmentsDir, takeUploads, type Attachment } from './attachments.js';
import { boardPrompt, planTasksOf, planTasksTool, replayBoard, TaskBoard, updateTaskTool, type BoardTask } from './tasks.js';

export interface RunOptions {
  team: TeamConfig;
  repo: string;
  goal: string;
  store: EventStore;
  runner: AgentRunner;
  /** Parent environment for agent processes (defaults to process.env). */
  env?: Env;
  signal?: AbortSignal;
  /** Git ref to start from, e.g. an earlier run's branch to build on its result. Defaults to HEAD. Ignored in a plain folder. */
  base?: string;
  /** When the plan's usage limit stops a member: wait for the reset and continue (default), or stop the run. */
  onLimit?: 'wait' | 'stop';
  /** Claude accounts and providers from Settings → Advanced (and balancing across accounts). */
  connections?: Connections;
  /** Files given with the goal: uploads (by id, see attachments.ts) and files on this computer (the CLI's --attach). */
  uploads?: string[];
  files?: string[];
}

export interface RunOutcome {
  runId: string;
  status: Exclude<RunStatus, 'running'>;
  reason?: string;
  /** Branch with the merged result (worktree isolation). */
  branch?: string;
  context: RunContext;
  costUsd: number;
}

/** What gates, task selectors and feed expressions see: step outputs keyed by step id. */
export interface RunContext {
  goal: string;
  loop: number;
  feedback: Record<string, unknown>;
  [stepId: string]: unknown;
}

class StepError extends Error {}

/** Before the task, for a member whose step was cut short and is now continued. */
const RESUME_NOTE =
  'The run stopped while you were working on this step, and the human has continued it. What you did before it stopped is still in your working folder and, if your conversation was kept, above. Pick up where you left off: check what is already done, finish the rest, and report as the step asks. Do not start over.\n\n';

/** The plan's usage limit stopped a member and the run stops (onLimit: stop). */
class LimitError extends StepError {
  constructor(
    message: string,
    readonly resetsAt: string | undefined,
  ) {
    super(message);
  }
}

/** Without a reset time, look again after this long. */
const LIMIT_RETRY_MS = 30 * 60_000;
/** Wait a little past the reset, so the window has really turned over. */
const LIMIT_GRACE_MS = 60_000;
const MAX_LIMIT_WAIT_MS = 7 * 24 * 60 * 60_000;

const resetIso = (epoch: number | undefined) => (epoch ? new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString() : undefined);

/** Sleep until `ms` from now, or until the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function newRunId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/**
 * Run a team's workflow to completion: succeeded, failed, or escalated to a
 * human. Members can ask questions on the way (see questions.ts); while one
 * waits for the human, the run pauses.
 */
export async function runTeam(opts: RunOptions): Promise<RunOutcome> {
  return (await startRun(opts)).done;
}

/**
 * Create the run (workspace and record) and start it in the background.
 * Resolves as soon as the run id exists, so a UI can follow it from the first event.
 */
export async function startRun(opts: RunOptions): Promise<{ runId: string; done: Promise<RunOutcome> }> {
  const runId = newRunId();
  // Files that cannot be found fail the goal before anything is set up.
  const attachments = [...takeUploads(opts.uploads ?? [], opts.repo, runId), ...attachFiles(opts.files ?? [], opts.repo, runId)];
  const workspace = await Workspace.create(opts.repo, runId, opts.team.isolation, opts.base, writersOf(opts.team));
  opts.store.createRun({
    id: runId,
    team: opts.team.name,
    teamFile: opts.team.file,
    repo: workspace.repo,
    goal: opts.goal,
    branch: workspace.branch,
    base: opts.base,
  });
  return { runId, done: new Engine(opts, runId, workspace, attachments).run() };
}

/** Where a stopped run picks up again (see resumePoint). */
export interface ResumePoint {
  /** Index of the step to run first. */
  index: number;
  /** Step outputs, loop and feedback as they were. */
  context: RunContext;
  maxLoops?: number;
  /** In a parallel step: the branches that already finished, with their reports. */
  done: Record<string, unknown>;
  /** The step was cut short (its members pick up where they stopped), or a gate ran out of rounds (one more fix round). */
  kind: 'step' | 'round';
  /** Why the run had stopped. */
  reason?: string;
  costUsd: number;
  /** The todo list as it stood. */
  tasks?: BoardTask[];
}

/**
 * Work out from a run's events where it stopped: the step that was cut short,
 * or, when a gate ran out of fix rounds, one more round from the gate's
 * on_gate_fail step. Undefined when there is nothing to continue.
 */
export async function resumePoint(team: TeamConfig, events: { type: string; step?: string | null; agent?: string | null; data: Record<string, unknown> }[]): Promise<ResumePoint | undefined> {
  const context: RunContext = { goal: '', loop: 0, feedback: {} };
  let maxLoops: number | undefined;
  let started: string | undefined;
  let open = false;
  let done: Record<string, unknown> = {};
  let failedGate: string | undefined;
  let status: string | undefined;
  let reason: string | undefined;
  let costUsd = 0;
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case 'run.started':
        context.goal = String(d.goal ?? '');
        break;
      case 'step.started':
        started = e.step ?? undefined;
        open = true;
        done = {};
        failedGate = undefined;
        if (typeof d.loop === 'number') context.loop = d.loop;
        break;
      case 'step.branch_finished':
        if (e.step === started && e.agent) done[e.agent] = d.output;
        break;
      case 'step.finished':
        if (e.step) context[e.step] = d.output;
        if (e.step === started) open = false;
        break;
      case 'gate.failed':
        failedGate = e.step ?? undefined;
        break;
      case 'loop.goto':
        context.loop = Number(d.loop ?? context.loop);
        context.feedback = (d.feedback as Record<string, unknown>) ?? {};
        if (typeof d.max_loops === 'number') maxLoops = d.max_loops;
        failedGate = undefined;
        break;
      case 'run.finished':
        status = String(d.status ?? '');
        reason = typeof d.reason === 'string' ? d.reason : undefined;
        if (typeof d.cost_usd === 'number') costUsd = d.cost_usd;
        break;
    }
  }
  if (status === 'succeeded') return undefined;
  const tasks = replayBoard(events).map(({ updatedAt: _u, by: _b, ...t }) => t);
  const point = await resumeAt(team, context, { started, open, done, failedGate, maxLoops, reason, costUsd });
  return point && (tasks.length ? { ...point, tasks } : point);
}

async function resumeAt(
  team: TeamConfig,
  context: RunContext,
  s: { started?: string; open: boolean; done: Record<string, unknown>; failedGate?: string; maxLoops?: number; reason?: string; costUsd: number },
): Promise<ResumePoint | undefined> {
  const { started, open, done, failedGate, maxLoops, reason, costUsd } = s;
  const at = (id: string | undefined) => team.steps.findIndex((s) => s.id === id);
  if (started && open && at(started) >= 0) return { index: at(started), context, maxLoops, done, kind: 'step', reason, costUsd };
  if (failedGate) {
    const step = team.steps[at(failedGate)];
    const policy = step?.onGateFail;
    if (policy && at(policy.goto) >= 0) {
      const feedback: Record<string, unknown> = {};
      for (const expr of policy.feed) feedback[expr] = (await evaluate(expr, context)) ?? null;
      return { index: at(policy.goto), context: { ...context, loop: context.loop + 1, feedback }, maxLoops: Math.max(policy.maxLoops, context.loop + 1), done: {}, kind: 'round', reason, costUsd };
    }
    // No fix loop: run the gated step again.
    if (step) return { index: at(failedGate), context, maxLoops, done: {}, kind: 'step', reason, costUsd };
  }
  // Stopped before any step (a member's account or plugin was not set up), or between steps.
  if (!started) return { index: 0, context, maxLoops, done: {}, kind: 'step', reason, costUsd };
  const next = at(started) + 1;
  return next < team.steps.length ? { index: next, context, maxLoops, done: {}, kind: 'step', reason, costUsd } : undefined;
}

/**
 * Carry on a stopped run where it stopped, in the same run: its workspace,
 * branch and members' conversations. The step that was cut short runs again
 * and its members resume their sessions; finished steps keep their reports.
 */
export async function continueRun(opts: Omit<RunOptions, 'goal' | 'base' | 'uploads' | 'files'> & { runId: string }): Promise<{ runId: string; done: Promise<RunOutcome> }> {
  const run = opts.store.getRun(opts.runId);
  if (!run) throw new Error(`run ${opts.runId} not found`);
  if (run.kind !== 'workflow') throw new Error('only workflow runs can be continued');
  if (opts.store.isLive(run)) throw new Error('this run is still going');
  const events = opts.store.events(run.id);
  const from = await resumePoint(opts.team, events);
  if (!from) throw new Error(run.status === 'succeeded' ? 'this run finished; start a new goal to carry on from its result' : 'there is nothing left to continue in this run');
  const attachments = (events.find((e) => e.type === 'run.started')?.data.attachments as Attachment[] | undefined) ?? [];
  const workspace = await Workspace.attach(run.repo, run.id, run.branch ? opts.team.isolation : 'none', run.branch, writersOf(opts.team));
  if (run.branch) await workspace.restore(workspace.integrationDir);
  workspace.resuming = true;
  opts.store.reopenRun(run.id);
  return { runId: run.id, done: new Engine({ ...opts, goal: run.goal }, run.id, workspace, attachments, from).run() };
}

/** The members that change files, and where (for a plain folder's record of changes). */
export function writersOf(team: TeamConfig): Writer[] {
  return Object.values(team.agents)
    .filter((a) => a.writes)
    .map((a) => ({ name: a.name, scope: a.writeScope }));
}

/** The agent.finished / agent.error payload, shared by workflow steps, chat and ask. `via`: the account or connection it ran on. */
export function finishedData(agent: AgentConfig, result: AgentResult, via?: string): Record<string, unknown> {
  return {
    ok: result.ok,
    model: agent.model ?? null,
    ...(via ? { via } : {}),
    turns: result.turns,
    cost_usd: result.costUsd,
    duration_ms: result.durationMs,
    tokens: result.tokens ?? null,
    ...(result.ok ? {} : { error: result.error ?? 'unknown error' }),
  };
}

class Engine {
  private readonly team: TeamConfig;
  private readonly store: EventStore;
  private readonly context: RunContext;
  private readonly slots: Semaphore;
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true });
  private readonly validators = new WeakMap<JsonSchema, ValidateFunction>();
  private readonly warned = new Set<string>();
  private readonly pause: RunPause;
  /** One turn at a time per member: a teammate's request waits for its workflow turn, and the other way round. */
  private readonly members = new Map<string, Semaphore>();
  private readonly chains = new RequestChains();
  private requests = 0;
  private costUsd = 0;
  private maxLoops: number | undefined;
  /** The goal as members read it: with the files the human attached. */
  private readonly goalText: string;
  /** Continuing a run: members of the step that was cut short, told on their first turn to pick up where they stopped. */
  private resumeNotes = new Set<string>();
  /** The run's todo list. */
  private readonly board: TaskBoard;

  constructor(
    private readonly opts: RunOptions,
    private readonly runId: string,
    private readonly workspace: Workspace,
    private readonly attachments: Attachment[] = [],
    /** Set when continuing a stopped run. */
    private readonly from?: ResumePoint,
  ) {
    this.goalText = attachments.length ? `${opts.goal}\n\n${attachmentNote(attachments)}` : opts.goal;
    this.team = opts.team;
    this.store = opts.store;
    this.context = from ? { ...from.context, goal: opts.goal } : { goal: opts.goal, loop: 0, feedback: {} };
    this.maxLoops = from?.maxLoops;
    this.costUsd = from?.costUsd ?? 0;
    if (from?.kind === 'step') this.resumeNotes = new Set(this.stepAgents(this.team.steps[from.index]!));
    this.slots = new Semaphore(this.team.maxParallel);
    this.board = new TaskBoard((e) => this.emit(e), from?.tasks);
    this.pause = new RunPause((paused, questions) =>
      this.emit(paused ? { type: 'run.paused', data: { questions } } : { type: 'run.resumed', data: {} }),
    );
  }

  private emit(event: NewEvent) {
    this.store.append(this.runId, event);
  }

  async run(): Promise<RunOutcome> {
    const { steps } = this.team;
    // The brain must exist before members are pointed at it.
    await ensureBrain(this.workspace.repo).catch(() => undefined);
    // Signed-in plugin servers are reached through it (see mcp-proxy.ts).
    await startMcpProxy().catch(() => undefined);
    const from = this.from;
    if (from) {
      const step = steps[from.index]!;
      this.emit({ type: 'run.continued', step: step.id, data: { from_step: step.id, loop: this.context.loop, kind: from.kind, reason: from.reason ?? null, done: Object.keys(from.done) } });
    } else this.emit({
      type: 'run.started',
      data: {
        team: this.team.name,
        goal: this.opts.goal,
        ...(this.attachments.length ? { attachments: this.attachments } : {}),
        // A plain folder: members work in it directly, and the run can be undone.
        isolation: this.workspace.folder ? 'folder' : this.team.isolation,
        ...(this.workspace.folder ? { folder: this.workspace.repo } : {}),
        branch: this.workspace.branch,
        steps: steps.map((s) => s.id),
      },
    });

    let status: RunOutcome['status'] = 'succeeded';
    let reason: string | undefined;
    let limit: { resets_at: string | null } | undefined;
    try {
      // An account or provider that is not set up, or a plugin that cannot run
      // (missing, waiting for approval, no OS sandbox), fails the run now, not halfway.
      for (const a of Object.values(this.team.agents)) {
        try {
          checkBackend(a.backend, this.opts.connections);
          resolvePlugins(a.plugins);
        } catch (err) {
          throw new StepError(`${a.name}: ${(err as Error).message}`);
        }
      }
      let i = from?.index ?? 0;
      while (i < steps.length) {
        this.opts.signal?.throwIfAborted();
        const step = steps[i]!;
        this.emit({ type: 'step.started', step: step.id, data: { loop: this.context.loop } });
        const output = await this.runStep(step);
        this.context[step.id] = output;
        // The report goes into the log too, so the plan and every other report can be read while the run goes.
        const agents = step.kind === 'agent' ? [step.agent] : Object.keys(output as object);
        this.emit({ type: 'step.finished', step: step.id, data: { loop: this.context.loop, agents, parallel: step.kind === 'parallel', output: clipReport(output) } });
        // A report that lists tasks (the plan) becomes the run's todo list.
        const planned = step.kind === 'agent' ? planTasksOf(output) : undefined;
        if (planned && step.kind === 'agent') this.board.plan(planned, { step: step.id, agent: step.agent }, 'report');

        if (step.gate) {
          const { passed, value } = await evaluateGate(step.gate, this.context);
          if (passed) {
            this.emit({ type: 'gate.passed', step: step.id, data: { gate: step.gate } });
          } else {
            this.emit({ type: 'gate.failed', step: step.id, data: { gate: step.gate, value: value ?? null } });
            const policy = step.onGateFail;
            if (!policy) {
              status = 'failed';
              reason = `gate "${step.gate}" failed on step ${step.id} and the step has no on_gate_fail policy`;
              break;
            }
            if (this.context.loop >= policy.maxLoops) {
              status = policy.then === 'escalate_to_human' ? 'escalated' : 'failed';
              reason = `gate "${step.gate}" on step ${step.id} still failing after ${this.context.loop} fix round(s)`;
              break;
            }
            const feedback: Record<string, unknown> = {};
            for (const expr of policy.feed) feedback[expr] = (await evaluate(expr, this.context)) ?? null;
            this.context.loop += 1;
            this.context.feedback = feedback;
            this.maxLoops = policy.maxLoops;
            this.emit({ type: 'loop.goto', step: step.id, data: { to: policy.goto, loop: this.context.loop, max_loops: policy.maxLoops, feedback } });
            i = steps.findIndex((s) => s.id === policy.goto);
            continue;
          }
        }
        i += 1;
      }
    } catch (err) {
      status = 'failed';
      reason = this.opts.signal?.aborted ? 'aborted' : (err as Error).message;
      if (err instanceof LimitError) limit = { resets_at: err.resetsAt ?? null };
    }
    this.store.cancelQuestions(this.runId);

    // Members' proposals from this run (and earlier ones) go to the curator.
    const { curator, curate: when } = this.team.brain;
    // Waiting for a batch of proposals saves a curation session per run.
    if (curator && when === 'after_run' && !this.opts.signal?.aborted && this.store.proposals('pending').length >= this.team.brain.minProposals) {
      try {
        await curate({ team: this.team, store: this.store, runner: this.opts.runner, repo: this.workspace.repo, runId: this.runId, buildInvocation, env: this.opts.env, connections: this.opts.connections, signal: this.opts.signal });
      } catch (err) {
        this.emit({ type: 'agent.error', step: 'curate', agent: curator, data: { ok: false, error: (err as Error).message } });
      }
    }

    this.store.finishRun(this.runId, status);
    this.emit({
      type: 'run.finished',
      data: { status, reason, branch: this.workspace.branch, loops: this.context.loop, cost_usd: this.costUsd, feedback: this.context.feedback, ...(limit ? { limit } : {}) },
    });
    return { runId: this.runId, status, reason, branch: this.workspace.branch, context: this.context, costUsd: this.costUsd };
  }

  private async runStep(step: Step): Promise<unknown> {
    if (step.kind === 'agent') {
      const task = step.task ? await evaluate(step.task, this.context) : undefined;
      return this.invoke(step.agent, step, task, step.outputSchema);
    }

    const output: Record<string, unknown> = {};
    // Continuing a run: branches that finished before it stopped keep their reports.
    const done = this.from && this.team.steps[this.from.index] === step && this.context.loop === this.from.context.loop ? this.from.done : {};
    const runBranch = async (b: Branch) => {
      if (b.agent in done) {
        output[b.agent] = done[b.agent];
        this.emit({ type: 'step.skipped', step: step.id, agent: b.agent, data: { reason: 'finished before the run stopped' } });
        return;
      }
      const task = b.task ? await evaluate(b.task, this.context) : undefined;
      if (b.task && (task == null || (Array.isArray(task) && task.length === 0))) {
        this.emit({ type: 'step.skipped', step: step.id, agent: b.agent, data: { reason: 'no task', task_expr: b.task } });
        return;
      }
      output[b.agent] = await this.invoke(b.agent, step, task, b.outputSchema);
      // Kept so a run that stops in this step can continue without this branch.
      this.emit({ type: 'step.branch_finished', step: step.id, agent: b.agent, data: { loop: this.context.loop, output: clipReport(output[b.agent]) } });
    };
    // Let every branch finish (and merge its work) before reporting a failure.
    const results = await Promise.allSettled(step.branches.map(runBranch));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    return output;
  }

  private async invoke(agentName: string, step: Step, task: unknown, outputSchema: JsonSchema | undefined): Promise<unknown> {
    const agent = this.team.agents[agentName]!;
    // Nothing new starts while a question waits for the human.
    await this.pause.wait(this.opts.signal);
    const release = await this.slots.acquire();
    // The todo list: this member's tasks for the step are being worked on until it hands the step in.
    const by = { step: step.id, agent: agent.name };
    const tasks = this.tasksFor(agent.name, task);
    this.board.set(tasks, 'working', by, undefined, true);
    const still = () => tasks.filter((id) => this.board.get(id)?.status === 'working');
    try {
      const note = this.resumeNotes.delete(agent.name) ? RESUME_NOTE : '';
      const result = await this.work(agent, step.id, outputSchema, (messages) =>
        note + turnPrompt({
          goal: this.goalText,
          stepId: step.id,
          loop: this.context.loop,
          maxLoops: this.maxLoops,
          instructions: step.instructions,
          task,
          feedback: this.context.feedback,
          messages,
          structured: !!outputSchema,
        }),
      );
      const report = this.output(agent, step.id, result, outputSchema);
      this.board.set(still(), 'done', by, undefined, true);
      return report;
    } catch (err) {
      this.board.set(still(), 'open', by, undefined, true);
      throw err;
    } finally {
      release();
    }
  }

  /** The tasks on the todo list a member's step is about: those its task hands it, or else its own that are not done. */
  private tasksFor(agent: string, task: unknown): string[] {
    if (!this.board.size) return [];
    const given = task === undefined ? [] : this.board.match(task);
    return given.length ? given : this.board.owned(agent).filter((t) => t.status !== 'done').map((t) => t.id);
  }

  /** Whether a member writes the todo list in this step: a planning step (or the lead's first step) whose report does not list tasks itself. */
  private plans(agent: AgentConfig, stepId: string, outputSchema: JsonSchema | undefined): boolean {
    const planning = /^plan(ning)?$/i.test(stepId) || (this.team.lead === agent.name && this.team.steps[0]?.id === stepId);
    const listsTasks = !!(outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.tasks;
    return planning && !listsTasks;
  }

  /**
   * One turn of a member, for a workflow step or a teammate's request (both
   * labelled with `stepId`): its workspace and inbox, the plan's usage limit,
   * and committing and merging what it changed. Throws a StepError when the
   * turn fails.
   */
  private async work(
    agent: AgentConfig,
    stepId: string,
    outputSchema: JsonSchema | undefined,
    prompt: (messages: InboxMessage[]) => string,
    request?: { id: number; from: string },
  ): Promise<AgentResult & { files: string[] }> {
    const base = { step: stepId, agent: agent.name };
    const connections = this.opts.connections;
    const balanced = isBalanced(agent, connections);
    const releaseMember = await this.member(agent.name).acquire();
    let unclaim = () => {};
    try {
      let built = await this.environment(agent, base, balanced ? await connections!.pick() : undefined);
      const claim = () => {
        const account = accountOf(built);
        unclaim = balanced && account ? connections!.claim(account) : () => {};
      };
      claim();
      const cwd = await this.workspace.prepare(agent.name, agent.writes);
      const messages = this.store.drainInbox(this.runId, agent.name);
      for (const m of messages) this.emit({ ...base, type: 'message.delivered', data: { id: m.id, from: m.from } });

      const previous = this.store.getSession(this.runId, agent.name);
      const resume = previous && previous.cwd === cwd ? previous.sessionId : undefined;
      const planning = !request && this.plans(agent, stepId, outputSchema);
      const todo = boardPrompt(this.board, agent.name, true);
      const text = [prompt(messages), todo, planning ? PLAN_NOTE : undefined].filter(Boolean).join('\n\n');
      const requested = request ? { request: request.id, request_from: request.from } : {};

      this.emit({
        ...base,
        type: 'agent.started',
        data: { model: agent.model ?? null, backend: agent.backend.type, via: built.via, cwd, resumed: !!resume, loop: this.context.loop, ...requested },
      });
      const turn = (p: { prompt: string; resume?: string }) =>
        this.runAgent(agent, { cwd, ...p, env: built.env, pricing: built.pricing, account: accountOf(built), via: built.via, outputSchema, step: stepId, planning });
      /** Move this member to another account. */
      const move = async (account: string) => {
        unclaim();
        built = await this.environment(agent, base, account);
        claim();
      };
      let result = await turn({ prompt: text, resume });
      // The plan's usage limit stopped the turn: move on to another account
      // (when sharing them), or wait for the reset and pick the session up
      // again (or stop the run).
      const waitedSince = Date.now();
      while (result.limit) {
        this.costUsd += result.costUsd;
        if (result.sessionId) this.store.saveSession(this.runId, agent.name, result.sessionId, cwd);
        const resetsAt = resetIso(result.limit.resetsAt);
        const limited = { ...finishedData(agent, result, built.via), resets_at: resetsAt ?? null, window: result.limit.window ?? null };
        // A session to pick up continues; without one the turn starts over.
        const again = { prompt: result.sessionId ? LIMIT_RESUME : text, resume: result.sessionId ?? resume };
        const account = accountOf(built);
        if (balanced && account) {
          connections!.exhausted(account, result.limit.resetsAt);
          const next = await connections!.pick();
          if (next) {
            this.emit({ ...base, type: 'agent.limited', data: { ...limited, waiting: false, until: null, switched_to: next } });
            await move(next);
            this.emit({ ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: agent.backend.type, via: built.via, cwd, resumed: !!result.sessionId, after_limit: true, switched: true, loop: this.context.loop, ...requested } });
            result = await turn({ ...again, prompt: result.sessionId ? LIMIT_SWITCH : text });
            continue;
          }
        }
        const stop = this.opts.onLimit === 'stop' || Date.now() - waitedSince > MAX_LIMIT_WAIT_MS;
        let until = resetsAt ? Math.max(Date.parse(resetsAt) + LIMIT_GRACE_MS, Date.now() + 2_000) : Date.now() + LIMIT_RETRY_MS;
        // Sharing accounts: wait only until the first one comes free.
        const free = balanced ? connections!.nextFree() : undefined;
        if (free) until = Math.min(until, Math.max(free + LIMIT_GRACE_MS, Date.now() + 2_000));
        this.emit({ ...base, type: 'agent.limited', data: { ...limited, waiting: !stop, until: stop ? null : new Date(until).toISOString() } });
        if (stop) throw new LimitError(`${agent.name} hit the plan's usage limit on step ${stepId}${resetsAt ? `; it resets at ${resetsAt}` : ''}`, resetsAt);
        await sleep(until - Date.now(), this.opts.signal);
        if (balanced) {
          const next = await connections!.pick();
          if (next && next !== account) await move(next);
        }
        this.emit({ ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: agent.backend.type, via: built.via, cwd, resumed: !!result.sessionId, after_limit: true, loop: this.context.loop, ...requested } });
        result = await turn(again);
      }
      this.costUsd += result.costUsd;
      if (result.sessionId) this.store.saveSession(this.runId, agent.name, result.sessionId, cwd);

      const finished = finishedData(agent, result, built.via);
      if (!result.ok) {
        this.emit({ ...base, type: 'agent.error', data: finished });
        throw new StepError(`${agent.name} failed on step ${stepId}: ${result.error ?? 'unknown error'}`);
      }
      this.emit({ ...base, type: 'agent.finished', data: finished });

      if (this.team.brain.curator === agent.name) {
        const commit = await commitBrain(this.workspace.repo, `${agent.name} during ${stepId}`, agent.name);
        if (commit) this.emit({ ...base, type: 'brain.updated', data: { commit } });
      }
      let files: string[] = [];
      if (agent.writes) {
        const label = request ? `${stepId}: ${agent.name} for ${request.from} (request ${request.id})` : `${stepId}: ${agent.name} (round ${this.context.loop})`;
        const c = await this.workspace.collect(agent.name, agent.writeScope, label);
        for (const e of collectEvents(c, agent, this.workspace.branch)) this.emit({ ...base, ...e });
        files = c.files;
      }
      return { ...result, files };
    } finally {
      this.workspace.release(agent.name);
      releaseMember();
      unclaim();
    }
  }

  private stepAgents(step: Step): string[] {
    return step.kind === 'agent' ? [step.agent] : step.branches.map((b) => b.agent);
  }

  private member(name: string): Semaphore {
    let s = this.members.get(name);
    if (!s) this.members.set(name, (s = new Semaphore(1)));
    return s;
  }

  /** Resolve a member's environment (on `account` when balancing chose one), reporting backend warnings once. */
  private async environment(agent: AgentConfig, base: { step: string; agent: string }, account?: string | null): Promise<BackendEnv> {
    const backend = account ? { ...agent.backend, account } : agent.backend;
    try {
      const built = await resolverOf(this.opts.connections).resolve(backend, this.opts.env ?? process.env);
      for (const w of built.warnings) {
        if (!this.warned.has(w)) {
          this.warned.add(w);
          this.emit({ ...base, type: 'backend.warning', data: { message: w } });
        }
      }
      return built;
    } catch (err) {
      if (err instanceof BackendError) throw new StepError(`${agent.name}: ${err.message}`);
      throw err;
    }
  }

  private async runAgent(
    agent: AgentConfig,
    p: { cwd: string; prompt: string; resume?: string; env: Env; pricing?: BackendEnv['pricing']; account?: string; via?: string; outputSchema?: JsonSchema; step: string; planning?: boolean },
  ): Promise<AgentResult> {
    // The time limit does not count while the member waits for an answer or the run is paused.
    const deadline = new Deadline(agent.limits.timeout_min * 60_000);
    const untrack = this.pause.track(deadline);
    const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, deadline.signal]) : deadline.signal;
    const inv = buildInvocation(this.team, this.store, this.runId, agent, {
      ...p,
      root: this.workspace.isolation === 'none' ? this.workspace.repo : p.cwd,
      signal,
      repo: this.workspace.repo,
      folder: !!this.workspace.folder,
      extraTools: [
        this.askTool(agent.name, p.step, deadline),
        ...(agent.canRequest.length ? [this.requestTool(agent, p.step, deadline)] : []),
        ...(p.planning ? [planTasksTool(this.board, Object.values(this.team.agents).filter((a) => a.name !== agent.name), { step: p.step, agent: agent.name })] : []),
        // Tools are fixed for the turn: a planner gets update_task with plan_tasks, so it can mark progress on the list it writes.
        ...(this.board.size || p.planning ? [updateTaskTool(this.board, agent.name, this.team.lead === agent.name || !!p.planning, p.step)] : []),
      ],
      // A paused run holds working members at their next tool call.
      beforeToolUse: () => this.pause.wait(signal),
    });
    try {
      // Stop live delivery even if a runner forgets to signal the end of its turn.
      return await this.opts.runner.run(inv).finally(() => inv.onControl?.(null));
    } finally {
      untrack();
      deadline.dispose();
    }
  }

  private askTool(from: string, step: string, deadline: Deadline): CustomTool {
    const lead = this.team.lead && this.team.lead !== from ? this.team.lead : undefined;
    return {
      name: ASK_TOOL,
      description: lead
        ? `Ask ${lead}, the team lead, for a decision you cannot make yourself. If ${lead} cannot answer, the question goes to the human and the whole run pauses until they reply. Returns the answer.`
        : 'Ask the human for a decision you cannot make yourself. The whole run pauses until they reply. Returns their answer.',
      params: {
        question: { type: 'string', description: 'What you need decided, with the options you see, so it can be answered without seeing your work.' },
        context: { type: 'string', optional: true, description: 'What you found or tried, the files involved, and what you would do by default.' },
        options: { type: 'list', optional: true, description: 'When it is a choice: the answers to pick from (2 to 8, short). Any other answer is still possible.' },
      },
      run: (args) => {
        const context = typeof args.context === 'string' && args.context.trim() ? args.context.trim() : undefined;
        return this.ask(from, step, String(args.question ?? '').trim(), context, questionOptions(args.options), deadline);
      },
    };
  }

  /** A member's question: the lead first, then the human (pausing the run). Returns the text the member sees. */
  private async ask(from: string, step: string, text: string, context: string | undefined, options: string[] | undefined, deadline: Deadline): Promise<string> {
    if (!text) throw new Error('the question is empty');
    const lead = this.team.lead && this.team.lead !== from ? this.team.lead : undefined;
    const release = deadline.hold();
    try {
      const { id } = this.store.addQuestion({ runId: this.runId, from, text, context, options, status: lead ? 'lead' : 'open' });
      this.emit({ step, agent: from, type: 'question.asked', data: { id, question: text, context: context ?? null, options: options ?? null, to: lead ?? 'human' } });
      if (lead) {
        const verdict = await this.consultLead(lead, from, step, text, context, options);
        if ('answer' in verdict) {
          this.store.answerQuestion(id, verdict.answer, lead);
          this.emit({ step, agent: from, type: 'question.answered', data: { id, by: lead, answer: verdict.answer } });
          return `Answer from ${lead}:\n${verdict.answer}`;
        }
        // A rephrased question comes with the lead's own options; otherwise the member's still fit.
        const choices = verdict.options ?? (verdict.forHuman === text ? options : undefined);
        this.store.escalateQuestion(id, verdict.forHuman, verdict.note, choices);
        this.emit({ step, agent: lead, type: 'question.escalated', data: { id, from, question: verdict.forHuman, reason: verdict.note ?? null, options: choices ?? null } });
      }
      this.pause.add(id);
      try {
        const answered = await waitForAnswer(this.store, id, this.opts.signal);
        return `Answer from the human:\n${answered.answer}`;
      } finally {
        this.pause.remove(id);
      }
    } finally {
      release();
    }
  }

  private requestTool(from: AgentConfig, step: string, deadline: Deadline): CustomTool {
    const names = from.canRequest;
    const who = names.map((n) => (this.team.agents[n]?.description ? `${n} (${this.team.agents[n]!.description})` : n)).join(', ');
    return {
      name: REQUEST_TOOL,
      description: `Ask a teammate to do work for you: ${who}. They work on it in a turn of their own; their changes are committed and merged, so you can use them, and their reply is this tool's answer. You wait until they finish. Use it when their part would help; you do not have to.`,
      params: {
        to: { type: 'string', enum: names, description: 'The teammate to ask.' },
        request: { type: 'string', description: 'What you need from them, specific enough to do without seeing your work: what to make or decide, where it should go, and what you will do with it.' },
        context: { type: 'string', optional: true, description: 'What they should know: the files involved, constraints, what you have so far.' },
      },
      run: (args) => {
        const context = typeof args.context === 'string' && args.context.trim() ? args.context.trim() : undefined;
        return this.request(from, step, String(args.to ?? ''), String(args.request ?? '').trim(), context, deadline);
      },
    };
  }

  /** A member asks a teammate for work and waits for its reply. Returns the text the member sees. */
  private async request(from: AgentConfig, step: string, to: string, text: string, context: string | undefined, deadline: Deadline): Promise<string> {
    if (!from.canRequest.includes(to)) throw new Error(`you cannot request work from ${to || 'nobody'}; you can ask ${from.canRequest.join(', ')}`);
    if (!text) throw new Error('the request is empty');
    const cycle = this.chains.cycle(from.name, to);
    if (cycle) throw new Error(`${cycle.join(' → ')} ${cycle.length > 1 ? 'are' : 'is'} waiting for you, so ${to} cannot take a request now. Finish your part, or send_message it if you can.`);
    const target = this.team.agents[to]!;
    const id = ++this.requests;
    const base = { step, agent: from.name };
    const release = deadline.hold();
    const done = this.chains.wait(from.name, to);
    this.emit({ ...base, type: 'request.sent', data: { id, to, request: text, context: context ?? null } });
    try {
      await this.pause.wait(this.opts.signal);
      const result = await this.work(target, step, undefined, (messages) => requestPrompt({ goal: this.goalText, from: from.name, to, request: text, context, messages }), { id, from: from.name });
      const reply = result.text.trim() || '(no reply)';
      // A member working in a worktree of its own gets the teammate's changes right away.
      const synced = result.files.length && from.writes ? await this.workspace.refresh(from.name) : true;
      this.emit({ ...base, type: 'request.done', data: { id, to, ok: true, reply: clip(reply, 4000), files: result.files } });
      const files = result.files.length
        ? synced
          ? `\n\n${to} changed: ${result.files.join(', ')}. The changes are merged into your working folder.`
          : `\n\n${to} changed: ${result.files.join(', ')}. They could not be merged into your working folder while you have changes there; read them in ${this.workspace.integrationDir} (you get them in your folder at your next turn).`
        : '';
      return `Reply from ${to}:\n${reply}${files}`;
    } catch (err) {
      this.opts.signal?.throwIfAborted();
      const error = (err as Error).message;
      this.emit({ ...base, type: 'request.done', data: { id, to, ok: false, error } });
      // The asking member decides what to do without it; its own step goes on.
      throw new Error(`${to} could not finish your request: ${error}`);
    } finally {
      done();
      release();
    }
  }

  /**
   * The lead answers in a read-only copy of its session from this run, so it
   * knows the plan without its own session being touched. If anything goes
   * wrong, the question goes on to the human.
   */
  private async consultLead(leadName: string, from: string, step: string, question: string, context: string | undefined, options: string[] | undefined): Promise<LeadVerdict> {
    const lead = readOnly(this.team.agents[leadName]!);
    const base = { step: QUESTION_STEP, agent: leadName };
    const passOn = (why: string): LeadVerdict => ({ forHuman: question, note: `${leadName} could not answer: ${why}`, options });
    try {
      const account = isBalanced(lead, this.opts.connections) ? await this.opts.connections!.pick() : undefined;
      const built = await resolverOf(this.opts.connections).resolve(account ? { ...lead.backend, account } : lead.backend, this.opts.env ?? process.env);
      const session = this.store.getSession(this.runId, leadName);
      const cwd = session?.cwd ?? (await this.workspace.prepare(leadName, false));
      this.emit({ ...base, type: 'agent.started', data: { model: lead.model ?? null, backend: lead.backend.type, via: built.via, cwd, resumed: !!session, question: true } });
      const timeout = AbortSignal.timeout(lead.limits.timeout_min * 60_000);
      const inv = buildInvocation(this.team, this.store, this.runId, lead, {
        cwd,
        root: this.workspace.isolation === 'none' ? this.workspace.repo : cwd,
        folder: !!this.workspace.folder,
        prompt: leadPrompt({ goal: this.goalText, lead: leadName, from, step, question, context, options }),
        resume: session?.sessionId,
        fork: true,
        env: built.env,
        pricing: built.pricing,
        account: accountOf(built),
        via: built.via,
        outputSchema: LEAD_SCHEMA,
        step: QUESTION_STEP,
        signal: this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout,
        repo: this.workspace.repo,
      });
      const result = await this.opts.runner.run(inv).finally(() => inv.onControl?.(null));
      this.costUsd += result.costUsd;
      this.emit({ ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(lead, result, built.via) });
      if (!result.ok) return passOn(result.error ?? 'unknown error');
      return leadVerdict(result.structured ?? extractJson(result.text), question);
    } catch (err) {
      this.opts.signal?.throwIfAborted();
      return passOn((err as Error).message);
    }
  }

  private output(agent: AgentConfig, stepId: string, result: AgentResult, schema: JsonSchema | undefined): unknown {
    if (!schema) return { text: result.text };
    const value = result.structured ?? extractJson(result.text);
    let validate = this.validators.get(schema);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.validators.set(schema, validate);
    }
    if (value === undefined || !validate(value)) {
      const why = value === undefined ? 'no structured output' : this.ajv.errorsText(validate.errors);
      throw new StepError(`${agent.name} on step ${stepId}: report does not match its output schema (${why})`);
    }
    return value;
  }
}

/** Members on the subscription without an account of their own share the Claude accounts (when balancing is on). */
export function isBalanced(agent: AgentConfig, connections: Connections | undefined): boolean {
  return !!connections && agent.backend.type === 'subscription' && !agent.backend.account;
}

/** Throws when a backend names an account or connection that is not set up. */
export function checkBackend(backend: AgentConfig['backend'], connections: Connections | undefined): void {
  if (connections) return connections.check(backend);
  if (backend.type === 'connection') throw new BackendError(`connection "${backend.connection}" is not set up (Settings → Advanced)`);
  if (backend.type === 'subscription' && backend.account && backend.account !== MAIN_ACCOUNT) throw new BackendError(`Claude account "${backend.account}" is not set up (Settings → Advanced)`);
}

/**
 * The member's prompt-cache lifetime, for Claude Code. Only Anthropic's API
 * knows it: a member pointed elsewhere (another provider, the OpenAI
 * translator, a gateway) is left alone.
 */
export function withCacheTtl(env: Env, ttl: AgentConfig['cacheTtl']): Env {
  if (!ttl) return env;
  const base = env.ANTHROPIC_BASE_URL;
  if (base) {
    try {
      if (!/(^|\.)anthropic\.com$/.test(new URL(base).hostname)) return env;
    } catch {
      return env;
    }
  }
  return { ...env, CLAUDE_CODE_PROMPT_CACHE_TTL: ttl };
}

/** The backends a run, chat or curation resolves agent environments with. */
export function resolverOf(connections: Connections | undefined): BackendResolver {
  return connections ?? plainBackends;
}

/** Which Claude account a resolved environment uses ("main" for your own login), if it is on the subscription. */
export function accountOf(built: BackendEnv): string | undefined {
  return built.via === 'claude' ? MAIN_ACCOUNT : built.via.startsWith('claude:') ? built.via.slice(7) : undefined;
}

/**
 * Wire one agent turn to the event stream, the scope checker and the team
 * inbox. Shared by workflow steps and direct chat.
 */
export function buildInvocation(
  team: TeamConfig,
  store: EventStore,
  runId: string,
  agent: AgentConfig,
  p: {
    cwd: string;
    root: string;
    prompt: string;
    resume?: string;
    env: Env;
    /** Prices for a provider's model (see BackendEnv.pricing). */
    pricing?: BackendEnv['pricing'];
    /** The Claude account the turn runs on, for its usage reports. */
    account?: string;
    /** The account or connection it runs on (BackendEnv.via), for live spend. */
    via?: string;
    outputSchema?: JsonSchema;
    step: string;
    signal: AbortSignal;
    /** The project, for its brain. */
    repo?: string;
    extraTools?: CustomTool[];
    /** A curation pass (the curator edits the brain and decides proposals). */
    curating?: boolean;
    /** Resume into a copy of the session (see AgentInvocation.forkSession). */
    fork?: boolean;
    beforeToolUse?: () => Promise<void>;
    /** The member works directly in a plain folder (no git): `root` is that folder. */
    folder?: boolean;
  },
): AgentInvocation {
  const base = { step: p.step, agent: agent.name };
  const emit = (e: NewEvent) => store.append(runId, e);
  let stopLive: (() => void) | undefined;
  const brain = p.repo ? brainRoot(p.repo) : undefined;
  const isCurator = !!brain && team.brain.curator === agent.name;
  const tools: CustomTool[] = [...(brain && !isCurator && !p.curating ? [proposeTool(store, runId, agent.name, p.step)] : []), ...(p.extraTools ?? [])];
  if (agent.browser) {
    tools.push(
      ...browserTools({
        hub: browserHub,
        runId,
        agent: agent.name,
        root: p.cwd,
        network: agent.sandbox?.network,
        signal: p.signal,
        onChange: (c) =>
          emit(
            c.kind === 'opened'
              ? { ...base, type: 'browser.opened', data: { provider: c.provider } }
              : c.kind === 'page'
                ? { ...base, type: 'browser.page', data: { url: c.url } }
                : c.kind === 'control'
                  ? { ...base, type: 'browser.control', data: { by: c.by } }
                  : { ...base, type: 'browser.closed', data: { reason: c.reason } },
          ),
      }),
    );
  }
  if (agent.app && p.repo && !p.curating) {
    tools.push(
      ...appTools({
        hub: appHub,
        team,
        agent,
        repo: p.repo,
        runId,
        folder: p.cwd,
        signal: p.signal,
        onEvent: (e) => emit({ ...base, type: e.type, data: e.data }),
        keepAlive: () => {
          const run = store.getRun(runId);
          return !!run && store.isLive(run);
        },
      }),
    );
  }
  let sandbox = agent.sandbox && isCurator ? { ...agent.sandbox, allowWrite: [...agent.sandbox.allowWrite, brain!] } : agent.sandbox;
  // In a plain folder nothing can be thrown away after the turn, so shell commands are kept out of what the scope does not reach.
  if (sandbox && p.folder) sandbox = { ...sandbox, denyWrite: denyWritePaths(p.root, agent.writes ? agent.writeScope : []) };
  return {
    agentName: agent.name,
    prompt: p.prompt,
    systemPrompt: [systemPrompt(team, agent, { canAsk: tools.some((t) => t.name === ASK_TOOL), canRequest: tools.some((t) => t.name === REQUEST_TOOL), app: tools.some((t) => t.name === 'app_start'), folder: p.folder ? p.root : undefined }), ...(p.repo && !p.curating ? [brainPrompt(p.repo, agent, team)] : [])].join('\n\n'),
    // The brain, and the files the human gave the run (its folder exists from the first turn, so files sent later in chat are readable too).
    readDirs: [...(brain && !p.curating ? [brain] : []), ...(p.repo && !p.curating ? [ensureAttachmentsDir(p.repo, runId)] : [])],
    skills: resolveSkills(agent.skills),
    plugins: resolvePlugins(agent.plugins),
    customTools: tools.length ? tools : undefined,
    cwd: p.cwd,
    resumeSessionId: p.resume,
    forkSession: p.fork,
    model: agent.model,
    effort: agent.effort,
    thinking: agent.thinking,
    tools: agent.tools,
    outputSchema: p.outputSchema,
    env: withCacheTtl(p.env, agent.cacheTtl),
    pricing: p.pricing,
    maxTurns: agent.limits.max_turns,
    maxBudgetUsd: agent.limits.max_budget_usd,
    settingSources: team.settingSources,
    signal: p.signal,
    canMessage: agent.canMessage,
    beforeToolUse: p.beforeToolUse,
    checkToolUse: makeToolChecker({ root: p.root, cwd: p.cwd, writeScope: agent.writes ? agent.writeScope : [], extraRoots: isCurator && brain ? [brain] : undefined }),
    sendMessage: (to, text) => {
      if (!agent.canMessage.includes(to)) return `You cannot message ${to}.`;
      const m = store.enqueue(runId, to, agent.name, text, 'steer');
      emit({ ...base, type: 'message.queued', data: { id: m.id, to, text, mode: 'steer' } });
      return `Sent to ${to}. If ${to} is working it reads it between its tool calls; otherwise at the start of its next turn.`;
    },
    sandbox,
    // While the agent works, hand it steer/interrupt messages from its inbox.
    // Polling the store (not an in-memory hook) also reaches runs started by
    // another process, such as the CLI.
    onControl: (control) => {
      stopLive?.();
      stopLive = undefined;
      if (!control) return;
      const deliver = () => {
        for (const m of store.liveMessages(runId, agent.name)) {
          const text =
            m.from === 'human' ? `[Message from the human, sent while you were working]\n${m.text}` : `[Message from your teammate ${m.from}]\n${m.text}`;
          if (!control.send(text, m.mode === 'interrupt' ? 'now' : 'next')) return; // stays queued for its next turn
          store.markDelivered([m.id]);
          emit({ ...base, type: 'message.delivered', data: { id: m.id, from: m.from, live: true, mode: m.mode } });
        }
      };
      deliver();
      const timer = setInterval(deliver, 500);
      stopLive = () => clearInterval(timer);
    },
    onEvent: eventSink(store, runId, base, { account: p.account, via: p.via, model: agent.model }),
  };
}

/** For a member who writes the todo list (see Engine.plans). */
const PLAN_NOTE =
  '## Todo list\nWrite the run\'s todo list with the plan_tasks tool before you finish: the concrete tasks the goal breaks into, in order, each for the one member who will do it. People watch it live while the team works through it.';

const LIMIT_SWITCH =
  'Your last turn stopped because a usage limit was reached. You now continue on another account: pick up where you left off and finish the task as asked.';

const LIMIT_RESUME =
  "Your last turn stopped because the plan's usage limit was reached. The limit has reset: continue where you left off and finish the task as asked.";

/** Larger images are not kept (screenshots are well below this). */
const MAX_VIEW_BYTES = 10 << 20;

/**
 * Turn an agent's stream into stored events (text, tool calls, denials, plan
 * usage, running spend, images it saw). `account`: whose plan usage reports
 * belong to; `via` and `model` label the running spend.
 */
export function eventSink(store: EventStore, runId: string, base: { step?: string; agent?: string }, meta: { account?: string; via?: string; model?: string } = {}) {
  const { account } = meta;
  const emit = (e: NewEvent) => store.append(runId, e);
  return (e: AgentStreamEvent) => {
    if (e.kind === 'text') emit({ ...base, type: 'agent.text', data: { text: clip(e.text, 4000) } });
    else if (e.kind === 'tool') {
      // A browser call carries the page it goes to, read from the full input (the stored one is clipped).
      const browser = browserActivity(e.tool, e.input);
      emit({ ...base, type: 'agent.tool', data: { tool: e.tool, input: summarize(e.input), ...(browser ? { browser } : {}) } });
    } else if (e.kind === 'image' && base.agent) {
      const data = Buffer.from(e.data, 'base64');
      if (!data.length || data.length > MAX_VIEW_BYTES || !/^image\/(png|jpeg|gif|webp)$/.test(e.mediaType)) return;
      const id = store.addView(runId, base.agent, e.mediaType, data);
      const file = typeof (e.input as { file_path?: unknown })?.file_path === 'string' ? (e.input as { file_path: string }).file_path : null;
      emit({ ...base, type: 'agent.view', data: { id, tool: e.tool, file, media_type: e.mediaType, bytes: data.length } });
    }
    else if (e.kind === 'restarted') emit({ ...base, type: 'agent.restarted', data: { attempt: e.attempt, error: clip(e.error, 2000) } });
    else if (e.kind === 'denied') emit({ ...base, type: 'scope.denied', data: { tool: e.tool, input: summarize(e.input), reason: e.reason } });
    else if (e.kind === 'rate_limit') emit({ ...base, type: 'usage.limit', data: { ...e.info, ...(account ? { account } : {}) } });
    // Running totals of the turn in progress; its agent.finished (or error, or limited) replaces them.
    else if (e.kind === 'usage') store.appendLatest(runId, { ...base, type: 'agent.usage', data: { tokens: e.tokens, cost_usd: e.costUsd ?? null, model: meta.model ?? null, ...(meta.via ? { via: meta.via } : {}) } });
  };
}

/** The events for what a member's turn changed: commits and merges, or in a plain folder the files it changed. */
export function collectEvents(c: CollectResult, agent: AgentConfig, branch: string | undefined): NewEvent[] {
  const scope = agent.writeScope ?? null;
  const out: NewEvent[] = [];
  if (c.reverted.length) out.push({ type: 'scope.violation', data: { files: c.reverted, scope } });
  if (c.folder?.outside.length) out.push({ type: 'scope.violation', data: { files: c.folder.outside, scope, kept: true } });
  if (c.folder && c.files.length) out.push({ type: 'files.changed', data: { files: c.files, added: c.folder.added, modified: c.folder.modified, deleted: c.folder.deleted } });
  if (c.commit) out.push({ type: 'git.commit', data: { commit: c.commit, files: c.files } });
  if (c.merged) out.push({ type: 'git.merge', data: { into: branch } });
  return out;
}

/** Fallback for backends that return the report as text: take the last JSON object in it. */
export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  for (const candidate of [...fenced.reverse(), text]) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** A step's report as the log keeps it: long strings clipped. */
function clipReport(value: unknown): unknown {
  if (typeof value === 'string') return clip(value, 20_000);
  if (Array.isArray(value)) return value.map(clipReport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipReport(v)]));
  return value;
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
}

/** Keep tool inputs readable in the log: long strings (file contents) are clipped. */
function summarize(input: unknown): unknown {
  if (typeof input === 'string') return clip(input, 300);
  if (Array.isArray(input)) return input.slice(0, 20).map(summarize);
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, summarize(v)]));
  }
  return input;
}

class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((r) => this.waiting.push(r));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    };
  }
}
