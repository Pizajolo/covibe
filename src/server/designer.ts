// The team designer: a chat with an architect agent that sets up or changes a
// team for you. It can read your project to see the stack, and it edits the
// team only through save_team, which writes nothing unless team.yaml is valid.
import { existsSync } from 'node:fs';
import type { AgentConfig, Effort } from '../config/types.js';
import { DEFAULT_SANDBOX_NETWORK } from '../config/load.js';
import { eventSink, finishedData, newRunId } from '../engine/engine.js';
import type { EventStore } from '../events/store.js';
import { backendEnv, type Env } from '../runner/backend.js';
import type { AgentRunner, CustomTool, EnvironmentInfo } from '../runner/types.js';
import { listSkills } from '../skills.js';
import type { Library } from './library.js';

export const ARCHITECT = 'architect';
const EXAMPLES = new URL('../../examples/', import.meta.url).pathname;

const GUIDE = `You are the team architect in covibe, a desktop app where a team of Claude Code agents works on a software project. You help the user set up or change a team by talking with them, and you write the team with the save_team tool.

# How covibe teams work
A team is one team.yaml (YAML 1.2) plus Markdown prompt files and optional JSON Schema report files, all relative to the team folder. covibe enforces the file in code, not by prompting:
- Members (agents) each get a role prompt (prompts/<name>.md), a model (opus | sonnet | haiku or a model id), optionally effort (low | medium | high | xhigh | max; higher for planning and review, lower for simple checks) and thinking (adaptive | off | a token budget), built-in tools (Read, Grep, Glob, Edit, Write, Bash, WebSearch, WebFetch), optional scope.write globs (paths it may change; omit = anything in its worktree, [] = nothing), can_message (teammates it may message), output_schema (a JSON Schema file its structured report must match), skills (skill names), limits, backend.
- Each member that can write works in its own git worktree; covibe commits and merges. Shell commands are sandboxed (only its worktree, temp, package caches; only allowed domains).
- workflow.steps run in order. A step is { id, agent } or { id, parallel: [{ agent, task }] }. task is a JSONata expression over earlier reports, e.g. "plan.tasks[owner = 'frontend']". A step's output is its member's structured report (or {text}) under the step id.
- gate is a JSONata expression that must be literally true, e.g. "review.blocking_count = 0". When it fails, on_gate_fail { goto, max_loops, feed: [expressions], then: escalate_to_human | fail } loops back (workflow.on_gate_fail is the default for all gated steps). goto must be this or an earlier step.
- defaults: backend ({ type: subscription } by default), model, isolation (worktree), max_parallel (2–3 to save plan limits), limits { max_turns, timeout_min }, sandbox { network: [domains], allow_write: [folders] }, skills (for every member).
- brain: { curator: <member> } makes that member maintain the project brain (shared notes everyone reads; others propose additions). The curator needs Write or Edit.
- lead: <member> answers members' questions first (they ask with an ask_question tool); if the lead cannot answer, the question goes to the user and the run pauses. Defaults to a member named manager; null sends questions straight to the user. Make the planner the lead.
- Reserved step ids: goal, loop, feedback, question.

# Minimal example
version: 1
name: web-team
defaults:
  backend: { type: subscription }
  max_parallel: 2
agents:
  builder:
    prompt: prompts/builder.md
    model: sonnet
    tools: [Read, Edit, Write, Bash, Grep, Glob]
  reviewer:
    prompt: prompts/reviewer.md
    model: sonnet
    tools: [Read, Grep, Glob]
    output_schema: schemas/review.json
workflow:
  on_gate_fail: { goto: build, max_loops: 2, feed: [review.findings], then: escalate_to_human }
  steps:
    - { id: build, agent: builder }
    - { id: review, agent: reviewer, gate: "review.blocking_count = 0" }

A review schema: {"type":"object","additionalProperties":false,"required":["blocking_count","findings"],"properties":{"blocking_count":{"type":"integer","minimum":0},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["severity","file","message"],"properties":{"severity":{"enum":["blocking","minor"]},"file":{"type":"string"},"message":{"type":"string"}}}}}}

Full examples to read: ${EXAMPLES}feature-team, build-and-review, starter.

# How to work
- Look at the project first when there is one (README, package files, folder layout) so the team fits its stack and folders.
- Ask at most two or three short questions when something important is unclear (what kind of work, how careful, budget); otherwise propose a sensible team and say what you assumed.
- Prefer small teams (2–5 members). Give writers write scopes that match the project's folders, keep reviewers and planners read-only, and use structured reports plus gates for anything that must pass.
- Write every prompt file a member references, and every schema file. Prompts: a few concrete paragraphs about the role, what it owns and what a good report looks like.
- Always call get_team before changing an existing team. Save with save_team (the whole team.yaml plus any new or changed files). If it returns problems, fix them and save again. Never say the team is saved unless save_team said so.
- After saving, explain the team in plain language: who does what, what they may change, and when work loops back. Keep it short.
- Use list_skills to see which skills exist before assigning any.`;

export interface DesignStart {
  library: Library;
  store: EventStore;
  runner: AgentRunner;
  teamId: string;
  /** Project the team is for: the architect may read it. */
  projectPath?: string;
  model?: string;
  effort?: Effort;
  env?: Env;
  builtinSkills?: () => Promise<EnvironmentInfo['skills']>;
}

/** Start a design conversation (or continue one) and send a message. Returns at once; the reply streams as events. */
export async function design(opts: DesignStart & { runId?: string; message: string }): Promise<{ runId: string; done: Promise<void> }> {
  const { library, store } = opts;
  let run = opts.runId ? store.getRun(opts.runId) : undefined;
  if (opts.runId && !run) throw new Error(`design conversation ${opts.runId} not found`);
  if (!run) {
    run = store.createRun({ id: newRunId(), kind: 'design', team: opts.teamId, teamFile: library.teamFile(opts.teamId), repo: opts.projectPath ?? '', goal: opts.message });
    store.append(run.id, { type: 'run.started', data: { team: opts.teamId, goal: opts.message, kind: 'design', agent: ARCHITECT, steps: [] } });
  } else store.reopenRun(run.id);
  const runId = run.id;
  const teamId = run.team;
  store.append(runId, { type: 'chat.message', agent: ARCHITECT, step: 'chat', data: { from: 'human', to: ARCHITECT, text: opts.message } });

  const agent: AgentConfig = {
    name: ARCHITECT,
    prompt: GUIDE,
    model: opts.model ?? 'sonnet',
    effort: opts.effort,
    tools: ['Read', 'Grep', 'Glob'],
    canMessage: [],
    writeScope: [],
    backend: { type: 'subscription' },
    limits: { max_turns: 40, timeout_min: 20 },
    writes: false,
    skills: [],
  };
  const tools = designerTools({ ...opts, teamId, runId });
  const session = store.getSession(runId, ARCHITECT);
  const cwd = run.repo && existsSync(run.repo) ? run.repo : library.teamDir(teamId);
  const base = { step: 'chat', agent: ARCHITECT };
  const { env } = backendEnv(agent.backend, opts.env ?? process.env);
  const first = !session;
  const prompt = first
    ? `${opts.message}\n\n(The team you are working on is "${teamId}" in ${library.teamDir(teamId)}. Keep its name field as "${teamId}" unless the user asks for a new name.${run.repo ? ` The project it is for is ${run.repo} (your working folder).` : ' No project was chosen; design a general-purpose team unless the user says more.'})`
    : opts.message;

  store.append(runId, { ...base, type: 'agent.started', data: { model: agent.model ?? null, backend: 'subscription', cwd, resumed: !!session, chat: true } });
  const done = opts.runner
    .run({
      agentName: ARCHITECT,
      prompt,
      systemPrompt: GUIDE,
      cwd,
      resumeSessionId: session?.sessionId,
      model: agent.model,
      effort: agent.effort,
      tools: agent.tools,
      env,
      maxTurns: agent.limits.max_turns,
      settingSources: [],
      signal: AbortSignal.timeout(agent.limits.timeout_min * 60_000),
      canMessage: [],
      readDirs: [library.teamDir(teamId), EXAMPLES],
      customTools: tools,
      checkToolUse: () => undefined,
      sendMessage: () => 'Messaging is not available here.',
      onEvent: eventSink(store, runId, base),
    })
    .then((result) => {
      if (result.sessionId) store.saveSession(runId, ARCHITECT, result.sessionId, cwd);
      store.append(runId, { ...base, type: result.ok ? 'agent.finished' : 'agent.error', data: finishedData(agent, result) });
    })
    .catch((err) => {
      store.append(runId, { ...base, type: 'agent.error', data: { ok: false, error: (err as Error).message } });
    })
    .finally(() => store.finishRun(runId, 'succeeded'));
  return { runId, done };
}

function designerTools(opts: DesignStart & { teamId: string; runId: string }): CustomTool[] {
  const { library, store, teamId, runId } = opts;
  return [
    {
      name: 'get_team',
      description: "Read the team's current team.yaml, its problems (if any), and the list of its files.",
      params: {},
      run: () => {
        const yaml = library.readFile(teamId, 'team.yaml');
        const problems = library.check(teamId).problems;
        const files = library.files(teamId).map((f) => f.path);
        return `team.yaml:\n${yaml}\n\nProblems: ${problems.length ? problems.join('; ') : 'none'}\nFiles: ${files.join(', ')}`;
      },
    },
    {
      name: 'read_team_file',
      description: 'Read a prompt or schema file of the team, e.g. prompts/builder.md.',
      params: { path: { type: 'string', description: 'Path inside the team folder' } },
      run: (a) => library.readFile(teamId, String(a.path)),
    },
    {
      name: 'save_team',
      description:
        "Save the team: the complete team.yaml plus any prompt (.md) or schema (.json) files to create or replace. team.yaml is only written when it is valid; otherwise you get the problems to fix.",
      params: {
        yaml: { type: 'string', description: 'The complete team.yaml' },
        files: { type: 'files', description: 'Prompt and schema files to write, as [{path, content}] relative to the team folder', optional: true },
        summary: { type: 'string', description: 'One line describing what you changed, for the user' },
      },
      run: (a) => {
        const files = (a.files as { path: string; content: string }[] | undefined) ?? [];
        for (const f of files) {
          if (f.path === 'team.yaml') continue;
          if (!/^(prompts|schemas)\/[\w./-]+\.(md|json)$/.test(f.path) || f.path.includes('..')) throw new Error(`files go in prompts/*.md or schemas/*.json, not "${f.path}"`);
          library.writeFile(teamId, f.path, f.content);
        }
        const problems = library.validateText(teamId, String(a.yaml));
        if (problems.length) {
          store.append(runId, { type: 'team.saved', agent: ARCHITECT, step: 'chat', data: { valid: false, problems, summary: a.summary ?? null } });
          return `Not saved. team.yaml has problems:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix them and call save_team again. (The ${files.length} other file(s) were written.)`;
        }
        library.writeFile(teamId, 'team.yaml', String(a.yaml));
        store.append(runId, { type: 'team.saved', agent: ARCHITECT, step: 'chat', data: { valid: true, problems: [], summary: a.summary ?? null } });
        return 'Saved. The team is valid and ready to run.';
      },
    },
    {
      name: 'list_skills',
      description: 'List the skills you can assign to members: from the covibe library and built into Claude Code.',
      params: {},
      run: async () => {
        const lib = listSkills();
        const builtin = (await opts.builtinSkills?.().catch(() => [])) ?? [];
        const lines = [
          ...lib.map((s) => `- ${s.name} (library${s.everyone ? ', already given to everyone' : ''}): ${s.description}`),
          ...builtin.map((s) => `- ${s.name} (built into Claude Code): ${s.description}`),
        ];
        return lines.length ? lines.join('\n') : 'No skills available yet.';
      },
    },
    {
      name: 'sandbox_defaults',
      description: 'The websites shell commands may reach by default, to decide whether a member needs more.',
      params: {},
      run: () => DEFAULT_SANDBOX_NETWORK.join(', '),
    },
  ];
}
