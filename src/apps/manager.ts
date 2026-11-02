// Running a project's app (a web app's dev server, a site) so people and
// members can use it: in the OS sandbox, or in Docker. One app per run and
// name, started by a member (app_start) or a person (the App panel). It keeps
// running between steps and after the run until it is stopped, or nobody used
// it for a while. Its state and log are files (~/.covibe/apps/…), so a
// process that did not start it (the app, for a run started in the terminal)
// can show and stop it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appsRoot } from '../home.js';
import { rememberApp, type AppRuntime, type AppSpec } from './config.js';
import type { LaunchApp } from './policy.js';

export type AppStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/** state.json: what an app is and where it is. */
export interface AppState {
  name: string;
  runId: string;
  repo: string;
  /** The folder it runs from. */
  folder: string;
  runtime: AppRuntime;
  status: AppStatus;
  /** Where it answers on this computer. */
  port: number;
  /** The page to open: http://127.0.0.1:<port><path>. */
  url: string;
  path: string;
  setup?: string;
  command?: string;
  image?: string;
  dockerfile?: string;
  compose?: string;
  service?: string;
  /** Docker: the port inside the container. */
  containerPort?: number;
  source: AppSpec['source'];
  /** A member's name, or "you". */
  by: string;
  startedAt: string;
  readyAt?: string;
  stoppedAt?: string;
  /** Why it failed or stopped. */
  reason?: string;
  /** The process that manages it. */
  owner: number;
  /** The launcher (sandbox) or the log follower (Docker). */
  pid?: number;
  /** Docker: the container's name, or the compose project's. */
  container?: string;
  /** The settings it started with (to start it again). */
  spec: AppSpec;
}

export interface AppEvent {
  type: 'app.starting' | 'app.ready' | 'app.failed' | 'app.stopped';
  data: Record<string, unknown>;
}

export interface StartApp {
  repo: string;
  runId: string;
  name?: string;
  folder: string;
  spec: AppSpec;
  by: string;
  /** Sandbox: domains it may reach (the team's sandbox list plus the spec's). */
  network: string[];
  /** Sandbox: extra folders it may write (package caches). */
  allowWrite: string[];
  onEvent?(e: AppEvent): void;
  /** While this says true (the run is going), the app is not stopped for being idle. */
  keepAlive?(): boolean;
  signal?: AbortSignal;
}

/** An app nobody used (no request, no tool call, nobody watching) for this long stops. */
export const IDLE_MS = 30 * 60_000;
const LOG_TAIL_BYTES = 256 << 10;
const DOCKER_BUILD_MS = 20 * 60_000;

export class AppError extends Error {}

interface Live {
  state: AppState;
  child?: ChildProcess;
  bridge?: Server;
  sockets: Set<Socket>;
  lastUsed: number;
  keepAlive?: () => boolean;
  onEvent?: (e: AppEvent) => void;
  stopping: boolean;
  exited: Promise<void>;
  markExited: () => void;
}

const keyOf = (repo: string, runId: string, name: string) => `${repo}\0${runId}\0${name}`;
const now = () => new Date().toISOString();

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // gone
    }
  }
}

/** A port nothing on 127.0.0.1 listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Whether something answers HTTP at the address (any status counts). */
export function answers(url: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET', timeout: timeoutMs, headers: { accept: 'text/html,*/*' } }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** How to start the launcher: this Node (or Electron as Node), with tsx when covibe runs from source. */
function launcherCommand(): string[] {
  const ts = import.meta.url.endsWith('.ts');
  const script = fileURLToPath(new URL(ts ? './launcher.ts' : './launcher.js', import.meta.url));
  return [process.execPath, ...(ts ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : []), script];
}

/** The start command, after the setup command when there is one. */
export function fullCommand(spec: Pick<AppSpec, 'setup' | 'command'>): string {
  return spec.setup ? `(${spec.setup}) && ${spec.command}` : spec.command!;
}

export class AppHub {
  private live = new Map<string, Live>();
  private sweeper: NodeJS.Timeout | undefined;
  private exitHook = false;

  /** The folder with an app's state.json and log. */
  dirOf(repo: string, runId: string, name: string): string {
    return join(appsRoot(repo), runId, name);
  }

  private readState(dir: string): AppState | undefined {
    try {
      return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as AppState;
    } catch {
      return undefined;
    }
  }

  private writeState(state: AppState) {
    const dir = this.dirOf(state.repo, state.runId, state.name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  /** An app's state, here or in another process; one whose process is gone is cleaned up and reported stopped. */
  get(repo: string, runId: string, name = 'app'): AppState | undefined {
    const here = this.live.get(keyOf(repo, runId, name));
    if (here) return here.state;
    const state = this.readState(this.dirOf(repo, runId, name));
    if (!state) return undefined;
    if ((state.status === 'starting' || state.status === 'running' || state.status === 'stopping') && !alive(state.owner)) {
      cleanup(state);
      const stopped: AppState = { ...state, status: 'stopped', stoppedAt: state.stoppedAt ?? now(), reason: state.reason ?? 'the covibe process that ran it ended' };
      this.writeState(stopped);
      return stopped;
    }
    return state;
  }

  /** Every app of a run. */
  list(repo: string, runId: string): AppState[] {
    const dir = join(appsRoot(repo), runId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => this.get(repo, runId, name))
      .filter((s): s is AppState => !!s);
  }

  /** Whether this process runs the app (and can, say, put a view in front of it). */
  isHere(repo: string, runId: string, name = 'app'): boolean {
    return this.live.has(keyOf(repo, runId, name));
  }

  touch(repo: string, runId: string, name = 'app') {
    const l = this.live.get(keyOf(repo, runId, name));
    if (l) l.lastUsed = Date.now();
  }

  /** The end of an app's log (setup and start output). */
  logs(repo: string, runId: string, name = 'app', maxBytes = LOG_TAIL_BYTES): string {
    const file = join(this.dirOf(repo, runId, name), 'app.log');
    try {
      const size = statSync(file).size;
      const fd = openSync(file, 'r');
      try {
        const len = Math.min(size, maxBytes);
        const buf = Buffer.alloc(len);
        let off = 0;
        while (off < len) {
          const n = readSync(fd, buf, off, len - off, size - len + off);
          if (n <= 0) break;
          off += n;
        }
        const text = buf.subarray(0, off).toString('utf8');
        return size > len ? text.slice(text.indexOf('\n') + 1) : text;
      } finally {
        closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /**
   * Start an app (stopping the run's app of the same name first) and wait
   * until it answers HTTP. Resolves with its state, running or failed.
   */
  async start(o: StartApp): Promise<AppState> {
    const name = o.name ?? 'app';
    await this.stop(o.repo, o.runId, name, 'started again');
    const dir = this.dirOf(o.repo, o.runId, name);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, 'tmp'), { recursive: true, force: true });
    const logFile = join(dir, 'app.log');
    const log = openSync(logFile, 'w');
    const say = (line: string) => writeSync(log, `${line}\n`);
    const spec = o.spec;
    const docker = spec.runtime === 'docker';
    const containerPort = docker ? (spec.port ?? 3000) : undefined;
    let port: number;
    if (!docker && spec.port) {
      if (!(await portFree(spec.port))) {
        closeSync(log);
        throw new AppError(`port ${spec.port} is already in use on this computer (another app, or another run's?). Leave the port out to use a free one.`);
      }
      port = spec.port;
    } else port = await freePort();
    const container = `covibe-app-${createHash('sha1').update(keyOf(o.repo, o.runId, name)).digest('hex').slice(0, 12)}`;
    const state: AppState = {
      name,
      runId: o.runId,
      repo: o.repo,
      folder: o.folder,
      runtime: spec.runtime,
      status: 'starting',
      port,
      url: `http://127.0.0.1:${port}${spec.path}`,
      path: spec.path,
      ...(spec.setup ? { setup: spec.setup } : {}),
      ...(spec.command ? { command: spec.command } : {}),
      ...(spec.image ? { image: spec.image } : {}),
      ...(spec.dockerfile ? { dockerfile: spec.dockerfile } : {}),
      ...(spec.compose ? { compose: spec.compose } : {}),
      ...(spec.service ? { service: spec.service } : {}),
      ...(containerPort ? { containerPort } : {}),
      source: spec.source,
      by: o.by,
      startedAt: now(),
      owner: process.pid,
      ...(docker ? { container } : {}),
      spec,
    };
    let markExited!: () => void;
    const live: Live = { state, sockets: new Set(), lastUsed: Date.now(), keepAlive: o.keepAlive, onEvent: o.onEvent, stopping: false, exited: new Promise((r) => (markExited = r)), markExited: () => markExited() };
    const key = keyOf(o.repo, o.runId, name);
    this.live.set(key, live);
    this.writeState(state);
    this.ensureTimers();
    o.onEvent?.({ type: 'app.starting', data: { name, runtime: spec.runtime, folder: o.folder, url: state.url, command: spec.command ?? null, setup: spec.setup ?? null, image: spec.image ?? null, dockerfile: spec.dockerfile ?? null, compose: spec.compose ?? null, by: o.by, source: spec.source } });

    const fail = (reason: string): AppState => {
      if (live.stopping) return live.state;
      live.state = { ...live.state, status: 'failed', reason, stoppedAt: now() };
      this.writeState(live.state);
      o.onEvent?.({ type: 'app.failed', data: { name, reason, log: tail(this.logs(o.repo, o.runId, name), 30) } });
      void this.halt(live);
      return live.state;
    };

    try {
      if (docker) await this.launchDocker(live, o, log, say, container, containerPort!);
      else await this.launchSandbox(live, o, log, say, dir);
    } catch (err) {
      closeSync(log);
      return fail((err as Error).message);
    }
    closeSync(log);

    // Wait until it answers, it exits, or it takes too long.
    const deadline = Date.now() + spec.readyTimeoutS * 1000;
    const probe = `http://127.0.0.1:${port}${spec.path}`;
    let exited = false;
    void live.exited.then(() => (exited = true));
    while (true) {
      if (live.stopping) return live.state;
      if (o.signal?.aborted) {
        await this.stop(o.repo, o.runId, name, 'the member that started it stopped');
        return live.state;
      }
      if (exited) return fail(live.state.reason ?? 'the app stopped before it answered');
      if (await answers(probe)) break;
      if (Date.now() > deadline) return fail(`the app did not answer at ${probe} within ${spec.readyTimeoutS} s. It must listen on 127.0.0.1:$PORT${docker ? ` (0.0.0.0:${containerPort} in the container)` : ''}.`);
      await new Promise((r) => setTimeout(r, 700));
    }
    live.state = { ...live.state, status: 'running', readyAt: now() };
    this.writeState(live.state);
    live.lastUsed = Date.now();
    o.onEvent?.({ type: 'app.ready', data: { name, url: live.state.url, port, runtime: spec.runtime } });
    // What a person or member chose is kept for next time.
    if (spec.source === 'given') {
      try {
        const { source: _s, ...kept } = spec;
        rememberApp(o.repo, kept);
      } catch {
        // the project folder may be read-only; it only means no memory
      }
    }
    return live.state;
  }

  private async launchSandbox(live: Live, o: StartApp, log: number, say: (l: string) => void, dir: string) {
    const spec = o.spec;
    const linux = process.platform === 'linux';
    const socketDir = linux ? join(tmpdir(), `covibe-${createHash('sha1').update(dir).digest('hex').slice(0, 10)}`) : undefined;
    if (socketDir) {
      rmSync(socketDir, { recursive: true, force: true });
      mkdirSync(socketDir, { recursive: true });
    }
    const launch: LaunchApp = {
      folder: o.folder,
      command: fullCommand(spec),
      port: live.state.port,
      env: spec.env,
      network: [...new Set([...o.network, ...(spec.network ?? [])])],
      allowWrite: o.allowWrite,
      tmp: join(dir, 'tmp'),
      log: join(dir, 'app.log'),
      ...(socketDir ? { socket: join(socketDir, 'app.sock') } : {}),
    };
    // Protected even before the app runs: hooks there would run outside any sandbox at a member's next turn (see policy.ts).
    if (linux) mkdirSync(join(o.folder, '.claude'), { recursive: true });
    const launchFile = join(dir, 'launch.json');
    writeFileSync(launchFile, JSON.stringify(launch, null, 2));
    say(`$ ${launch.command}`);
    say(`# in ${o.folder}, in the OS sandbox; reaches ${launch.network.join(', ') || 'no websites'}; listens on 127.0.0.1:${live.state.port}`);
    const [cmd, ...args] = launcherCommand();
    const child = spawn(cmd!, [...args, launchFile], { cwd: o.folder, stdio: ['ignore', log, log], detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    live.child = child;
    live.state = { ...live.state, pid: child.pid };
    this.writeState(live.state);
    child.on('exit', (code, signal) => this.exited(live, code, signal));
    child.on('error', (err) => this.exited(live, null, null, err.message));
    if (launch.socket) live.bridge = await this.bridge(live, launch.socket);
  }

  /** Linux: listen on the app's port here and carry each connection into the sandbox through its socket. */
  private bridge(live: Live, socket: string): Promise<Server> {
    const server = createServer((c) => {
      live.lastUsed = Date.now();
      live.sockets.add(c);
      const up = connect(socket);
      live.sockets.add(up);
      c.pipe(up);
      up.pipe(c);
      const end = () => {
        c.destroy();
        up.destroy();
        live.sockets.delete(c);
        live.sockets.delete(up);
      };
      c.on('error', end);
      up.on('error', end);
      c.on('close', end);
      up.on('close', end);
    });
    return new Promise((resolve, reject) => {
      server.once('error', (err) => reject(new AppError(`cannot listen on port ${live.state.port}: ${err.message}`)));
      server.listen(live.state.port, '127.0.0.1', () => resolve(server));
    });
  }

  private async launchDocker(live: Live, o: StartApp, log: number, say: (l: string) => void, container: string, containerPort: number) {
    const spec = o.spec;
    const port = live.state.port;
    const env = { PORT: String(containerPort), HOST: '0.0.0.0', BROWSER: 'none', ...spec.env };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const run = (args: string[], ms = DOCKER_BUILD_MS) => {
      say(`$ docker ${args.join(' ')}`);
      return dockerStep(args, o.folder, log, ms, o.signal);
    };
    if (!(await dockerAvailable())) throw new AppError('Docker is not running on this computer (start Docker Desktop, or use the sandbox instead)');
    let follow: string[];
    if (spec.compose) {
      const override = join(this.dirOf(o.repo, o.runId, live.state.name), 'compose.override.yaml');
      const service = spec.service;
      if (!service) throw new AppError(`say which service of ${spec.compose} serves the app (service)`);
      writeFileSync(override, `services:\n  ${JSON.stringify(service)}:\n    ports:\n      - "127.0.0.1:${port}:${containerPort}"\n${Object.keys(spec.env).length ? `    environment:\n${Object.entries(spec.env).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join('\n')}\n` : ''}`);
      const base = ['compose', '-p', container, '--project-directory', o.folder, '-f', join(o.folder, spec.compose), '-f', override];
      await run([...base, 'up', '-d', '--build', '--remove-orphans']);
      follow = [...base, 'logs', '-f', '--no-color'];
    } else {
      let image = spec.image;
      const mount: string[] = [];
      if (spec.dockerfile) {
        image = `${container}:latest`;
        await run(['build', '-t', image, '-f', join(o.folder, spec.dockerfile), o.folder]);
      } else {
        mount.push('-v', `${o.folder}:/app`, '-w', '/app');
        // Files it writes in your folder belong to you, not root.
        if (process.platform === 'linux' && process.getuid && process.getuid() !== 0) mount.push('--user', `${process.getuid()}:${process.getgid!()}`, '-e', 'HOME=/tmp');
      }
      const command = spec.command ? ['sh', '-c', fullCommand(spec)] : [];
      await run(['run', '-d', '--rm', '--name', container, '--label', 'covibe.app=1', '-p', `127.0.0.1:${port}:${containerPort}`, ...mount, ...envArgs, image!, ...command]);
      follow = ['logs', '-f', container];
    }
    // The log follower ends when the container does.
    const child = spawn('docker', follow, { cwd: o.folder, stdio: ['ignore', log, log], detached: true });
    live.child = child;
    live.state = { ...live.state, pid: child.pid };
    this.writeState(live.state);
    child.on('exit', (code, signal) => this.exited(live, code, signal));
    child.on('error', (err) => this.exited(live, null, null, err.message));
  }

  private exited(live: Live, code: number | null, signal: NodeJS.Signals | null, error?: string) {
    live.markExited();
    if (live.stopping || live.state.status === 'stopped' || live.state.status === 'failed') return;
    // Someone else (another process) stopped it.
    const onDisk = this.readState(this.dirOf(live.state.repo, live.state.runId, live.state.name));
    if (onDisk?.status === 'stopping' || onDisk?.status === 'stopped') {
      void this.halt(live, onDisk.reason ?? 'stopped');
      return;
    }
    const reason = error ?? (signal ? `the app was stopped (${signal})` : `the app exited with code ${code}`);
    if (live.state.status === 'starting') {
      live.state = { ...live.state, reason };
      return; // start() reports it
    }
    live.state = { ...live.state, status: 'failed', reason, stoppedAt: now() };
    this.writeState(live.state);
    live.onEvent?.({ type: 'app.failed', data: { name: live.state.name, reason, log: tail(this.logs(live.state.repo, live.state.runId, live.state.name), 30) } });
    void this.halt(live);
  }

  /** Stop what is left of an app here and forget it. */
  private async halt(live: Live, reason?: string) {
    live.stopping = true;
    const key = keyOf(live.state.repo, live.state.runId, live.state.name);
    if (this.live.get(key) === live) this.live.delete(key);
    live.bridge?.close();
    for (const s of live.sockets) s.destroy();
    killGroup(live.child?.pid, 'SIGTERM');
    await dockerDown(live.state);
    const exited = await Promise.race([live.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
    if (!exited) killGroup(live.child?.pid, 'SIGKILL');
    if (reason && live.state.status !== 'failed') {
      live.state = { ...live.state, status: 'stopped', reason, stoppedAt: now() };
      this.writeState(live.state);
    }
  }

  /** Stop a run's app, here or in another process. Resolves once it is down. */
  async stop(repo: string, runId: string, name = 'app', reason = 'stopped'): Promise<AppState | undefined> {
    const live = this.live.get(keyOf(repo, runId, name));
    if (live) {
      const was = live.state.status;
      live.state = { ...live.state, status: 'stopping', reason };
      await this.halt(live);
      live.state = { ...live.state, status: 'stopped', reason, stoppedAt: now() };
      this.writeState(live.state);
      if (was === 'running' || was === 'starting') live.onEvent?.({ type: 'app.stopped', data: { name, reason } });
      return live.state;
    }
    const state = this.get(repo, runId, name);
    if (!state || state.status === 'stopped' || state.status === 'failed') return state;
    // Another process runs it: tell it (state on disk), then end the processes.
    this.writeState({ ...state, status: 'stopping', reason });
    killGroup(state.pid, 'SIGTERM');
    await dockerDown(state);
    const stopped: AppState = { ...state, status: 'stopped', reason, stoppedAt: now() };
    this.writeState(stopped);
    return stopped;
  }

  /** Stop every app of a run. */
  async stopRun(repo: string, runId: string, reason: string) {
    await Promise.all(this.list(repo, runId).map((s) => this.stop(repo, runId, s.name, reason)));
  }

  private ensureTimers() {
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), 60_000);
      this.sweeper.unref();
    }
    if (!this.exitHook) {
      this.exitHook = true;
      // A covibe that ends takes its apps with it (containers too).
      process.on('exit', () => {
        for (const l of this.live.values()) {
          killGroup(l.child?.pid, 'SIGTERM');
          cleanup(l.state, true);
        }
      });
    }
  }

  private sweep() {
    for (const l of [...this.live.values()]) {
      if (l.keepAlive?.()) l.lastUsed = Date.now();
      if (l.state.status === 'running' && Date.now() - l.lastUsed > IDLE_MS) void this.stop(l.state.repo, l.state.runId, l.state.name, `nobody used it for ${IDLE_MS / 60_000} minutes`);
    }
  }

  /** Stop every app this process runs. */
  async shutdown() {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    await Promise.all([...this.live.values()].map((l) => this.stop(l.state.repo, l.state.runId, l.state.name, 'covibe closed')));
  }
}

/** The last `n` lines of a text. */
export function tail(text: string, n: number): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}

function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill(), 15_000);
    p.on('exit', (code) => (clearTimeout(timer), resolve(code === 0)));
    p.on('error', () => (clearTimeout(timer), resolve(false)));
  });
}

/** One docker command, its output in the app's log. */
function dockerStep(args: string[], cwd: string, log: number, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { cwd, stdio: ['ignore', log, log] });
    const timer = setTimeout(() => p.kill('SIGTERM'), ms);
    const onAbort = () => p.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (err) => reject(new AppError(`could not run docker: ${err.message}`)));
    p.on('exit', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new AppError(`docker ${args[0] === 'compose' ? 'compose up' : args[0]} failed (exit code ${code}); see the app's log`));
    });
  });
}

/** Take an app's containers down. */
function dockerDown(state: AppState): Promise<void> {
  if (state.runtime !== 'docker' || !state.container) return Promise.resolve();
  const args = state.compose ? ['compose', '-p', state.container, 'down', '--remove-orphans', '--timeout', '5'] : ['rm', '-f', state.container];
  return new Promise((resolve) => {
    const p = spawn('docker', args, { stdio: 'ignore', cwd: existsSync(state.folder) ? state.folder : undefined });
    const timer = setTimeout(() => p.kill(), 30_000);
    p.on('exit', () => (clearTimeout(timer), resolve()));
    p.on('error', () => (clearTimeout(timer), resolve()));
  });
}

/** End an app's processes and containers right away (another process's leftovers, or on exit). */
function cleanup(state: AppState, sync = true) {
  killGroup(state.pid, 'SIGTERM');
  if (state.runtime === 'docker' && state.container && sync) {
    const args = state.compose ? ['compose', '-p', state.container, 'down', '--remove-orphans', '--timeout', '3'] : ['rm', '-f', state.container];
    spawnSync('docker', args, { stdio: 'ignore', timeout: 20_000 });
  }
}

/** Every app in this process. */
export const appHub = new AppHub();
