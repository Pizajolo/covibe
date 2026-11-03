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
import { listPlugins } from '../plugins.js';
import { listSkills } from '../skills.js';
import type { Library } from './library.js';

export const ARCHITECT = 'architect';
const EXAMPLES = new URL('../../examples/', import.meta.url).pathname;

const GUIDE = `You are the team architect in covibe, a desktop app where a team of Claude Code agents works on a project: a software project, or a plain folder of documents, media or research (writing and editing documents, cutting video with ffmpeg, researching the web and writing up the results). You help the user set up or change a team by talking with them, and you write the team with the save_team tool.

# How covibe teams work
A team is one team.yaml (YAML 1.2) plus Markdown prompt files and optional JSON Schema report files, all relative to the team folder. covibe enforces the file in code, not by prompting:
- Members (agents) each get a role prompt (prompts/<name>.md), a model (opus | sonnet | haiku or a model id), optionally effort (low | medium | high | xhigh | max; high for planning and hard building, medium for reviewing and testing, low for simple checks: lower effort uses far fewer tokens), cache_ttl (5m | 1h; 1h for members resumed after long waits, such as builders between fix rounds) and thinking (adaptive | off | a token budget), built-in tools (Read, Grep, Glob, Edit, Write, Bash, WebSearch, WebFetch), optional scope.write globs (paths it may change; omit = anything in its worktree, [] = nothing), can_message (teammates it may message), can_request (teammates it may ask to do work for it with request_work: they run a turn of their own, even without a workflow step, and reply; good for on-call specialists such as a designer the manager or a builder may call on when needed), output_schema (a JSON Schema file its structured report must match), skills (skill names), plugins (names from the plugin library; their hooks and servers run in the OS sandbox), browser (true gives it covibe's browser to open, click through and screenshot web pages; for members who build or test websites and web apps; give it to reviewers and QA of web projects so they try the change live), app (the app tools: run the project's app so members and people can use it; on by default for members with Bash or a browser), limits, backend.
- A web project can say how to run its app in a top-level app: section (runtime: sandbox or docker; setup, e.g. npm install; command, which must listen on $PORT; in Docker an image, a dockerfile or a compose file with its service, and the port inside the container). Leave it out when covibe can tell from the project (package.json scripts, manage.py, index.html) and the user did not ask for Docker.
- In a git repository, each member that can write works in its own git worktree; covibe commits and merges. In a plain folder (no git), members work in the folder itself; covibe records what each one changes and keeps the originals so the user can undo a run, and shell commands cannot write outside the member's scope.write folders. There, give writers a scope that keeps source material read-only (e.g. footage in raw/ stays untouched, a video editor writes only final/**). Shell commands are sandboxed (only the working folder, temp, package caches; only allowed domains: add the domains a member needs, e.g. for research). Members without code to work on still use these tools: WebSearch and WebFetch for research, Bash with tools such as ffmpeg or pandoc for media and documents, skills such as pdf or docx for office files, and plugins for outside services (the Notion plugin from Anthropic's directory gives Notion tools, for writing research into a Notion page).
- workflow.steps run in order. A step is { id, agent } or { id, parallel: [{ agent, task }] }. task is a JSONata expression over earlier reports, e.g. "plan.tasks[owner = 'frontend']". A step's output is its member's structured report (or {text}) under the step id. A plan's report should list tasks[] with an id, an owner (the member who does it) and a title each: it becomes the run's todo list, which people watch live as members mark tasks working, done or blocked (a planning step without such a report writes the list with the plan_tasks tool).
- gate is a JSONata expression that must be literally true, e.g. "review.blocking_count = 0". When it fails, on_gate_fail { goto, max_loops, feed: [expressions], then: escalate_to_human | fail } loops back (workflow.on_gate_fail is the default for all gated steps). goto must be this or an earlier step. Give review findings and test failures an owner field (the member who fixes it): when every item has one, a fix round reruns only those members' branches instead of every builder.
- Every member that runs is a session of its own that starts cold and reads the project, so members cost tokens even when they have little to do. The planner (the member of a step named plan, or the lead's first step) chooses which later members a goal needs: with the select_members tool, or a members list in its plan report (add members: { type: array, items: { enum: [...] } } to the plan schema). Steps of members it leaves out and gives no task are skipped. Mark a step required: true when it must always run (say, a security review). Keep teams small and put reviewers and testers in the workflow only where they earn their cost.
- defaults: backend ({ type: subscription } by default), model, isolation (worktree), max_parallel (2–3 to save plan limits), limits { max_turns, timeout_min }, sandbox { network: [domains], allow_write: [folders] }, skills and plugins (for every member).
- backend: { type: subscription } is the user's own Claude login; { type: subscription, account: <id> } is another of their Claude accounts; { type: connection, connection: <id>, model: <model id> } runs the member on another provider's model (the model goes inside backend, never in model or defaults.model, which are for Claude models; Claude Code's tools still work). Use only the accounts and providers listed under "Accounts and providers" below; other models are less reliable than Claude on long tool-heavy work, so suggest them for simpler roles (reviewing, testing) unless the user asks otherwise.
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
- Use list_skills to see which skills exist before assigning any, and list_plugins before assigning plugins. Only assign installed plugins; to add one, the user installs it on the Plugins page.`;

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
  /** The Claude accounts and providers set up in Settings → Advanced, described for the architect. */
  connections?: () => string;
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
    canRequest: [],
    writeScope: [],
    backend: { type: 'subscription' },
    limits: { max_turns: 40, timeout_min: 20 },
    writes: false,
    skills: [],
    plugins: [],
    browser: false,
    app: false,
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
      systemPrompt: opts.connections ? `${GUIDE}\n\n${opts.connections()}` : GUIDE,
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
      name: 'list_plugins',
      description: 'List the plugins installed in the covibe plugin library, with what each adds, so you can assign them to members.',
      params: {},
      run: () => {
        const lines = listPlugins().map((p) => {
          const c = p.contents;
          const parts = [
            c.skills.length && `${c.skills.length} skill(s)`,
            c.commands.length && `${c.commands.length} command(s)`,
            c.programs.filter((x) => x.kind === 'hook').length && 'hooks',
            (c.programs.some((x) => x.kind === 'mcp') || c.remotes.some((x) => x.kind === 'mcp')) && `MCP servers (${[...c.programs, ...c.remotes].filter((x) => x.kind === 'mcp').map((x) => x.name).join(', ')})`,
            c.programs.some((x) => x.kind === 'lsp') && 'a language server',
          ].filter(Boolean);
          return `- ${p.name}${p.everyone ? ' (already given to everyone)' : ''}${p.approved ? '' : ' (waits for the user to approve an update; do not assign yet)'}: ${p.description}${parts.length ? ` [${parts.join(', ')}]` : ''}`;
        });
        return lines.length ? lines.join('\n') : 'No plugins installed yet.';
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
