import { useEffect, useState } from 'react';
import { del, get, post, put, type AppSettings, type BacklogSettings, type BacklogView, type CheckMode, type GoalView } from '../api';
import { href, useData, useLive } from '../data';
import { countdown, resetTime } from '../format';
import { Composer } from './Composer';
import { IconAlert, IconCheck, IconClip, IconClock, IconPlay, IconQuestion, IconRuns, IconSpinner, IconStop, IconTrash, IconUp, IconUndo } from './icons';
import { Empty, Modal, RunStatusPill, Since, useAction, useToast } from './ui';

const CHECKS: { value: CheckMode; label: string }[] = [
  { value: 'fast', label: 'the lead on Haiku (faster)' },
  { value: 'lead', label: 'the lead' },
  { value: 'off', label: 'nobody' },
];

/**
 * A project's backlog: goals lined up for the team. New goals are checked for
 * anything only you can settle; the rest are worked off one after another,
 * waiting while plan usage is above the threshold set in Settings.
 */
export function Backlog({ projectId, plain }: { projectId: string; plain: boolean }) {
  const { value: view, setValue } = useLive(
    () => get<BacklogView>(`/api/projects/${projectId}/backlog`),
    [projectId],
    (e) => e.projectId === projectId && /^(backlog\.|goal\.|run\.|agent\.(limited|finished|error))/.test(e.event.type),
  );
  if (!view) return <div className="content faint small">Loading the backlog…</div>;
  const needsYou = view.goals.filter((g) => g.status === 'needs_info');
  const upNext = view.goals.filter((g) => g.status === 'checking' || g.status === 'ready');
  const started = view.goals.filter((g) => g.state === 'started').sort((a, b) => (b.run?.startedAt ?? '').localeCompare(a.run?.startedAt ?? ''));

  return (
    <div className="content">
      <div className="page">
        <BacklogHead projectId={projectId} view={view} plain={plain} onView={setValue} />
        <div className="card">
          <Composer fixedProject={projectId} initialMode="backlog" defaultTeam={view.settings.team} key={view.settings.team ?? ''} />
        </div>
        {needsYou.length > 0 && (
          <div className="card">
            <div className="card-head">
              <h2>Needs you</h2>
              <span className="tiny faint">Answer what the check asked, or send the goal on as it is.</span>
            </div>
            <div className="list">
              {needsYou.map((g) => (
                <NeedsYou key={g.id} projectId={projectId} goal={g} onView={setValue} />
              ))}
            </div>
          </div>
        )}
        <div className="card">
          <div className="card-head">
            <h2>Up next</h2>
            <span className="tiny faint">{upNext.length ? `${upNext.length} goal${upNext.length > 1 ? 's' : ''}, in the order the team takes them` : ''}</span>
          </div>
          {upNext.length ? (
            <div className="list">
              {upNext.map((g, i) => (
                <Waiting key={g.id} projectId={projectId} goal={g} all={view.goals} prev={upNext[i - 1]} next={upNext[i + 1]} position={i + 1} onView={setValue} />
              ))}
            </div>
          ) : (
            <Empty icon={<IconRuns />} title="Nothing lined up">
              Add goals above: the team works them off one after another.
            </Empty>
          )}
        </div>
        {started.length > 0 && (
          <div className="card">
            <div className="card-head">
              <h2>Worked on</h2>
            </div>
            <div className="list">
              {started.map((g) => (
                <Started key={g.id} projectId={projectId} goal={g} onView={setValue} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** What the backlog is doing, and how it works off goals. */
function BacklogHead({ projectId, view, plain, onView }: { projectId: string; view: BacklogView; plain: boolean; onView: (v: BacklogView) => void }) {
  const toast = useToast();
  const { overview } = useData();
  const teams = (overview?.teams ?? []).filter((t) => t.valid);
  const { settings, state } = view;
  const [save] = useAction(async (patch: Partial<BacklogSettings>) => onView(await put<BacklogView>(`/api/projects/${projectId}/backlog`, patch)));
  const [next, starting] = useAction(async () => {
    await post(`/api/projects/${projectId}/backlog/next`);
    toast('Started the next goal');
  });
  const working = state.kind === 'working' ? view.goals.find((g) => g.id === state.goalId) : undefined;
  const ready = view.goals.filter((g) => g.status === 'ready').length;
  // A countdown that moves while you look.
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.kind !== 'waiting') return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [state.kind]);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Backlog</h2>
        <div className="right">
          <div className="seg" role="tablist" aria-label="Backlog">
            <button className={settings.auto ? 'on' : ''} onClick={() => void save({ auto: true })} title="Start the next goal whenever the team is free">
              Working it off
            </button>
            <button className={!settings.auto ? 'on' : ''} onClick={() => void save({ auto: false })} title="Goals start only when you start them">
              Paused
            </button>
          </div>
        </div>
      </div>
      <div className="card-pad col" style={{ gap: 12 }}>
        {working?.run ? (
          <div className="banner info">
            <IconSpinner />
            <span className="grow">
              Working on <a href={href('runs', projectId, working.run.id)}>{firstLine(working.text)}</a>
              {ready ? `. ${ready} more waiting.` : '.'}
            </span>
          </div>
        ) : state.kind === 'waiting' ? (
          <div className="banner warn">
            <IconClock />
            <span className="grow">
              Waiting for your plan: {state.account ? `${state.account}'s ` : ''}
              {state.label.toLowerCase()} usage is at {state.used}% (the backlog waits at {view.maxUsage}%).{' '}
              {state.until ? `The next goal starts after it resets, ${resetTime(state.until)} (in ${countdown(state.until)}).` : 'The next goal starts once it comes down.'}
            </span>
            <button className="btn sm" disabled={starting} onClick={() => void next()}>
              <IconPlay /> Start next now
            </button>
          </div>
        ) : state.kind === 'paused' ? (
          <div className="banner warn">
            <IconStop />
            <span className="grow">
              Paused, with {ready} goal{ready > 1 ? 's' : ''} waiting. Goals start only when you start them.
            </span>
            <button className="btn sm" disabled={starting} onClick={() => void next()}>
              <IconPlay /> Start next now
            </button>
            <button className="btn sm primary" onClick={() => void save({ auto: true })}>
              Work it off
            </button>
          </div>
        ) : (
          <div className="small muted">{ready ? 'Starting the next goal…' : 'Nothing waiting. Goals you add are checked, then the team takes them one after another.'}</div>
        )}
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="row small" style={{ gap: 6 }}>
            Team
            <select className="input" style={{ width: 'auto' }} value={settings.team ?? ''} onChange={(e) => void save({ team: e.target.value })}>
              <option value="">The one you pick</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="row small" style={{ gap: 6 }} title="Before a goal waits its turn, it is checked for anything only you can settle">
            New goals are checked by
            <select className="input" style={{ width: 'auto' }} value={settings.check} onChange={(e) => void save({ check: e.target.value as CheckMode })}>
              {CHECKS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {!plain && (
            <label className="check small" title="Otherwise each goal starts from your branch">
              <input type="checkbox" checked={settings.chain} onChange={(e) => void save({ chain: e.target.checked })} />
              Build each goal on the last one's result
            </label>
          )}
        </div>
        <UsageThreshold onChange={(maxUsage) => onView({ ...view, maxUsage })} />
      </div>
    </div>
  );
}

/** Settings' usage threshold for every backlog: wait for the plan to reset once this much of it is used. */
export function UsageThreshold({ onChange }: { onChange?: (max: number | null) => void }) {
  const toast = useToast();
  const { value, setValue } = useLive(() => get<AppSettings>('/api/settings'), []);
  const [draft, setDraft] = useState<string | null>(null);
  const [save] = useAction(async (max: number | null) => {
    const saved = await put<AppSettings>('/api/settings', { backlogMaxUsage: max });
    setValue(saved);
    setDraft(null);
    onChange?.(saved.backlogMaxUsage);
    toast(max === null ? 'Backlogs start goals whatever the plan usage' : `Backlogs wait for the reset once ${max}% of the plan is used`);
  });
  if (!value) return null;
  const max = value.backlogMaxUsage;
  const commit = () => {
    if (draft === null) return;
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 1 && n <= 100 && n !== max) void save(n);
    else setDraft(null);
  };
  return (
    <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
      <label className="check">
        <input type="checkbox" checked={max !== null} onChange={(e) => void save(e.target.checked ? 90 : null)} />
        Don't start the next goal once
      </label>
      <input
        className="input num"
        style={{ width: 64 }}
        type="number"
        min={1}
        max={100}
        disabled={max === null}
        value={draft ?? String(max ?? 90)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label="Plan usage, percent"
      />
      <span>% of the plan's 5-hour or weekly usage is used; wait for it to reset.</span>
      <span className="tiny faint">For every project's backlog. You can always start a goal yourself.</span>
    </div>
  );
}

function firstLine(text: string, n = 120): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

function GoalText({ goal }: { goal: GoalView }) {
  const [open, setOpen] = useState(false);
  const long = goal.text.includes('\n') || goal.text.length > 160;
  return (
    <div className="col" style={{ gap: 2, minWidth: 0 }}>
      <span style={{ fontWeight: 500, whiteSpace: open ? 'pre-wrap' : undefined }} className={open ? '' : 'ellipsis'}>
        {open ? goal.text : firstLine(goal.text, 200)}
      </span>
      <span className="tiny faint row" style={{ gap: 6 }}>
        <span>{goal.team}</span>
        <span>·</span>
        <Since iso={goal.createdAt} />
        {goal.attachments.length > 0 && (
          <span className="row" style={{ gap: 3 }} title={goal.attachments.map((a) => a.name).join(', ')}>
            · <IconClip width={11} height={11} /> {goal.attachments.length} file{goal.attachments.length > 1 ? 's' : ''}
          </span>
        )}
        {long && (
          <button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={() => setOpen((o) => !o)}>
            {open ? 'Less' : 'More'}
          </button>
        )}
      </span>
    </div>
  );
}

/** What the check made of a goal: its summary, and a link to how it got there. */
function CheckNote({ projectId, goal }: { projectId: string; goal: GoalView }) {
  const c = goal.check;
  if (!c || c.verdict === 'skipped') return null;
  const link = c.runId ? (
    <a className="tiny" href={href('runs', projectId, c.runId, 'chat')}>
      how {c.by ?? 'the check'} got there
    </a>
  ) : null;
  if (c.error) return <span className="tiny" style={{ color: 'var(--bad)' }}>{c.verdict === 'failed' ? `The check could not run (${c.error}); the goal went on without it.` : c.error} {link}</span>;
  const asked = c.questions?.length ?? 0;
  const answered = c.questions?.filter((q) => q.answer).length ?? 0;
  const after = goal.status !== 'needs_info' && asked ? (answered ? ` You answered ${answered} of ${asked} question${asked > 1 ? 's' : ''}.` : ' Sent on without answers.') : '';
  if (!c.summary && !after) return null;
  return (
    <span className="tiny muted">
      {c.by && c.summary ? `${c.by}: ` : ''}
      {c.summary}
      {after} {link}
    </span>
  );
}

function useGoalAction(projectId: string, goal: GoalView, onView: (v: BacklogView) => void) {
  const base = `/api/projects/${projectId}/goals/${goal.id}`;
  return {
    base,
    act: async (method: 'POST' | 'PUT' | 'DELETE', path = '', body: unknown = {}) =>
      onView(method === 'DELETE' ? await del<BacklogView>(base + path) : method === 'PUT' ? await put<BacklogView>(base + path, body) : await post<BacklogView>(base + path, body)),
  };
}

function GoalButtons({ projectId, goal, onView, children }: { projectId: string; goal: GoalView; onView: (v: BacklogView) => void; children?: React.ReactNode }) {
  const toast = useToast();
  const { base, act } = useGoalAction(projectId, goal, onView);
  const [editing, setEditing] = useState(false);
  const [start, starting] = useAction(async () => {
    await post(`${base}/start`);
    toast('Started');
  });
  const [remove] = useAction(() => act('DELETE'));
  return (
    <div className="row" style={{ gap: 4, flex: 'none' }}>
      {children}
      <button className="btn sm" disabled={starting} onClick={() => void start()} title="Start it now, whatever the backlog is doing">
        <IconPlay /> Start now
      </button>
      <button className="btn sm" onClick={() => setEditing(true)}>
        Edit
      </button>
      <button className="btn sm ghost icon-btn" title="Remove from the backlog" onClick={() => void remove()}>
        <IconTrash />
      </button>
      {editing && <EditGoal projectId={projectId} goal={goal} onView={onView} onClose={() => setEditing(false)} />}
    </div>
  );
}

function Waiting({ projectId, goal, all, prev, next, position, onView }: { projectId: string; goal: GoalView; all: GoalView[]; prev?: GoalView; next?: GoalView; position: number; onView: (v: BacklogView) => void }) {
  const { act } = useGoalAction(projectId, goal, onView);
  // Moving past a neighbour puts the goal where the neighbour is in the whole list.
  const [move] = useAction((to: GoalView) => act('POST', '/move', { index: all.findIndex((g) => g.id === to.id) }));
  return (
    <div className="list-row" style={{ alignItems: 'flex-start' }}>
      <span className="num faint small" style={{ width: 18, textAlign: 'right', paddingTop: 1 }}>
        {position}
      </span>
      <div className="grow col" style={{ gap: 4, minWidth: 0 }}>
        <GoalText goal={goal} />
        {goal.status === 'checking' ? (
          <span className="tiny faint row" style={{ gap: 5 }}>
            <IconSpinner width={11} height={11} /> Checking whether anything is unclear…
          </span>
        ) : (
          <CheckNote projectId={projectId} goal={goal} />
        )}
      </div>
      <GoalButtons projectId={projectId} goal={goal} onView={onView}>
        <button className="btn sm ghost icon-btn" title="Earlier" disabled={!prev} onClick={() => prev && void move(prev)}>
          <IconUp />
        </button>
        <button className="btn sm ghost icon-btn" title="Later" disabled={!next} onClick={() => next && void move(next)}>
          <IconUp style={{ transform: 'rotate(180deg)' }} />
        </button>
      </GoalButtons>
    </div>
  );
}

function NeedsYou({ projectId, goal, onView }: { projectId: string; goal: GoalView; onView: (v: BacklogView) => void }) {
  const toast = useToast();
  const { act } = useGoalAction(projectId, goal, onView);
  const questions = goal.check?.questions ?? [];
  const [answers, setAnswers] = useState<string[]>(() => questions.map((q) => q.answer ?? ''));
  const [send, sending] = useAction(async () => {
    await act('POST', '/answer', { answers });
    toast('In the backlog, with your answers');
  });
  const [queue] = useAction(async () => {
    await act('POST', '/queue');
    toast('In the backlog as it is');
  });
  const [recheck] = useAction(() => act('POST', '/check'));
  const set = (i: number, v: string) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
  return (
    <div className="list-row" style={{ alignItems: 'flex-start' }}>
      <IconQuestion width={16} height={16} style={{ color: 'var(--warn)', flex: 'none', marginTop: 2 }} />
      <div className="grow col" style={{ gap: 8, minWidth: 0 }}>
        <GoalText goal={goal} />
        <CheckNote projectId={projectId} goal={goal} />
        {questions.map((q, i) => (
          <div key={i} className="col" style={{ gap: 4 }}>
            <span className="small">{q.question}</span>
            {q.options && (
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {q.options.map((o) => (
                  <button key={o} className={`btn sm ${answers[i] === o ? 'primary' : ''}`} onClick={() => set(i, o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            <input className="input" value={answers[i] ?? ''} placeholder={q.options ? 'Or write your own answer' : 'Your answer (leave empty to let the team decide)'} onChange={(e) => set(i, e.target.value)} />
          </div>
        ))}
        <div className="row" style={{ gap: 6 }}>
          {questions.length > 0 && (
            <button className="btn sm primary" disabled={sending || answers.every((a) => !a.trim())} onClick={() => void send()}>
              <IconCheck /> Answer and add to the backlog
            </button>
          )}
          <button className="btn sm" onClick={() => void queue()} title="The team decides what the questions leave open">
            Add as it is
          </button>
          <button className="btn sm ghost" onClick={() => void recheck()} title="Look the goal over again (after you edited it, say)">
            <IconUndo /> Check again
          </button>
        </div>
      </div>
      <GoalButtons projectId={projectId} goal={goal} onView={onView} />
    </div>
  );
}

function Started({ projectId, goal, onView }: { projectId: string; goal: GoalView; onView: (v: BacklogView) => void }) {
  const toast = useToast();
  const { act } = useGoalAction(projectId, goal, onView);
  const [again] = useAction(async () => {
    await act('POST', '/queue');
    toast('Back in the backlog');
  });
  const [remove] = useAction(() => act('DELETE'));
  const run = goal.run;
  const ended = goal.status !== 'running';
  return (
    <div className="list-row">
      {goal.status === 'succeeded' ? (
        <IconCheck width={16} height={16} style={{ color: 'var(--good)', flex: 'none' }} />
      ) : goal.status === 'running' ? (
        <IconSpinner width={16} height={16} style={{ color: 'var(--accent)', flex: 'none' }} />
      ) : (
        <IconAlert width={16} height={16} style={{ color: 'var(--warn)', flex: 'none' }} />
      )}
      <div className="grow" style={{ minWidth: 0 }}>
        <GoalText goal={goal} />
      </div>
      {goal.runs.length > 1 && <span className="tiny faint">{goal.runs.length} runs</span>}
      {run && (
        <a href={href('runs', projectId, run.id)} title="Open the run">
          <RunStatusPill status={run.status} kind={run.kind} paused={run.paused} limited={run.limit?.waiting} />
        </a>
      )}
      {ended && goal.status !== 'succeeded' && (
        <button className="btn sm" onClick={() => void again()} title="Line it up again; the team starts from where it stopped if you build on results">
          Try again
        </button>
      )}
      {ended && (
        <button className="btn sm ghost icon-btn" title="Remove from the list (the run stays)" onClick={() => void remove()}>
          <IconTrash />
        </button>
      )}
    </div>
  );
}

function EditGoal({ projectId, goal, onView, onClose }: { projectId: string; goal: GoalView; onView: (v: BacklogView) => void; onClose: () => void }) {
  const { overview } = useData();
  const teams = (overview?.teams ?? []).filter((t) => t.valid);
  const { act } = useGoalAction(projectId, goal, onView);
  const [text, setText] = useState(goal.text);
  const [team, setTeam] = useState(goal.team);
  const [save, saving] = useAction(async () => {
    await act('PUT', '', { text, team });
    onClose();
  });
  return (
    <Modal
      title="Edit goal"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || !text.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <textarea className="input" rows={6} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <label className="field">
          Team
          <select className="input" value={team} onChange={(e) => setTeam(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="help">A changed goal is checked again before it waits its turn.</span>
        </label>
      </div>
    </Modal>
  );
}
