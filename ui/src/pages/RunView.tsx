import { useEffect, useMemo, useRef, useState } from 'react';
import { desktop, get, post, type ChatItem, type DiffResult, type RunDetail, type RunEvent, type RunSummary } from '../api';
import { Composer } from '../components/Composer';
import {
  IconAlert,
  IconBranch,
  IconChat,
  IconCheck,
  IconClock,
  IconFlow,
  IconFolder,
  IconInfo,
  IconLoop,
  IconRuns,
  IconSend,
  IconSpinner,
  IconStop,
  IconX,
} from '../components/icons';
import { Toolbar } from '../components/Toolbar';
import { AgentStatus, Avatar, Copy, Empty, LoopBadge, Modal, RunStatusPill, useAction, useToast } from '../components/ui';
import { go, useData, useLive } from '../data';
import { clock, duration, money, tokens, toolText } from '../format';

type Tab = 'board' | 'activity' | 'chat' | 'changes';

export function RunView({ projectId, runId, tab: tabParam }: { projectId: string; runId: string; tab?: string }) {
  const { value: detail, error, reload } = useLive(
    () => get<RunDetail>(`/api/runs/${projectId}/${runId}`),
    [projectId, runId],
    (e) => e.projectId === projectId && e.event.runId === runId,
  );
  const [chatWith, setChatWith] = useState<string | undefined>();
  const [continueOpen, setContinueOpen] = useState(false);
  const toast = useToast();
  const { refresh } = useData();

  // Tick so durations of live runs move.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

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
  const tab: Tab = (['board', 'activity', 'chat', 'changes'].includes(tabParam ?? '') ? tabParam : isAsk ? 'chat' : 'board') as Tab;
  const setTab = (t: Tab) => go('runs', projectId, runId, t);
  const openChat = (agent: string) => {
    setChatWith(agent);
    setTab('chat');
  };

  return (
    <>
      <Toolbar title={run.goal} sub={`${isAsk ? 'Question for' : 'Team'} ${run.team} · ${run.projectName} · started ${new Date(run.startedAt).toLocaleString()}`}>
        {run.status === 'running' && detail.canStop && (
          <button className="btn danger" onClick={() => void stop()} disabled={stopping}>
            <IconStop /> Stop
          </button>
        )}
        {!isAsk && run.status !== 'running' && run.branch && (
          <button className="btn" onClick={() => setContinueOpen(true)} title="Start a new goal from this run's result">
            <IconBranch /> New goal on this result
          </button>
        )}
      </Toolbar>

      <div className="content flush">
        <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 12, borderBottom: '1px solid var(--border)' }}>
          <div className="row wrap" style={{ gap: 14 }}>
            <RunStatusPill status={run.status} kind={run.kind} />
            <LoopBadge loops={run.loops} max={run.maxLoops} />
            <Fact icon={<IconClock />} label={duration(run.startedAt, run.finishedAt)} />
            <Fact label={`${money(run.costUsd)} est.`} title="Estimated API-equivalent cost" />
            <Fact label={`${tokens(run.tokens)} tokens`} />
            {!isAsk && <Fact label={`${run.filesChanged.length} files changed`} />}
            {run.branch && (
              <span className="row tiny faint" style={{ gap: 2 }}>
                <IconBranch width={13} height={13} />
                <Copy text={run.branch} />
              </span>
            )}
          </div>
          <Banner run={run} />
          {!isAsk && (
            <div className="members">
              {run.agents.map((a, i) => (
                <div key={a.name} className="member card" onClick={() => openChat(a.name)} title={`Chat with ${a.name}`}>
                  <Avatar name={a.name} index={i} status={a.status} />
                  <div className="who">
                    <div className="row">
                      <span className="name grow">{a.name}</span>
                      <AgentStatus status={detail.answering.includes(a.name) ? 'working' : a.status} />
                    </div>
                    <span className="act">{a.status === 'working' ? (a.activity ?? 'thinking…') : a.step ? `last in ${a.step}` : 'waiting for its step'}</span>
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
        </nav>

        {tab === 'board' && <Board run={run} onOpen={openChat} />}
        {tab === 'activity' && <Activity events={detail.events} run={run} roots={detail.roots} />}
        {tab === 'chat' && <Chat detail={detail} projectId={projectId} selected={chatWith} onSelect={setChatWith} onSent={reload} />}
        {tab === 'changes' && <Changes projectId={projectId} run={run} />}
      </div>

      {continueOpen && (
        <Modal title="New goal on this result" onClose={() => setContinueOpen(false)} wide>
          <p className="small muted">The team starts from the branch {run.branch}, so it can build on what this run produced.</p>
          <div className="card" style={{ boxShadow: 'none' }}>
            <Composer base={run.branch} fixedProject={projectId} autoFocus onDone={() => setContinueOpen(false)} />
          </div>
        </Modal>
      )}
    </>
  );
}

function Fact({ icon, label, title }: { icon?: React.ReactNode; label: string; title?: string }) {
  return (
    <span className="row tiny muted num" style={{ gap: 4 }} title={title}>
      {icon && <span style={{ display: 'inline-flex', width: 13, height: 13 }}>{icon}</span>}
      {label}
    </span>
  );
}

function Banner({ run }: { run: RunSummary }) {
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
          <strong>All gates passed.</strong> {run.branch ? `The result is on branch ${run.branch}; review it under Changes and merge it when you are happy.` : ''}
        </div>
      </div>
    );
  return null;
}

// ---------------------------------------------------------------- board

function Board({ run, onOpen }: { run: RunSummary; onOpen: (agent: string) => void }) {
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
    case 'agent.started': return { cls: '', text: `Started${d.resumed ? ' (resumed its session)' : ''} · ${d.model ?? 'default model'} via ${d.backend}` };
    case 'agent.text': return { cls: '', text: String(d.text) };
    case 'agent.tool': return { cls: 'tool', text: toolText(String(d.tool), d.input, roots) };
    case 'agent.finished': return { cls: 'good', text: `Finished · ${d.turns} turns · ${money(d.cost_usd)} · ${tokens((d.tokens?.input ?? 0) + (d.tokens?.output ?? 0) + (d.tokens?.cacheRead ?? 0) + (d.tokens?.cacheWrite ?? 0))} tokens` };
    case 'agent.error': return { cls: 'error', text: `Failed: ${d.error}` };
    case 'scope.denied': return { cls: 'warn', text: `Blocked ${d.tool}: ${d.reason}` };
    case 'scope.violation': return { cls: 'warn', text: `Discarded out-of-scope changes: ${(d.files as string[]).join(', ')}` };
    case 'git.commit': return { cls: '', text: `Committed ${String(d.commit).slice(0, 8)}: ${(d.files as string[]).join(', ')}` };
    case 'git.merge': return { cls: '', text: `Merged into ${d.into}` };
    case 'message.queued': return { cls: '', text: `Message from ${d.from ?? e.agent} to ${d.to}: ${d.text}` };
    case 'message.delivered': return { cls: '', text: `Delivered message from ${d.from}` };
    case 'chat.message': return { cls: '', text: `You: ${d.text}` };
    case 'backend.warning': return { cls: 'warn', text: String(d.message) };
    case 'usage.limit': return null; // shown as plan usage on Home
    default: return { cls: '', text: JSON.stringify(d) };
  }
}

const PROBLEMS = new Set(['agent.error', 'scope.violation', 'scope.denied', 'gate.failed', 'backend.warning']);

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

function Chat({ detail, projectId, selected, onSelect, onSent }: { detail: RunDetail; projectId: string; selected?: string; onSelect: (a: string) => void; onSent: () => void }) {
  const run = detail.summary;
  const names = run.agents.length ? run.agents.map((a) => a.name) : Object.keys(detail.threads);
  const agent = selected && names.includes(selected) ? selected : names[0];
  const items = (agent && detail.threads[agent]) || [];
  const state = run.agents.find((a) => a.name === agent);
  const answering = !!agent && detail.answering.includes(agent);
  const working = state?.status === 'working' || answering;
  const [text, setText] = useState('');
  const toast = useToast();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // scrollIntoView returns a Promise in newer Chromium; never hand it to React as a cleanup.
    void end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, agent, working]);

  const [send, sending] = useAction(async () => {
    if (!agent || !text.trim()) return;
    const res = await post<{ mode: string }>(`/api/runs/${projectId}/${run.id}/chat`, { agent, message: text.trim() });
    setText('');
    if (res.mode === 'queued') toast(`Queued. ${agent} reads it at the start of its next turn.`);
    onSent();
  });

  if (!agent) return <Empty icon={<IconChat />} title="Nobody to chat with yet">Members appear here once they start working.</Empty>;
  const hasSession = items.some((i) => i.kind === 'agent' || i.kind === 'tool');
  const queueMode = detail.chatMode === 'queue';

  return (
    <div className="chat">
      {names.length > 1 && (
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
            <button className="btn primary icon-btn" disabled={!text.trim() || sending || answering} onClick={() => void send()} aria-label="Send" style={{ borderRadius: 14 }}>
              <IconSend />
            </button>
          </div>
          <span className="mode">
            <IconInfo />
            {queueMode
              ? `The run is live: your message is queued and ${agent} reads it at the start of its next turn. Nothing is interrupted.`
              : run.kind === 'ask'
                ? `${agent} answers now, read-only, and remembers this conversation.`
                : `${agent} answers now. It resumes its session with full memory; file changes it makes are merged into ${run.branch ?? 'the run'}.`}
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
            <span className="msg-meta right">{g.pending ? 'Queued for next turn' : clock(g.ts)}</span>
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
  if (diff.note) return <div className="banner info" style={{ margin: 20 }}><IconInfo />{diff.note}</div>;
  if (!diff.files.length) return <Empty icon={<IconBranch />} title="No changes yet">Files the team changes show up here as they are merged.</Empty>;
  const lines = diff.patch.split('\n');
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <div className="col" style={{ gap: 14, maxWidth: 1100, margin: '0 auto' }}>
        <div className="card">
          <div className="card-head">
            <h2>
              {diff.files.length} file{diff.files.length > 1 ? 's' : ''} changed
            </h2>
            <span className="hint mono">{diff.range}</span>
            <div className="right">
              {run.branch && <Copy text={`git merge ${run.branch}`} label="Copy merge command" />}
              {desktop && project && (
                <button className="btn sm" onClick={() => void desktop!.reveal(project.path)}>
                  <IconFolder /> Show in Finder
                </button>
              )}
            </div>
          </div>
          <table className="table">
            <tbody>
              {diff.files.map((f) => (
                <tr key={f.path}>
                  <td className="mono">{f.path}</td>
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
