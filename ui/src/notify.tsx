// Notifications: the bell's list, system notifications, and the popup for
// questions that wait for you. Questions pop up wherever you are in the app;
// dismissing one keeps it under the bell and on the lead's desk in the Office.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { desktop, get, type AppNotification, type QuestionView, type RunSummary } from './api';
import { useToast } from './components/ui';
import { go, useData, useLive } from './data';

/** A question that waits for you, with the run it belongs to. */
export interface OpenQuestion {
  key: string;
  projectId: string;
  run: RunSummary;
  q: QuestionView;
}

interface Notify {
  items: AppNotification[];
  open: OpenQuestion[];
  unread: number;
  markRead(): void;
  /** The question shown in the popup, if any. */
  shown: OpenQuestion | undefined;
  showQuestion(projectId: string, runId: string, id: number): void;
  dismiss(): void;
}

const Ctx = createContext<Notify | null>(null);
const NOTIFY_TYPES = /^(question\.|usage\.limit|run\.finished)/;
const SEEN_KEY = 'covibe-notifications-seen';

export const questionKey = (projectId: string, runId: string, id: number) => `${projectId}/${runId}/${id}`;

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Bring the app forward and open what a notification is about. */
export function openNotification(n: Pick<AppNotification, 'projectId' | 'runId' | 'questionId' | 'open'>, showQuestion: Notify['showQuestion']) {
  if (n.projectId === '_library') return;
  go('runs', n.projectId, n.runId);
  if (n.questionId !== undefined && n.open) showQuestion(n.projectId, n.runId, n.questionId);
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const { overview } = useData();
  const toast = useToast();
  const { value } = useLive(() => get<AppNotification[]>('/api/notifications'), [], (e) => NOTIFY_TYPES.test(e.event.type));
  const items = useMemo(() => value ?? [], [value]);

  // Read state is a per-viewer convenience: the newest notification you saw.
  const [seen, setSeen] = useState(readSeen);
  const listed = items.filter((n) => n.bell);
  const unread = listed.filter((n) => n.ts > seen).length;
  const markRead = useCallback(() => {
    const newest = listed[0]?.ts;
    if (!newest || newest <= seen) return;
    setSeen(newest);
    try {
      localStorage.setItem(SEEN_KEY, newest);
    } catch {
      // storage unavailable; read state lasts for this window
    }
  }, [listed, seen]);

  const open = useMemo(
    () =>
      (overview?.runs ?? [])
        .filter((r) => r.status === 'running')
        .flatMap((run) => run.questions.filter((q) => q.status === 'open').map((q) => ({ key: questionKey(run.projectId, run.id, q.id), projectId: run.projectId, run, q }))),
    [overview],
  );

  // The popup shows the question you reopened, else the first one you have not dismissed.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [pinned, setPinned] = useState<string | undefined>();
  const shown = open.find((o) => o.key === pinned) ?? open.find((o) => !dismissed.has(o.key));
  const showQuestion = useCallback((projectId: string, runId: string, id: number) => setPinned(questionKey(projectId, runId, id)), []);
  const dismiss = useCallback(() => {
    if (!shown) return;
    const key = shown.key;
    setDismissed((d) => new Set(d).add(key));
    setPinned(undefined);
  }, [shown]);

  // New notifications since the app opened: a system notification when the
  // app is in the background, a toast when you are looking at it.
  const known = useRef<Set<string> | null>(null);
  const showRef = useRef(showQuestion);
  showRef.current = showQuestion;
  useEffect(() => {
    if (!value) return;
    const first = known.current === null;
    const fresh = first ? [] : value.filter((n) => !known.current!.has(n.id));
    known.current = new Set(value.map((n) => n.id));
    for (const n of fresh.reverse()) {
      // Open questions pop up in the app on their own.
      const away = document.hidden || !document.hasFocus();
      if (n.push && away && canPush()) {
        const note = new Notification(n.title, { body: n.body, tag: n.id, icon: '/icon.svg' });
        note.onclick = () => {
          window.focus();
          void desktop?.focus();
          openNotification(n, showRef.current);
          note.close();
        };
      } else if (!away && n.bell && n.kind !== 'question') {
        toast(n.body ? `${n.title}: ${n.body}` : n.title, n.kind === 'error');
      }
    }
  }, [value, toast]);

  const ctx = useMemo<Notify>(() => ({ items, open, unread, markRead, shown, showQuestion, dismiss }), [items, open, unread, markRead, shown, showQuestion, dismiss]);
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

export function useNotify(): Notify {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNotify outside NotifyProvider');
  return v;
}

// ---- system notifications

export type PushState = 'unsupported' | 'default' | 'granted' | 'denied';

export function pushState(): PushState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function canPush(): boolean {
  return pushState() === 'granted';
}

export async function askPushPermission(): Promise<PushState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}
