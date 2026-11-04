import type { RunEvent, RunRecord } from './events/types.js';
import { WORKTREE_PATH } from './server/projections.js';

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
  // Show worktree paths relative to the worktree: …/worktrees/<repo>/<run>/<agent>/web/x → web/x
  const shown = String(pick).replace(WORKTREE_PATH, '');
  return `${tool} ${one(shown, 120)}`;
}

/** One line per event for the plain log view. */
/** Running totals that would flood the terminal; the turn's end line has the figures. */
export const QUIET_EVENTS = new Set(['agent.usage']);

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
    case 'step.finished': {
      text = dim(`✓ step ${e.step} done`);
      // A plan reads as its summary and one line per task.
      const out = (d.parallel ? undefined : d.output) as Record<string, unknown> | undefined;
      if (out && Array.isArray(out.tasks)) {
        const tasks = (out.tasks as Record<string, unknown>[]).map(
          (t) => `\n${' '.repeat(28)}• ${t.owner ? cyan(`[${t.owner}] `) : ''}${one(String(t.title ?? t.description ?? t.id ?? JSON.stringify(t)), 120)}`,
        );
        text += (typeof out.summary === 'string' ? `: ${one(out.summary, 200)}` : '') + tasks.join('');
      }
      break;
    }
    case 'step.skipped':
      text = dim(`skipped (${d.reason})`);
      break;
    case 'summary.written':
      text = d.ok ? `summary written by ${d.model}` + dim(` ($${Number(d.cost_usd ?? 0).toFixed(4)})`) : yellow(`${d.model} could not write the summary (${d.error}); covibe's own is used`);
      break;
    case 'members.selected': {
      const skipped = (d.skipped as string[] | undefined) ?? [];
      text = `needed: ${(d.members as string[]).join(', ') || 'nobody else'}` + (skipped.length ? dim(` · left out: ${skipped.join(', ')}`) : '') + (d.reason ? dim(` (${d.reason})`) : '');
      break;
    }
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
      text = `started ${dim(`${d.model ?? 'default model'} via ${d.backend}${d.resumed ? ', resumed' : ''}`)}${d.request_from ? ` on ${d.request_from}'s request #${d.request}` : ''}`;
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
      text = d.kept
        ? yellow(`changed outside its write scope (left in the folder): ${(d.files as string[]).join(', ')}`)
        : yellow(`discarded out-of-scope changes: ${(d.files as string[]).join(', ')}`);
      break;
    case 'files.changed':
      text = dim(`changed ${(d.files as string[]).length} file${(d.files as string[]).length === 1 ? '' : 's'}: ${one((d.files as string[]).join(', '), 120)}`);
      break;
    case 'files.undone':
      text = `undone: ${(d.restored as string[]).length} restored, ${(d.removed as string[]).length} removed${(d.skipped as unknown[]).length ? yellow(`, ${(d.skipped as unknown[]).length} left as they are`) : ''}`;
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
      text = dim(`✉ delivered message #${d.id} from ${d.from}${d.live ? (d.mode === 'interrupt' ? ' (interrupted its turn)' : ' (while working)') : ''}`);
      break;
    case 'brain.proposed':
      text = `✎ proposed brain note #${d.id}: ${d.title}`;
      break;
    case 'brain.decided':
      text = `✎ brain proposal #${d.id} ${d.status}${d.note_path ? ` into ${d.note_path}` : ''}`;
      break;
    case 'brain.updated':
      text = dim(`brain updated (${String(d.commit).slice(0, 7)})`);
      break;
    case 'workspace.cleaned':
      text = dim(`worktrees removed (${(Number(d.freed_kb) / 1024).toFixed(1)} MB freed)`);
      break;
    case 'backend.warning':
      text = yellow(`warning: ${d.message}`);
      break;
    case 'question.asked':
      text = `? asks ${d.to === 'human' ? 'you' : d.to} (#${d.id}): ${one(String(d.question), 200)}`;
      break;
    case 'question.escalated':
      text = yellow(`? passes #${d.id} from ${d.from} to you: ${one(String(d.question), 200)}`) + (d.reason ? dim(` (${one(String(d.reason), 120)})`) : '');
      break;
    case 'question.answered':
      text = green(`✓ #${d.id} answered by ${d.by === 'human' ? 'you' : d.by}: `) + one(String(d.answer), 200);
      break;
    case 'request.sent':
      text = `⇢ asks ${d.to} for work (#${d.id}): ${one(String(d.request), 200)}`;
      break;
    case 'request.done':
      text = d.ok
        ? green(`⇠ ${d.to} finished request #${d.id}: `) + one(String(d.reply), 200)
        : red(`⇠ ${d.to} could not finish request #${d.id}: ${one(String(d.error), 200)}`);
      break;
    case 'run.paused':
      text = bold(yellow('⏸ run paused until you answer'));
      break;
    case 'run.resumed':
      text = green('▶ run resumed');
      break;
    case 'agent.limited':
      text = yellow(
        d.switched_to
          ? `hit a usage limit; continues on the ${d.switched_to} account`
          : d.waiting
          ? `⏸ hit the plan's usage limit; continues ${d.until ? `at ${new Date(String(d.until)).toLocaleTimeString()}` : 'once it resets'}`
          : `stopped by the plan's usage limit${d.resets_at ? ` (resets ${new Date(String(d.resets_at)).toLocaleString()})` : ''}`,
      );
      break;
    case 'agent.view':
      text = dim(`👁 looked at ${d.file ?? `an image from ${d.tool}`}`);
      break;
    case 'run.restarted':
      text = green(`↻ restarted as run ${d.run_id}`);
      break;
    case 'run.continued':
      text = green(`▶ continued from step ${d.from_step}${d.kind === 'round' ? ` with another fix round (${d.loop})` : ''}`);
      break;
    case 'run.restart_scheduled':
      text = dim(`↻ restart scheduled for ${new Date(String(d.at)).toLocaleString()}`);
      break;
    case 'run.restart_cancelled':
      text = dim('restart cancelled');
      break;
    default:
      text = JSON.stringify(d);
  }
  return `${time} ${dim(who.padEnd(18))} ${text}`;
}

/** One line per run; a live run waiting for your answer shows as paused. */
export function formatRun(r: RunRecord, paused = false): string {
  const status = paused ? yellow : r.status === 'succeeded' ? green : r.status === 'running' ? cyan : r.status === 'escalated' ? yellow : red;
  return `${r.id}  ${status((paused ? 'paused' : r.status).padEnd(9))}  ${r.team.padEnd(16)}  ${one(r.goal, 60)}`;
}
