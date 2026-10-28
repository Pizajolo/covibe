// The browser inside the Mac app: Electron's own Chromium, so nothing needs
// installing. Each tab is an offscreen window (never shown; people watch it
// in the app) with a private in-memory session, driven over the Chrome
// DevTools Protocol through Electron's debugger. The Electron module is passed
// in by the app (desktop/main.mjs), so the engine never imports Electron.
import { randomBytes } from 'node:crypto';
import type * as ElectronModule from 'electron';
import type { BrowserProvider, CdpSession, ContextOptions, ProviderContext, ProviderTab } from './types.js';

export type ElectronApi = Pick<typeof ElectronModule, 'BrowserWindow' | 'session'>;

/** Frames a second while someone watches. */
const FRAME_RATE = 15;

export function electronProvider(electron: ElectronApi): BrowserProvider {
  const open = new Set<ElectronModule.BrowserWindow>();
  return {
    name: 'covibe’s built-in Chromium',
    async newContext(opts: ContextOptions): Promise<ProviderContext> {
      // No "persist:" prefix: the session lives in memory and is gone when closed.
      const partition = `covibe-browser-${randomBytes(8).toString('hex')}`;
      const ses = electron.session.fromPartition(partition, { cache: false });
      const allow = opts.allow;
      ses.webRequest.onBeforeRequest((details, callback) => {
        if (!allow || allow(details.url) || details.url.startsWith('devtools:')) return callback({});
        opts.onBlocked?.(details.url);
        callback({ cancel: true });
      });
      // Nobody is there to answer permission prompts or save downloads.
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.on('will-download', (_e, item) => item.cancel());
      const windows = new Set<ElectronModule.BrowserWindow>();
      return {
        async newTab({ width, height, onPopup }): Promise<ProviderTab> {
          const win = new electron.BrowserWindow({
            show: false,
            width,
            height,
            useContentSize: true,
            paintWhenInitiallyHidden: true,
            webPreferences: { offscreen: true, partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
          });
          windows.add(win);
          open.add(win);
          const wc = win.webContents;
          wc.setAudioMuted(true);
          wc.setWindowOpenHandler(({ url }) => {
            if (/^https?:/.test(url)) onPopup(url);
            return { action: 'deny' };
          });
          // Leaving a page with unsaved changes asks nobody.
          wc.on('will-prevent-unload', (e) => e.preventDefault());
          wc.debugger.attach('1.3');
          const handlers = new Map<string, Set<(params: any) => void>>();
          wc.debugger.on('message', (_e, method, params) => {
            for (const h of handlers.get(method) ?? []) h(params);
          });
          const cdp: CdpSession = {
            send: (method, params) => wc.debugger.sendCommand(method, params),
            on: (event, handler) => void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(handler),
            off: (event, handler) => void handlers.get(event)?.delete(handler),
          };
          await win.loadURL('about:blank');
          return {
            cdp,
            async resize(w, h) {
              if (!win.isDestroyed()) win.setContentSize(w, h);
            },
            // Offscreen windows paint into frames of their own; no screencast needed.
            frames(onFrame) {
              if (win.isDestroyed()) return () => {};
              const onPaint = (_e: unknown, _dirty: unknown, image: ElectronModule.NativeImage) => {
                if (!image.isEmpty()) onFrame(image.toJPEG(70));
              };
              wc.setFrameRate(FRAME_RATE);
              wc.on('paint', onPaint);
              wc.invalidate();
              return () => {
                if (!wc.isDestroyed()) wc.off('paint', onPaint);
              };
            },
            async close() {
              windows.delete(win);
              open.delete(win);
              if (win.isDestroyed()) return;
              try {
                wc.debugger.detach();
              } catch {
                // already detached
              }
              win.destroy();
            },
          };
        },
        async close() {
          for (const w of windows) if (!w.isDestroyed()) w.destroy();
          windows.clear();
          await ses.clearStorageData().catch(() => undefined);
          await ses.clearCache().catch(() => undefined);
        },
      };
    },
    async close() {
      for (const w of open) if (!w.isDestroyed()) w.destroy();
      open.clear();
    },
  };
}
