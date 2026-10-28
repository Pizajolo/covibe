// The live browser against a real headless Chromium. Skipped where none can be
// started (no Playwright Chromium, Chrome or Edge on the machine).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserHub, networkFilter, type TabChange } from '../src/browser/hub.js';
import { playwrightProvider } from '../src/browser/playwright.js';
import { keyEvents } from '../src/browser/tab.js';
import { browserTools, BROWSER_TOOL_NAMES } from '../src/browser/tools.js';
import { outputText, type CustomTool } from '../src/runner/types.js';
import { tempDir, writeFiles } from './helpers.js';

const probe = playwrightProvider();
const available = await probe
  .newContext({})
  .then(async (c) => (await c.close(), true))
  .catch(() => false)
  .finally(() => probe.close());

describe('key combinations', () => {
  it('turns combinations into CDP key events', () => {
    expect(keyEvents('Enter', 'linux').down).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 0 });
    expect(keyEvents('a', 'linux').down).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
    expect(keyEvents('Shift+a', 'linux').down).toMatchObject({ key: 'A', text: 'A', modifiers: 8 });
    expect(keyEvents('Control+A', 'linux').down).toMatchObject({ type: 'rawKeyDown', key: 'A', modifiers: 2 });
    expect(keyEvents('Control+A', 'linux').down.text).toBeUndefined();
    expect(keyEvents('ControlOrMeta+a', 'darwin').down).toMatchObject({ modifiers: 4, commands: ['selectAll'] });
    expect(keyEvents('ControlOrMeta+a', 'linux').down).toMatchObject({ modifiers: 2 });
    expect(keyEvents('Shift+Tab', 'linux').down).toMatchObject({ key: 'Tab', modifiers: 8 });
    expect(keyEvents('Esc', 'linux').down).toMatchObject({ key: 'Escape' });
    expect(keyEvents('Control++', 'linux').down).toMatchObject({ key: '+', modifiers: 2 });
    expect(() => keyEvents('Hyper+a')).toThrow(/unknown modifier/);
    expect(() => keyEvents('Banana')).toThrow(/unknown key/);
  });
});

describe('network filter', () => {
  it('lets everything out but local files when unrestricted', () => {
    const allow = networkFilter(undefined);
    expect(allow('https://example.com/a')).toBe(true);
    expect(allow('file:///etc/passwd')).toBe(false);
    expect(allow('chrome://settings')).toBe(false);
    expect(allow('data:text/html,hi')).toBe(true);
  });
  it('follows a sandbox list, always allowing local addresses', () => {
    const allow = networkFilter(['registry.npmjs.org', '*.example.com']);
    expect(allow('http://localhost:5173/')).toBe(true);
    expect(allow('http://127.0.0.1:4000/x')).toBe(true);
    expect(allow('http://[::1]:3000/')).toBe(true);
    expect(allow('http://app.localhost/')).toBe(true);
    expect(allow('https://registry.npmjs.org/x')).toBe(true);
    expect(allow('https://cdn.example.com/a.js')).toBe(true);
    expect(allow('https://example.com/')).toBe(true);
    expect(allow('wss://live.example.com/socket')).toBe(true);
    expect(allow('https://evil.test/')).toBe(false);
    expect(allow('https://notexample.com/')).toBe(false);
  });
});

describe.skipIf(!available)('live browser (Chromium)', () => {
  const hub = new BrowserHub(playwrightProvider);
  const root = tempDir('covibe-site-');
  writeFiles(root, {
    'index.html': `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Shop</title></head><body>
      <header><nav aria-label="Main"><a href="about.html">About us</a> <a href="/docs/">Docs</a></nav></header>
      <main>
        <h1>Welcome to the shop</h1>
        <p>Fresh <strong>bread</strong> every day.</p>
        <ul><li>Sourdough</li><li>Rye</li></ul>
        <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Ordered ' + document.getElementById('qty').value + ' for ' + document.getElementById('email').value">
          <label for="email">Email</label> <input id="email" type="email" placeholder="you@example.com">
          <label>Size <select id="size"><option value="s">Small</option><option value="l">Large</option></select></label>
          <label><input id="gift" type="checkbox"> Gift wrap</label>
          <input id="qty" value="1" aria-label="Quantity">
          <button>Order</button>
        </form>
        <p id="out"></p>
        <div id="fancy" style="cursor:pointer" onclick="this.textContent='Fancy clicked'">Fancy</div>
        <button id="confirm" onclick="this.textContent = confirm('Sure?') ? 'Confirmed' : 'Cancelled'">Delete</button>
        <button id="later" onclick="setTimeout(() => document.getElementById('out').textContent = 'Arrived late', 400)">Later</button>
        <a href="about.html" target="_blank">About in new tab</a>
        <div style="height:2000px"></div>
        <p>Bottom of page</p>
      </main>
      <script>console.log('page ready'); console.error('something broke');</script>
    </body></html>`,
    'about.html': '<!doctype html><title>About</title><h1>About us</h1><p>Since 1987.</p><a href="index.html">Home</a>',
    'docs/index.html': '<!doctype html><title>Docs</title><h2>Docs home</h2>',
  });
  const changes: TabChange[] = [];
  let tools: Record<string, CustomTool> = {};
  const call = async (name: string, args: Record<string, unknown> = {}) => outputText(await tools[name]!.run(args));

  beforeAll(() => {
    tools = Object.fromEntries(browserTools({ hub, runId: 'run-1', agent: 'tester', root, onChange: (c) => changes.push(c) }).map((t) => [t.name, t]));
  });
  afterAll(() => hub.shutdown());

  it('offers every browser tool', () => {
    expect(Object.keys(tools)).toEqual([...BROWSER_TOOL_NAMES]);
  });

  it('opens a file of the working folder and reads it as a numbered snapshot', async () => {
    const out = await call('browser_open', { url: 'index.html' });
    expect(out).toMatch(/^Page: Shop — http:\/\/127\.0\.0\.1:\d+\/index\.html\n/);
    expect(out).not.toContain('covibe_key');
    expect(out).toContain('— nav "Main"');
    expect(out).toContain('# Welcome to the shop');
    expect(out).toContain('Fresh bread every day.');
    expect(out).toContain('- Sourdough');
    expect(out).toMatch(/\[\d+\] link "About us" → \/about\.html/);
    expect(out).toMatch(/\[\d+\] textbox "Email" value="" placeholder="you@example.com" type=email/);
    expect(out).toMatch(/\[\d+\] combobox "Size" value="Small" options: Small \| Large/);
    expect(out).not.toMatch(/^Email$/m);
    expect(out).toMatch(/\[\d+\] checkbox "Gift wrap" unchecked/);
    expect(out).toMatch(/\[\d+\] clickable "Fancy"/);
    expect(out).toMatch(/1 new console error: see browser_console/);
    expect(changes[0]).toEqual({ kind: 'opened', provider: 'Chromium (Playwright)' });
    expect(changes).toContainEqual({ kind: 'page', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/) });
  });

  const refOf = async (pattern: RegExp) => {
    const snap = await call('browser_snapshot');
    const line = snap.split('\n').find((l) => pattern.test(l));
    if (!line) throw new Error(`no line matching ${pattern} in:\n${snap}`);
    return Number(/^\[(\d+)\]/.exec(line)![1]);
  };

  it('types, selects, checks and submits a form', async () => {
    const email = await refOf(/textbox "Email"/);
    expect(await call('browser_type', { ref: email, text: 'ann@example.com' })).toMatch(/Now: \[\d+\] textbox "Email" value="ann@example.com"/);
    const qty = await refOf(/textbox "Quantity"/);
    await call('browser_type', { ref: qty, text: '3' });
    expect(await call('browser_select', { ref: await refOf(/combobox/), option: 'Large' })).toMatch(/Selected "Large"/);
    expect(await call('browser_click', { ref: await refOf(/checkbox "Gift wrap"/) })).toMatch(/checkbox "Gift wrap" checked/);
    const after = await call('browser_type', { ref: qty, text: '4', submit: true });
    expect(after).toContain('Ordered 4 for ann@example.com');
    // Find a single line.
    expect(await call('browser_snapshot', { find: 'gift' })).toMatch(/Lines with "gift" \(1\):\n\n\[\d+\] checkbox "Gift wrap" checked/);
  });

  it('clicks script-made controls, answers dialogs and reads the console', async () => {
    expect(await call('browser_click', { ref: await refOf(/clickable "Fancy"/) })).toContain('Fancy clicked');
    expect(await call('browser_click', { ref: await refOf(/button "Delete"/) })).toContain('Confirmed');
    const log = await call('browser_console');
    expect(log).toContain('page ready');
    expect(log).toContain('error: something broke');
    expect(log).toContain('[dialog] confirm (answered OK): Sure?');
    expect(await call('browser_console')).toBe('Nothing new in the console.');
    await call('browser_click', { ref: await refOf(/button "Later"/) });
    expect(await call('browser_wait', { text: 'Arrived late', seconds: 5 })).toContain('Done waiting.');
    await expect(call('browser_wait', { text: 'Never', seconds: 0.3 })).rejects.toThrow(/did not appear/);
  });

  it('follows links (new-tab ones in the same tab), goes back and scrolls', async () => {
    expect(await call('browser_click', { ref: await refOf(/link "About us"/) })).toMatch(/^Clicked .*\n\nPage: About — .*\/about\.html/);
    expect(await call('browser_navigate', { action: 'back' })).toMatch(/^Page: Shop/);
    await call('browser_click', { ref: await refOf(/link "About in new tab"/) });
    await new Promise((r) => setTimeout(r, 500));
    expect(await call('browser_snapshot')).toMatch(/^Page: About/);
    await call('browser_open', { url: 'docs' });
    expect(await call('browser_snapshot')).toMatch(/^Page: Docs — .*\/docs\/\n/);
    await call('browser_open', { url: 'index.html' });
    expect(await call('browser_scroll', { direction: 'down', screens: 2 })).toMatch(/scrolled to y=1[0-9]{3} of a/);
    expect(await call('browser_evaluate', { expression: 'Math.round(scrollY) > 1000' })).toBe('true');
  });

  it('takes screenshots and resizes the window', async () => {
    const shot = await tools.browser_screenshot!.run({});
    expect(typeof shot).toBe('object');
    const { images } = shot as { images: { data: string; mediaType: string }[] };
    expect(images[0]!.mediaType).toBe('image/jpeg');
    expect(Buffer.from(images[0]!.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(await call('browser_resize', { width: 390, height: 844 })).toContain('The window is 390×844 now.');
    expect(await call('browser_evaluate', { expression: 'innerWidth' })).toBe('390');
  });

  it('refuses addresses it should not open', async () => {
    await expect(call('browser_open', { url: 'file:///etc/passwd' })).rejects.toThrow(/outside the working folder/);
    await expect(call('browser_open', { url: 'javascript:alert(1)' })).rejects.toThrow(/cannot be opened/);
    await expect(call('browser_open', { url: 'nothing-here' })).rejects.toThrow(/neither an address nor a file/);
    await expect(call('browser_click', { ref: 99999 })).rejects.toThrow(/not on the page any more/);
  });

  it('streams frames to watchers and lets a person take control while the member waits', async () => {
    const live = (await hub.get('run-1', 'tester'))!;
    const frames: Buffer[] = [];
    const stop = live.watch((f) => frames.push(f));
    await call('browser_open', { url: 'about.html' });
    await new Promise((r) => setTimeout(r, 500));
    stop();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    live.setControl('human');
    let done = false;
    const waiting = call('browser_snapshot').then((s) => ((done = true), s));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    live.setControl('member');
    expect(await waiting).toMatch(/^A person used this browser while you waited/);
    expect(changes).toContainEqual({ kind: 'control', by: 'human' });
    expect(changes).toContainEqual({ kind: 'control', by: 'member' });
  });

  it('keeps a member inside its sandbox network list', async () => {
    const sandboxed = Object.fromEntries(browserTools({ hub, runId: 'run-1', agent: 'locked', root, network: ['example.invalid'] }).map((t) => [t.name, t]));
    await expect(sandboxed.browser_open!.run({ url: 'http://blocked.test/' })).rejects.toThrow(/sandbox network list/);
    // Its own working folder is local, so it opens.
    expect(outputText(await sandboxed.browser_open!.run({ url: 'about.html' }))).toMatch(/^Page: About/);
  });

  it('never opens a local file from a page, even as a new window', async () => {
    writeFiles(root, { 'popup.html': `<!doctype html><title>Popup</title><button onclick="window.open('file:///etc/passwd')">Open file</button>` });
    await call('browser_open', { url: 'popup.html' });
    await call('browser_click', { ref: await refOf(/button "Open file"/) });
    await new Promise((r) => setTimeout(r, 500));
    expect(await call('browser_snapshot')).toMatch(/^Page: Popup — http:/);
  });

  it('opens a fresh tab after the page crashes', async () => {
    const live = (await hub.get('run-1', 'tester'))!;
    // A crashed page never answers this command; don't wait for it.
    void (live.tab as unknown as { cdp: { send(m: string): Promise<unknown> } }).cdp.send('Page.crash').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    expect(live.tab.isClosed).toBe(true);
    expect(await call('browser_open', { url: 'about.html' })).toMatch(/^Page: About/);
    expect(await hub.get('run-1', 'tester')).not.toBe(live);
  });

  it('closes tabs nobody used for a while', async () => {
    await hub.closeIdle(Date.now() + 60 * 60_000);
    expect(await hub.list('run-1')).toEqual([]);
    expect(changes.at(-1)).toEqual({ kind: 'closed', reason: 'idle' });
  });
});
