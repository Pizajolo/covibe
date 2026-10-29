// Feedback pinned on a run's result: a moment of a video, an area of an
// image, a passage, an element of a page or of the running app. Comments are
// kept with the project until you send them; sending starts a new goal on the
// result (server/feedback.ts writes it).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, get, post, type FeedbackItem, type FeedbackList, type RunSummary } from '../api';
import { go, href, useLive } from '../data';
import { IconAlert, IconChat, IconSend, IconTrash, IconX } from './icons';
import { MicButton, withSpoken } from './MicButton';
import { Modal, useAction, useToast } from './ui';

/** Where a comment points, before it has text. */
export type Anchor = Omit<FeedbackItem, 'id' | 'comment' | 'createdAt'>;

interface Feedback {
  projectId: string;
  items: FeedbackItem[];
  sent: FeedbackList['sent'];
  /** Open the comment form on a spot. */
  compose(anchor: Anchor): void;
  remove(id: string): Promise<void>;
  /** Whether the run has ended, so the feedback can be sent. */
  canSend: boolean;
  openSend(): void;
}

const Ctx = createContext<Feedback | null>(null);

export function useFeedback(): Feedback {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFeedback outside FeedbackProvider');
  return v;
}

/** 75.4 → "1:15.4" */
export function timecode(s: number): string {
  const m = Math.floor(s / 60);
  const rest = Math.round((s - m * 60) * 10) / 10;
  const sec = rest % 1 ? rest.toFixed(1).padStart(4, '0') : String(rest).padStart(2, '0');
  return `${m}:${sec}`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A comment's spot, in a few words. */
export function anchorLabel(a: Anchor): string {
  const parts: string[] = [];
  if (a.at !== undefined) parts.push(a.until !== undefined ? `${timecode(a.at)}–${timecode(a.until)}` : `at ${timecode(a.at)}`);
  if (a.region) parts.push(`area ${pct(a.region.x)}–${pct(a.region.x + a.region.width)} × ${pct(a.region.y)}–${pct(a.region.y + a.region.height)}`);
  if (a.page !== undefined) parts.push(`page ${a.page}`);
  if (a.element) parts.push(a.element.text ? `“${a.element.text.slice(0, 60)}”` : `<${a.element.tag}>`);
  if (a.quote) parts.push(`“${a.quote.slice(0, 60)}${a.quote.length > 60 ? '…' : ''}”`);
  return parts.join(' · ');
}

const placeLabel = (a: Anchor) => (a.target === 'app' ? `App · ${a.path}` : a.path);

export function FeedbackProvider({ projectId, run, children }: { projectId: string; run: RunSummary; children: ReactNode }) {
  const base = `/api/runs/${projectId}/${run.id}/feedback`;
  const { value, setValue } = useLive(
    () => get<FeedbackList>(base),
    [projectId, run.id],
    (e) => e.projectId === projectId && e.event.runId === run.id && e.event.type === 'feedback.sent',
  );
  const [draft, setDraft] = useState<Anchor | null>(null);
  const [sending, setSending] = useState(false);
  const toast = useToast();

  const add = useCallback(
    async (anchor: Anchor, comment: string) => {
      setValue(await post<FeedbackList>(base, { ...anchor, comment }));
    },
    [base, setValue],
  );
  const remove = useCallback(
    async (id: string) => {
      const items = (value?.items ?? []).filter((i) => i.id !== id);
      try {
        setValue(await api<FeedbackList>('PUT', base, { items }));
      } catch (err) {
        toast((err as Error).message, true);
      }
    },
    [base, value, setValue, toast],
  );

  const feedback = useMemo<Feedback>(
    () => ({
      projectId,
      items: value?.items ?? [],
      sent: value?.sent ?? [],
      compose: setDraft,
      remove,
      canSend: run.status !== 'running' && run.kind === 'workflow',
      openSend: () => setSending(true),
    }),
    [projectId, value, remove, run.status, run.kind],
  );

  return (
    <Ctx.Provider value={feedback}>
      {children}
      {draft && <Composer anchor={draft} onClose={() => setDraft(null)} onAdd={add} />}
      {sending && <SendDialog projectId={projectId} run={run} items={feedback.items} onClose={() => setSending(false)} />}
    </Ctx.Provider>
  );
}

/** The form for one comment on a spot (the moment of a video can still be adjusted). */
function Composer({ anchor, onClose, onAdd }: { anchor: Anchor; onClose: () => void; onAdd: (a: Anchor, comment: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [spot, setSpot] = useState(anchor);
  const [page, setPage] = useState(anchor.page ? String(anchor.page) : '');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  const [save, saving] = useAction(async () => {
    const n = Number(page);
    await onAdd({ ...spot, ...(anchor.kind === 'pdf' && page && Number.isInteger(n) && n > 0 ? { page: n } : {}) }, text);
    onClose();
  });
  const label = anchorLabel(spot);
  return (
    <Modal
      title="Comment"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!text.trim() || saving} onClick={() => void save()}>
            Add comment
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <div className="feedback-spot">
          <span className="mono ellipsis">{placeLabel(spot)}</span>
          {label && <span className="muted">{label}</span>}
        </div>
        {spot.at !== undefined && spot.until !== undefined && (
          <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSpot(({ until: _u, ...rest }) => rest)}>
            Just the moment {timecode(spot.at)}
          </button>
        )}
        {anchor.kind === 'pdf' && (
          <label className="row small" style={{ gap: 8 }}>
            Page <input className="input" style={{ width: 80 }} inputMode="numeric" placeholder="any" value={page} onChange={(e) => setPage(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
          <textarea
            ref={box}
            className="input grow"
            rows={4}
            placeholder={spot.kind === 'video' ? 'What should change here? (“cut this shorter”, “the music is too loud”)' : spot.element ? 'What should change about this? (“make it bigger”, “wrong price”)' : 'What should change?'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void save();
            }}
          />
          <MicButton onText={(t) => setText((v) => withSpoken(v, t))} />
        </div>
        <span className="tiny faint">Comments are kept with this run until you send them to the team. ⌘↩ adds it.</span>
      </div>
    </Modal>
  );
}

/** The comments so far, next to what they are about, with the button that sends them. */
export function FeedbackPanel({ onShow, onClose }: { onShow?: (item: FeedbackItem) => void; onClose?: () => void }) {
  const { projectId, items, sent, remove, canSend, openSend } = useFeedback();
  return (
    <aside className="feedback-panel">
      <div className="row" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', gap: 6 }}>
        <IconChat width={14} height={14} />
        <strong className="small grow">Feedback</strong>
        {onClose && (
          <button className="btn sm ghost icon-btn" title="Hide" onClick={onClose}>
            <IconX width={13} height={13} />
          </button>
        )}
      </div>
      <div className="feedback-items">
        {!items.length ? (
          <p className="tiny faint" style={{ padding: 12 }}>
            Point at what should change: a moment of a video, an area of an image, a passage, or an element of a page or the app. Then send it all to the team as a new goal.
          </p>
        ) : (
          items.map((i, n) => (
            <div key={i.id} className="feedback-item">
              <div className="row" style={{ gap: 6 }}>
                <span className="badge num">{n + 1}</span>
                <button className="linkish grow ellipsis mono tiny" title={`Show ${i.path}`} onClick={() => onShow?.(i)}>
                  {placeLabel(i)}
                </button>
                <button className="btn sm ghost icon-btn" title="Remove" onClick={() => void remove(i.id)}>
                  <IconTrash width={12} height={12} />
                </button>
              </div>
              {anchorLabel(i) && <span className="tiny muted">{anchorLabel(i)}</span>}
              <span className="small" style={{ whiteSpace: 'pre-wrap' }}>{i.comment}</span>
            </div>
          ))
        )}
      </div>
      <div className="col" style={{ padding: 12, gap: 6, borderTop: '1px solid var(--border)' }}>
        <button className="btn primary" disabled={!canSend || !items.length} onClick={openSend} title={canSend ? 'Start a new goal on this result with your comments' : 'You can send it once the run has finished'}>
          <IconSend /> Send to the team{items.length ? ` (${items.length})` : ''}
        </button>
        {!canSend && items.length > 0 && <span className="tiny faint">You can send it once the run has finished.</span>}
        {sent.length > 0 && (
          <span className="tiny faint">
            Sent before:{' '}
            {sent.map((s, k) => (
              <span key={s.runId}>
                {k > 0 && ', '}
                <a href={href('runs', projectId, s.runId)}>{s.count} comment{s.count === 1 ? '' : 's'}</a>
              </span>
            ))}
          </span>
        )}
      </div>
    </aside>
  );
}

function SendDialog({ projectId, run, items, onClose }: { projectId: string; run: RunSummary; items: FeedbackItem[]; onClose: () => void }) {
  const [note, setNote] = useState('');
  const toast = useToast();
  const [send, busy] = useAction(async () => {
    const started = await post<{ runId: string; projectId: string }>(`/api/runs/${projectId}/${run.id}/feedback/send`, { note });
    toast(`${run.team} is working on your feedback.`);
    onClose();
    go('runs', started.projectId, started.runId);
  });
  return (
    <Modal
      title="Send feedback to the team"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (!items.length && !note.trim())} onClick={() => void send()}>
            <IconSend /> Start a new goal
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="small muted">
          {run.team} starts a new goal on this run's result{run.branch ? ` (branch ${run.branch})` : run.folder ? ' in your folder' : ''}, with every comment and where it points. The comments are cleared here once sent.
        </p>
        <ol className="feedback-summary">
          {items.map((i) => (
            <li key={i.id}>
              <span className="mono tiny">{placeLabel(i)}</span>
              {anchorLabel(i) && <span className="tiny muted"> · {anchorLabel(i)}</span>}
              <div className="small">{i.comment}</div>
            </li>
          ))}
        </ol>
        <label className="col" style={{ gap: 6 }}>
          <span className="label">Anything else? (optional)</span>
          <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <textarea className="input grow" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="An overall note for the team" />
            <MicButton onText={(t) => setNote((v) => withSpoken(v, t))} />
          </div>
        </label>
        {run.status === 'running' && (
          <div className="banner warn">
            <IconAlert />
            The run is still going.
          </div>
        )}
      </div>
    </Modal>
  );
}
