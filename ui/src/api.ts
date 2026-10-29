import type { RunEvent } from '../../src/server/api-types';

export type * from '../../src/server/api-types';

/** Bridge the Electron shell exposes (absent in a plain browser). */
export interface DesktopBridge {
  pickFolder(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Bring the window to the front. */
  focus(): Promise<void>;
  platform: string;
}

declare global {
  interface Window {
    covibe?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = window.covibe;

// The server hands out a per-start token in the page URL. Keep it for this
// window and take it out of the address bar.
const token = (() => {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      sessionStorage.setItem('covibe-token', fromUrl);
    } catch {
      // storage unavailable; the token still lives in memory
    }
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem('covibe-token') ?? '';
  } catch {
    return '';
  }
})();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** For a failed git operation: what kind of trouble, what to do, and git's own output. */
    readonly git?: import('../../src/server/api-types').GitProblemInfo,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = json as { error?: string; git?: ApiError['git'] };
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body.git);
  }
  return json as T;
}

/** A URL for an element that cannot send headers (an <img>): the token goes in the query. */
export function authedUrl(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export interface LiveEvent {
  projectId: string;
  event: RunEvent;
}

/** Subscribe to every event from every project. EventSource reconnects on its own. */
export function openEvents(onEvent: (e: LiveEvent) => void, onStatus: (connected: boolean) => void): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.addEventListener('run-event', (m) => onEvent(JSON.parse((m as MessageEvent).data)));
  source.onopen = () => onStatus(true);
  source.onerror = () => onStatus(false);
  return () => source.close();
}
