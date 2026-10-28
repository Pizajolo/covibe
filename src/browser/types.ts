// The seam between covibe's browser and whatever Chromium runs it: a headless
// Chromium through Playwright (CLI, `covibe app`), or the Mac app's own
// Electron. Both hand over a Chrome DevTools Protocol session per tab, and
// everything else (clicking, typing, snapshots, live frames) is built once on
// top of that in tab.ts.

/** A Chrome DevTools Protocol session attached to one page. */
export interface CdpSession {
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (params: any) => void): void;
  off(event: string, handler: (params: any) => void): void;
}

/** One page as a provider opened it. */
export interface ProviderTab {
  cdp: CdpSession;
  /** Size the page's surface to the viewport (a provider whose window has a size of its own). */
  resize?(width: number, height: number): Promise<void>;
  /**
   * Live frames, when the provider has a better source than CDP screencasting
   * (Electron's offscreen paint). Returns a function that stops them.
   */
  frames?(onFrame: (jpeg: Buffer) => void): () => void;
  close(): Promise<void>;
}

export interface ContextOptions {
  /** Whether a request may go out (the member's sandbox network list). Unset = everything but local files. */
  allow?: (url: string) => boolean;
  /** Told about each request `allow` refused. */
  onBlocked?: (url: string) => void;
}

/** A private browsing context: its own cookies, storage and cache. */
export interface ProviderContext {
  /** `onPopup`: a page tried to open a new window; covibe opens its address in the same tab instead. */
  newTab(opts: { width: number; height: number; onPopup: (url: string) => void }): Promise<ProviderTab>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  /** For people: "Chromium (Playwright)", "covibe's built-in Chromium". */
  readonly name: string;
  newContext(opts: ContextOptions): Promise<ProviderContext>;
  close(): Promise<void>;
}

/** Thrown when no browser can be started; the message says what to install. */
export class BrowserUnavailable extends Error {}
