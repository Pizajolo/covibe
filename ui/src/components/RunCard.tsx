import type { RunSummary } from '../api';
import { href } from '../data';
import { duration, money } from '../format';
import { IconQuestion } from './icons';
import { AgentStatus, Avatar, LoopBadge, RunStatusPill, Since } from './ui';

/** A live run: goal, status and what each member is doing. */
export function RunCard({ run }: { run: RunSummary }) {
  const working = run.agents.filter((a) => a.status === 'working' || a.status === 'asking');
  return (
    <a className="card card-pad col" href={href('runs', run.projectId, run.id)} style={{ color: 'var(--text)', gap: 12 }}>
      <div className="row">
        <RunStatusPill status={run.status} kind={run.kind} paused={run.paused} />
        <LoopBadge loops={run.loops} max={run.maxLoops} />
        <span className="grow" />
        <span className="tiny faint num">
          {duration(run.startedAt, run.finishedAt)} · {money(run.costUsd)}
        </span>
      </div>
      <h3 className="ellipsis" style={{ fontSize: 14 }}>
        {run.goal}
      </h3>
      <div className="tiny faint">
        {run.team} · {run.projectName}
      </div>
      <div className="col" style={{ gap: 6 }}>
        {(working.length ? working : run.agents.slice(0, 3)).map((a) => (
          <div className="row" key={a.name}>
            <Avatar name={a.name} index={run.agents.indexOf(a)} size="sm" />
            <span style={{ fontWeight: 600, fontSize: 12 }}>{a.name}</span>
            <span className="tiny muted ellipsis grow">{a.status === 'working' || a.status === 'asking' ? a.activity : ''}</span>
            <AgentStatus status={a.status} />
          </div>
        ))}
      </div>
    </a>
  );
}

/** One line in a list of runs. */
export function RunRow({ run }: { run: RunSummary }) {
  return (
    <a className="list-row" href={href('runs', run.projectId, run.id)}>
      {run.kind === 'ask' ? <IconQuestion width={16} height={16} style={{ color: 'var(--text-3)', flex: 'none' }} /> : null}
      <div className="grow col" style={{ gap: 2 }}>
        <span className="ellipsis" style={{ fontWeight: 500 }}>
          {run.goal}
        </span>
        <span className="tiny faint">
          {run.team} · {run.projectName} · <Since iso={run.startedAt} />
        </span>
      </div>
      <div className="avatars">
        {run.agents.slice(0, 5).map((a, i) => (
          <Avatar key={a.name} name={a.name} index={i} size="sm" status={a.status === 'working' ? 'working' : undefined} />
        ))}
      </div>
      <span className="tiny faint num" style={{ width: 56, textAlign: 'right' }}>
        {money(run.costUsd)}
      </span>
      <div style={{ width: 96, display: 'flex', justifyContent: 'flex-end' }}>
        <RunStatusPill status={run.status} kind={run.kind} paused={run.paused} />
      </div>
    </a>
  );
}
