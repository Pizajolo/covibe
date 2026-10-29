// The run's plan and the other steps' reports, readable rather than as JSON:
// the plan's summary and its tasks by owner, the requests members made of each
// other, and every other step's latest report.
import type { RequestView, RunDetail, RunSummary, StepReport } from '../api';
import { IconCheck, IconPlan, IconSpinner } from './icons';
import { Markdown } from './Markdown';
import { AgentStatus, Avatar, Empty } from './ui';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const human = (key: string) => {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function PlanTab({ detail, onOpen }: { detail: RunDetail; onOpen: (agent: string) => void }) {
  const run = detail.summary;
  const plan = detail.reports.find((r) => r.step === detail.planStep);
  const others = detail.reports.filter((r) => r.step !== detail.planStep);
  const planState = run.steps.find((s) => s.id === detail.planStep);
  const planner = planState?.cards.at(-1)?.agent ?? plan?.agents[0];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <div className="col" style={{ gap: 14, maxWidth: 1000, margin: '0 auto' }}>
        {detail.planStep &&
          (plan ? (
            <PlanCard run={run} report={plan} onOpen={onOpen} />
          ) : (
            <div className="card">
              <div className="card-head">
                <h2>Plan</h2>
              </div>
              <div style={{ padding: 16 }} className="row small muted">
                {planState?.status === 'running' ? (
                  <>
                    <IconSpinner width={14} height={14} style={{ color: 'var(--accent)' }} />
                    {planner ?? 'The planner'} is planning
                    {planner && run.agents.find((a) => a.name === planner)?.activity ? `: ${run.agents.find((a) => a.name === planner)!.activity}` : '…'}
                  </>
                ) : planState?.status === 'pending' && run.status === 'running' ? (
                  'The plan shows here once the planning step finishes.'
                ) : (
                  'This run has no recorded plan (runs from older versions of covibe did not keep reports).'
                )}
              </div>
            </div>
          ))}

        {run.requests.length > 0 && <Requests run={run} onOpen={onOpen} />}

        {others.map((r) => (
          <ReportCard key={r.step} run={run} report={r} />
        ))}

        {!detail.planStep && !detail.reports.length && !run.requests.length && (
          <Empty icon={<IconPlan />} title="No reports yet">
            Each step's report shows here when the step finishes: the plan, reviews, test results.
          </Empty>
        )}
      </div>
    </div>
  );
}

function Byline({ run, report }: { run: RunSummary; report: StepReport }) {
  return (
    <span className="hint">
      by {report.agents.join(', ') || 'the team'}
      {report.round > 0 ? ` · fix round ${report.round}` : ''} · {new Date(report.ts).toLocaleTimeString()}
      {run.steps.find((s) => s.id === report.step)?.status === 'running' ? ' · running again' : ''}
    </span>
  );
}

function PlanCard({ run, report, onOpen }: { run: RunSummary; report: StepReport; onOpen: (agent: string) => void }) {
  const out = report.output;
  const index = (name: string) => run.agents.findIndex((a) => a.name === name);
  if (!isObj(out) || report.parallel) return <ReportCard run={run} report={report} title="Plan" />;
  const tasks = Array.isArray(out.tasks) ? (out.tasks as unknown[]) : undefined;
  const rest = Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'summary' && k !== 'tasks' && k !== 'text'));
  // Tasks by owner, in the order owners first appear in the plan.
  const groups = new Map<string, Obj[]>();
  for (const t of tasks ?? []) {
    const task = isObj(t) ? t : { title: String(t) };
    const owner = typeof task.owner === 'string' ? task.owner : '';
    groups.set(owner, [...(groups.get(owner) ?? []), task]);
  }
  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <IconPlan width={15} height={15} />
        <h2>Plan</h2>
        <Byline run={run} report={report} />
        {tasks && (
          <span className="right tiny faint">
            {tasks.length} task{tasks.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="col plan" style={{ padding: 16, gap: 16 }}>
        {typeof out.summary === 'string' && <Markdown text={out.summary} />}
        {typeof out.text === 'string' && <Markdown text={out.text} />}
        {[...groups].map(([owner, list]) => {
          const member = run.agents.find((a) => a.name === owner);
          return (
            <section key={owner || '_'} className="col" style={{ gap: 8 }}>
              <div className="row plan-owner" onClick={owner ? () => onOpen(owner) : undefined} title={owner ? `Chat with ${owner}` : undefined}>
                {owner ? <Avatar name={owner} index={index(owner)} size="sm" /> : null}
                <strong>{owner || 'Not assigned'}</strong>
                <span className="tiny faint">
                  {list.length} task{list.length === 1 ? '' : 's'}
                </span>
                {member && <AgentStatus status={member.status} />}
              </div>
              {list.map((t, i) => (
                <Task key={String(t.id ?? i)} task={t} />
              ))}
            </section>
          );
        })}
        {Object.keys(rest).length > 0 && <Fields value={rest} />}
      </div>
    </div>
  );
}

function Task({ task }: { task: Obj }) {
  const acceptance = Array.isArray(task.acceptance) ? (task.acceptance as unknown[]) : undefined;
  const rest = Object.fromEntries(Object.entries(task).filter(([k]) => !['id', 'owner', 'title', 'description', 'acceptance'].includes(k)));
  return (
    <div className="plan-task">
      <div className="row" style={{ gap: 8 }}>
        {task.id !== undefined && <span className="chip static mono">{String(task.id)}</span>}
        <strong className="grow">{String(task.title ?? task.description ?? '')}</strong>
      </div>
      {typeof task.description === 'string' && task.title !== undefined && <Markdown text={task.description} />}
      {acceptance && acceptance.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <span className="label">Done when</span>
          <ul className="plan-checks">
            {acceptance.map((a, i) => (
              <li key={i}>
                <IconCheck width={12} height={12} />
                <span>{typeof a === 'string' ? a : JSON.stringify(a)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {Object.keys(rest).length > 0 && <Fields value={rest} />}
    </div>
  );
}

function Requests({ run, onOpen }: { run: RunSummary; onOpen: (agent: string) => void }) {
  const index = (name: string) => run.agents.findIndex((a) => a.name === name);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Requests between members</h2>
        <span className="hint">work members asked teammates for, outside the workflow's steps</span>
      </div>
      <div className="col" style={{ padding: 16, gap: 10 }}>
        {[...run.requests].reverse().map((r) => (
          <RequestItem key={r.id} r={r} index={index} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function RequestItem({ r, index, onOpen }: { r: RequestView; index: (n: string) => number; onOpen: (agent: string) => void }) {
  const pill = r.status === 'working' ? ['info', 'Working'] : r.status === 'done' ? ['good', 'Done'] : ['bad', 'Not done'];
  return (
    <div className="plan-task">
      <div className="row" style={{ gap: 8 }}>
        <span className="row plan-owner" onClick={() => onOpen(r.from)} title={`Chat with ${r.from}`}>
          <Avatar name={r.from} index={index(r.from)} size="sm" />
          <strong>{r.from}</strong>
        </span>
        <span className="faint">asked</span>
        <span className="row plan-owner" onClick={() => onOpen(r.to)} title={`Chat with ${r.to}`}>
          <Avatar name={r.to} index={index(r.to)} size="sm" />
          <strong>{r.to}</strong>
        </span>
        <span className="grow tiny faint">{r.step ? `during ${r.step} · ` : ''}{new Date(r.sentAt).toLocaleTimeString()}</span>
        <span className={`pill ${pill[0]}`}>
          {r.status === 'working' && <IconSpinner />}
          {pill[1]}
        </span>
      </div>
      <Markdown text={r.request} />
      {r.context && <div className="small muted">{r.context}</div>}
      {(r.reply || r.error) && (
        <details open={r.status !== 'done'}>
          <summary className="small">{r.error ? 'Why not' : `${r.to}'s reply`}</summary>
          <Markdown text={r.reply ?? r.error ?? ''} />
        </details>
      )}
      {r.files.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {r.files.map((f) => (
            <span key={f} className="chip static mono">
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({ run, report, title }: { run: RunSummary; report: StepReport; title?: string }) {
  const index = (name: string) => run.agents.findIndex((a) => a.name === name);
  const out = report.output;
  return (
    <details className="card report" open={!!title}>
      <summary className="card-head">
        <h2>{title ?? `Report: ${report.step}`}</h2>
        <Byline run={run} report={report} />
      </summary>
      <div className="col" style={{ padding: 16, gap: 14 }}>
        {report.parallel && isObj(out) ? (
          Object.entries(out).map(([agent, value]) => (
            <section key={agent} className="col" style={{ gap: 8 }}>
              <div className="row plan-owner">
                <Avatar name={agent} index={index(agent)} size="sm" />
                <strong>{agent}</strong>
              </div>
              <ReportValue value={value} />
            </section>
          ))
        ) : (
          <ReportValue value={out} />
        )}
      </div>
    </details>
  );
}

/** Any report value as text, lists and labelled fields. */
function ReportValue({ value }: { value: unknown }) {
  if (typeof value === 'string') return value.includes('\n') || value.length > 120 ? <Markdown text={value} /> : <span>{value}</span>;
  if (value === null || value === undefined) return <span className="faint">—</span>;
  if (typeof value !== 'object') return <span className="mono">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="faint">none</span>;
    if (value.every((v) => !isObj(v) && !Array.isArray(v)))
      return (
        <ul className="report-list">
          {value.map((v, i) => (
            <li key={i}>{String(v)}</li>
          ))}
        </ul>
      );
    return (
      <div className="col" style={{ gap: 8 }}>
        {value.map((v, i) => (
          <div key={i} className="plan-task">
            <ReportValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  // A {text} report is the member's answer as written.
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'text' && typeof (value as Obj).text === 'string') return <Markdown text={(value as Obj).text as string} />;
  return <Fields value={value as Obj} />;
}

function Fields({ value }: { value: Obj }) {
  return (
    <dl className="report-fields">
      {Object.entries(value).map(([k, v]) => (
        <div key={k}>
          <dt>{human(k)}</dt>
          <dd>
            <ReportValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
