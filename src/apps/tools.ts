// The app tools a member gets (app: true, the default for members with Bash or
// a browser): start the project's app from its working folder, see where it
// runs, read its log, stop it. The app keeps running between turns and steps,
// so a reviewer can open what a builder started, and people can open it in
// the App panel.
import { DEFAULT_SANDBOX_NETWORK, DEFAULT_SANDBOX_WRITE } from '../config/load.js';
import type { AgentConfig, TeamConfig } from '../config/types.js';
import type { CustomTool } from '../runner/types.js';
import { expandHome } from '../sandbox-policy.js';
import { homedir } from 'node:os';
import { AppConfigError, rememberedApp, resolveApp, type AppConfig } from './config.js';
import { tail, type AppEvent, type AppHub, type AppState } from './manager.js';

export const APP_TOOL_NAMES = ['app_start', 'app_status', 'app_logs', 'app_stop'] as const;

export interface AppToolOptions {
  hub: AppHub;
  team: TeamConfig;
  agent: AgentConfig;
  repo: string;
  runId: string;
  /** The member's working folder: where the app runs from. */
  folder: string;
  onEvent?(e: AppEvent): void;
  /** True while the run goes (the app is not stopped for being idle meanwhile). */
  keepAlive?(): boolean;
  signal?: AbortSignal;
}

/** Fields only members that run shell commands may choose. */
const COMMAND_FIELDS = ['command', 'setup', 'image', 'dockerfile', 'compose', 'service'] as const;

function describe(s: AppState): string {
  const how = s.runtime === 'docker' ? (s.compose ? `docker compose (${s.compose}, service ${s.service})` : s.dockerfile ? `Docker (${s.dockerfile})` : `Docker (${s.image})`) : 'the OS sandbox';
  const what = s.command ? `\`${s.command}\`` : 'its container';
  return `${what} in ${how}, from ${s.folder}, started by ${s.by}`;
}

export function appTools(o: AppToolOptions): CustomTool[] {
  const { hub, repo, runId } = o;
  const shell = o.agent.tools.includes('Bash');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const resolve = (given: AppConfig) => resolveApp(o.folder, { given, team: o.team.app, remembered: rememberedApp(repo), allowRuntime: false });

  return [
    {
      name: 'app_start',
      description:
        `Start the project's app (its dev server, or a site) from your working folder, so you, your teammates and the people watching can open it. covibe gives it a free port ($PORT), waits until it answers and returns its address; open it with your browser if you have one. It keeps running between turns and steps until someone stops it. If it already runs (a teammate may have started it), you get its address; restart: true starts it again from your folder, e.g. after changing how it is built. ` +
        (shell
          ? 'Leave command and setup out to use the team file\'s settings, what worked last time, or what covibe detects (package.json, manage.py, index.html). A command must listen on 127.0.0.1:$PORT.'
          : 'It starts the way the team file, the project or covibe\'s detection says.'),
      params: {
        ...(shell
          ? {
              command: { type: 'string' as const, optional: true, description: 'Shell command that starts it; must listen on $PORT, e.g. "npm run dev -- --port $PORT --host 127.0.0.1".' },
              setup: { type: 'string' as const, optional: true, description: 'Shell command to run first, e.g. "npm install".' },
            }
          : {}),
        path: { type: 'string', optional: true, description: 'The page to open first (default /).' },
        restart: { type: 'boolean', optional: true, description: 'Start it again even if it is running.' },
      },
      run: async (args) => {
        const given: AppConfig = {};
        if (shell) {
          for (const k of COMMAND_FIELDS) {
            const v = str(args[k]);
            if (v) (given as Record<string, unknown>)[k] = v;
          }
        } else if (COMMAND_FIELDS.some((k) => str(args[k]))) {
          throw new Error('you cannot choose how the app starts (you do not run shell commands); start it without command or setup');
        }
        const path = str(args.path);
        if (path) given.path = path;
        const current = hub.get(repo, runId);
        if (current && !args.restart && !given.command) {
          if (current.status === 'running') {
            hub.touch(repo, runId);
            const elsewhere = current.folder !== o.folder ? ` It runs from ${current.folder}, not your working folder: restart: true runs it from yours (to see changes you have not handed in yet).` : ' restart: true starts it again.';
            return `The app already runs at ${current.url}: ${describe(current)}. Open it with your browser.${elsewhere}`;
          }
          if (current.status === 'starting') return `${current.by} is starting the app (${describe(current)}); it will answer at ${current.url}. Call app_status in a moment.`;
        }
        let spec;
        try {
          spec = resolve(given);
        } catch (err) {
          if (err instanceof AppConfigError) throw new Error(err.message);
          throw err;
        }
        const sandbox = o.agent.sandbox;
        const state = await hub.start({
          repo,
          runId,
          folder: o.folder,
          spec,
          by: o.agent.name,
          network: sandbox?.network ?? DEFAULT_SANDBOX_NETWORK,
          allowWrite: sandbox?.allowWrite ?? DEFAULT_SANDBOX_WRITE.map((p) => expandHome(p, homedir())),
          onEvent: o.onEvent,
          keepAlive: o.keepAlive,
          signal: o.signal,
        });
        const log = tail(hub.logs(repo, runId), 25);
        if (state.status !== 'running') {
          throw new Error(`the app did not start: ${state.reason ?? 'unknown reason'}\n\nThe end of its log:\n${log || '(empty)'}`);
        }
        const moved = current && current.folder !== o.folder && current.status === 'running' ? ` (it ran from ${current.folder} before; it runs from your folder now)` : '';
        return `The app runs at ${state.url}${moved}: ${describe(state)}. Open it with your browser. People can open it in covibe's App panel; it keeps running after your turn.\n\nThe end of its log:\n${log || '(empty)'}`;
      },
    },
    {
      name: 'app_status',
      description: "Whether the project's app runs for this run, where (its address), from which folder and who started it.",
      params: {},
      run: () => {
        const s = hub.get(repo, runId);
        if (!s) {
          let how: string;
          try {
            const spec = resolve({});
            how = `app_start would run ${spec.command ? `\`${spec.setup ? `${spec.setup} && ` : ''}${spec.command}\`` : spec.compose ? `docker compose (${spec.compose})` : `the Dockerfile ${spec.dockerfile}`} (${spec.source === 'team' ? 'from the team file' : spec.source === 'remembered' ? 'what worked last time' : 'detected from the project'}).`;
          } catch (err) {
            how = (err as Error).message;
          }
          return `The app is not running for this run. ${how}`;
        }
        hub.touch(repo, runId);
        if (s.status === 'running') return `The app runs at ${s.url}: ${describe(s)}, since ${s.readyAt ?? s.startedAt}.`;
        if (s.status === 'starting') return `The app is starting (${describe(s)}); it will answer at ${s.url}.`;
        return `The app is ${s.status}${s.reason ? `: ${s.reason}` : ''} (${describe(s)}). Start it with app_start.`;
      },
    },
    {
      name: 'app_logs',
      description: "Read the end of the app's log: what its setup and start commands printed (errors, compile warnings, requests).",
      params: {
        lines: { type: 'number', optional: true, description: 'How many lines from the end (default 80, at most 400).' },
        find: { type: 'string', optional: true, description: 'Only lines containing this text (case-insensitive).' },
      },
      run: (args) => {
        const s = hub.get(repo, runId);
        if (!s) return 'The app has not been started for this run.';
        const n = Math.min(400, Math.max(1, Number(args.lines) || 80));
        let lines = hub.logs(repo, runId).split('\n');
        const find = str(args.find)?.toLowerCase();
        if (find) lines = lines.filter((l) => l.toLowerCase().includes(find));
        const text = lines.slice(-n).join('\n').trim();
        return `The app is ${s.status}${s.reason && s.status !== 'running' ? ` (${s.reason})` : ''}.\n\n${text || (find ? `No lines with "${find}".` : 'The log is empty.')}`;
      },
    },
    {
      name: 'app_stop',
      description: "Stop the project's app for this run.",
      params: {},
      run: async () => {
        const s = await hub.stop(repo, runId, 'app', `stopped by ${o.agent.name}`);
        return s ? 'The app is stopped.' : 'The app was not running.';
      },
    },
  ];
}
