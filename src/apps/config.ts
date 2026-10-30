// How to run a project's app: from what a member or person gave, the team
// file's `app:` section, what worked last time in this project, or what
// covibe can tell from the files (package.json, a compose file…).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type AppRuntime = 'sandbox' | 'docker';

/** The `app:` section of a team file, resolved (see schemas/team.schema.json). */
export interface AppConfig {
  runtime?: AppRuntime;
  /** Runs before the command, every start (npm install). */
  setup?: string;
  /** Starts the app; $PORT is the port it must listen on. */
  command?: string;
  /** Sandbox: a fixed port to use instead of a free one. Docker: the port the app listens on inside the container. */
  port?: number;
  /** The page to open (default /). */
  path?: string;
  env?: Record<string, string>;
  /** How long to wait for the app to answer, in seconds (default 180). */
  readyTimeoutS?: number;
  /** Sandbox: domains it may reach besides the team's sandbox list. */
  network?: string[];
  /** Docker: an image to run the command in, with the project mounted at /app. */
  image?: string;
  /** Docker: a Dockerfile to build and run (relative to the project). */
  dockerfile?: string;
  /** Docker: a compose file to bring up (relative to the project). */
  compose?: string;
  /** Docker compose: the service that serves the app. */
  service?: string;
}

/** Everything needed to start an app. */
export interface AppSpec extends AppConfig {
  runtime: AppRuntime;
  path: string;
  env: Record<string, string>;
  readyTimeoutS: number;
  /** Where the settings came from, for people. */
  source: 'given' | 'team' | 'remembered' | 'detected';
}

export const DEFAULT_READY_S = 180;
export const APP_FIELDS = ['runtime', 'setup', 'command', 'port', 'path', 'env', 'readyTimeoutS', 'network', 'image', 'dockerfile', 'compose', 'service'] as const;

export class AppConfigError extends Error {}

/** What last started successfully in this project, kept in its .covibe folder. */
export function rememberedApp(repo: string): AppConfig | undefined {
  try {
    return JSON.parse(readFileSync(join(repo, '.covibe', 'app.json'), 'utf8')) as AppConfig;
  } catch {
    return undefined;
  }
}

export function rememberApp(repo: string, config: AppConfig): void {
  const dir = join(repo, '.covibe');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
  const kept: AppConfig = {};
  for (const k of APP_FIELDS) if (config[k] !== undefined) (kept as Record<string, unknown>)[k] = config[k];
  writeFileSync(join(dir, 'app.json'), JSON.stringify(kept, null, 2) + '\n');
}

const clean = (c: AppConfig | undefined): AppConfig => {
  const out: AppConfig = {};
  for (const k of APP_FIELDS) {
    const v = c?.[k];
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
  }
  return out;
};

/** Whether a config says how to start something (a command, a Dockerfile or a compose file). */
const startable = (c: AppConfig) => !!(c.command || c.dockerfile || c.compose);

/**
 * The settings to start with. `given` (a member's or person's choices) wins
 * field by field; then the team file, else what worked last time, else what
 * the folder suggests. The runtime only comes from people (team file,
 * remembered, the App panel): `allowRuntime` is false for members.
 */
export function resolveApp(folder: string, opts: { given?: AppConfig; team?: AppConfig; remembered?: AppConfig; allowRuntime?: boolean }): AppSpec {
  const given = clean(opts.given);
  if (!opts.allowRuntime) delete given.runtime;
  const team = clean(opts.team);
  const remembered = clean(opts.remembered);
  const runtime: AppRuntime = given.runtime ?? team.runtime ?? remembered.runtime ?? 'sandbox';
  // The first of team, remembered or detected that knows how to start the app fills in what `given` leaves out.
  let base: AppConfig = {};
  let source: AppSpec['source'] = 'given';
  if (!startable(given)) {
    if (startable(team)) [base, source] = [team, 'team'];
    else if (startable(remembered) && (remembered.runtime ?? 'sandbox') === runtime) [base, source] = [remembered, 'remembered'];
    else {
      const found = detectApp(folder, runtime);
      if (found) [base, source] = [{ ...team, ...found }, 'detected'];
      else [base, source] = [team, 'team'];
    }
  }
  // The team's environment, extra domains and patience apply whatever starts the app.
  const context = clean({ env: team.env, network: team.network, readyTimeoutS: team.readyTimeoutS });
  const merged: AppConfig = { ...context, ...base, ...given };
  const spec: AppSpec = {
    ...merged,
    runtime,
    path: merged.path ? (merged.path.startsWith('/') ? merged.path : `/${merged.path}`) : '/',
    env: { ...(team.env ?? {}), ...(base.env ?? {}), ...(given.env ?? {}) },
    readyTimeoutS: merged.readyTimeoutS ?? DEFAULT_READY_S,
    source,
  };
  if (runtime === 'sandbox' && !spec.command) {
    throw new AppConfigError('covibe cannot tell how to start this app. Give the command that starts it (it must listen on $PORT), e.g. "npm run dev -- --port $PORT".');
  }
  if (runtime === 'docker' && !spec.command && !spec.dockerfile && !spec.compose && !spec.image) {
    throw new AppConfigError('covibe cannot tell how to start this app in Docker. Give a compose file, a Dockerfile, or an image (and a command, unless the image starts the app itself).');
  }
  if (runtime === 'docker' && spec.command && !spec.dockerfile && !spec.compose && !spec.image) spec.image = DEFAULT_IMAGE;
  if (spec.port !== undefined && (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535)) throw new AppConfigError(`port ${spec.port} is not a valid port`);
  return spec;
}

export const DEFAULT_IMAGE = 'node:22-bookworm-slim';

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

/** What the folder suggests: a web app's dev server, or (in Docker) its compose file or Dockerfile. */
export function detectApp(folder: string, runtime: AppRuntime): AppConfig | undefined {
  const has = (f: string) => existsSync(join(folder, f));
  if (runtime === 'docker') {
    const compose = COMPOSE_FILES.find(has);
    if (compose) return { ...composeService(join(folder, compose)), compose };
    if (has('Dockerfile')) {
      const expose = /^\s*EXPOSE\s+(\d+)/im.exec(readFileSync(join(folder, 'Dockerfile'), 'utf8'));
      return { dockerfile: 'Dockerfile', port: expose ? Number(expose[1]) : 3000 };
    }
  }
  // In a container the server must listen on every interface for the port to reach it.
  const host = runtime === 'docker' ? '0.0.0.0' : '127.0.0.1';
  const node = detectNode(folder, host);
  if (node) return runtime === 'docker' ? { ...node, port: 3000, image: DEFAULT_IMAGE } : node;
  if (has('manage.py')) return { command: `python3 manage.py runserver ${host}:$PORT`, ...(runtime === 'docker' ? { port: 8000, image: 'python:3.12-slim', setup: has('requirements.txt') ? 'pip install -r requirements.txt' : undefined } : {}) };
  if (has('index.html')) return { command: `python3 -m http.server $PORT --bind ${host}`, ...(runtime === 'docker' ? { port: 8000, image: 'python:3.12-slim' } : {}) };
  return undefined;
}

function detectNode(folder: string, host: string): AppConfig | undefined {
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const has = (f: string) => existsSync(join(folder, f));
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  const scripts = pkg.scripts ?? {};
  const name = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : scripts.preview ? 'preview' : undefined;
  if (!name) return undefined;
  const script = scripts[name]!;
  // Vite and the tools on it take the port as a flag; Next, Create React App, Express apps… read $PORT.
  const flags = /\b(vite|astro|svelte-kit|nuxi|nuxt)\b/.test(script) ? ` --port $PORT --strictPort --host ${host}` : /\bnext\b/.test(script) ? ` -p $PORT -H ${host}` : '';
  const run = pm === 'npm' ? `npm run ${name}${flags ? ` --${flags}` : ''}` : `${pm} run ${name}${flags}`;
  return { setup: `${pm} install`, command: run };
}

/** The service of a compose file that publishes a port (else the first one), and the port it listens on. */
function composeService(file: string): AppConfig {
  try {
    const doc = parse(readFileSync(file, 'utf8')) as { services?: Record<string, { ports?: unknown[]; expose?: unknown[] }> };
    const services = Object.entries(doc.services ?? {});
    const [name, svc] = services.find(([, s]) => s?.ports?.length) ?? services[0] ?? [];
    if (!name) return {};
    const first = svc?.ports?.[0] ?? svc?.expose?.[0];
    const port = typeof first === 'number' ? first : typeof first === 'string' ? Number(/(\d+)(\/\w+)?$/.exec(first)?.[1]) : typeof first === 'object' && first ? Number((first as { target?: unknown }).target) : NaN;
    return { service: name, ...(Number.isFinite(port) && port > 0 ? { port } : {}) };
  } catch {
    return {};
  }
}
