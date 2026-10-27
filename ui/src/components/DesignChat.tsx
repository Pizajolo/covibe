import { useEffect, useRef, useState } from 'react';
import { get, post, type ChatItem, type TeamDetail } from '../api';
import { go, useLive } from '../data';
import { money } from '../format';
import { IconAlert, IconCheck, IconSend, IconSpinner, IconTeam } from './icons';
import { Avatar, useAction } from './ui';

interface DesignDetail {
  runId: string;
  teamId: string;
  busy: boolean;
  thread: ChatItem[];
  saves: { ts: string; valid: boolean; problems: string[]; summary: string | null }[];
  costUsd: number;
}

const STARTERS = [
  'A web app team: a planner, frontend and backend builders, a reviewer and a tester',
  'One careful builder and a strict reviewer that must approve every change',
  'A bug-fixing team that writes a failing test first, then fixes it',
  'A documentation team that keeps the README and docs up to date',
];

/**
 * Set up or change a team by talking to the architect. The team preview on
 * the side updates whenever the architect saves.
 */
export function DesignChat({
  teamId: initialTeam,
  projectId,
  name,
  onTeam,
  height = 460,
}: {
  teamId?: string;
  projectId?: string;
  /** Name for a new team (when no teamId). */
  name?: string;
  onTeam?: (teamId: string, valid: boolean) => void;
  height?: number;
}) {
  const [teamId, setTeamId] = useState(initialTeam);
  const [runId, setRunId] = useState<string | null | undefined>(initialTeam ? undefined : null);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // Continue the team's latest design conversation, if there is one.
  useEffect(() => {
    if (!initialTeam) return;
    void get<{ runId: string | null }>(`/api/teams/${initialTeam}/design`).then((r) => setRunId(r.runId));
  }, [initialTeam]);

  const { value: detail } = useLive(
    () => (runId ? get<DesignDetail>(`/api/design/${runId}`) : Promise.resolve(null)),
    [runId],
    (e) => e.projectId === '_library' && e.event.runId === runId,
  );
  const lastSave = detail?.saves.at(-1);
  useEffect(() => {
    if (teamId && lastSave) onTeam?.(teamId, lastSave.valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSave?.ts]);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [detail?.thread.length, detail?.busy]);

  const [send, sending] = useAction(async (message: string) => {
    if (!message.trim()) return;
    setText('');
    if (runId) await post(`/api/design/${runId}`, { message });
    else {
      const r = await post<{ runId: string; teamId: string }>('/api/design', { team: teamId, name, project: projectId, message });
      setRunId(r.runId);
      setTeamId(r.teamId);
    }
  });

  const busy = sending || !!detail?.busy;
  const items = detail?.thread ?? [];
  return (
    <div className="design" style={{ height }}>
      <div className="design-chat">
        <div className="thread">
          {!items.length && (
            <div className="col" style={{ gap: 10, margin: 'auto 0' }}>
              <p className="small muted" style={{ textAlign: 'center' }}>
                Describe the team you want. The architect looks at {projectId ? 'your project' : 'what you describe'}, asks if something important is unclear, and sets the team up. You can keep changing it here.
              </p>
              <div className="col" style={{ gap: 6, alignItems: 'center' }}>
                {STARTERS.map((s) => (
                  <button key={s} className="chip" onClick={() => void send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((it) =>
            it.kind === 'human' ? (
              <div key={it.id} className="msg human">
                {it.text}
              </div>
            ) : it.kind === 'agent' ? (
              <div key={it.id} className="msg agent">
                {it.text}
              </div>
            ) : it.kind === 'tool' ? (
              <div key={it.id} className="tools-line">
                · {it.text.replace(/^mcp__covibe__/, '').replace('save_team', 'saving the team').replace('get_team', 'reading the team')}
              </div>
            ) : (
              <div key={it.id} className={`note-line ${it.kind === 'error' ? 'error' : ''}`}>
                {it.text}
              </div>
            ),
          )}
          {busy && (
            <div className="note-line row" style={{ gap: 6 }}>
              <IconSpinner width={12} height={12} /> The architect is working…
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="chat-input">
          <div className="box">
            <textarea
              value={text}
              rows={1}
              placeholder={items.length ? 'Ask for changes, e.g. "add a security reviewer" or "use haiku for the tester"' : 'Describe the team you need…'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!busy) void send(text);
                }
              }}
            />
            <button className="btn primary icon-btn" style={{ borderRadius: 14 }} disabled={!text.trim() || busy} onClick={() => void send(text)} aria-label="Send">
              <IconSend />
            </button>
          </div>
          {detail && detail.costUsd > 0 && <span className="mode">This conversation so far: {money(detail.costUsd)} (estimate)</span>}
        </div>
      </div>
      <div className="design-side">
        {teamId ? <TeamPreview teamId={teamId} version={lastSave?.ts} /> : <div className="card card-pad small muted">The team appears here once the architect saves it.</div>}
        {lastSave && !lastSave.valid && (
          <div className="banner warn small">
            <IconAlert />
            <span>Last save had problems; the architect is fixing them.</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TeamPreview({ teamId, version }: { teamId: string; version?: string }) {
  const { value: team } = useLive(() => get<TeamDetail>(`/api/teams/${teamId}`), [teamId, version]);
  if (!team) return <div className="card card-pad faint small">Loading team…</div>;
  const doc = team.doc as { name?: string; agents?: Record<string, { description?: string; model?: string; tools?: string[] }>; workflow?: { steps?: { id: string; agent?: string; parallel?: { agent: string }[]; gate?: string }[] } };
  const agents = Object.entries(doc.agents ?? {});
  const steps = doc.workflow?.steps ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <IconTeam width={14} height={14} />
        <h2 className="grow ellipsis">{doc.name ?? teamId}</h2>
        {team.problems.length ? (
          <span className="pill bad">
            <IconAlert /> {team.problems.length}
          </span>
        ) : (
          <span className="pill good">
            <IconCheck /> Ready
          </span>
        )}
      </div>
      <div className="card-pad col" style={{ gap: 10 }}>
        {agents.map(([n, a], i) => (
          <div key={n} className="row" style={{ alignItems: 'flex-start' }}>
            <Avatar name={n} index={i} size="sm" />
            <div className="col grow" style={{ gap: 0 }}>
              <span className="small">
                <strong>{n}</strong> <span className="faint">· {a?.model ?? 'default'}</span>
              </span>
              <span className="tiny faint">{a?.description ?? (a?.tools ?? []).join(', ')}</span>
            </div>
          </div>
        ))}
        {steps.length > 0 && (
          <div className="tiny muted" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            {steps.map((s) => `${s.id}${s.gate ? ' ✓' : ''}`).join(' → ')}
          </div>
        )}
        <button className="btn sm" onClick={() => go('teams', teamId)}>
          Open in team editor
        </button>
      </div>
    </div>
  );
}
