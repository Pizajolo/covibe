import { useEffect, useRef, useState } from 'react';
import { post, type AppNotification, type NotificationKind } from '../api';
import { href } from '../data';
import { openNotification, useNotify, type OpenQuestion } from '../notify';
import { IconAlert, IconBell, IconCheck, IconGauge, IconQuestion, IconStop, IconX } from './icons';
import { Avatar, Modal, Since, useAction, useToast } from './ui';

const KIND_ICON: Record<NotificationKind, React.ReactNode> = {
  question: <IconQuestion />,
  limit: <IconGauge />,
  stopped: <IconStop />,
  error: <IconX />,
  done: <IconCheck />,
};

/** The bell in the toolbar: questions waiting for you, then the latest notifications. */
export function NotificationBell() {
  const { items, open, unread, markRead, showQuestion } = useNotify();
  const [show, setShow] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // A question still waiting for you is listed once, under "Waiting for you".
  const listed = items.filter((n) => n.bell && !(n.kind === 'question' && n.open));
  const count = open.length + unread;

  useEffect(() => {
    if (!show) return;
    markRead();
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setShow(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShow(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [show, markRead]);

  const pick = (n: Pick<AppNotification, 'projectId' | 'runId' | 'questionId' | 'open'>) => {
    setShow(false);
    openNotification(n, showQuestion);
  };

  return (
    <div className="bell-wrap" ref={wrap}>
      <button
        className={`btn ghost bell ${open.length ? 'asks' : ''}`}
        aria-label={`Notifications${count ? `, ${count} new` : ''}`}
        aria-expanded={show}
        title="Notifications"
        onClick={() => setShow((s) => !s)}
      >
        <IconBell />
        {count > 0 && <span className="bell-count num">{count > 9 ? '9+' : count}</span>}
      </button>
      {show && (
        <div className="bell-pop" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            <span className="grow" />
            <a className="tiny" href={href('settings')} onClick={() => setShow(false)}>
              Settings
            </a>
          </div>
          <div className="bell-list">
            {open.length > 0 && <div className="bell-section">Waiting for you</div>}
            {open.map((o) => (
              <button key={o.key} className="bell-item open" onClick={() => pick({ projectId: o.projectId, runId: o.run.id, questionId: o.q.id, open: true })}>
                <span className="bell-icon question">
                  <IconQuestion />
                </span>
                <span className="bell-text">
                  <strong>{o.q.from} asks you</strong>
                  <span className="ellipsis-2">{o.q.forHuman ?? o.q.question}</span>
                  <span className="tiny faint ellipsis">{o.run.goal}</span>
                </span>
              </button>
            ))}
            {listed.length > 0 && open.length > 0 && <div className="bell-section">Latest</div>}
            {listed.map((n) => (
              <button key={n.id} className="bell-item" onClick={() => pick(n)}>
                <span className={`bell-icon ${n.kind}`}>{KIND_ICON[n.kind]}</span>
                <span className="bell-text">
                  <strong>{n.title}</strong>
                  {n.body && <span className="ellipsis-2">{n.body}</span>}
                  <span className="tiny faint">
                    <Since iso={n.ts} />
                    {n.kind === 'question' && !n.open ? ' · answered or closed' : ''}
                  </span>
                </span>
              </button>
            ))}
            {!open.length && !listed.length && <p className="small muted bell-empty">Nothing yet. Questions, plan limits and finished runs show up here.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The question in the popup, when one waits for you. */
export function QuestionPopup() {
  const { shown, dismiss } = useNotify();
  if (!shown) return null;
  return <QuestionDialog key={shown.key} item={shown} onClose={dismiss} />;
}

const OTHER = -1;

function QuestionDialog({ item, onClose }: { item: OpenQuestion; onClose: () => void }) {
  const { q, run, projectId } = item;
  const options = q.options ?? [];
  const [choice, setChoice] = useState<number | undefined>(options.length ? undefined : OTHER);
  const [text, setText] = useState('');
  const other = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const answer = choice === OTHER ? text.trim() : choice !== undefined ? options[choice]! : '';
  const [send, sending] = useAction(async () => {
    await post(`/api/runs/${projectId}/${run.id}/questions/${q.id}/answer`, { answer });
    toast(`Answered. ${q.from} carries on.`);
    onClose();
  });
  const submit = () => answer && !sending && void send();
  const index = run.agents.findIndex((a) => a.name === q.from);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  return (
    <Modal
      title={
        <span className="row" style={{ gap: 10 }}>
          <Avatar name={q.from} index={index} size="sm" />
          {q.from} asks you
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <a className="btn ghost" href={href('runs', projectId, run.id)} onClick={onClose}>
            Open run
          </a>
          <span className="grow" />
          <button className="btn" onClick={onClose} title="Answer later from the bell or the lead's desk in the Office">
            Later
          </button>
          <button className="btn primary" disabled={!answer || sending} onClick={submit}>
            Answer
          </button>
        </>
      }
    >
      <div className="ask">
        <p className="ask-q">{q.forHuman ?? q.question}</p>
        {q.context && (
          <p className="ask-why">
            <span className="faint">{q.from}'s context:</span> {q.context}
          </p>
        )}
        {q.leadNote && (
          <p className="ask-why">
            <span className="faint">Why it comes to you:</span> {q.leadNote}
          </p>
        )}
        <p className="ask-why row" style={{ gap: 6 }}>
          <IconAlert width={13} height={13} style={{ color: 'var(--warn)' }} />
          The team is paused until you answer. <span className="faint ellipsis">{run.goal}</span>
        </p>
      </div>
      {options.length > 0 ? (
        <div className="ask-options" role="radiogroup" aria-label={`Answer to ${q.from}`}>
          {options.map((o, i) => (
            <label key={i} className={`ask-option ${choice === i ? 'on' : ''}`}>
              <input type="radio" name={`q-${item.key}`} checked={choice === i} onChange={() => setChoice(i)} />
              <span>{o}</span>
            </label>
          ))}
          <label className={`ask-option ${choice === OTHER ? 'on' : ''}`}>
            <input
              type="radio"
              name={`q-${item.key}`}
              checked={choice === OTHER}
              onChange={() => {
                setChoice(OTHER);
                other.current?.focus();
              }}
            />
            <span className="col" style={{ gap: 6 }}>
              Other
              <AnswerBox ref={other} value={text} label={`Your own answer to ${q.from}`} placeholder="Write your own answer" onChange={(v) => (setText(v), setChoice(OTHER))} onFocus={() => setChoice(OTHER)} />
            </span>
          </label>
        </div>
      ) : (
        <AnswerBox value={text} label={`Answer to ${q.from}`} placeholder="Your answer" autoFocus onChange={setText} />
      )}
      <p className="tiny faint" style={{ margin: 0 }}>
        ⌘ ↩ to answer. You can also answer from the bell, or from {q.lead && run.agents.some((a) => a.name === q.lead) ? `${q.lead}'s` : `${q.from}'s`} desk in the Office.
      </p>
    </Modal>
  );
}

function AnswerBox({
  ref,
  value,
  label,
  placeholder,
  autoFocus,
  onChange,
  onFocus,
}: {
  ref?: React.Ref<HTMLTextAreaElement>;
  value: string;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  onChange: (v: string) => void;
  onFocus?: () => void;
}) {
  return (
    <textarea
      ref={ref}
      className="input answer-box"
      rows={3}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
    />
  );
}
