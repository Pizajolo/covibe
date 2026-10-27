import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentActivity, RunStatus } from '../api';
import { IconAlert, IconCheck, IconClock, IconLoop, IconSpinner, IconX } from './icons';

// ---- status

const RUN_STATUS: Record<RunStatus, { label: string; cls: string; icon: ReactNode }> = {
  running: { label: 'Running', cls: 'info', icon: <IconSpinner /> },
  succeeded: { label: 'Succeeded', cls: 'good', icon: <IconCheck /> },
  escalated: { label: 'Needs you', cls: 'warn', icon: <IconAlert /> },
  failed: { label: 'Failed', cls: 'bad', icon: <IconX /> },
};

/** A live run with a question waiting for you shows as paused. */
export function RunStatusPill({ status, kind, paused }: { status: RunStatus; kind?: string; paused?: boolean }) {
  const s = paused && status === 'running' ? { label: 'Paused · needs you', cls: 'warn', icon: <IconAlert /> } : RUN_STATUS[status];
  const label = kind === 'ask' && status === 'succeeded' ? 'Answered' : kind === 'ask' && status === 'running' ? 'Thinking' : s.label;
  return (
    <span className={`pill ${s.cls}`}>
      {s.icon}
      {label}
    </span>
  );
}

const AGENT_STATUS: Record<AgentActivity, string> = {
  idle: 'Not started',
  working: 'Working',
  done: 'Done',
  error: 'Stopped',
  waiting: 'Has messages',
  asking: 'Waiting for an answer',
};

export function AgentStatus({ status }: { status: AgentActivity }) {
  return (
    <span className="row tiny" style={{ gap: 5 }}>
      <span className={`dot ${status}`} />
      <span className={status === 'working' ? '' : 'faint'}>{AGENT_STATUS[status]}</span>
    </span>
  );
}

export function LoopBadge({ loops, max }: { loops: number; max?: number }) {
  if (!loops) return null;
  return (
    <span className="pill warn" title="Fix rounds after a failed gate">
      <IconLoop />
      Round {loops}
      {max !== undefined ? ` of ${max}` : ''}
    </span>
  );
}

// ---- avatars: color follows the member's position in the team roster

export function memberColor(index: number): string {
  return index >= 0 && index < 8 ? `var(--series-${index + 1})` : 'var(--text-3)';
}

export function Avatar({ name, index, status, size }: { name: string; index: number; status?: AgentActivity; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size ?? ''}`} style={{ background: memberColor(index) }} title={name}>
      {name.slice(0, 2)}
      {status && status !== 'idle' && <span className={`dot ${status}`} />}
    </span>
  );
}

// ---- modal

export function Modal({ title, children, onClose, footer, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal>
        <div className="modal-head">
          <h2>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---- toasts

interface Toast {
  id: number;
  text: string;
  bad?: boolean;
}
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, text, bad }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Run an async action, toasting its error. Returns a [run, busy] pair. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): [(...args: A) => Promise<void>, boolean] {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      try {
        await fn(...args);
      } catch (err) {
        toast((err as Error).message, true);
      } finally {
        setBusy(false);
      }
    },
    [fn, toast],
  );
  return [run, busy];
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
      {action}
    </div>
  );
}

export function Since({ iso }: { iso: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const d = new Date(iso);
  return (
    <span title={d.toLocaleString()} className="row" style={{ gap: 4, display: 'inline-flex' }}>
      <IconClock width={12} height={12} />
      {relative(iso)}
    </span>
  );
}

function relative(iso: string) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      className="btn sm ghost"
      title={`Copy ${text}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => toast('Copied'));
      }}
    >
      <span className="mono ellipsis" style={{ maxWidth: 260 }}>
        {label ?? text}
      </span>
    </button>
  );
}
