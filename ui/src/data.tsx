import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { get, openEvents, type LiveEvent, type Overview } from './api';

interface Data {
  overview: Overview | null;
  error: string | null;
  connected: boolean;
  refresh(): Promise<void>;
  /** Listen to live events; returns an unsubscribe function. */
  onEvent(listener: (e: LiveEvent) => void): () => void;
}

const Ctx = createContext<Data | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setOverview(await get<Overview>('/api/overview'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const close = openEvents(
      (e) => {
        for (const l of listeners.current) l(e);
        // Coalesce bursts of events (tool calls stream fast) into one refresh.
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void refresh(), 400);
      },
      setConnected,
    );
    // Slow heartbeat so stats and liveness stay fresh even without events.
    const heartbeat = window.setInterval(() => void refresh(), 30_000);
    return () => {
      close();
      window.clearInterval(heartbeat);
    };
  }, [refresh]);

  const onEvent = useCallback((listener: (e: LiveEvent) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const value = useMemo(() => ({ overview, error, connected, refresh, onEvent }), [overview, error, connected, refresh, onEvent]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): Data {
  const v = useContext(Ctx);
  if (!v) throw new Error('useData outside DataProvider');
  return v;
}

/** Fetch something and re-fetch it when a matching live event arrives. */
export function useLive<T>(load: () => Promise<T>, deps: unknown[], match?: (e: LiveEvent) => boolean) {
  const { onEvent } = useData();
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setValue(await loadRef.current());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    setValue(null);
    void reload();
    if (!match) return;
    return onEvent((e) => {
      if (!match(e)) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void reload(), 150);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { value, error, reload, setValue };
}

// ---- tiny hash router

export function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function go(...parts: string[]) {
  location.hash = '/' + parts.map(encodeURIComponent).join('/');
}

export function href(...parts: string[]) {
  return '#/' + parts.map(encodeURIComponent).join('/');
}
