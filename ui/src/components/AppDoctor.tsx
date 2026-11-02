// The app doctor: an agent beside the App tab that finds out why the run's
// app does not start. It reads the folder, the log and the settings by
// itself, and proposes every change (start with other settings, forget what
// covibe remembered, ask a member to change the code); you apply or decline
// each one here.
import { useEffect, useRef, useState } from 'react';
import { get, post, type DoctorDetail, type DoctorItem } from '../api';
import { useLive } from '../data';
import { money } from '../format';
import { IconCheck, IconPlus, IconSend, IconSparkle, IconSpinner, IconStop, IconX } from './icons';
import { Markdown } from './Markdown';
import { useAction } from './ui';

export function AppDoctor({
  projectId,
  runId: targetRun,
  conversation,
  seed,
  onSeeded,
  onClose,
}: {
  projectId: string;
  /** The run whose app it is. */
  runId: string;
  /** The latest conversation about this app, if any. */
  conversation?: string;
  /** A message to send as soon as the panel opens (from "Find and fix it"). */
  seed?: string;
  onSeeded?: () => void;
  onClose: () => void;
}) {
  const [runId, setRunId] = useState<string | null>(conversation ?? null);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);

  const { value: detail, reload } = useLive(
    () => (runId ? get<DoctorDetail>(`/api/app-doctor/${runId}`) : Promise.resolve(null)),
    [runId],
    (e) => e.projectId === '_library' && e.event.runId === runId,
  );
  // Proposals arrive while it works; follow them.
  useEffect(() => {
    if (!runId) return;
    const t = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(t);
  }, [runId, reload]);

  const [send, sending] = useAction(async (message: string, fresh = false) => {
    if (!message.trim()) return;
    setText('');
    const r = await post<{ runId: string }>(`/api/runs/${projectId}/${targetRun}/app/doctor`, { message, runId: fresh ? undefined : runId ?? undefined });
    setRunId(r.runId);
    if (r.runId === runId) await reload();
  });

  useEffect(() => {
    if (!seed) return;
    onSeeded?.();
    void send(seed, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const [decide] = useAction(async (id: string, run: boolean) => {
    await post(`/api/app-doctor/${runId}/decide`, { id, run });
    await reload();
  });
  const [stop] = useAction(async () => {
    await post(`/api/app-doctor/${runId}/stop`);
  });

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [detail?.thread.length, detail?.busy]);

  const busy = sending || !!detail?.busy;
  const items = detail?.thread ?? [];
  return (
    <aside className="helper-drawer" aria-label="App doctor">
      <div className="card-head">
        <IconSparkle width={15} height={15} />
        <h2>App doctor</h2>
        <span className="hint">{detail ? `${money(detail.costUsd)} est.` : ''}</span>
        <div className="right">
          {busy && runId && (
            <button className="btn sm ghost" onClick={() => void stop()} title="Stop its current turn">
              <IconStop /> Stop
            </button>
          )}
          <button className="btn sm ghost" disabled={busy} onClick={() => setRunId(null)} title="Start a new conversation">
            <IconPlus /> New
          </button>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
      </div>
      <div className="thread">
        {!items.length && !busy && (
          <div className="col" style={{ gap: 10, margin: 'auto 0' }}>
            <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
              The app doctor reads the app’s log, its folder and its settings, finds out why it does not start, and proposes fixes. Nothing changes until you apply a proposal: starting it with other settings,
              forgetting what ran last time, or asking a member to change the code.
            </p>
            <div className="col" style={{ gap: 6, alignItems: 'center' }}>
              <button className="chip" disabled={busy} onClick={() => void send('The app does not start. Find out why and get it running.')}>
                Find out why the app does not start
              </button>
            </div>
          </div>
        )}
        {items.map((it) => (
          <Item key={it.id} it={it} onDecide={(id, run) => void decide(id, run)} />
        ))}
        {busy && (
          <div className="note-line row" style={{ gap: 6 }}>
            <IconSpinner width={12} height={12} />
            {items.some((i) => i.kind === 'proposal' && i.state === 'waiting') ? 'Waiting for you' : 'Looking into it…'}
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="composer-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          className="input grow"
          rows={2}
          placeholder={busy ? 'The app doctor is working…' : 'Tell the app doctor something'}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button className="btn primary" disabled={busy || !text.trim()} aria-label="Send">
          <IconSend />
        </button>
      </form>
    </aside>
  );
}

const APPLY: Record<string, string> = { start: 'Start it like this', forget: 'Forget it', message: 'Send it' };
const DONE: Record<string, string> = { start: 'You started it', forget: 'You forgot it', message: 'You sent it' };

function Item({ it, onDecide }: { it: DoctorItem; onDecide: (id: string, run: boolean) => void }) {
  if (it.kind === 'human') return <div className="msg human">{it.text}</div>;
  if (it.kind === 'agent')
    return (
      <div className="msg agent helper-text">
        <Markdown text={it.text} />
      </div>
    );
  if (it.kind === 'tool') return <div className="tools-line">· {it.text}</div>;
  if (it.kind === 'note' || it.kind === 'error') return <div className={`note-line ${it.kind === 'error' ? 'error' : ''}`}>{it.text}</div>;
  if (it.kind !== 'proposal') return null;
  return (
    <div className={`helper-proposal ${it.state === 'applied' ? 'ran' : it.state}`}>
      <div className="tiny faint">
        {it.state === 'waiting' ? 'The app doctor proposes' : it.state === 'applied' ? DONE[it.action] : it.state === 'skipped' ? 'You declined' : 'Not applied (the conversation ended)'}
      </div>
      <div className="small"><strong>{it.title}</strong></div>
      {it.settings && (
        <code className="mono" style={{ whiteSpace: 'pre-wrap' }}>
          {Object.entries(it.settings)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')}
        </code>
      )}
      {it.message && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>To {it.to}: {it.message}</div>}
      {it.why && <div className="small muted">{it.why}</div>}
      {it.state === 'waiting' && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" onClick={() => onDecide(it.proposal, true)}>
            <IconCheck /> {APPLY[it.action]}
          </button>
          <button className="btn sm" onClick={() => onDecide(it.proposal, false)}>
            Don’t
          </button>
        </div>
      )}
      {it.state === 'applied' && (
        <details>
          <summary className={`tiny ${it.ok ? 'faint' : 'text-bad'}`}>{it.ok ? 'Done' : 'It did not work'} · result</summary>
          <pre>{it.output || '(nothing)'}</pre>
        </details>
      )}
    </div>
  );
}
