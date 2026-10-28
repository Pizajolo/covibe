// The git helper: a chat beside the Git tab. It looks at the repository by
// itself and proposes every command that would change something; you run or
// decline each one here.
import { useEffect, useRef, useState } from 'react';
import { get, post, type HelperDetail, type HelperItem } from '../api';
import { useLive } from '../data';
import { money } from '../format';
import { IconCheck, IconPlus, IconSend, IconSparkle, IconSpinner, IconStop, IconX } from './icons';
import { Markdown } from './Markdown';
import { useAction } from './ui';

const STARTERS = ['What state is my repository in?', 'Why can’t I push?', 'Undo my last commit, but keep the changes', 'Clean up branches that are already merged'];

export function GitHelper({
  projectId,
  seed,
  onSeeded,
  onClose,
}: {
  projectId: string;
  /** A message to send as soon as the panel opens (from "Ask the git helper" on an error). */
  seed?: string;
  onSeeded?: () => void;
  onClose: () => void;
}) {
  const [runId, setRunId] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // Continue the project's latest conversation.
  useEffect(() => {
    void get<{ runId: string | null }>(`/api/projects/${projectId}/git-helper`).then((r) => setRunId(r.runId));
  }, [projectId]);

  const { value: detail, reload } = useLive(
    () => (runId ? get<HelperDetail>(`/api/git-helper/${runId}`) : Promise.resolve(null)),
    [runId],
    (e) => e.projectId === '_library' && e.event.runId === runId,
  );

  const [send, sending] = useAction(async (message: string, fresh = false) => {
    if (!message.trim()) return;
    setText('');
    const r = await post<{ runId: string }>(`/api/projects/${projectId}/git-helper`, { message, runId: fresh ? undefined : runId ?? undefined });
    setRunId(r.runId);
    if (r.runId === runId) await reload();
  });

  // An error's "Ask the git helper" starts a fresh conversation about it.
  useEffect(() => {
    if (!seed || runId === undefined) return;
    onSeeded?.();
    void send(seed, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, runId === undefined]);

  const [decide] = useAction(async (id: string, run: boolean) => {
    await post(`/api/git-helper/${runId}/decide`, { id, run });
    await reload();
  });
  const [stop] = useAction(async () => {
    await post(`/api/git-helper/${runId}/stop`);
  });

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [detail?.thread.length, detail?.busy]);

  const busy = sending || !!detail?.busy;
  const items = detail?.thread ?? [];
  return (
    <aside className="helper-drawer" aria-label="Git helper">
      <div className="card-head">
        <IconSparkle width={15} height={15} />
        <h2>Git helper</h2>
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
              Ask about anything git: what state your checkout is in, why something failed, how to undo, merge or clean up. The helper looks around by itself and asks you before it runs
              anything that changes your repository.
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
          placeholder={busy ? 'The helper is working…' : 'Ask the git helper'}
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

function Item({ it, onDecide }: { it: HelperItem; onDecide: (id: string, run: boolean) => void }) {
  if (it.kind === 'human') return <div className="msg human">{it.text}</div>;
  if (it.kind === 'agent')
    return (
      <div className="msg agent helper-text">
        <Markdown text={it.text} />
      </div>
    );
  if (it.kind === 'tool') return <div className="tools-line">· {it.text}</div>;
  if (it.kind === 'note' || it.kind === 'error') return <div className={`note-line ${it.kind === 'error' ? 'error' : ''}`}>{it.text}</div>;
  if (it.kind === 'command')
    return (
      <details className="helper-cmd">
        <summary>
          <span className={it.ok ? 'faint' : 'text-bad'}>{it.ok ? '·' : '×'}</span> <span className="mono">{it.program} {it.args.join(' ')}</span>
        </summary>
        <pre>{it.output || '(no output)'}</pre>
      </details>
    );
  if (it.kind !== 'proposal') return null;
  return (
    <div className={`helper-proposal ${it.state}`}>
      <div className="tiny faint">{it.state === 'waiting' ? 'The helper wants to run' : it.state === 'ran' ? 'You ran' : it.state === 'skipped' ? 'You declined' : 'Not run (the conversation ended)'}</div>
      <code className="mono">
        {it.program} {it.args.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}
      </code>
      {it.why && <div className="small">{it.why}</div>}
      {it.state === 'waiting' && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" onClick={() => onDecide(it.proposal, true)}>
            <IconCheck /> Run it
          </button>
          <button className="btn sm" onClick={() => onDecide(it.proposal, false)}>
            Don’t
          </button>
        </div>
      )}
      {it.state === 'ran' && (
        <details>
          <summary className={`tiny ${it.ok ? 'faint' : 'text-bad'}`}>{it.ok ? 'Done' : 'It failed'} · output</summary>
          <pre>{it.output || '(no output)'}</pre>
        </details>
      )}
    </div>
  );
}
