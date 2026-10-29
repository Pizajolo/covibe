import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ConfigError, loadTeam } from './config/load.js';
import { chat } from './engine/chat.js';
import { cleanupWorktrees } from './engine/cleanup.js';
import { folderDiff, isFolderRun, undoFolderRun } from './engine/folder.js';
import type { DeliveryMode, RunEvent } from './events/types.js';
import { runTeam } from './engine/engine.js';
import { browserHub } from './browser/hub.js';
import { answerQuestion } from './engine/questions.js';
import { EventStore } from './events/store.js';
import { bold, dim, formatEvent, formatRun, green, QUIET_EVENTS, red, yellow } from './format.js';
import { ClaudeSdkRunner } from './runner/claude-sdk.js';
import { Connections, loginCommand, openInBrowser } from './connections/store.js';

/** Accounts and providers from Settings → Advanced, shared with the app. */
function openConnections(runner: ClaudeSdkRunner): Connections {
  const connections = new Connections();
  connections.usageReader = (env) => runner.usage(env);
  return connections;
}

const USAGE = `covibe — YAML-defined agent teams on the Claude Agent SDK

Usage:
  covibe validate [team.yaml]                  Check a team file against the schema
  covibe run [team.yaml] --goal "<text>"       Run the team's workflow on a goal
  covibe runs                                  List recent runs
  covibe log <run> [--follow] [--json]         Show a run's event log
  covibe chat <run> <agent> <message...>       Talk to an agent of a run
        [--now | --interrupt]                 (live run: reach it while it works / stop it)
  covibe answer <run> [<question> <answer...>] Answer a member's question (without one: list them)
  covibe changes <run>                         List what a run in a plain folder changed
  covibe undo <run>                            Put a plain folder back the way it was before a run
  covibe clean [--older-than <days>] [--run <id>] [--dry-run]
                                               Remove worktrees of finished runs
  covibe app [--port <n>] [--no-open]          Open the covibe app in your browser
  covibe connections                           List accounts and providers (Settings → Advanced)
  covibe login <account>                       Sign in one of those Claude or ChatGPT accounts

Options:
  --repo <dir>   Repository or folder the team works on (default: current directory)
  --goal <text>  What the team should achieve (run)
  --goal-file <path>  Read the goal from a file (run)
  -h, --help     Show this help

In a folder without git, members work in the folder itself. covibe records
what each one changes and keeps the originals, so \`covibe undo\` can revert a run.

A message to an agent of a live run is queued for its next turn; after the run
has ended, the agent's session is resumed and it answers immediately.

Members ask the team lead when they need a decision. If the lead cannot answer,
the question comes to you and the run pauses until you reply: in the terminal
running it, in the app, or with \`covibe answer\`.`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      goal: { type: 'string' },
      'goal-file': { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      now: { type: 'boolean' },
      interrupt: { type: 'boolean' },
      'older-than': { type: 'string' },
      run: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }

  try {
    switch (command) {
      case 'validate':
        return validate(args[0]);
      case 'run':
        return await run(args[0], values);
      case 'runs':
        return runs(values.repo);
      case 'log':
        return await log(args[0], values);
      case 'chat':
        return await chatCommand(args, values.repo, values.interrupt ? 'interrupt' : values.now ? 'steer' : 'queue');
      case 'answer':
        return answerCommand(args, values.repo);
      case 'changes':
        return await changes(args[0], values.repo);
      case 'undo':
        return await undo(args[0], values.repo);
      case 'clean':
        return await clean(values);
      case 'app':
        return await app(values.port ? Number(values.port) : undefined, !values['no-open']);
      case 'connections':
        return listConnections();
      case 'login':
        return await login(args[0]);
      default:
        console.error(`unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof ConfigError) console.error(red(err.message));
    else console.error(red(`error: ${(err as Error).message}`));
    return 1;
  } finally {
    // Members' browsers belong to this command; close them so the process can end.
    await browserHub.shutdown();
  }
}

function teamPath(arg: string | undefined) {
  if (arg) return arg;
  for (const candidate of ['team.yaml', 'team.yml', '.covibe/team.yaml']) if (existsSync(candidate)) return candidate;
  return 'team.yaml';
}

function repoRoot(repo: string | undefined): string {
  const dir = resolve(repo ?? '.');
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return dir;
  }
}

function openStore(repo: string | undefined) {
  const dir = join(repoRoot(repo), '.covibe');
  mkdirSync(dir, { recursive: true });
  // Keep covibe's state (database, worktrees) out of the user's git status.
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
  return new EventStore(join(dir, 'covibe.db'));
}

function validate(file: string | undefined): number {
  const team = loadTeam(teamPath(file));
  console.log(green(`✓ ${team.file}`));
  console.log(`  team ${bold(team.name)}: ${Object.keys(team.agents).length} agents, ${team.steps.length} steps, isolation ${team.isolation}, max ${team.maxParallel} in parallel`);
  for (const a of Object.values(team.agents)) {
    const scope = a.writeScope === undefined ? (a.writes ? 'writes anywhere' : 'read-only') : a.writeScope.length ? `writes ${a.writeScope.join(', ')}` : 'read-only';
    const inSteps = team.steps.some((s) => (s.kind === 'agent' ? s.agent === a.name : s.branches.some((b) => b.agent === a.name)));
    const onCall = !inSteps && Object.values(team.agents).some((o) => o.canRequest.includes(a.name)) ? ', on request only' : '';
    const asks = a.canRequest.length ? `, asks ${a.canRequest.join(', ')} for work` : '';
    console.log(dim(`  - ${a.name.padEnd(12)} ${(a.model ?? 'default').padEnd(14)} ${a.backend.type.padEnd(12)} ${scope}${a.browser ? ', browser' : ''}${asks}${onCall}`));
  }
  return 0;
}

async function run(file: string | undefined, values: { repo?: string; goal?: string; 'goal-file'?: string }): Promise<number> {
  const team = loadTeam(teamPath(file));
  const goal = values['goal-file'] ? readFileSync(values['goal-file'], 'utf8').trim() : values.goal;
  if (!goal) throw new Error('run needs --goal "<what to build>" or --goal-file <path>');

  const store = openStore(values.repo);
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    console.error(yellow('\nstopping… (press Ctrl-C again to force quit)'));
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  const prompter = process.stdin.isTTY ? questionPrompter(store, onSigint) : undefined;
  const unsubscribe = store.subscribe((e) => {
    if (!QUIET_EVENTS.has(e.type)) console.log(formatEvent(e));
    prompter?.onEvent(e);
  });
  try {
    const runner = new ClaudeSdkRunner();
    const outcome = await runTeam({ team, repo: repoRoot(values.repo), goal, store, runner, signal: controller.signal, connections: openConnections(runner) });
    console.log('');
    console.log(`run ${bold(outcome.runId)}: ${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ''}`);
    if (outcome.branch) console.log(`result branch: ${bold(outcome.branch)}  ${dim(`(git diff HEAD...${outcome.branch})`)}`);
    else if (isFolderRun(repoRoot(values.repo), outcome.runId)) {
      const { files } = await folderDiff(repoRoot(values.repo), outcome.runId);
      console.log(`changed ${bold(String(files.length))} file${files.length === 1 ? '' : 's'} in the folder  ${dim(`(covibe changes ${outcome.runId}; undo with covibe undo ${outcome.runId})`)}`);
    }
    if (outcome.status === 'escalated') {
      console.log(yellow('The fix loop ran out of rounds. Review the feedback above, then talk to an agent:'));
      console.log(dim(`  covibe chat ${outcome.runId} <agent> "<instructions>"`));
    }
    return outcome.status === 'succeeded' ? 0 : outcome.status === 'escalated' ? 2 : 1;
  } finally {
    unsubscribe();
    prompter?.close();
    process.off('SIGINT', onSigint);
    store.close();
  }
}

/**
 * In a terminal, put the questions that reach the human to them one at a
 * time while the run waits. An answer given elsewhere (the app, `covibe
 * answer`) takes the prompt away.
 */
function questionPrompter(store: EventStore, onSigint: () => void) {
  const queue: number[] = [];
  let current: { id: number; abort: AbortController } | undefined;
  let rl: Interface | undefined;
  const next = async (): Promise<void> => {
    if (current) return;
    const id = queue.shift();
    if (id === undefined) return;
    const q = store.getQuestion(id);
    if (!q || q.status !== 'open') return next();
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', onSigint);
    }
    current = { id, abort: new AbortController() };
    console.log('');
    console.log(bold(yellow(`? ${q.from} asks you (#${id}):`)) + ` ${q.forHuman ?? q.text}`);
    if (q.context) console.log(dim(`  ${q.from}'s context: ${q.context}`));
    if (q.leadNote) console.log(dim(`  why it comes to you: ${q.leadNote}`));
    q.options?.forEach((o, i) => console.log(`  ${bold(String(i + 1))}. ${o}`));
    console.log(dim(`  Type your answer${q.options ? ' (or an option\'s number)' : ''} and press Enter, or answer in the app or with: covibe answer ${q.runId} ${id} "<answer>"`));
    try {
      for (;;) {
        const text = (await rl.question(bold(`answer #${id}> `), { signal: current.abort.signal })).trim();
        if (!text) continue;
        answerQuestion(store, q.runId, id, pickOption(q.options, text));
        break;
      }
    } catch {
      // answered elsewhere, or the run stopped
    }
    current = undefined;
    return next();
  };
  return {
    onEvent(e: RunEvent) {
      if (e.type === 'question.escalated' || (e.type === 'question.asked' && e.data.to === 'human')) {
        queue.push(Number(e.data.id));
        void next();
      }
      // The engine resumes when an answer arrives from anywhere, this process or another.
      if ((e.type === 'run.resumed' || e.type === 'question.answered' || e.type === 'run.finished') && current && store.getQuestion(current.id)?.status !== 'open') {
        current.abort.abort();
      }
    },
    close() {
      current?.abort.abort();
      rl?.close();
    },
  };
}

/** An option's number stands for the option. */
function pickOption(options: string[] | undefined, text: string): string {
  const n = /^\d+$/.test(text) ? Number(text) : 0;
  return options && n >= 1 && n <= options.length ? options[n - 1]! : text;
}

function answerCommand(args: string[], repo: string | undefined): number {
  const [id, qid, ...words] = args;
  if (!id) throw new Error('usage: covibe answer <run> [<question> <answer...>]');
  const store = openStore(repo);
  try {
    const run = store.findRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    if (!qid) {
      const open = store.isLive(run) ? store.questions(run.id, 'open') : [];
      if (!open.length) console.log(dim('no questions are waiting for you in this run'));
      for (const q of open) {
        console.log(`${bold(`#${q.id}`)} from ${q.from}: ${q.forHuman ?? q.text}`);
        if (q.context) console.log(dim(`    context: ${q.context}`));
        if (q.leadNote) console.log(dim(`    why it comes to you: ${q.leadNote}`));
        q.options?.forEach((o, i) => console.log(`    ${i + 1}. ${o}`));
      }
      return 0;
    }
    if (!words.length) throw new Error('usage: covibe answer <run> <question> <answer...>');
    if (!store.isLive(run)) throw new Error(`run ${run.id} has ended, so nobody is waiting for the answer`);
    const qnum = Number(qid.replace(/^#/, ''));
    const q = answerQuestion(store, run.id, qnum, pickOption(store.getQuestion(qnum)?.options, words.join(' ')));
    const others = store.questions(run.id, 'open').length;
    console.log(`answered #${q.id}; ${q.from} carries on${others ? `, and the run resumes once you answer the ${others} other open question${others > 1 ? 's' : ''}` : ' and the run resumes'}.`);
    return 0;
  } finally {
    store.close();
  }
}

function runs(repo: string | undefined): number {
  const store = openStore(repo);
  try {
    const list = store.listRuns();
    if (!list.length) console.log(dim('no runs yet'));
    for (const r of list) {
      const live = store.isLive(r);
      console.log(formatRun(live || r.status !== 'running' ? r : { ...r, status: 'failed' }, live && store.questions(r.id, 'open').length > 0));
    }
    return 0;
  } finally {
    store.close();
  }
}

async function log(id: string | undefined, values: { repo?: string; follow?: boolean; json?: boolean }): Promise<number> {
  if (!id) throw new Error('log needs a run id (see `covibe runs`)');
  const store = openStore(values.repo);
  try {
    const found = store.findRun(id);
    if (!found) throw new Error(`run ${id} not found`);
    const print = (e: Parameters<typeof formatEvent>[0]) => (values.json ? console.log(JSON.stringify(e)) : !QUIET_EVENTS.has(e.type) && console.log(formatEvent(e)));
    let last = 0;
    for (;;) {
      for (const e of store.events(found.id, last)) {
        print(e);
        last = e.id;
      }
      const current = store.getRun(found.id)!;
      if (!values.follow || !store.isLive(current)) return 0;
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    store.close();
  }
}

async function changes(id: string | undefined, repo: string | undefined): Promise<number> {
  if (!id) throw new Error('usage: covibe changes <run>');
  const store = openStore(repo);
  try {
    const run = store.findRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    if (!isFolderRun(run.repo, run.id)) throw new Error(run.branch ? `run ${run.id} worked on a branch: git diff HEAD...${run.branch}` : `run ${run.id} has no record of changes`);
    const diff = await folderDiff(run.repo, run.id);
    if (diff.undoneAt) console.log(dim(`undone at ${diff.undoneAt}`));
    if (!diff.files.length) console.log(dim('no changes'));
    const mark = { added: green('A'), modified: yellow('M'), deleted: red('D') };
    for (const f of diff.files) console.log(`${mark[f.status]} ${f.path}  ${dim(`${f.by.join(', ')}  +${f.additions} −${f.deletions}`)}`);
    if (diff.note) console.log(yellow(diff.note));
    return 0;
  } finally {
    store.close();
  }
}

async function undo(id: string | undefined, repo: string | undefined): Promise<number> {
  if (!id) throw new Error('usage: covibe undo <run>');
  const store = openStore(repo);
  try {
    const run = store.findRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    if (!isFolderRun(run.repo, run.id)) throw new Error(`only a run in a plain folder can be undone${run.branch ? `; this one left your checkout alone (its result is on ${run.branch})` : ''}`);
    if (store.isLive(run)) throw new Error(`run ${run.id} is still working; stop it first`);
    const result = await undoFolderRun(run.repo, run.id);
    store.append(run.id, { type: 'files.undone', data: { restored: result.restored, removed: result.removed, skipped: result.skipped, kept_in: result.keptIn } });
    for (const f of result.restored) console.log(`${green('restored')} ${f}`);
    for (const f of result.removed) console.log(`${green('removed')}  ${f}`);
    for (const s of result.skipped) console.log(yellow(`left ${s.path}: ${s.reason}`));
    if (result.restored.length || result.removed.length) console.log(dim(`The run's versions are kept in ${result.keptIn}`));
    return 0;
  } finally {
    store.close();
  }
}

async function app(port: number | undefined, open: boolean): Promise<number> {
  const { startServer } = await import('./server/app.js');
  const server = await startServer({ port });
  console.log(`covibe is running at ${bold(server.url)}`);
  console.log(dim('This link carries an access token; do not share it. Press Ctrl-C to stop.'));
  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try {
      execFileSync(opener, [server.url], { stdio: 'ignore' });
    } catch {
      // no browser available; the URL is printed above
    }
  }
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  console.log(dim('\nstopping…'));
  await server.close();
  return 0;
}

async function clean(values: { repo?: string; 'older-than'?: string; run?: string; 'dry-run'?: boolean }): Promise<number> {
  const store = openStore(values.repo);
  try {
    const days = values['older-than'] === undefined ? undefined : Number(values['older-than'].replace(/d$/, ''));
    if (days !== undefined && !Number.isFinite(days)) throw new Error('--older-than takes a number of days, e.g. 7');
    const run = values.run ? store.findRun(values.run)?.id ?? values.run : undefined;
    const res = await cleanupWorktrees(repoRoot(values.repo), store, { olderThanDays: days, runIds: run ? [run] : undefined, dryRun: values['dry-run'] });
    for (const c of res.cleaned) console.log(`${values['dry-run'] ? 'would remove' : 'removed'} ${c.runId}  ${dim(`${(c.freedKb / 1024).toFixed(1)} MB`)}`);
    for (const s of res.skipped) console.log(dim(`kept ${s.runId}: ${s.reason}`));
    console.log(`${values['dry-run'] ? 'Would free' : 'Freed'} ${bold(`${(res.freedKb / 1024).toFixed(1)} MB`)}. Branches are kept; chatting with a member restores its worktree.`);
    return 0;
  } finally {
    store.close();
  }
}

async function chatCommand(args: string[], repo: string | undefined, delivery: DeliveryMode): Promise<number> {
  const [id, agent, ...words] = args;
  if (!id || !agent || !words.length) throw new Error('usage: covibe chat <run> <agent> <message...>');
  const store = openStore(repo);
  try {
    const run = store.findRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    const team = loadTeam(run.teamFile);
    const live = store.isLive(run);
    const unsubscribe = live ? () => {} : store.subscribe((e) => e.type !== 'agent.text' && !QUIET_EVENTS.has(e.type) && console.log(formatEvent(e)));
    try {
      const runner = new ClaudeSdkRunner();
      const outcome = await chat({ store, runner, team, runId: run.id, agent, message: words.join(' '), delivery, connections: openConnections(runner) });
      if (outcome.mode === 'queued') {
        const when =
          outcome.delivery === 'interrupt'
            ? `${agent} stops its current turn and reads it (or reads it at its next turn if it is not working)`
            : outcome.delivery === 'steer'
              ? `${agent} reads it between tool calls if it is working, otherwise at its next turn`
              : `it is delivered at the start of ${agent}'s next turn`;
        console.log(`sent message #${outcome.messageId}; ${when}.`);
        return 0;
      }
      if (!outcome.ok) {
        console.error(red(`${agent}: ${outcome.error}`));
        return 1;
      }
      console.log(`\n${bold(agent)}: ${outcome.text}`);
      return 0;
    } finally {
      unsubscribe();
    }
  } finally {
    store.close();
  }
}

function listConnections(): number {
  const connections = new Connections();
  const all = connections.views();
  if (!all.length) {
    console.log(dim('No accounts or providers yet. Add them in the app: Settings → Advanced.'));
    return 0;
  }
  for (const c of all) {
    const who = c.kind === 'codex' ? connections.codexInfo(c.id) : undefined;
    const what =
      c.kind === 'claude'
        ? 'Claude account'
        : c.kind === 'codex'
          ? `ChatGPT account${who?.email ? ` · ${who.email}` : ''}${who?.subscriptionType ? ` · ${who.subscriptionType}` : ''}`
          : c.kind === 'anthropic'
            ? `Anthropic-compatible · ${c.baseUrl}`
            : `OpenAI-compatible · ${c.baseUrl}`;
    const missing = c.kind === 'codex' ? ' · not signed in' : ' · no key';
    const extra = c.kind === 'claude' ? '' : ` · ${c.models?.length ?? 0} model(s)${c.hasKey ? '' : yellow(missing)}`;
    console.log(`${bold(c.id.padEnd(16))} ${c.label}  ${dim(what)}${extra}`);
  }
  console.log(dim(`\nSharing work across Claude accounts: ${connections.balance ? 'on' : 'off'}`));
  return 0;
}

async function login(id: string | undefined): Promise<number> {
  if (!id) throw new Error('usage: covibe login <account>');
  const connections = new Connections();
  const account = connections.get(id);
  if (account?.kind === 'codex') {
    // The browser does the sign-in and comes back to a callback on this machine.
    const { url, done } = await connections.codexSignIn(id);
    const opened = await openInBrowser(url);
    console.log(opened ? 'Finish signing in in your browser. If it did not open, go to:' : 'Open this page in a browser on this machine to sign in:');
    console.log(dim(url));
    const who = await done;
    console.log(`Signed in${who.email ? ` as ${who.email}` : ''}${who.plan ? dim(` (${who.plan})`) : ''}.`);
    return 0;
  }
  if (!account || account.kind !== 'claude' || !account.configDir) throw new Error(`no Claude or ChatGPT account "${id}" (add it in the app: Settings → Advanced)`);
  console.log(dim(loginCommand(account.configDir)));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: account.configDir };
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE']) delete env[k];
  const res = spawnSync('claude', ['auth', 'login'], { stdio: 'inherit', env });
  if (res.error) throw new Error(`could not start claude: ${res.error.message} (is Claude Code installed?)`);
  return res.status ?? 1;
}
