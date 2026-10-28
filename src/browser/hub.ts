// Every live browser tab in this process: one per member and run, opened the
// first time the member uses a browser tool and closed after a while unused.
// A person watching a tab sees its frames live and can take control; while
// they have it, the member's browser tools wait.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { LiveBrowser } from '../server/api-types.js';
import { diskSource, SiteServer } from '../server/site.js';
import { playwrightProvider } from './playwright.js';
import { Tab, type ConsoleEntry, type Viewport } from './tab.js';
import type { BrowserProvider, ProviderContext } from './types.js';

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };
/** A tab nobody used or watched for this long closes. */
const IDLE_MS = 20 * 60_000;
/** A person who took control and stopped watching hands it back to the member after this long. */
export const HAND_BACK_MS = 30_000;

export interface OpenOptions {
  /** The member's working folder: served over http for pages it builds (see localUrl). */
  root: string;
  /** Domains its sandbox lets out; unset = unrestricted. Local addresses are always allowed. */
  network?: string[];
  /** Told when the page's address changes, when control changes hands and when the tab closes. */
  onChange?(change: TabChange): void;
}

export type TabChange = { kind: 'opened'; provider: string } | { kind: 'page'; url: string } | { kind: 'control'; by: 'member' | 'human' } | { kind: 'closed'; reason: string };


/** Whether a request may leave the browser, for a member whose sandbox allows `domains` (unset = no limit besides local files). */
export function networkFilter(domains: string[] | undefined): (url: string) => boolean {
  return (raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return true;
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
    if (!domains) return true;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1') return true;
    return domains.some((d) => {
      const pattern = d.toLowerCase();
      if (pattern === '*') return true;
      if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
      return host === pattern;
    });
  };
}

export class LiveTab {
  control: 'member' | 'human' = 'member';
  lastUsed = Date.now();
  /** The newest frame, for viewers who join. */
  private latest: Buffer | undefined;
  /** Watchers: what to call with each frame, and when the tab closes. */
  private viewers = new Map<(jpeg: Buffer) => void, () => void>();
  private handBack: NodeJS.Timeout | undefined;
  private stopFrames: (() => void) | undefined;
  private released: (() => void)[] = [];
  private site: Promise<SiteServer> | undefined;
  /** What the member has read of the console (see browser_console). */
  consoleRead = 0;

  constructor(
    readonly runId: string,
    readonly agent: string,
    readonly tab: Tab,
    private readonly context: ProviderContext,
    readonly root: string,
    readonly providerName: string,
    private readonly onChange: (change: TabChange) => void,
  ) {}

  touch() {
    this.lastUsed = Date.now();
  }

  get watched() {
    return this.viewers.size > 0;
  }

  async state(): Promise<LiveBrowser> {
    return { agent: this.agent, url: cleanUrl(this.tab.url), title: await this.tab.title(), viewport: this.tab.viewport, control: this.control, provider: this.providerName };
  }

  /** Resolves when the member may act (now, unless a person has control). */
  whenMemberMayAct(signal?: AbortSignal): Promise<void> {
    if (this.control === 'member') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.released = this.released.filter((r) => r !== done);
        reject(signal!.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.released.push(done);
    });
  }

  setControl(by: 'member' | 'human') {
    clearTimeout(this.handBack);
    if (this.control === by) return;
    this.control = by;
    this.touch();
    this.onChange({ kind: 'control', by });
    if (by === 'member') for (const r of this.released.splice(0)) r();
  }

  /** Watch the tab: frames as they are drawn, starting with the newest one. `onEnd`: the tab closed. */
  watch(onFrame: (jpeg: Buffer) => void, onEnd: () => void = () => {}): () => void {
    this.touch();
    clearTimeout(this.handBack);
    this.viewers.set(onFrame, onEnd);
    if (this.latest) onFrame(this.latest);
    else void this.tab.screenshot(70).then((f) => {
      this.latest ??= f;
      if (this.viewers.has(onFrame)) onFrame(f);
    }, () => undefined);
    if (!this.stopFrames) {
      this.stopFrames = this.tab.frames((jpeg) => {
        this.latest = jpeg;
        for (const v of this.viewers.keys()) v(jpeg);
      });
    }
    return () => {
      if (!this.viewers.delete(onFrame)) return;
      this.touch();
      if (this.viewers.size) return;
      this.stopFrames?.();
      this.stopFrames = undefined;
      // Nobody is looking any more: don't keep the member waiting for a person who left.
      if (this.control === 'human') {
        clearTimeout(this.handBack);
        this.handBack = setTimeout(() => {
          if (!this.viewers.size && this.control === 'human') this.setControl('member');
        }, HAND_BACK_MS);
        this.handBack.unref?.();
      }
    };
  }

  /** The member's working folder over http (pages it builds), with the key that lets the browser in. */
  async localUrl(path: string): Promise<string> {
    this.site ??= SiteServer.start(diskSource(this.root, 'the working folder'));
    return (await this.site).url(path);
  }

  /** What a person or member typed in the address bar, as an address to open. */
  async resolve(input: string): Promise<string> {
    const s = input.trim();
    if (!s) throw new Error('give an address or a path');
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^localhost:\d/i.test(s)) {
      const scheme = s.slice(0, s.indexOf(':')).toLowerCase();
      if (scheme === 'http' || scheme === 'https' || s === 'about:blank') return s;
      if (scheme === 'file') {
        const path = decodeURIComponent(new URL(s).pathname);
        const rel = this.inRoot(path);
        if (rel !== undefined) return this.localUrl(rel);
        throw new Error('file:// addresses outside the working folder cannot be opened; serve the page or pass a path inside the working folder');
      }
      throw new Error(`${scheme}: addresses cannot be opened; use http(s) or a path in the working folder`);
    }
    // A file or folder of the working folder.
    const rel = this.inRoot(isAbsolute(s) ? s : resolve(this.root, s.replace(/[?#].*$/, '')));
    if (rel !== undefined && existsSync(resolve(this.root, rel))) {
      const suffix = /[?#]/.test(s) ? s.slice(s.search(/[?#]/)) : '';
      return this.localUrl('/' + rel.split(sep).map(encodeURIComponent).join('/') + (statSync(resolve(this.root, rel)).isDirectory() && rel ? '/' : '') + suffix);
    }
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(s)) return `https://${s}`;
    throw new Error(`"${s}" is neither an address nor a file in the working folder`);
  }

  private inRoot(path: string): string | undefined {
    const rel = relative(resolve(this.root), resolve(path));
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return rel;
  }

  async close(reason: string) {
    clearTimeout(this.handBack);
    this.control = 'member';
    for (const r of this.released.splice(0)) r();
    this.stopFrames?.();
    this.stopFrames = undefined;
    const ends = [...this.viewers.values()];
    this.viewers.clear();
    for (const end of ends) end();
    await this.tab.close();
    await this.context.close();
    if (this.site) await (await this.site.catch(() => undefined))?.close();
    this.onChange({ kind: 'closed', reason });
  }
}

export class BrowserHub {
  private provider: BrowserProvider | undefined;
  private factory: () => BrowserProvider;
  private tabs = new Map<string, Promise<LiveTab>>();
  private sweep: NodeJS.Timeout | undefined;

  constructor(factory: () => BrowserProvider = playwrightProvider) {
    this.factory = factory;
  }

  /** Use this browser from now on (the Mac app passes its built-in Chromium). Open tabs keep theirs. */
  use(provider: BrowserProvider) {
    this.provider = provider;
  }

  private key(runId: string, agent: string) {
    return `${runId}\0${agent}`;
  }

  /** The member's tab in this run; opened on first use. */
  open(runId: string, agent: string, opts: OpenOptions): Promise<LiveTab> {
    const key = this.key(runId, agent);
    let live = this.tabs.get(key);
    if (live) {
      // A tab that crashed or lost its browser is replaced with a fresh one.
      return live.then(async (t) => {
        if (!t.tab.isClosed) return t;
        if (this.tabs.get(key) === live) {
          this.tabs.delete(key);
          await t.close('crashed').catch(() => undefined);
        }
        return this.open(runId, agent, opts);
      });
    }
    live = (async () => {
      const provider = (this.provider ??= this.factory());
      let tab: Tab | undefined;
      // Only a sandboxed member's requests are filtered; local files never open either way (see resolve).
      const context = await provider.newContext(
        opts.network
          ? {
              allow: networkFilter(opts.network),
              onBlocked: (url) => tab?.log('error', `Blocked by the sandbox (not on the network list): ${url}`),
            }
          : {},
      );
      try {
        // A new window's address opens in the same tab (web addresses only: never a local file).
        const onPopup = (url: string) => {
          if (/^https?:\/\//i.test(url)) void tab?.goto(url).catch(() => undefined);
        };
        const pt = await context.newTab({ ...DEFAULT_VIEWPORT, onPopup });
        tab = await Tab.open(pt, DEFAULT_VIEWPORT, { onNavigate: (url) => opts.onChange?.({ kind: 'page', url: cleanUrl(url) }) });
      } catch (err) {
        await context.close();
        throw err;
      }
      this.startSweep();
      opts.onChange?.({ kind: 'opened', provider: provider.name });
      return new LiveTab(runId, agent, tab, context, opts.root, provider.name, (c) => opts.onChange?.(c));
    })();
    live.catch(() => this.tabs.delete(key));
    this.tabs.set(key, live);
    return live;
  }

  /** The member's tab, if it is open in this process. */
  async get(runId: string, agent: string): Promise<LiveTab | undefined> {
    const live = this.tabs.get(this.key(runId, agent));
    const tab = live && (await live.catch(() => undefined));
    return tab && !tab.tab.isClosed ? tab : undefined;
  }

  /** Members of a run with an open tab here. */
  async list(runId: string): Promise<LiveTab[]> {
    const out: LiveTab[] = [];
    for (const [key, live] of this.tabs) {
      if (!key.startsWith(`${runId}\0`)) continue;
      const tab = await live.catch(() => undefined);
      if (tab && !tab.tab.isClosed) out.push(tab);
    }
    return out;
  }

  async close(runId: string, agent: string, reason = 'closed') {
    const key = this.key(runId, agent);
    const live = this.tabs.get(key);
    this.tabs.delete(key);
    await (await live?.catch(() => undefined))?.close(reason);
  }

  private startSweep() {
    if (this.sweep) return;
    this.sweep = setInterval(() => void this.closeIdle(), 60_000);
    this.sweep.unref();
  }

  /** Close tabs nobody used or watched for a while. */
  async closeIdle(now = Date.now()) {
    for (const [key, live] of [...this.tabs]) {
      const tab = await live.catch(() => undefined);
      if (!tab) continue;
      if (tab.watched || now - tab.lastUsed < IDLE_MS) continue;
      this.tabs.delete(key);
      await tab.close('idle');
    }
  }

  async shutdown() {
    clearInterval(this.sweep);
    this.sweep = undefined;
    const all = [...this.tabs.values()];
    this.tabs.clear();
    await Promise.all(all.map((l) => l.then((t) => t.close('covibe stopped'), () => undefined)));
    await this.provider?.close();
    this.provider = undefined;
  }
}

/** An address without covibe's preview key in it. */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('covibe_key')) return url;
    u.searchParams.delete('covibe_key');
    return u.toString();
  } catch {
    return url;
  }
}

/** The browser of this process. */
export const browserHub = new BrowserHub();

export type { ConsoleEntry };
