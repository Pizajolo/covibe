// One browser tab, driven over the Chrome DevTools Protocol: whichever
// provider opened it, members and people act on it through this class.
import { platform } from 'node:os';
import { DIALOG_SCRIPT, pageCall } from './page-script.js';
import type { CdpSession, ProviderTab } from './types.js';

export interface Viewport {
  width: number;
  height: number;
}

export interface ConsoleEntry {
  /** Grows by one per entry, so readers can ask for what is new. */
  seq: number;
  level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  text: string;
  ts: string;
}

export interface Snapshot {
  text: string;
  shown: number;
  total: number;
  truncated: boolean;
  scroll: ScrollInfo;
}

export interface ScrollInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  vw: number;
  vh: number;
}

/** Longest wait for a page to load. */
const LOAD_TIMEOUT_MS = 20_000;
/** Console entries kept per tab. */
const CONSOLE_KEPT = 300;

/** Named keys as CDP wants them: key, code and Windows key code (and the text it types). */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i }])),
};
const KEY_ALIASES: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Del: 'Delete', ' ': 'Space' };
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
/** Editing shortcuts macOS Chromium only runs as commands, not from key events. */
const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

/** A key combination like "Control+A", "Shift+Tab", "Enter" or "a", as CDP key events. */
export function keyEvents(combo: string, os = platform()): { down: Record<string, unknown>; up: Record<string, unknown> } {
  const parts = combo === '+' ? ['+'] : combo.split('+').map((p) => p.trim());
  // "Control++" means Control and the plus key.
  if (combo.endsWith('++')) parts.splice(-2, 2, '+');
  let name = parts.pop() ?? '';
  let modifiers = 0;
  for (const p of parts) {
    const m = p === 'ControlOrMeta' ? (os === 'darwin' ? 4 : 2) : MODIFIERS[p];
    if (m === undefined) throw new Error(`unknown modifier "${p}" in "${combo}" (use Alt, Control, Meta, Shift or ControlOrMeta)`);
    modifiers |= m;
  }
  name = KEY_ALIASES[name] ?? name;
  let def = KEYS[name];
  if (!def) {
    if ([...name].length !== 1) throw new Error(`unknown key "${name}" (use a single character or one of ${Object.keys(KEYS).join(', ')})`);
    const ch = modifiers & 8 && /[a-z]/.test(name) ? name.toUpperCase() : name;
    const upper = ch.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : '';
    def = { key: ch, code, keyCode: /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0, text: ch };
  }
  // A shortcut (Control, Alt or Meta held) types nothing.
  const text = modifiers & 7 ? undefined : def.text;
  const commands = os === 'darwin' && modifiers === 4 ? MAC_COMMANDS[def.key.toLowerCase()] : undefined;
  const base = { modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
  return {
    down: { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands: [commands] } : {}) },
    up: { ...base, type: 'keyUp' },
  };
}

export interface TabHooks {
  /** The page's address changed (a navigation, or a single-page app moving on). */
  onNavigate?(url: string): void;
  onConsole?(entry: ConsoleEntry): void;
}

export class Tab {
  url = 'about:blank';
  viewport: Viewport;
  readonly console: ConsoleEntry[] = [];
  private seq = 0;
  private mainFrame = '';
  private loading = false;
  private loadWaiters: (() => void)[] = [];
  private closed = false;
  private readonly cdp: CdpSession;

  private constructor(
    private readonly provider: ProviderTab,
    viewport: Viewport,
    private readonly hooks: TabHooks,
  ) {
    this.cdp = provider.cdp;
    this.viewport = viewport;
  }

  static async open(provider: ProviderTab, viewport: Viewport, hooks: TabHooks = {}): Promise<Tab> {
    const tab = new Tab(provider, viewport, hooks);
    await tab.init();
    return tab;
  }

  private async init() {
    const c = this.cdp;
    c.on('Page.frameNavigated', (p: { frame: { id: string; parentId?: string; url: string; urlFragment?: string } }) => {
      if (p.frame.parentId) return;
      this.mainFrame = p.frame.id;
      this.setUrl(p.frame.url + (p.frame.urlFragment ?? ''));
    });
    c.on('Page.navigatedWithinDocument', (p: { frameId: string; url: string }) => {
      if (p.frameId === this.mainFrame) this.setUrl(p.url);
    });
    c.on('Page.frameStartedLoading', (p: { frameId: string }) => {
      if (p.frameId === this.mainFrame) this.loading = true;
    });
    c.on('Page.frameStoppedLoading', (p: { frameId: string }) => {
      if (p.frameId !== this.mainFrame) return;
      this.loading = false;
      for (const w of this.loadWaiters.splice(0)) w();
    });
    // Covered by DIALOG_SCRIPT; this answers what it cannot (beforeunload).
    c.on('Page.javascriptDialogOpening', (p: { type: string; message: string }) => {
      this.log('info', `[dialog] ${p.type}: ${p.message}`);
      void c.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    });
    c.on('Runtime.consoleAPICalled', (p: { type: string; args: { value?: unknown; description?: string; type: string }[] }) => {
      const text = p.args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type))).join(' ');
      // Electron's own note to app developers (unpackaged builds only), not the page's.
      if (text.startsWith('%cElectron Security Warning')) return;
      const level = p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : p.type === 'debug' ? 'debug' : p.type === 'info' ? 'info' : 'log';
      this.log(level, text);
    });
    c.on('Runtime.exceptionThrown', (p: { exceptionDetails: { text: string; exception?: { description?: string } } }) => {
      this.log('error', `Uncaught ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
    });
    c.on('Log.entryAdded', (p: { entry: { level: string; text: string; url?: string } }) => {
      const level = p.entry.level === 'error' ? 'error' : p.entry.level === 'warning' ? 'warning' : 'info';
      this.log(level, p.entry.url ? `${p.entry.text} (${p.entry.url})` : p.entry.text);
    });
    // A crashed page or a lost connection: this tab is done; the next use opens a fresh one.
    c.on('Inspector.targetCrashed', () => this.markClosed());
    c.on('Inspector.detached', () => this.markClosed());
    await Promise.all([c.send('Page.enable'), c.send('Runtime.enable'), c.send('Log.enable'), c.send('Inspector.enable').catch(() => undefined)]);
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SCRIPT });
    const tree = await c.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree');
    this.mainFrame = tree.frameTree.frame.id;
    this.url = tree.frameTree.frame.url;
    await this.setViewport(this.viewport);
  }

  private setUrl(url: string) {
    if (url === this.url) return;
    this.url = url;
    this.hooks.onNavigate?.(url);
  }

  log(level: ConsoleEntry['level'], text: string) {
    const entry = { seq: ++this.seq, level, text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text, ts: new Date().toISOString() };
    this.console.push(entry);
    if (this.console.length > CONSOLE_KEPT) this.console.splice(0, this.console.length - CONSOLE_KEPT);
    this.hooks.onConsole?.(entry);
  }

  get isClosed() {
    return this.closed;
  }

  private markClosed() {
    this.closed = true;
    for (const w of this.loadWaiters.splice(0)) w();
  }

  async title(): Promise<string> {
    return String((await this.evaluate('document.title').catch(() => '')) ?? '');
  }

  /** Go to an address and wait for the page to load. */
  async goto(url: string): Promise<void> {
    const res = await this.cdp.send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url });
    if (res.errorText) {
      const why = res.errorText === 'net::ERR_BLOCKED_BY_CLIENT' ? 'blocked: the address is not on this member’s sandbox network list' : res.errorText;
      throw new Error(`could not open ${url}: ${why}`);
    }
    if (res.loaderId) {
      this.loading = true;
      await this.waitLoaded();
    }
  }

  /** Back, forward or reload, then wait for the page. */
  async history(action: 'back' | 'forward' | 'reload'): Promise<boolean> {
    if (action === 'reload') {
      this.loading = true;
      await this.cdp.send('Page.reload', {});
      await this.waitLoaded();
      return true;
    }
    const h = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    const entry = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
    if (!entry) return false;
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    await this.settle();
    return true;
  }

  private waitLoaded(timeout = LOAD_TIMEOUT_MS): Promise<void> {
    if (!this.loading) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // A page that never finishes (a stream, a hung request) still gets used.
      const timer = setTimeout(() => {
        this.loadWaiters = this.loadWaiters.filter((w) => w !== done);
        resolve();
      }, timeout);
      this.loadWaiters.push(done);
    });
  }

  /** After an action: give a navigation it caused the chance to start, then wait for it. */
  async settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 150));
    await this.waitLoaded(10_000);
  }

  /** Run JavaScript in the page and return its (JSON) value. Throws what the page threw. */
  async evaluate(expression: string): Promise<unknown> {
    const res = await this.cdp.send<{ result: { value?: unknown; type: string; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.type === 'undefined' ? undefined : res.result.value;
  }

  call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.evaluate(pageCall(fn, ...args)) as Promise<T>;
  }

  snapshot(opts: { maxChars?: number; query?: string } = {}): Promise<Snapshot> {
    return this.call<Snapshot>('snapshot', opts);
  }

  async mouse(type: 'move' | 'down' | 'up', x: number, y: number, opts: { button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: number } = {}) {
    const button = opts.button ?? 'left';
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: type === 'move' ? 'mouseMoved' : type === 'down' ? 'mousePressed' : 'mouseReleased',
      x,
      y,
      button: type === 'move' ? 'none' : button,
      buttons: type === 'down' ? ({ left: 1, right: 2, middle: 4 } as const)[button] : 0,
      clickCount: type === 'move' ? 0 : (opts.clickCount ?? 1),
      modifiers: opts.modifiers ?? 0,
    });
  }

  async click(x: number, y: number, opts: { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}) {
    await this.mouse('move', x, y);
    const count = opts.clickCount ?? 1;
    for (let i = 1; i <= count; i++) {
      await this.mouse('down', x, y, { ...opts, clickCount: i });
      await this.mouse('up', x, y, { ...opts, clickCount: i });
    }
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  }

  /** Type text into whatever has focus, as one insertion (like pasting, but with input events). */
  async insertText(text: string) {
    await this.cdp.send('Input.insertText', { text });
  }

  async press(combo: string) {
    const { down, up } = keyEvents(combo);
    await this.cdp.send('Input.dispatchKeyEvent', down);
    await this.cdp.send('Input.dispatchKeyEvent', up);
  }

  async screenshot(quality = 80): Promise<Buffer> {
    const { data } = await this.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality });
    return Buffer.from(data, 'base64');
  }

  async setViewport(v: Viewport) {
    this.viewport = { width: Math.round(v.width), height: Math.round(v.height) };
    await this.provider.resize?.(this.viewport.width, this.viewport.height);
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: this.viewport.width < 600 });
  }

  /** Live JPEG frames of the page while someone watches. Returns a function that stops them. */
  frames(onFrame: (jpeg: Buffer) => void): () => void {
    if (this.provider.frames) return this.provider.frames(onFrame);
    const on = (p: { data: string; sessionId: number }) => {
      void this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
      onFrame(Buffer.from(p.data, 'base64'));
    };
    this.cdp.on('Page.screencastFrame', on);
    void this.cdp
      .send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 })
      .catch(() => undefined);
    return () => {
      this.cdp.off('Page.screencastFrame', on);
      if (!this.closed) void this.cdp.send('Page.stopScreencast').catch(() => undefined);
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.loadWaiters.splice(0)) w();
    await this.provider.close().catch(() => undefined);
  }
}
