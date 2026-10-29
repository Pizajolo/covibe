import { useEffect, useMemo, useRef, useState } from 'react';
import { desktop, get, post, type ChatItem, type DiffResult, type RunDetail, type RunEvent, type RunSummary, type UndoResult } from '../api';
import { Composer } from '../components/Composer';
import { MicButton, withSpoken } from '../components/MicButton';
import { deskNote, DeskPill, deskState, OfficeLegend, OfficeStage, Portrait, questionDesk, useFigures, type DeskState } from '../components/Office';
import {
  IconAlert,
  IconBranch,
  IconBrowser,
  IconChat,
  IconCheck,
  IconClock,
  IconEye,
  IconFlow,
  IconFolder,
  IconHome,
  IconInfo,
  IconLoop,
  IconPlan,
  IconPlay,
  IconQuestion,
  IconRuns,
  IconSend,
  IconSpinner,
  IconStop,
  IconTrash,
  IconUndo,
  IconX,
} from '../components/icons';
import { BrowserPreview, viewSrc } from '../components/BrowserView';
import { PlanTab } from '../components/Plan';
import { Preview } from '../components/Preview';
import { AppPanel } from '../components/AppPanel';
import { FeedbackProvider, useFeedback } from '../components/Feedback';
import { askedToShip, markAskedToShip, ShipDialog } from '../components/ShipDialog';
import { Toolbar } from '../components/Toolbar';
import { AgentStatus, Avatar, Copy, Empty, LoopBadge, Modal, RunStatusPill, useAction, useToast } from '../components/ui';
import { go, href, useData, useLive } from '../data';
import { clock, countdown, duration, money, resetTime, tokens, toolText } from '../format';
import { useNotify } from '../notify';

type Tab = 'office' | 'plan' | 'board' | 'activity' | 'chat' | 'changes' | 'preview' | 'app';
type Delivery = 'queue' | 'steer' | 'interrupt';

const DELIVERY: Record<Delivery, { label: string; pending: string; help: (a: string) => string; toast: (a: string) => string }> = {
  queue: {
    label: 'Next turn',
    pending: 'Waiting for its next turn',
    help: (a) => `${a} reads this at the start of its next turn. Nothing is interrupted.`,
    toast: (a) => `Queued. ${a} reads it at the start of its next turn.`,
  },
  steer: {
    label: 'Now',
    pending: 'Sending while it works…',
    help: (a) => `${a} reads this between its tool calls and adjusts, without stopping what it is doing.`,
    toast: (a) => `Sent. ${a} reads it between its tool calls.`,
  },
  interrupt: {
    label: 'Stop and redirect',
    pending: 'Stopping its current turn…',
    help: (a) => `${a} stops its current turn after the tool call in progress and answers this first.`,
    toast: (a) => `Sent. ${a} stops its current turn and reads it.`,
  },
};

export function RunView({ projectId, runId, tab: tabParam }: { projectId: string; runId: string; tab?: string }) {
  const { value: detail, error, reload } = useLive(
    () => get<RunDetail>(`/api/runs/${projectId}/${runId}`),
    [projectId, runId],
    (e) => e.projectId === projectId && e.event.runId === runId,
  );
  const [chatWith, setChatWith] = useState<string | undefined>();
  const [continueOpen, setContinueOpen] = useState(false);
  const [ship, setShip] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  // Once a run you are watching succeeds, ask what to do with its result (once per run).
  const summary = detail?.summary;
  useEffect(() => {
    if (!summary || summary.kind !== 'workflow' || summary.status !== 'succeeded' || !summary.branch || askedToShip(summary.id)) return;
    markAskedToShip(summary.id);
    if (summary.finishedAt && Date.now() - Date.parse(summary.finishedAt) < 15 * 60_000) setShip(true);
  }, [summary?.id, summary?.status]);
  const toast = useToast();
  const { refresh } = useData();

  // Tick so durations of live runs move.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const [freeSpace, freeing] = useAction(async () => {
    const res = await post<{ freedKb: number }>(`/api/projects/${projectId}/cleanup`, { runIds: [runId] });
    toast(`Removed this run's worktrees (${(res.freedKb / 1024).toFixed(1)} MB). The result branch stays, and chat restores a member's worktree when needed.`);
    await reload();
  });

  const [stop, stopping] = useAction(async () => {
    await post(`/api/runs/${projectId}/${runId}/stop`);
    toast('Stopping… the current turn is cancelled.');
    await reload();
    await refresh();
  });

  if (error) return <><Toolbar title="Run" /><div className="content"><div className="banner bad"><IconAlert />{error}</div></div></>;
  if (!detail) return <Toolbar title="Loading…" />;
  const run = detail.summary;
  const isAsk = run.kind === 'ask';
  const tab: Tab = (['office', 'plan', 'board', 'activity', 'chat', 'changes', 'preview', 'app'].includes(tabParam ?? '') ? tabParam : isAsk ? 'chat' : 'office') as Tab;
  const setTab = (t: Tab) => go('runs', projectId, runId, t);
  const openChat = (agent: string) => {
    setChatWith(agent);
    setTab('chat');
  };
  // The app's latest state, from its events.
  const appEvent = [...detail.events].reverse().find((e) => e.type.startsWith('app.'));
  const appRunning = appEvent?.type === 'app.ready' || appEvent?.type === 'app.starting';

  return (
    <FeedbackProvider projectId={projectId} run={run}>
      <Toolbar title={run.goal} sub={`${isAsk ? 'Question for' : 'Team'} ${run.team} · ${run.projectName} · started ${new Date(run.startedAt).toLocaleString()}`}>
        {run.status === 'running' && detail.canStop && (
          <button className="btn danger" onClick={() => void stop()} disabled={stopping}>
            <IconStop /> Stop
          </button>
        )}
        {!isAsk && run.status !== 'running' && run.branch && !run.worktreesRemoved && (
          <button className="btn ghost" disabled={freeing} onClick={() => void freeSpace()} title="Remove this run's worktrees from disk. The result branch is kept.">
            <IconTrash /> Free disk space
          </button>
        )}
        {!isAsk && run.folder && !run.folder.undone && run.status !== 'running' && run.filesChanged.length > 0 && (
          <button className="btn" onClick={() => setUndoOpen(true)} title="Put your folder back the way it was before this run">
            <IconUndo /> Undo changes
          </button>
        )}
        {!isAsk && run.status === 'succeeded' && run.branch && (
          <button className="btn primary" onClick={() => setShip(true)} title="Merge, push or open a pull request for the result">
            <IconBranch /> Ship result
          </button>
        )}
        {!isAsk && <SendFeedbackButton />}
        {!isAsk && run.status !== 'running' && run.branch && (
          <button className="btn" onClick={() => setContinueOpen(true)} title="Start a new goal from this run's result">
            <IconBranch /> New goal on this result
          </button>
        )}
      </Toolbar>

      <div className="content flush">
        <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 12, borderBottom: '1px solid var(--border)' }}>
          <div className="row wrap" style={{ gap: 14 }}>
            <RunStatusPill status={run.status} kind={run.kind} paused={run.paused} limited={run.limit?.waiting} />
            <LoopBadge loops={run.loops} max={run.maxLoops} />
            <QuestionsWaiting run={run} projectId={projectId} />
            <Fact icon={<IconClock />} label={duration(run.startedAt, run.finishedAt)} />
            <Fact label={`${money(run.costUsd)} est.`} title="Estimated API-equivalent cost" />
            <Fact label={`${tokens(run.tokens)} tokens`} />
            {!isAsk && <Fact label={`${run.filesChanged.length} files changed`} />}
            {run.worktreesRemoved && !run.folder && <Fact label="worktrees removed" title="Removed to free disk space; chat restores them when needed" />}
            {run.folder && <Fact icon={<IconFolder />} label={run.folder.undone ? 'undone' : 'in your folder'} title={run.folder.undone ? 'Its changes were undone' : 'The team worked directly in your folder (no git)'} />}
            {run.branch && (
              <span className="row tiny faint" style={{ gap: 2 }}>
                <IconBranch width={13} height={13} />
                <Copy text={run.branch} />
              </span>
            )}
          </div>
          <LimitBanner run={run} projectId={projectId} onChange={reload} />
          <Banner run={run} />
          {!isAsk && tab !== 'office' && (
            <div className="members">
              {run.agents.map((a, i) => (
                <div key={a.name} className="member card" onClick={() => openChat(a.name)} title={`Chat with ${a.name}`}>
                  <Avatar name={a.name} index={i} status={a.status} />
                  <div className="who">
                    <div className="row">
                      <span className="name grow">{a.name}</span>
                      <AgentStatus status={detail.answering.includes(a.name) ? 'working' : a.status} />
                    </div>
                    <span className="act">{a.status === 'working' || a.status === 'asking' ? (a.activity ?? 'thinking…') : a.step ? `last in ${a.step}` : 'waiting for its step'}</span>
                    <span className="meta num">
                      {money(a.costUsd)} · {a.turns} turns{a.inbox ? ` · ${a.inbox} message${a.inbox > 1 ? 's' : ''} waiting` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <nav className="tabs">
          {!isAsk && (
            <button className={tab === 'office' ? 'on' : ''} onClick={() => setTab('office')}>
              <IconHome width={14} height={14} /> Office
            </button>
          )}
          {!isAsk && (
            <button className={tab === 'plan' ? 'on' : ''} onClick={() => setTab('plan')}>
              <IconPlan width={14} height={14} /> {detail.planStep ? 'Plan' : 'Reports'}
              {run.requests.some((r) => r.status === 'working') && <span className="badge">{run.requests.filter((r) => r.status === 'working').length}</span>}
            </button>
          )}
          {!isAsk && (
            <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
              <IconFlow width={14} height={14} /> Board
            </button>
          )}
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            <IconChat width={14} height={14} /> Chat
          </button>
          <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>
            <IconRuns width={14} height={14} /> Activity <span className="badge">{detail.events.length}</span>
          </button>
          {!isAsk && (
            <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
              <IconBranch width={14} height={14} /> Changes <span className="badge">{run.filesChanged.length}</span>
            </button>
          )}
          {!isAsk && (
            <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
              <IconEye width={14} height={14} /> Preview <FeedbackBadge />
            </button>
          )}
          {!isAsk && (
            <button className={tab === 'app' ? 'on' : ''} onClick={() => setTab('app')} title="Run the project's app and use it live">
              <IconPlay width={14} height={14} /> App {appRunning && <i className="app-dot on" title="running" />}
            </button>
          )}
        </nav>

        {tab === 'office' && <OfficeTab detail={detail} projectId={projectId} selected={chatWith} onSelect={setChatWith} onSent={reload} />}
        {tab === 'plan' && <PlanTab detail={detail} onOpen={openChat} />}
        {tab === 'board' && <Board run={run} planStep={detail.planStep} onOpen={openChat} onPlan={() => setTab('plan')} />}
        {tab === 'activity' && <Activity events={detail.events} run={run} roots={detail.roots} />}
        {tab === 'chat' && <Chat detail={detail} projectId={projectId} selected={chatWith} onSelect={setChatWith} onSent={reload} />}
        {tab === 'changes' && <Changes projectId={projectId} run={run} />}
        {tab === 'preview' && <Preview projectId={projectId} run={run} />}
        {tab === 'app' && <AppPanel projectId={projectId} run={run} />}
      </div>

      {ship && <ShipDialog projectId={projectId} run={run} onClose={() => setShip(false)} />}
      {undoOpen && <UndoDialog projectId={projectId} run={run} onClose={() => setUndoOpen(false)} onDone={reload} />}
      {continueOpen && (
        <Modal title="New goal on this result" onClose={() => setContinueOpen(false)} wide>
          <p className="small muted">The team starts from the branch {run.branch}, so it can build on what this run produced.</p>
          <div className="card" style={{ boxShadow: 'none' }}>
            <Composer base={run.branch} fixedProject={projectId} autoFocus onDone={() => setContinueOpen(false)} />
          </div>
        </Modal>
      )}
    </FeedbackProvider>
  );
}

/** Once the run has ended and you left comments: send them as a new goal. */
function SendFeedbackButton() {
  const { items, canSend, openSend } = useFeedback();
  if (!items.length || !canSend) return null;
  return (
    <button className="btn primary" onClick={openSend} title="Start a new goal on this result with your comments">
      <IconSend /> Send feedback ({items.length})
    </button>
  );
}

/** How many comments wait to be sent. */
function FeedbackBadge() {
  const { items } = useFeedback();
  return items.length ? <span className="badge" title="Comments not sent yet">{items.length}</span> : null;
}

function Fact({ icon, label, title }: { icon?: React.ReactNode; label: string; title?: string }) {
  return (
    <span className="row tiny muted num" style={{ gap: 4 }} title={title}>
      {icon && <span style={{ display: 'inline-flex', width: 13, height: 13 }}>{icon}</span>}
      {label}
    </span>
  );
}

/** Questions for you open in a popup; this brings a dismissed one back. */
function QuestionsWaiting({ run, projectId }: { run: RunSummary; projectId: string }) {
  const { showQuestion } = useNotify();
  const open = run.status === 'running' ? run.questions.filter((q) => q.status === 'open') : [];
  if (!open.length) return null;
  return (
    <button className="btn sm ask-btn" onClick={() => showQuestion(projectId, run.id, open[0]!.id)}>
      <IconQuestion />
      {open.length === 1 ? `${open[0]!.from} asks you` : `${open.length} questions for you`}
    </button>
  );
}

/** The plan's usage limit: a countdown while members wait for the reset, or restarting a run it stopped. */
function LimitBanner({ run, projectId, onChange }: { run: RunSummary; projectId: string; onChange: () => Promise<unknown> }) {
  const toast = useToast();
  const [restart, restarting] = useAction(async (when: 'now' | 'reset' | 'cancel') => {
    const res = await post<{ runId?: string; at?: string }>(`/api/runs/${projectId}/${run.id}/restart`, { when });
    if (res.runId) {
      toast('Restarted from this run’s result.');
      go('runs', projectId, res.runId);
    } else if (res.at) toast(`Restarts at ${resetTime(res.at)}.`);
    await onChange();
  });
  const limit = run.limit;
  if (!limit) return null;
  if (limit.waiting)
    return (
      <div className="banner warn">
        <IconClock />
        <div>
          <strong>Waiting for your plan's usage limit to reset.</strong> {limit.agents.join(', ')} {limit.agents.length > 1 ? 'continue' : 'continues'} where{' '}
          {limit.agents.length > 1 ? 'they' : 'it'} stopped
          {limit.until ? (
            <>
              {' '}
              in <strong className="num">{countdown(limit.until)}</strong> ({resetTime(limit.until)})
            </>
          ) : (
            ' once it resets'
          )}
          . Keep covibe open; the run continues on its own.
        </div>
      </div>
    );
  if (run.status === 'running') return null;
  return (
    <div className="banner warn limit-banner">
      <IconClock />
      <div className="grow">
        <strong>Stopped by your plan's usage limit.</strong>{' '}
        {limit.resetsAt && Date.parse(limit.resetsAt) > Date.now() ? (
          <>
            It resets in <strong className="num">{countdown(limit.resetsAt)}</strong> ({resetTime(limit.resetsAt)}).
          </>
        ) : (
          'It has reset by now.'
        )}{' '}
        {run.restart?.runId ? (
          <>
            Restarted as <a href={href('runs', projectId, run.restart.runId)}>a new run</a>.
          </>
        ) : run.restart?.at ? (
          <>
            Restarts on its own in <strong className="num">{countdown(run.restart.at)}</strong>, from this run's result.
          </>
        ) : (
          'Restart it to carry on from its result (the branch keeps what the team committed).'
        )}
      </div>
      {!run.restart?.runId && (
        <div className="row" style={{ gap: 6, flex: 'none' }}>
          {run.restart?.at ? (
            <button className="btn sm" disabled={restarting} onClick={() => void restart('cancel')}>
              Cancel restart
            </button>
          ) : (
            limit.resetsAt &&
            Date.parse(limit.resetsAt) > Date.now() && (
              <button className="btn sm" disabled={restarting} onClick={() => void restart('reset')}>
                Restart when it resets
              </button>
            )
          )}
          <button className="btn sm primary" disabled={restarting} onClick={() => void restart('now')}>
            Restart now
          </button>
        </div>
      )}
    </div>
  );
}

function Banner({ run }: { run: RunSummary }) {
  if (run.limit && run.status === 'failed') return null;
  if (run.status === 'escalated')
    return (
      <div className="banner warn">
        <IconAlert />
        <div>
          <strong>The fix loop ran out of rounds.</strong> {run.reason}. Open <em>Chat</em> to tell a member what to do (it resumes with full memory), or start a
          new goal on this result.
        </div>
      </div>
    );
  if (run.status === 'failed')
    return (
      <div className="banner bad">
        <IconX />
        <div>
          <strong>The run stopped.</strong> {run.reason ?? 'See Activity for details.'}
        </div>
      </div>
    );
  if (run.status === 'succeeded' && run.kind === 'workflow')
    return (
      <div className="banner good">
        <IconCheck />
        <div>
          <strong>All gates passed.</strong>{' '}
          {run.branch
            ? `The result is on branch ${run.branch}; review it under Changes, then Ship result to merge, push or open a pull request.`
            : run.folder && !run.folder.undone && run.filesChanged.length
              ? 'The team worked directly in your folder. Review what it changed under Changes; Undo changes puts the folder back the way it was.'
              : ''}
        </div>
      </div>
    );
  return null;
}

// ---------------------------------------------------------------- board

function Board({ run, planStep, onOpen, onPlan }: { run: RunSummary; planStep?: string; onOpen: (agent: string) => void; onPlan: () => void }) {
  const index = (name: string) => run.agents.findIndex((a) => a.name === name);
  if (!run.steps.length) return <Empty title="No workflow steps" />;
  return (
    <div className="board">
      {run.steps.map((s) => (
        <div className="board-col" key={s.id}>
          <div className="board-col-head">
            <div className="row">
              <h3>{s.id}</h3>
              <StepBadge status={s.status} />
            </div>
            {s.gate && <span className="gate" title={`Gate: ${s.gate}`}>gate: {s.gate}</span>}
            {s.id === planStep && s.status !== 'pending' && s.status !== 'running' && (
              <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={onPlan}>
                <IconPlan /> View plan
              </button>
            )}
            {s.rounds > 1 && (
              <span className="tiny faint row" style={{ gap: 4 }}>
                <IconLoop width={12} height={12} /> ran {s.rounds} times
              </span>
            )}
          </div>
          <div className="board-col-body">
            {!s.cards.length && <span className="tiny faint" style={{ padding: 6 }}>Not started</span>}
            {[...s.cards].reverse().map((c, i) => (
              <div key={i} className={`board-card ${c.status}`} onClick={() => onOpen(c.agent)}>
                <div className="row">
                  <Avatar name={c.agent} index={index(c.agent)} size="sm" />
                  <strong className="grow">{c.agent}</strong>
                  {c.round > 0 && <span className="pill warn">round {c.round}</span>}
                  {c.status === 'working' ? <IconSpinner width={14} height={14} style={{ color: 'var(--accent)' }} /> : null}
                </div>
                {c.requestedBy && <span className="for">on {c.requestedBy}'s request</span>}
                {c.summary && <span className="summary">{c.summary}</span>}
                <span className="tiny faint">
                  {c.status === 'working' ? 'working…' : c.status === 'skipped' ? 'skipped' : c.status === 'error' ? 'failed' : 'done'} · {money(c.costUsd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StepBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    pending: ['', 'Waiting'],
    running: ['info', 'Running'],
    done: ['good', 'Done'],
    passed: ['good', 'Gate passed'],
    failed: ['bad', 'Gate failed'],
    skipped: ['', 'Skipped'],
  };
  const [cls, label] = map[status] ?? ['', status];
  return <span className={`pill ${cls}`}>{label}</span>;
}

// ---------------------------------------------------------------- office

type Pane = 'overview' | 'chat' | 'activity';
const LEGEND: DeskState[] = ['working', 'asking', 'needs', 'held', 'done', 'sleeping', 'stopped'];

/** The run as an office, with the picked member's details, chat and activity beside it. */
function OfficeTab({ detail, projectId, selected, onSelect, onSent }: { detail: RunDetail; projectId: string; selected?: string; onSelect: (a?: string) => void; onSent: () => void }) {
  const run = detail.summary;
  const figures = useFigures(run, detail.members);
  const agent = run.agents.find((a) => a.name === selected);
  const [pane, setPane] = useState<Pane>('overview');
  const [legendOpen, setLegendOpen] = useState(false);
  const [browserOf, setBrowserOf] = useState<string | undefined>();
  const { showQuestion } = useNotify();
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).matches('textarea, input') && onSelect(undefined);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onSelect]);

  if (!run.agents.length) return <Empty icon={<IconHome />} title="Nobody in the office yet">Members show up at their desks once the run starts.</Empty>;
  const pick = (name: string) => {
    if (name === selected) return onSelect(undefined);
    const a = run.agents.find((x) => x.name === name);
    // A member waiting for you opens on its question; otherwise on what it is doing.
    if (a?.waitingOn === 'human') setPane('overview');
    onSelect(name);
  };

  return (
    <div className="office">
      <div className="office-floor">
        <OfficeStage
          run={run}
          members={detail.members}
          answering={detail.answering}
          selected={agent?.name}
          onSelect={pick}
          onQuestion={(id) => showQuestion(projectId, run.id, id)}
          onBrowser={setBrowserOf}
        >
          <div className="row tiny faint" style={{ gap: 8 }}>
            <span className="grow">Click a desk to see what a member is doing and to talk to it.</span>
            <button className="btn sm ghost" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>
              {legendOpen ? 'Hide the legend' : 'What the desks show'}
            </button>
          </div>
          {legendOpen && <OfficeLegend figure={figures.get(agent?.name ?? run.agents[0]!.name)} states={LEGEND} />}
        </OfficeStage>
      </div>
      {agent && (
        <aside className="office-panel" aria-label={`${agent.name} details`}>
          <MemberPanel
            detail={detail}
            projectId={projectId}
            agent={agent.name}
            pane={pane}
            setPane={setPane}
            onClose={() => onSelect(undefined)}
            onSent={onSent}
            onBrowser={() => setBrowserOf(agent.name)}
            figure={figures.get(agent.name)!}
          />
        </aside>
      )}
      {browserOf && <BrowserPreview detail={detail} projectId={projectId} agent={browserOf} onClose={() => setBrowserOf(undefined)} />}
    </div>
  );
}

function MemberPanel({
  detail,
  projectId,
  agent,
  pane,
  setPane,
  onClose,
  onSent,
  onBrowser,
  figure,
}: {
  detail: RunDetail;
  projectId: string;
  agent: string;
  pane: Pane;
  setPane: (p: Pane) => void;
  onClose: () => void;
  onSent: () => void;
  onBrowser: () => void;
  figure: Parameters<typeof Portrait>[0]['figure'];
}) {
  const run = detail.summary;
  const a = run.agents.find((x) => x.name === agent)!;
  const member = detail.members.find((m) => m.name === agent);
  const state = deskState(a, run, detail.answering.includes(agent));
  const events = useMemo(() => detail.events.filter((e) => e.agent === agent), [detail.events, agent]);
  const question = run.questions.find((q) => (q.from === agent || (q.status === 'open' && questionDesk(run, q) === agent)) && (q.status === 'open' || q.status === 'lead'));
  const { showQuestion } = useNotify();
  const answered = run.questions.filter((q) => q.from === agent && q.status === 'answered').slice(-3);

  return (
    <>
      <div className="office-panel-head">
        <Portrait figure={figure} state={state} />
        <div className="who">
          <h2>{agent}</h2>
          <div className="row wrap" style={{ gap: 6 }}>
            <DeskPill state={state} />
            {member?.lead && <span className="pill">Team lead</span>}
            {member?.curator && <span className="pill">Curator</span>}
          </div>
        </div>
        <button className="btn sm ghost icon-btn" onClick={onClose} aria-label="Close member details" title="Close (Esc)">
          <IconX />
        </button>
      </div>
      {member?.description && <p className="office-panel-desc">{member.description}</p>}
      <nav className="tabs" role="tablist">
        {(['overview', 'chat', 'activity'] as Pane[]).map((p) => (
          <button key={p} role="tab" aria-selected={pane === p} className={pane === p ? 'on' : ''} onClick={() => setPane(p)}>
            {p === 'overview' ? 'Overview' : p === 'chat' ? 'Chat' : 'Activity'}
            {p === 'chat' && a.inbox ? <span className="badge">{a.inbox}</span> : null}
          </button>
        ))}
      </nav>

      {pane === 'chat' && <Chat detail={detail} projectId={projectId} selected={agent} onSelect={() => undefined} onSent={onSent} single />}

      {pane === 'activity' && (
        <div className="office-pane">
          {events.length === 0 && <p className="small faint">{agent} has not done anything in this run yet.</p>}
          <div className="timeline compact">
            {events.slice(-80).reverse().map((e) => {
              const d = describe(e, detail.roots);
              if (!d) return null;
              return (
                <div key={e.id} className={`tl-row ${d.cls}`}>
                  <span className="time">{clock(e.ts)}</span>
                  <span className="what">{d.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pane === 'overview' && (
        <div className="office-pane col" style={{ gap: 14 }}>
          <div className="office-now">
            <span className="label">Right now</span>
            {question ? (
              <div>
                {question.status === 'open' ? (
                  <>
                    <strong>{question.from === agent ? 'Waiting for your answer:' : `Has ${question.from}'s question for you:`}</strong> {question.forHuman ?? question.question}{' '}
                    <button className="btn sm" style={{ marginTop: 6 }} onClick={() => showQuestion(projectId, run.id, question.id)}>
                      <IconQuestion /> Answer
                    </button>
                  </>
                ) : (
                  <><strong>Asked {question.lead}:</strong> {question.question}</>
                )}
              </div>
            ) : (
              <div className={state === 'working' ? 'mono small' : 'small'}>{deskNote(a, state, run)}</div>
            )}
            {a.lastText && state !== 'sleeping' && <div className="small muted office-said">“{a.lastText}”</div>}
          </div>
          {(a.browser || a.lastView !== undefined) && (
            <div className="col" style={{ gap: 6 }}>
              <span className="label">{a.browser ? 'In its browser' : 'Last thing it looked at'}</span>
              {a.lastView !== undefined && (
                <button className="office-view" onClick={onBrowser} title={`See what ${agent} sees`}>
                  <img src={viewSrc(projectId, run.id, a.lastView)} alt={`The last screenshot ${agent} looked at`} />
                </button>
              )}
              <div className="row small" style={{ gap: 8 }}>
                <span className="grow ellipsis mono tiny">{a.browser?.url ?? (a.browser ? 'a page it did not name' : '')}</span>
                <button className={`btn sm ${a.browser?.live ? 'primary' : ''}`} onClick={onBrowser}>
                  <IconBrowser /> {a.browser?.live ? 'Watch live' : a.views ? `${a.views} screenshot${a.views > 1 ? 's' : ''}` : 'Preview'}
                </button>
              </div>
            </div>
          )}
          <dl className="office-facts">
            <div><dt>Model</dt><dd>{member?.model ?? 'default'}</dd></div>
            <div><dt>Cost this run</dt><dd className="num">{money(a.costUsd)}</dd></div>
            <div><dt>Turns</dt><dd className="num">{a.turns} in {a.invocations} {a.invocations === 1 ? 'session' : 'sessions'}</dd></div>
            <div><dt>Tokens</dt><dd className="num">{tokens(a.tokens)}</dd></div>
            {a.step && <div><dt>Last step</dt><dd>{a.step}</dd></div>}
            {a.inbox > 0 && <div><dt>Messages waiting</dt><dd className="num">{a.inbox}</dd></div>}
          </dl>
          {member && (
            <>
              <Chips label="Can change" items={!member.writes ? [] : member.writeScope ?? ['anything in its worktree']} empty="nothing (read-only)" />
              <Chips label="Tools" items={member.tools} empty="none" />
              <Chips label="Can message" items={member.canMessage} empty="nobody" />
              {member.canRequest.length > 0 && <Chips label="Can ask for work" items={member.canRequest} empty="nobody" />}
            </>
          )}
          {answered.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <span className="label">Answered questions</span>
              {answered.map((q) => (
                <div key={q.id} className="small">
                  <div>{q.question}</div>
                  <div className="muted">→ {q.answeredBy === 'human' ? 'You' : q.answeredBy}: {q.answer}</div>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setPane('chat')}>
              <IconChat /> Talk to {agent}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Chips({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="label">{label}</span>
      <div className="row wrap" style={{ gap: 6 }}>
        {items.length ? items.map((i) => <span key={i} className="chip static mono">{i}</span>) : <span className="small faint">{empty}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- activity

function describe(e: RunEvent, roots: string[] = []): { cls: string; text: string } | null {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case 'run.started': return { cls: 'step', text: `Run started${d.branch ? ` on branch ${d.branch}` : ''}` };
    case 'run.finished': return { cls: d.status === 'succeeded' ? 'good' : d.status === 'escalated' ? 'warn' : 'error', text: `Run ${d.status}${d.reason ? `: ${d.reason}` : ''}` };
    case 'step.started': return { cls: 'step', text: `Step ${e.step}${d.loop ? ` (round ${d.loop})` : ''}` };
    case 'step.finished': return null;
    case 'step.skipped': return { cls: '', text: `Skipped: ${d.reason}` };
    case 'gate.passed': return { cls: 'good', text: `Gate passed: ${d.gate}` };
    case 'gate.failed': return { cls: 'error', text: `Gate failed: ${d.gate} → ${JSON.stringify(d.value)}` };
    case 'loop.goto': return { cls: 'warn', text: `Back to ${d.to} (round ${d.loop} of ${d.max_loops}) with feedback: ${JSON.stringify(d.feedback).slice(0, 400)}` };
    case 'agent.started': return { cls: '', text: `Started${d.resumed ? ' (resumed its session)' : ''} · ${d.model ?? 'default model'} via ${d.via ?? d.backend}` };
    case 'agent.text': return { cls: '', text: String(d.text) };
    case 'agent.tool': return { cls: 'tool', text: toolText(String(d.tool), d.input, roots) };
    case 'agent.finished': return { cls: 'good', text: `Finished · ${d.turns} turns · ${money(d.cost_usd)} · ${tokens((d.tokens?.input ?? 0) + (d.tokens?.output ?? 0) + (d.tokens?.cacheRead ?? 0) + (d.tokens?.cacheWrite ?? 0))} tokens` };
    case 'agent.error': return { cls: 'error', text: `Failed: ${d.error}` };
    case 'agent.limited': return { cls: 'warn', text: d.switched_to ? `Hit a usage limit; continues on the ${d.switched_to} account` : d.waiting ? `Hit the plan's usage limit; continues ${d.until ? `at ${clock(String(d.until))}` : 'once it resets'}` : "Stopped by the plan's usage limit" };
    case 'run.restart_scheduled': return { cls: '', text: `Restart scheduled for ${new Date(String(d.at)).toLocaleString()}` };
    case 'run.restart_cancelled': return { cls: '', text: d.error ? `Restart failed: ${d.error}` : 'Restart cancelled' };
    case 'run.restarted': return { cls: 'good', text: `Restarted as run ${d.run_id}` };
    case 'agent.view': return { cls: 'tool', text: `Looked at ${d.file ? String(d.file).split('/').pop() : `an image from ${d.tool}`}` };
    case 'scope.denied': return { cls: 'warn', text: `Blocked ${d.tool}: ${d.reason}` };
    case 'scope.violation': return { cls: 'warn', text: d.kept ? `Changed outside its write scope (left in your folder; Undo changes reverts it): ${(d.files as string[]).join(', ')}` : `Discarded out-of-scope changes: ${(d.files as string[]).join(', ')}` };
    case 'files.changed': return { cls: '', text: `Changed ${(d.files as string[]).join(', ')}` };
    case 'files.undone': return { cls: 'good', text: `Undone: ${(d.restored as string[]).length} restored, ${(d.removed as string[]).length} removed${(d.skipped as unknown[]).length ? `, ${(d.skipped as unknown[]).length} left as they are` : ''}` };
    case 'git.commit': return { cls: '', text: `Committed ${String(d.commit).slice(0, 8)}: ${(d.files as string[]).join(', ')}` };
    case 'git.merge': return { cls: '', text: `Merged into ${d.into}` };
    case 'message.queued': return { cls: '', text: `Message from ${d.from ?? e.agent} to ${d.to}: ${d.text}` };
    case 'message.delivered': return { cls: '', text: `Delivered message from ${d.from}` };
    case 'chat.message': return { cls: '', text: `You: ${d.text}` };
    case 'backend.warning': return { cls: 'warn', text: String(d.message) };
    case 'usage.limit': return null; // shown as plan usage on Home
    case 'agent.usage': return null; // running totals, shown as the member's cost
    case 'brain.proposed': return { cls: '', text: `Proposed a brain note #${d.id}: ${d.title}` };
    case 'brain.decided': return { cls: d.status === 'accepted' ? 'good' : '', text: `Brain proposal #${d.id} ${d.status}${d.note_path ? ` into ${d.note_path}` : ''}${d.note ? `: ${d.note}` : ''}` };
    case 'brain.updated': return { cls: 'good', text: `Updated the project brain (${String(d.commit).slice(0, 7)})` };
    case 'workspace.cleaned': return { cls: '', text: `Worktrees removed (${(Number(d.freed_kb) / 1024).toFixed(1)} MB freed)` };
    case 'question.asked': return { cls: 'warn', text: `Asked ${d.to === 'human' ? 'you' : d.to} (#${d.id}): ${d.question}` };
    case 'question.escalated': return { cls: 'warn', text: `Passed ${d.from}'s question #${d.id} to you: ${d.question}${d.reason ? ` (${d.reason})` : ''}` };
    case 'question.answered': return { cls: 'good', text: `${d.by === 'human' ? 'You' : d.by} answered #${d.id}: ${d.answer}` };
    case 'run.paused': return { cls: 'warn', text: 'Run paused until you answer' };
    case 'run.resumed': return { cls: 'good', text: 'Run resumed' };
    case 'browser.opened': return { cls: 'tool', text: `Opened its browser (${d.provider})` };
    case 'browser.page': return { cls: 'tool', text: `Browser on ${d.url}` };
    case 'browser.control': return { cls: d.by === 'human' ? 'warn' : '', text: d.by === 'human' ? 'You took control of its browser' : 'Browser handed back' };
    case 'browser.closed': return { cls: '', text: `Browser closed (${d.reason})` };
    case 'app.starting': return { cls: 'tool', text: `Starting the app${d.command ? `: ${d.command}` : d.compose ? ` with docker compose (${d.compose})` : ''}${d.runtime === 'docker' ? ' in Docker' : ''}` };
    case 'app.ready': return { cls: 'good', text: `The app runs at ${d.url}` };
    case 'app.failed': return { cls: 'error', text: `The app did not run: ${d.reason}` };
    case 'app.stopped': return { cls: '', text: `The app stopped (${d.reason})` };
    case 'feedback.sent': return { cls: 'good', text: `Your feedback (${d.count} comment${d.count === 1 ? '' : 's'}) went to run ${d.run_id}` };
    default: return { cls: '', text: JSON.stringify(d) };
  }
}

const PROBLEMS = new Set(['agent.error', 'scope.violation', 'scope.denied', 'gate.failed', 'backend.warning', 'app.failed']);

function Activity({ events, run, roots }: { events: RunEvent[]; run: RunSummary; roots: string[] }) {
  const [agent, setAgent] = useState<string | null>(null);
  const [tools, setTools] = useState(true);
  const problems = events.filter((e) => PROBLEMS.has(e.type));
  const shown = events.filter((e) => (!agent || e.agent === agent) && (tools || e.type !== 'agent.tool'));
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    if (atBottom.current) void end.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  return (
    <div style={{ flex: 1, overflowY: 'auto' }} onScroll={(e) => {
      const el = e.currentTarget;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }}>
      {problems.length > 0 && (
        <div style={{ padding: '12px 20px 0' }}>
          <div className="banner warn" style={{ flexDirection: 'column', gap: 4 }}>
            <strong className="row">
              <IconAlert /> {problems.length} thing{problems.length > 1 ? 's' : ''} to look at
            </strong>
            {problems.slice(-6).map((e) => (
              <span key={e.id} className="small">
                <span className="faint mono">{clock(e.ts)}</span> {e.agent ? <strong>{e.agent}: </strong> : null}
                {describe(e)?.text}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="row wrap" style={{ padding: '12px 20px', gap: 6 }}>
        <button className={`chip ${agent === null ? 'on' : ''}`} onClick={() => setAgent(null)}>
          Everyone
        </button>
        {run.agents.map((a) => (
          <button key={a.name} className={`chip ${agent === a.name ? 'on' : ''}`} onClick={() => setAgent(a.name)}>
            {a.name}
          </button>
        ))}
        <span className="grow" />
        <label className="check small">
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} /> Show tool calls
        </label>
      </div>
      <div className="timeline">
        {shown.map((e) => {
          const d = describe(e, roots);
          if (!d) return null;
          return (
            <div key={e.id} className={`tl-row ${d.cls}`}>
              <span className="time">{clock(e.ts)}</span>
              <span className="who">{[e.step, e.agent].filter(Boolean).join(' · ') || 'run'}</span>
              <span className="what">{d.text}</span>
            </div>
          );
        })}
        <div ref={end} style={{ height: 20 }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- chat

function Chat({ detail, projectId, selected, onSelect, onSent, single }: { detail: RunDetail; projectId: string; selected?: string; onSelect: (a: string) => void; onSent: () => void; single?: boolean }) {
  const run = detail.summary;
  const names = run.agents.length ? run.agents.map((a) => a.name) : Object.keys(detail.threads);
  const agent = selected && names.includes(selected) ? selected : names[0];
  const items = (agent && detail.threads[agent]) || [];
  const state = run.agents.find((a) => a.name === agent);
  const answering = !!agent && detail.answering.includes(agent);
  const working = state?.status === 'working' || answering;
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<Delivery | null>(null);
  const toast = useToast();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // scrollIntoView returns a Promise in newer Chromium; never hand it to React as a cleanup.
    void end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, agent, working]);
  // Reaching a member mid-turn only makes sense while it works; default to "now" then.
  const delivery: Delivery = working ? (choice ?? 'steer') : 'queue';

  const [send, sending] = useAction(async () => {
    if (!agent || !text.trim()) return;
    const res = await post<{ mode: string; delivery?: Delivery }>(`/api/runs/${projectId}/${run.id}/chat`, { agent, message: text.trim(), delivery });
    setText('');
    if (res.mode === 'queued') toast(DELIVERY[res.delivery ?? 'queue'].toast(agent));
    onSent();
  });

  if (!agent) return <Empty icon={<IconChat />} title="Nobody to chat with yet">Members appear here once they start working.</Empty>;
  const hasSession = items.some((i) => i.kind === 'agent' || i.kind === 'tool');
  const queueMode = detail.chatMode === 'queue';

  return (
    <div className="chat">
      {names.length > 1 && !single && (
        <div className="chat-list">
          {names.map((n, i) => {
            const a = run.agents.find((x) => x.name === n);
            return (
              <button key={n} className={n === agent ? 'on' : ''} onClick={() => onSelect(n)}>
                <Avatar name={n} index={i} size="sm" status={detail.answering.includes(n) ? 'working' : a?.status} />
                <span className="grow ellipsis">{n}</span>
                {a?.inbox ? <span className="pill warn">{a.inbox}</span> : null}
              </button>
            );
          })}
        </div>
      )}
      <div className="chat-main">
        <div className="thread">
          {!items.length && <Empty icon={<IconChat />} title={`Nothing from ${agent} yet`}>Its messages, tool use and your conversation show up here.</Empty>}
          <ThreadItems items={items} />
          {working && (
            <div className="note-line row" style={{ gap: 6 }}>
              <IconSpinner width={12} height={12} /> {agent} is {state?.activity && !answering ? state.activity : 'thinking'}…
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="chat-input">
          <div className="box">
            <textarea
              value={text}
              rows={1}
              placeholder={hasSession || queueMode ? `Message ${agent}…` : `${agent} has not worked on this run yet`}
              disabled={!hasSession && !queueMode}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <MicButton disabled={!hasSession && !queueMode} onText={(t) => setText((prev) => withSpoken(prev, t))} />
            <button className="btn primary icon-btn" disabled={!text.trim() || sending} onClick={() => void send()} aria-label="Send" style={{ borderRadius: 14 }}>
              <IconSend />
            </button>
          </div>
          {(queueMode || answering) && (
            <div className="row wrap" style={{ gap: 8 }}>
              <div className="seg" role="radiogroup" aria-label="When it should read this">
                {(['queue', 'steer', 'interrupt'] as Delivery[]).map((d) => (
                  <button
                    key={d}
                    className={delivery === d ? 'on' : ''}
                    disabled={d !== 'queue' && !working}
                    title={d !== 'queue' && !working ? `Only while ${agent} is working` : DELIVERY[d].help(agent)}
                    onClick={() => setChoice(d)}
                    role="radio"
                    aria-checked={delivery === d}
                  >
                    {DELIVERY[d].label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <span className="mode">
            <IconInfo />
            {queueMode || answering
              ? DELIVERY[delivery].help(agent)
              : run.kind === 'ask'
                ? `${agent} answers now, read-only, and remembers this conversation.`
                : run.folder
                  ? `${agent} answers now. It resumes its session with full memory; file changes it makes go straight into your folder, and Undo changes covers them too.`
                  : `${agent} answers now. It resumes its session with full memory; file changes it makes are merged into ${run.branch ?? 'the run'}.${run.worktreesRemoved ? ' Its worktree was cleaned up and is restored first.' : ''}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Messages as bubbles; runs of tool calls collapse into one line. */
function ThreadItems({ items }: { items: ChatItem[] }) {
  const groups = useMemo(() => {
    const out: (ChatItem | ChatItem[])[] = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (it.kind === 'tool') {
        if (Array.isArray(last)) last.push(it);
        else out.push([it]);
      } else out.push(it);
    }
    return out;
  }, [items]);
  return (
    <>
      {groups.map((g, i) =>
        Array.isArray(g) ? (
          <ToolGroup key={`t${g[0]!.id}`} items={g} />
        ) : g.kind === 'human' ? (
          <div key={g.id} className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
            <div className={`msg human ${g.pending ? 'pending' : ''}`}>{g.text}</div>
            <span className="msg-meta right">{g.pending ? DELIVERY[g.delivery ?? 'queue'].pending : clock(g.ts)}</span>
          </div>
        ) : g.kind === 'agent' ? (
          <div key={g.id} className="msg agent">
            {g.text}
          </div>
        ) : (
          <div key={g.id ?? i} className={`note-line ${g.kind === 'error' ? 'error' : ''}`}>
            {g.text}
            {g.pending ? ' · waiting for next turn' : ''}
          </div>
        ),
      )}
    </>
  );
}

function ToolGroup({ items }: { items: ChatItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tools-line">
      <button onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {items.length} step{items.length > 1 ? 's' : ''}: {items[items.length - 1]!.text}
      </button>
      {open && items.map((t) => <span key={t.id}>· {t.text}</span>)}
    </div>
  );
}

// ---------------------------------------------------------------- changes

function Changes({ projectId, run }: { projectId: string; run: RunSummary }) {
  const { value: diff, error } = useLive(() => get<DiffResult>(`/api/runs/${projectId}/${run.id}/diff`), [projectId, run.id, run.filesChanged.length]);
  const { overview } = useData();
  const project = overview?.projects.find((p) => p.id === projectId);
  if (error) return <div className="banner bad" style={{ margin: 20 }}><IconAlert />{error}</div>;
  if (!diff) return <div style={{ padding: 20 }} className="faint">Loading changes…</div>;
  if (diff.note && !diff.files.length) return <div className="banner info" style={{ margin: 20 }}><IconInfo />{diff.note}</div>;
  if (!diff.files.length)
    return run.folder ? (
      <Empty icon={<IconFolder />} title={diff.undoneAt ? 'Undone' : 'No changes yet'}>
        {diff.undoneAt ? `The run's changes were undone ${new Date(diff.undoneAt).toLocaleString()}.` : 'Files the team changes in your folder show up here after each turn.'}
      </Empty>
    ) : (
      <Empty icon={<IconBranch />} title="No changes yet">Files the team changes show up here as they are merged.</Empty>
    );
  const folder = !!run.folder;
  const lines = diff.patch.split('\n');
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <div className="col" style={{ gap: 14, maxWidth: 1100, margin: '0 auto' }}>
        <div className="card">
          <div className="card-head">
            <h2>
              {diff.files.length} file{diff.files.length > 1 ? 's' : ''} changed
            </h2>
            <span className="hint mono">{diff.range ?? (folder ? 'in your folder' : '')}</span>
            <div className="right">
              {run.branch && <Copy text={`git merge ${run.branch}`} label="Copy merge command" />}
              {desktop && project && (
                <button className="btn sm" onClick={() => void desktop!.reveal(project.path)}>
                  <IconFolder /> Show in Finder
                </button>
              )}
            </div>
          </div>
          {(diff.note || diff.undoneAt) && (
            <div className="banner info" style={{ margin: '0 14px 10px' }}>
              <IconInfo />
              {[diff.undoneAt && `The run's changes were undone ${new Date(diff.undoneAt).toLocaleString()}; these are what was left as it was.`, diff.note].filter(Boolean).join(' ')}
            </div>
          )}
          <table className="table">
            <tbody>
              {diff.files.map((f) => (
                <tr key={f.path}>
                  {f.status && <td className="tiny" style={{ width: 70, color: f.status === 'added' ? 'var(--good)' : f.status === 'deleted' ? 'var(--bad)' : undefined }}>{f.status}</td>}
                  <td className="mono">{f.path}</td>
                  {f.by && <td className="tiny faint">{f.by.join(', ')}</td>}
                  <td className="r num" style={{ color: 'var(--good)' }}>+{f.additions}</td>
                  <td className="r num" style={{ color: 'var(--bad)' }}>−{f.deletions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card diff">
          {lines.map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''
              }
            >
              {l.startsWith('diff --git') ? l.replace(/^diff --git a\/(\S+) b\/.*$/, '$1') : l || ' '}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- undo (plain folders)

function UndoDialog({ projectId, run, onClose, onDone }: { projectId: string; run: RunSummary; onClose: () => void; onDone: () => Promise<unknown> | void }) {
  const toast = useToast();
  const [result, setResult] = useState<UndoResult | null>(null);
  const [undo, undoing] = useAction(async () => {
    const res = await post<UndoResult>(`/api/runs/${projectId}/${run.id}/undo`);
    setResult(res);
    await onDone();
    if (!res.skipped.length) {
      toast(`Undone: ${res.restored.length} file${res.restored.length === 1 ? '' : 's'} restored, ${res.removed.length} removed.`);
      onClose();
    }
  });
  if (result)
    return (
      <Modal title="Undone, with exceptions" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p className="small">
          {result.restored.length} file{result.restored.length === 1 ? '' : 's'} restored and {result.removed.length} removed. These were left as they are:
        </p>
        <ul className="small">
          {result.skipped.map((s) => (
            <li key={s.path}>
              <span className="mono">{s.path}</span>: {s.reason}
            </li>
          ))}
        </ul>
      </Modal>
    );
  return (
    <Modal
      title="Undo this run's changes?"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={undoing} onClick={() => void undo()}>
            <IconUndo /> {undoing ? 'Undoing…' : 'Undo changes'}
          </button>
        </>
      }
    >
      <p className="small">
        The team worked directly in your folder and changed {run.filesChanged.length} file{run.filesChanged.length === 1 ? '' : 's'}. Undo puts them back the way they were when the run
        started: changed and deleted files come back, files it added are removed.
      </p>
      <p className="small muted">
        Nothing is thrown away: the run's versions are moved to covibe's folder for this run. A file you edited yourself after the run, or one too large to keep a copy of, is left as it is.
      </p>
    </Modal>
  );
}
