import type { RunEvent, RunRecord } from './events/types.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);
export const bold = paint(1);

function one(s: string, n = 160) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function toolSummary(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.path ?? i.url ?? i.to;
  if (pick === undefined) return tool;
  // Show worktree paths relative to the worktree: .covibe/worktrees/<run>/<agent>/web/x → web/x
  const shown = String(pick).replace(/\S*\/\.covibe\/worktrees\/[^/\s]+\/[^/\s]+\//g, '');
  return `${tool} ${one(shown, 120)}`;
}

/** One line per event for the plain log view. */
export function formatEvent(e: RunEvent): string {
  const time = dim(e.ts.slice(11, 19));
  const who = [e.step, e.agent].filter(Boolean).join('/') || 'run';
  const d = e.data as Record<string, any>;
  let text: string;
  switch (e.type) {
    case 'run.started':
      text = bold(`run started: ${d.team} — ${one(d.goal)}`) + dim(` [${d.isolation}${d.branch ? `, branch ${d.branch}` : ''}]`);
      break;
    case 'run.finished': {
      const paintStatus = d.status === 'succeeded' ? green : d.status === 'escalated' ? yellow : red;
      text = bold(paintStatus(`run ${d.status}`)) + (d.reason ? `: ${d.reason}` : '') + dim(` (loops ${d.loops}, $${Number(d.cost_usd).toFixed(4)})`);
      break;
    }
    case 'step.started':
      text = cyan(`▶ step ${e.step}`) + (d.loop ? dim(` round ${d.loop}`) : '');
      break;
    case 'step.finished':
      text = dim(`✓ step ${e.step} done`);
      break;
    case 'step.skipped':
      text = dim(`skipped (${d.reason})`);
      break;
    case 'gate.passed':
      text = green(`gate passed: ${d.gate}`);
      break;
    case 'gate.failed':
      text = red(`gate failed: ${d.gate}`) + dim(` → ${JSON.stringify(d.value)}`);
      break;
    case 'loop.goto':
      text = yellow(`↺ back to ${d.to} (round ${d.loop}/${d.max_loops})`) + dim(` feedback: ${one(JSON.stringify(d.feedback), 200)}`);
      break;
    case 'agent.started':
      text = `started ${dim(`${d.model ?? 'default model'} via ${d.backend}${d.resumed ? ', resumed' : ''}`)}`;
      break;
    case 'agent.text':
      text = one(String(d.text));
      break;
    case 'agent.tool':
      text = dim('⚙ ') + toolSummary(String(d.tool), d.input);
      break;
    case 'agent.finished':
      text = green('finished') + dim(` ${d.turns} turns, ${(d.duration_ms / 1000).toFixed(1)}s, $${Number(d.cost_usd).toFixed(4)}`);
      break;
    case 'agent.error':
      text = red(`error: ${d.error}`);
      break;
    case 'scope.denied':
      text = yellow(`blocked ${toolSummary(String(d.tool), d.input)}: ${d.reason}`);
      break;
    case 'scope.violation':
      text = yellow(`discarded out-of-scope changes: ${(d.files as string[]).join(', ')}`);
      break;
    case 'git.commit':
      text = dim(`committed ${String(d.commit).slice(0, 8)} (${(d.files as string[]).length} files)`);
      break;
    case 'git.merge':
      text = dim(`merged into ${d.into}`);
      break;
    case 'message.queued':
      text = `✉ ${d.from ?? e.agent} → ${d.to}: ${one(String(d.text), 120)}`;
      break;
    case 'message.delivered':
      text = dim(`✉ delivered message #${d.id} from ${d.from}`);
      break;
    case 'backend.warning':
      text = yellow(`warning: ${d.message}`);
      break;
    default:
      text = JSON.stringify(d);
  }
  return `${time} ${dim(who.padEnd(18))} ${text}`;
}

export function formatRun(r: RunRecord): string {
  const status = r.status === 'succeeded' ? green : r.status === 'running' ? cyan : r.status === 'escalated' ? yellow : red;
  return `${r.id}  ${status(r.status.padEnd(9))}  ${r.team.padEnd(16)}  ${one(r.goal, 60)}`;
}
