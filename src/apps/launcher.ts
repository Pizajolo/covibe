// The process that runs a project's app in the OS sandbox (Seatbelt on macOS,
// bubblewrap on Linux), started by apps/manager.ts:
//
//   app-launcher <launch.json>
//
// It reads what to run from launch.json (which the app cannot change), runs
// the setup and start commands with a clean environment, writes only in the
// app's folder, its temp folder and package caches, and reaches only the
// allowed domains. On macOS the app listens on 127.0.0.1 itself. On Linux the
// sandbox has a network of its own, so a bridge inside it (socat) carries the
// app's port out through a Unix socket, and the manager listens on the same
// port outside.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { appEnv, appSandboxConfig, sandboxedCommand, type LaunchApp } from './policy.js';

function fail(message: string): never {
  process.stderr.write(`covibe: ${message}\n`);
  process.exit(1);
}

async function main() {
  const [file] = process.argv.slice(2);
  if (!file) fail('usage: app-launcher <launch.json>');
  let spec: LaunchApp;
  try {
    spec = JSON.parse(readFileSync(file, 'utf8')) as LaunchApp;
  } catch (err) {
    fail(`cannot read ${file}: ${(err as Error).message}`);
  }
  if (!SandboxManager.isSupportedPlatform()) fail('running apps needs the OS sandbox, which this system does not support; use Docker instead (runtime: docker)');
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length) fail(`the OS sandbox cannot start: ${deps.errors.join('; ')}`);
  mkdirSync(spec.tmp, { recursive: true });
  process.env.CLAUDE_CODE_TMPDIR = spec.tmp;
  // The sandbox guards shell profiles and editor settings in the folder it starts in, with placeholders
  // for the missing ones; starting in the app's temp folder keeps those out of the project.
  process.chdir(spec.tmp);
  await SandboxManager.initialize(appSandboxConfig(spec));
  const wrapped = await SandboxManager.wrapWithSandbox(sandboxedCommand(spec));
  const child = spawn(wrapped, { shell: true, stdio: 'inherit', env: appEnv(process.env, spec), detached: true });
  const stop = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      child.kill(signal);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => stop(signal));
  child.on('error', (err) => fail(`could not start the app: ${err.message}`));
  child.on('exit', (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    const status = code ?? 128 + (signal ? (constants.signals[signal] ?? 1) : 1);
    void SandboxManager.reset().finally(() => process.exit(status));
  });
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
