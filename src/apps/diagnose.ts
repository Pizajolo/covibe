// Why an app did not start, from its log and state: the problems covibe can
// recognise, each with what fixes it and where a person makes that change
// (the App tab's settings, the team file, what covibe remembered, or the
// project's code, which a member changes).
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { packageManager } from './config.js';

/** Where a fix is made. */
export type FixPlace = 'settings' | 'team' | 'memory' | 'code' | 'sandbox' | 'computer';

export interface AppFix {
  where: FixPlace;
  text: string;
}

export interface AppProblem {
  kind: 'not_installed' | 'missing_tool' | 'missing_file' | 'missing_package' | 'wrong_port' | 'no_port' | 'port_in_use' | 'blocked_domain' | 'blocked_write' | 'docker' | 'crashed';
  title: string;
  detail: string;
  fixes: AppFix[];
}

export interface FailedApp {
  status: string;
  reason?: string;
  folder: string;
  runtime: 'sandbox' | 'docker';
  port: number;
  command?: string;
  setup?: string;
  source: 'given' | 'team' | 'remembered' | 'detected';
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What went wrong, most likely first; empty when covibe cannot tell. */
export function diagnoseApp(app: FailedApp, log: string): AppProblem[] {
  const out: AppProblem[] = [];
  const add = (p: AppProblem) => {
    if (!out.some((o) => o.kind === p.kind)) out.push(p);
  };
  const reason = app.reason ?? '';
  const where = app.source === 'team' ? 'team' : app.source === 'remembered' ? 'memory' : 'settings';
  const settingsFix = (text: string): AppFix[] => [
    { where: 'settings', text: `${text} in How it runs, then start it.` },
    { where: 'team', text: `${text} in the team file's app: section, so every start does it.` },
  ];
  const hasPackageJson = existsSync(join(app.folder, 'package.json'));
  const installed = existsSync(join(app.folder, 'node_modules'));
  const install = hasPackageJson ? `${packageManager(app.folder)} install` : undefined;

  // A program the command runs does not exist (exit code 127).
  for (const m of log.matchAll(/(?:^|\n)(?:sh|bash|zsh|\/bin\/sh)(?:: line \d+)?: (?:([\w@./-]+): )?(?:command not found|not found)(?:: ([\w@./-]+))?/g)) {
    const tool = m[1] ?? m[2] ?? 'a program';
    if (hasPackageJson && !installed) {
      add({
        kind: 'not_installed',
        title: `The project's packages are not installed in this folder`,
        detail: `\`${tool}\` comes from node_modules, which is not in git, so a fresh worktree (${app.folder}) has none.${app.setup ? '' : ' Nothing installs them before the start.'}`,
        fixes: settingsFix(`Set Setup to \`${install}\``),
      });
    } else {
      add({
        kind: 'missing_tool',
        title: `\`${tool}\` is not installed${hasPackageJson ? ' (not in the project’s packages either)' : ''}`,
        detail: `The command runs \`${tool}\`, which the sandbox cannot find on this computer's PATH.`,
        fixes: [
          ...(hasPackageJson ? [{ where: 'code' as const, text: `Add \`${tool}\` to package.json (devDependencies), then install.` }] : []),
          { where: 'computer', text: `Install \`${tool}\` on this computer, or change the command to one that exists.` },
        ],
      });
    }
  }

  // A file the command runs, or a package it imports, is not there.
  for (const m of log.matchAll(/Cannot find module '([^']+)'|ERR_MODULE_NOT_FOUND\]?:? Cannot find (?:module|package) '([^']+)'|can't open file '([^']+)'|No such file or directory: '([^']+)'/g)) {
    const target = m[1] ?? m[2] ?? m[3] ?? m[4]!;
    const isPath = target.startsWith('/') || target.startsWith('.') || /\.(m?js|cjs|m?ts|py|sh)$/.test(target);
    if (isPath) {
      const rel = isAbsolute(target) ? relative(app.folder, target) : target;
      const fromMemory = app.source === 'remembered' || app.source === 'given';
      add({
        kind: 'missing_file',
        title: `\`${clip(rel, 80)}\` is not in this folder`,
        detail: `The app runs from ${app.folder}. ${fromMemory ? 'The command probably worked in another folder, such as a member’s worktree whose work is not merged into the run’s result yet.' : 'The command points at a file that does not exist here.'}`,
        fixes: [
          ...(app.source === 'remembered' ? [{ where: 'memory' as const, text: 'Forget what ran last time, so covibe uses the team file or what it detects.' }] : []),
          { where: 'settings', text: 'Change the command in How it runs to one that exists in this folder.' },
          { where: 'code', text: 'If the file should exist, ask the member who wrote it to hand it in (Continue the run so its step can finish and merge).' },
        ],
      });
    } else {
      add({
        kind: 'missing_package',
        title: `The package \`${clip(target, 60)}\` is not installed`,
        detail: installed ? 'node_modules exists but does not have it: it may be missing from package.json.' : 'node_modules is missing in this folder.',
        fixes: installed ? [{ where: 'code', text: `Add \`${target}\` to package.json, then start again with Setup \`${install ?? 'npm install'}\`.` }] : settingsFix(`Set Setup to \`${install ?? 'npm install'}\``),
      });
    }
  }

  if (/EADDRINUSE/.test(log) || /already in use/.test(reason)) {
    add({ kind: 'port_in_use', title: 'The port is already in use', detail: clip(reason || 'Another program listens on the port the app wants.'), fixes: [{ where: 'settings', text: 'Clear Fixed port so covibe picks a free one, or stop the other app.' }] });
  }

  // Domains the sandbox does not let it reach.
  if (app.runtime === 'sandbox') {
    const hosts = new Set<string>();
    for (const m of log.matchAll(/(?:ENOTFOUND|EAI_AGAIN|getaddrinfo \w+)\s+([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1]!.toLowerCase());
    for (const m of log.matchAll(/(?:request to|GET|fetch(?:ing)?) https?:\/\/([a-z0-9.-]+\.[a-z]{2,})[^\s]* (?:failed|403|blocked)/gi)) hosts.add(m[1]!.toLowerCase());
    if (hosts.size) {
      const list = [...hosts].slice(0, 5).join(', ');
      add({
        kind: 'blocked_domain',
        title: `The sandbox blocked ${list}`,
        detail: 'The app reaches only the team’s sandbox domains.',
        fixes: [
          { where: 'team', text: `Add ${list} to the team file's app.network (only the app) or defaults.sandbox.network (members too).` },
          { where: 'settings', text: 'Or run it in Docker, where the sandbox’s domain list does not apply.' },
        ],
      });
    }
    const denied = /(?:EPERM|EACCES|EROFS)[^\n]*?'([^']+)'|Operation not permitted[^\n]*?([/~][^\s'"]+)/.exec(log);
    if (denied) {
      const path = denied[1] ?? denied[2]!;
      add({
        kind: 'blocked_write',
        title: `The sandbox did not let it write ${clip(path, 80)}`,
        detail: 'In the sandbox the app writes only in its folder, its temp folder ($TMPDIR) and package caches.',
        fixes: [
          { where: 'code', text: 'Have the app write inside its folder or $TMPDIR (a member can change that).' },
          { where: 'settings', text: 'Or run it in Docker.' },
        ],
      });
    }
  }

  if (/Docker is not running/.test(reason)) add({ kind: 'docker', title: 'Docker is not running', detail: reason, fixes: [{ where: 'computer', text: 'Start Docker Desktop.' }, { where: 'settings', text: 'Or switch How it runs to the sandbox.' }] });

  // It ran but never answered on $PORT.
  if (/did not answer/.test(reason)) {
    const other = [...log.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/g)].map((m) => Number(m[1])).find((p) => p !== app.port);
    const desktop = /\belectron(-vite|-forge|-builder)?\b/.test(`${app.command ?? ''}\n${log}`);
    if (desktop) {
      add({
        kind: 'no_port',
        title: 'This starts a desktop (Electron) app, which does not serve a web page on $PORT',
        detail: 'The App tab shows web apps. An Electron window opens on this computer (if at all from the sandbox), not in covibe.',
        fixes: [
          { where: 'code', text: 'Add a script that serves only the renderer with Vite on $PORT (e.g. "dev:web"), with Electron’s preload API stubbed.' },
          { where: 'team', text: 'Point the team file’s app.command at that script, or set app: false on members who should not start it.' },
        ],
      });
    } else if (other) {
      add({
        kind: 'wrong_port',
        title: `It listens on port ${other}, not on $PORT (${app.port})`,
        detail: 'covibe gives the app a free port in $PORT and waits for it there.',
        fixes: settingsFix('Pass the port to the command (e.g. `-- --port $PORT --host 127.0.0.1` for Vite, `-p $PORT` for Next)'),
      });
    } else {
      add({ kind: 'no_port', title: 'It never answered on $PORT', detail: clip(reason), fixes: settingsFix('Make the command listen on 127.0.0.1:$PORT, or raise ready_timeout_s if it is only slow') });
    }
  }

  if (!out.length && /exited with code/.test(reason)) {
    const last = log.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('$')).slice(-3).join(' · ');
    add({ kind: 'crashed', title: reason.replace(/^the app /, 'It '), detail: last ? clip(last, 300) : 'Its log does not say why.', fixes: [{ where: where, text: 'Check the command and setup; an agent can look into it for you.' }] });
  }
  return out;
}
