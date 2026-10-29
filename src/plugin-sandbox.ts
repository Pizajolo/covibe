// The launcher Claude Code runs instead of a plugin's own hook, server or
// monitor command: it looks the real command up in the plugin's sandbox.json
// (which the plugin cannot change), and runs it in the OS sandbox (Seatbelt on
// macOS, bubblewrap on Linux) with the plugin's policy and a clean environment.
// stdin, stdout, stderr and the exit code pass straight through, so hooks and
// stdio servers work as they would unsandboxed.
//
//   plugin-sandbox <sandbox.json> hook|monitor <index>
//   plugin-sandbox <sandbox.json> mcp|lsp <server name>
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { readKeys } from './connections/plugin-keys.js';
import { childEnv, sandboxConfig, serverEnv, shellQuote, substitute, tempDirOf, type LaunchEntry, type LaunchSpec } from './sandbox-policy.js';

function fail(message: string): never {
  process.stderr.write(`covibe: ${message}\n`);
  process.exit(1);
}

async function main() {
  const [specPath, kind, key] = process.argv.slice(2);
  if (!specPath || !kind || key === undefined) fail('usage: plugin-sandbox <sandbox.json> hook|monitor|mcp|lsp <entry>');
  let spec: LaunchSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8')) as LaunchSpec;
  } catch (err) {
    fail(`cannot read ${specPath}: ${(err as Error).message}`);
  }
  const entry: LaunchEntry | undefined =
    kind === 'hook' ? spec.hooks[Number(key)] : kind === 'monitor' ? spec.monitors[Number(key)] : kind === 'mcp' ? spec.mcp[key] : kind === 'lsp' ? spec.lsp[key] : undefined;
  if (!entry) fail(`plugin ${spec.plugin} has no ${kind} "${key}"`);

  // A server's ${VAR}s come from the keys saved for the plugin, then the environment; hooks and monitors get neither.
  const server = kind === 'mcp' || kind === 'lsp';
  let source: NodeJS.ProcessEnv = process.env;
  if (server && spec.keys) {
    try {
      source = { ...process.env, ...readKeys(spec.keys) };
    } catch (err) {
      fail(`cannot read the keys saved for plugin ${spec.plugin}: ${(err as Error).message}`);
    }
  }
  // Hooks and monitors are shell commands; servers are a command and arguments.
  const command = entry.args ? [entry.command, ...entry.args].map((w) => shellQuote(substitute(w, spec, source))).join(' ') : substitute(entry.command, spec);

  if (!SandboxManager.isSupportedPlatform()) fail(`plugin ${spec.plugin} needs the OS sandbox, which this system does not support`);
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length) fail(`plugin ${spec.plugin} needs the OS sandbox, which cannot start: ${deps.errors.join('; ')}`);

  // The sandbox points TMPDIR at CLAUDE_CODE_TMPDIR: the plugin's own temp folder.
  process.env.CLAUDE_CODE_TMPDIR = tempDirOf(spec);
  mkdirSync(tempDirOf(spec), { recursive: true });
  await SandboxManager.initialize(sandboxConfig(spec, { cwd: process.cwd(), home: homedir() }));
  const wrapped = await SandboxManager.wrapWithSandbox(command);
  const child = spawn(wrapped, { shell: true, stdio: 'inherit', env: server ? serverEnv(process.env, spec, entry, source) : childEnv(process.env, spec, entry.env) });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => fail(`could not start ${kind} "${key}" of plugin ${spec.plugin}: ${err.message}`));
  child.on('exit', (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    const status = code ?? 128 + (signal ? (constants.signals[signal] ?? 1) : 1);
    void SandboxManager.reset().finally(() => process.exit(status));
  });
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
