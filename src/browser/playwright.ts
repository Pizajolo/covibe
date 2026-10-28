// The browser when covibe runs outside the Mac app (the CLI, `covibe app`): a
// headless Chromium started through Playwright. Playwright's own Chromium is
// used when it is installed; otherwise Google Chrome or Microsoft Edge.
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { BrowserUnavailable, type BrowserProvider, type CdpSession, type ContextOptions, type ProviderContext, type ProviderTab } from './types.js';

export function playwrightProvider(): BrowserProvider {
  let browser: Promise<Browser> | undefined;
  const launch = (): Promise<Browser> => {
    browser ??= start().then((b) => {
      // A crashed or closed browser starts again on next use.
      b.on('disconnected', () => (browser = undefined));
      return b;
    });
    browser.catch(() => (browser = undefined));
    return browser;
  };

  return {
    name: 'Chromium (Playwright)',
    async newContext(opts: ContextOptions): Promise<ProviderContext> {
      const context = await (await launch()).newContext({ viewport: null, ignoreHTTPSErrors: true, acceptDownloads: false });
      if (opts.allow) await filter(context, opts);
      return {
        async newTab({ width, height, onPopup }) {
          const page = await context.newPage();
          await page.setViewportSize({ width, height });
          // New windows open in the same tab instead.
          page.on('popup', (popup) => {
            void (async () => {
              await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
              const url = popup.url();
              await popup.close().catch(() => undefined);
              if (url && url !== 'about:blank') onPopup(url);
            })();
          });
          return tabOf(context, page);
        },
        close: () => context.close().catch(() => undefined),
      };
    },
    async close() {
      const b = browser;
      browser = undefined;
      if (b) await (await b.catch(() => undefined))?.close().catch(() => undefined);
    },
  };
}

async function start(): Promise<Browser> {
  let pw: typeof import('playwright-core');
  try {
    pw = await import('playwright-core');
  } catch {
    throw new BrowserUnavailable('playwright-core is not installed; run npm install in covibe');
  }
  const executablePath = process.env.COVIBE_BROWSER || undefined;
  const attempts: { label: string; options: Parameters<typeof pw.chromium.launch>[0] }[] = executablePath
    ? [{ label: executablePath, options: { executablePath } }]
    : [
        { label: 'Playwright’s Chromium', options: {} },
        { label: 'Google Chrome', options: { channel: 'chrome' } },
        { label: 'Microsoft Edge', options: { channel: 'msedge' } },
      ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      return await pw.chromium.launch({ headless: true, ...a.options });
    } catch (err) {
      errors.push(`${a.label}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new BrowserUnavailable(
    `No browser to start. Install Google Chrome, or run "npx playwright install chromium", or set COVIBE_BROWSER to a Chromium-based browser. (${errors.join('; ')})`,
  );
}

/** Refuse requests the member's sandbox does not allow (web sockets too). */
async function filter(context: BrowserContext, opts: ContextOptions) {
  const allow = opts.allow!;
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (allow(url)) return route.fallback();
    opts.onBlocked?.(url);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, (ws) => {
    if (allow(ws.url())) ws.connectToServer();
    else {
      opts.onBlocked?.(ws.url());
      ws.close({ code: 1008, reason: 'blocked by the sandbox' });
    }
  });
}

async function tabOf(context: BrowserContext, page: Page): Promise<ProviderTab> {
  const session = await context.newCDPSession(page);
  const cdp: CdpSession = {
    send: (method, params) => session.send(method as never, params as never) as Promise<any>,
    on: (event, handler) => void session.on(event as never, handler as never),
    off: (event, handler) => void session.off(event as never, handler as never),
  };
  return {
    cdp,
    resize: (width, height) => page.setViewportSize({ width, height }),
    async close() {
      await session.detach().catch(() => undefined);
      await page.close().catch(() => undefined);
    },
  };
}
