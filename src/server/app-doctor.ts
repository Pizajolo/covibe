// The app doctor: an agent that finds out why a run's app does not start and
// proposes fixes, which the person applies or declines one by one in the App
// tab. It reads the app's folder, log and settings freely; everything that
// changes something is a proposal: start the app with other settings (what
// works is remembered for the project), forget what covibe remembered, or ask
// a member of the run to change the project's code (members keep their own
// write scopes and sandbox, so the doctor never edits files itself).
import { eventSink, finishedData, newRunId } from '../engine/engine.js';
import type { AgentConfig } from '../config/types.js';
import type { EventStore } from '../events/store.js';
import type { RunEvent } from '../events/types.js';
import { backendEnv, type Env } from '../runner/backend.js';
import type { AgentRunner, CustomTool } from '../runner/types.js';
import type { AppConfig } from '../apps/config.js';
import type { DoctorItem, RunAppSettings } from './api-types.js';
import type { Approvals } from './git-helper.js';
import { toolLabel } from './projections.js';

export const APP_DOCTOR = 'app-doctor';

const GUIDE = `You are the app doctor in covibe, a desktop app where teams of Claude Code agents build software. A person wants to use the app their team built (its dev server or site) in covibe's App tab, and it does not start. Find out why and get it running.

# What you know about how covibe runs the app
- It runs one command (after an optional setup command, e.g. npm install) in the run's folder: the merged result of the run (its integration worktree). Members' own worktrees are elsewhere; work they did not hand in yet is not in this folder.
- The app must listen on 127.0.0.1:$PORT (covibe picks the port and waits until it answers HTTP). HOST is 127.0.0.1.
- In the OS sandbox it writes only in its folder, its temp folder and package caches, and reaches only the team's sandbox domains. In Docker it runs in a container (the person chooses the runtime).
- Settings come from, in order: what a person gave, the team file's app: section, what last started successfully in this project (<repo>/.covibe/app.json), or what covibe detects (package.json scripts, manage.py, index.html).
- node_modules is not in git, so a fresh worktree needs an install first.

# Your tools
- Read, Grep and Glob to read the app's folder (and the team file).
- app_logs: the app's log. app_info: how it runs now, where each setting comes from, and what covibe recognised.
- propose_start: start the app with settings you choose (setup, command, port, path). The person approves it first; you get the result and the log. What starts is remembered for the project.
- propose_forget: forget what covibe remembered from last time (app.json), after the person approves.
- propose_message: ask a member of the run to change the project's code (add a script, fix a crash, add a dependency). The person approves the message first. Use it only when settings cannot fix it.

# How to work
- Look first: the log and app_info usually say what is wrong. Read package.json, the scripts and configs it points to.
- Explain briefly, in plain words, what is wrong and what you propose. Propose one change at a time and wait for its result.
- Prefer the smallest fix: settings before code. Never propose commands that delete the person's files or reach outside the folder.
- When the fix belongs in the team file (so every start uses it), say exactly what to put in its app: section; you cannot edit it yourself.
- When it runs, say so and stop.`;

/** What the doctor may do once the person approves; the server implements these. */
export interface DoctorActions {
  /** How the app runs now, where its settings come from, and what covibe recognised. */
  info(): string;
  logs(lines: number, find?: string): string;
  start(settings: AppConfig): Promise<{ ok: boolean; text: string }>;
  forget(): { ok: boolean; text: string };
  message(to: string, text: string): Promise<{ ok: boolean; text: string }>;
  /** Members of the run that can take a message. */
  members: string[];
}

export interface DoctorStart {
  store: EventStore;
  runner: AgentRunner;
  approvals: Approvals;
  project: { id: string; name: string; path: string };
  /** The run whose app it is. */
  target: { runId: string };
  /** The folder the app runs from. */
  folder: string;
  /** Extra folders it may read (the team file's). */
  readDirs?: string[];
  message: string;
  runId?: string;
  model?: string;
  env?: Env;
  signal?: AbortSignal;
  actions: DoctorActions;
}

/** The library store's conversations are keyed by project and run. */
export const doctorKey = (projectId: string, runId: string) => `${projectId}/${runId}`;

/** Start a conversation with the app doctor (or continue one) and send a message. Returns at once; the reply streams as events. */
export async function appDoctor(opts: DoctorStart): Promise<{ runId: string; done: Promise<void> }> {
  const { store, project } = opts;
  const key = doctorKey(project.id, opts.target.runId);
  let run = opts.runId ? store.getRun(opts.runId) : undefined;
  if (opts.runId && (!run || run.kind !== 'doctor' || run.team !== key)) throw new Error(`app doctor conversation ${opts.runId} not found`);
  if (!run) {
    run = store.createRun({ id: newRunId(), kind: 'doctor', team: key, teamFile: '', repo: project.path, goal: opts.message });
    store.append(run.id, { type: 'run.started', data: { kind: 'doctor', project: project.id, target: opts.target.runId, agent: APP_DOCTOR, steps: [] } });
  } else store.reopenRun(run.id);
  const runId = run.id;
  const base = { step: 'chat', agent: APP_DOCTOR };
  store.append(runId, { ...base, type: 'chat.message', data: { from: 'human', to: APP_DOCTOR, text: opts.message } });

  const agent: AgentConfig = {
    name: APP_DOCTOR,
    prompt: GUIDE,
    model: opts.model ?? 'sonnet',
    tools: ['Read', 'Grep', 'Glob'],
    canMessage: [],
    canRequest: [],
    backend: { type: 'subscription' },
    limits: { max_turns: 60, timeout_min: 45 },
    writes: false,
    skills: [],
    plugins: [],
    browser: false,
    app: false,
  };
  const session = store.getSession(runId, APP_DOCTOR);
  const prompt = `${opts.message}\n\n<app>\n${opts.actions.info()}\n</app>`;
  const signal = AbortSignal.any([AbortSignal.timeout(agent.limits.timeout_min * 60_000), ...(opts.signal ? [opts.signal] : [])]);
  const { env } = backendEnv(agent.backend, opts.env ?? process.env);

  store.append(runId, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: 'subscription', cwd: opts.folder, resumed: !!session, chat: true } });
  const done = opts.runner
    .run({
      agentName: APP_DOCTOR,
      prompt,
      systemPrompt: `${GUIDE}\n\nThe app's folder is ${opts.folder} (project "${project.name}"); it is your working folder. Members of the run: ${opts.actions.members.join(', ') || 'none'}.`,
      cwd: opts.folder,
      resumeSessionId: session?.sessionId,
      model: agent.model,
      tools: agent.tools,
      env,
      maxTurns: agent.limits.max_turns,
      settingSources: [],
      signal,
      canMessage: [],
      readDirs: opts.readDirs,
      customTools: doctorTools({ ...opts, runId, signal }),
      // Read-only: the file tools it has do not write, and nothing else is offered.
      checkToolUse: (tool) => (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(tool) ? 'The app doctor does not change files; propose a start with other settings, or a message to a member.' : undefined),
      sendMessage: () => 'Messaging is not available here; use propose_message.',
      onEvent: eventSink(store, runId, base, { model: agent.model }),
    })
    .then((result) => {
      if (result.sessionId) store.saveSession(runId, APP_DOCTOR, result.sessionId, opts.folder);
      store.append(runId, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result) });
    })
    .catch((err) => {
      store.append(runId, { ...base, type: 'agent.error', data: { ok: false, error: (err as Error).message } });
    })
    .finally(() => store.finishRun(runId, 'succeeded'));
  return { runId, done };
}

const SETTING_KEYS = ['setup', 'command', 'port', 'path'] as const;

function doctorTools(opts: DoctorStart & { runId: string; signal: AbortSignal }): CustomTool[] {
  const { store, runId, approvals, signal, actions } = opts;
  const base = { step: 'chat', agent: APP_DOCTOR };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  /** Show a proposal, wait for the person, and apply it when they say so. */
  const propose = async (data: Record<string, unknown>, apply: () => Promise<{ ok: boolean; text: string }> | { ok: boolean; text: string }): Promise<string> => {
    const { id, decision } = approvals.wait(runId, signal);
    store.append(runId, { ...base, type: 'doctor.proposed', data: { id, ...data } });
    const d = await decision;
    if (!d.run) {
      store.append(runId, { ...base, type: 'doctor.skipped', data: { id } });
      return 'The person declined it. Ask what they would prefer, or suggest another way.';
    }
    let r: { ok: boolean; text: string };
    try {
      r = await apply();
    } catch (err) {
      r = { ok: false, text: (err as Error).message };
    }
    store.append(runId, { ...base, type: 'doctor.applied', data: { id, ok: r.ok, output: r.text.length > 4000 ? `${r.text.slice(0, 4000)}…` : r.text } });
    return `The person approved it. ${r.text}`;
  };

  return [
    {
      name: 'app_info',
      description: 'How the app runs now: its status, settings and where each comes from (the team file, what ran last time, detection), what covibe changed by itself, and the problems it recognised in the log.',
      params: {},
      run: () => actions.info(),
    },
    {
      name: 'app_logs',
      description: "The end of the app's log: what its setup and start commands printed.",
      params: {
        lines: { type: 'number', optional: true, description: 'How many lines from the end (default 120, at most 400).' },
        find: { type: 'string', optional: true, description: 'Only lines containing this text (case-insensitive).' },
      },
      run: (a) => actions.logs(Math.min(400, Math.max(1, Number(a.lines) || 120)), str(a.find)),
    },
    {
      name: 'propose_start',
      description: 'Propose starting the app with these settings (fields you leave out come from the team file, last time or detection). The person approves it first; you get whether it answered and the end of its log. What starts is remembered for the project.',
      params: {
        setup: { type: 'string', optional: true, description: 'Runs first, every start (e.g. "npm install").' },
        command: { type: 'string', optional: true, description: 'Starts the app; must listen on 127.0.0.1:$PORT.' },
        port: { type: 'number', optional: true, description: 'A fixed port instead of a free one (rarely needed).' },
        path: { type: 'string', optional: true, description: 'The first page to open (default /).' },
        why: { type: 'string', description: 'What is wrong and why these settings fix it, in a sentence the person can judge.' },
      },
      run: async (a) => {
        const settings: AppConfig = {};
        for (const k of SETTING_KEYS) {
          const v = k === 'port' ? (Number.isInteger(a.port) ? a.port : undefined) : str(a[k]);
          if (v !== undefined) (settings as Record<string, unknown>)[k] = v;
        }
        if (!Object.keys(settings).length) throw new Error('give at least one setting to change (setup, command, port or path)');
        const title = settings.command ? 'Start the app with another command' : `Start the app with another ${Object.keys(settings).join(' and ')}`;
        return propose({ action: 'start', title, why: str(a.why) ?? null, settings }, () => actions.start(settings));
      },
    },
    {
      name: 'propose_forget',
      description: 'Propose forgetting what covibe remembered from the last successful start in this project (.covibe/app.json), so the team file or detection is used. The person approves it first.',
      params: { why: { type: 'string', description: 'Why it should be forgotten.' } },
      run: (a) => propose({ action: 'forget', title: 'Forget what ran last time (.covibe/app.json)', why: str(a.why) ?? null }, () => actions.forget()),
    },
    {
      name: 'propose_message',
      description: "Propose asking a member of the run to change the project's code, when settings cannot fix it. The person approves the message first; the member works within its own write scope.",
      params: {
        to: { type: 'string', description: `The member (${actions.members.join(', ') || 'none'}).`, enum: actions.members.length ? actions.members : undefined },
        message: { type: 'string', description: 'What to change and why, with the error, so the member can act on it alone.' },
        why: { type: 'string', optional: true, description: 'For the person: why this member.' },
      },
      run: async (a) => {
        const to = str(a.to);
        const message = str(a.message);
        if (!to || !actions.members.includes(to)) throw new Error(`"to" must be one of: ${actions.members.join(', ') || '(no members)'}`);
        if (!message) throw new Error('give the message');
        return propose({ action: 'message', title: `Ask ${to} to change the code`, why: str(a.why) ?? null, to, message }, () => actions.message(to, message));
      },
    },
  ];
}

/** The conversation as the App tab shows it. */
export function doctorThread(events: RunEvent[], waiting: Set<string>): DoctorItem[] {
  const items: DoctorItem[] = [];
  const proposals = new Map<string, Extract<DoctorItem, { kind: 'proposal' }>>();
  for (const e of events) {
    const d = e.data as Record<string, any>;
    const at = { id: e.id, ts: e.ts };
    if (e.type === 'chat.message' && d.from === 'human') items.push({ ...at, kind: 'human', text: String(d.text) });
    else if (e.type === 'agent.text') items.push({ ...at, kind: 'agent', text: String(d.text) });
    else if (e.type === 'agent.tool') {
      const tool = String(d.tool);
      if (!/__propose_\w+$/.test(tool)) items.push({ ...at, kind: 'tool', text: toolLabel(tool, d.input) });
    } else if (e.type === 'scope.denied') items.push({ ...at, kind: 'note', text: `Not allowed: ${d.reason}` });
    else if (e.type === 'agent.error') items.push({ ...at, kind: 'error', text: String(d.error ?? 'failed') });
    else if (e.type === 'doctor.proposed') {
      const item: Extract<DoctorItem, { kind: 'proposal' }> = {
        ...at,
        kind: 'proposal',
        proposal: String(d.id),
        action: d.action,
        title: String(d.title),
        ...(d.why ? { why: String(d.why) } : {}),
        ...(d.settings ? { settings: d.settings as RunAppSettings } : {}),
        ...(d.to ? { to: String(d.to), message: String(d.message ?? '') } : {}),
        state: waiting.has(String(d.id)) ? 'waiting' : 'expired',
      };
      proposals.set(item.proposal, item);
      items.push(item);
    } else if (e.type === 'doctor.skipped') {
      const p = proposals.get(String(d.id));
      if (p) p.state = 'skipped';
    } else if (e.type === 'doctor.applied') {
      const p = proposals.get(String(d.id));
      if (p) Object.assign(p, { state: 'applied', ok: !!d.ok, output: String(d.output ?? '') });
    }
  }
  return items;
}
