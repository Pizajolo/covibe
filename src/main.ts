import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadTeam } from './config/load.js';
import { chat } from './engine/chat.js';
import { runTeam } from './engine/engine.js';
import { EventStore } from './events/store.js';
import { bold, dim, formatEvent, formatRun, green, red, yellow } from './format.js';
import { ClaudeSdkRunner } from './runner/claude-sdk.js';

const USAGE = `covibe — YAML-defined agent teams on the Claude Agent SDK

Usage:
  covibe validate [team.yaml]                  Check a team file against the schema
  covibe run [team.yaml] --goal "<text>"       Run the team's workflow on a goal
  covibe runs                                  List recent runs
  covibe log <run> [--follow] [--json]         Show a run's event log
  covibe chat <run> <agent> <message...>       Talk to an agent of a run

Options:
  --repo <dir>   Repository the team works on (default: current directory)
  --goal <text>  What the team should achieve (run)
  --goal-file <path>  Read the goal from a file (run)
  -h, --help     Show this help

A message to an agent of a live run is queued for its next turn; after the run
has ended, the agent's session is resumed and it answers immediately.`;

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
        return await chatCommand(args, values.repo);
      default:
        console.error(`unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof ConfigError) console.error(red(err.message));
    else console.error(red(`error: ${(err as Error).message}`));
    return 1;
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
    console.log(dim(`  - ${a.name.padEnd(12)} ${(a.model ?? 'default').padEnd(14)} ${a.backend.type.padEnd(12)} ${scope}`));
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
  const unsubscribe = store.subscribe((e) => console.log(formatEvent(e)));
  try {
    const outcome = await runTeam({ team, repo: repoRoot(values.repo), goal, store, runner: new ClaudeSdkRunner(), signal: controller.signal });
    console.log('');
    console.log(`run ${bold(outcome.runId)}: ${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ''}`);
    if (outcome.branch) console.log(`result branch: ${bold(outcome.branch)}  ${dim(`(git diff HEAD...${outcome.branch})`)}`);
    if (outcome.status === 'escalated') {
      console.log(yellow('The fix loop ran out of rounds. Review the feedback above, then talk to an agent:'));
      console.log(dim(`  covibe chat ${outcome.runId} <agent> "<instructions>"`));
    }
    return outcome.status === 'succeeded' ? 0 : outcome.status === 'escalated' ? 2 : 1;
  } finally {
    unsubscribe();
    process.off('SIGINT', onSigint);
    store.close();
  }
}

function runs(repo: string | undefined): number {
  const store = openStore(repo);
  try {
    const list = store.listRuns();
    if (!list.length) console.log(dim('no runs yet'));
    for (const r of list) console.log(formatRun(store.isLive(r) || r.status !== 'running' ? r : { ...r, status: 'failed' }));
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
    const print = (e: Parameters<typeof formatEvent>[0]) => console.log(values.json ? JSON.stringify(e) : formatEvent(e));
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

async function chatCommand(args: string[], repo: string | undefined): Promise<number> {
  const [id, agent, ...words] = args;
  if (!id || !agent || !words.length) throw new Error('usage: covibe chat <run> <agent> <message...>');
  const store = openStore(repo);
  try {
    const run = store.findRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    const team = loadTeam(run.teamFile);
    const live = store.isLive(run);
    const unsubscribe = live ? () => {} : store.subscribe((e) => e.type !== 'agent.text' && console.log(formatEvent(e)));
    try {
      const outcome = await chat({ store, runner: new ClaudeSdkRunner(), team, runId: run.id, agent, message: words.join(' ') });
      if (outcome.mode === 'queued') {
        console.log(`queued message #${outcome.messageId} for ${agent}; it is delivered at the start of ${agent}'s next turn.`);
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
