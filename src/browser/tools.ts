// The browser tools a member gets with `browser: true`: open pages, read them
// as numbered snapshots, click, type, take screenshots, read the console. They
// act on the member's live tab (hub.ts), which people can watch and take over
// in the app.
import type { CustomTool, ToolOutput } from '../runner/types.js';
import { cleanUrl, type BrowserHub, type LiveTab, type OpenOptions } from './hub.js';
import type { ScrollInfo } from './tab.js';

/** Snapshot text sent back after an action, at most. */
const AFTER_ACTION_CHARS = 6000;
/** Snapshot text browser_snapshot returns, at most. */
const SNAPSHOT_CHARS = 12_000;
const MAX_WAIT_S = 30;
/** Longest a browser action may take: a page that never answers does not hold the member's turn. */
const ACTION_TIMEOUT_MS = 90_000;

function timeLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the browser did not finish within ${ms / 1000} s (a page that never loads, or a script that never returns?)`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_select',
  'browser_scroll',
  'browser_navigate',
  'browser_screenshot',
  'browser_resize',
  'browser_wait',
  'browser_console',
  'browser_evaluate',
] as const;

export interface BrowserToolOptions extends OpenOptions {
  hub: BrowserHub;
  runId: string;
  agent: string;
  /** The member's turn; tools stop waiting for control when it ends. */
  signal?: AbortSignal;
}

/** One line on where the page is scrolled. */
function scrollLine(s: ScrollInfo): string {
  if (s.height <= s.vh + 2) return `The whole page fits the ${s.vw}×${s.vh} window.`;
  const below = Math.max(0, s.height - s.y - s.vh);
  return `Window ${s.vw}×${s.vh}, scrolled to y=${s.y} of a ${s.height}px page (${below}px more below).`;
}

async function pageReport(live: LiveTab, opts: { maxChars?: number; find?: string } = {}): Promise<string> {
  const tab = live.tab;
  const [title, snap] = await Promise.all([tab.title(), tab.snapshot({ maxChars: opts.maxChars ?? AFTER_ACTION_CHARS, query: opts.find })]);
  const lines = [`Page: ${title ? `${title} — ` : ''}${cleanUrl(tab.url)}`, scrollLine(snap.scroll)];
  if (opts.find) lines.push(`Lines with "${opts.find}" (${snap.total}):`);
  lines.push('', snap.text.trimEnd() || (opts.find ? '(none)' : '(the page shows no text or controls)'));
  if (snap.truncated) lines.push(`… ${snap.total - snap.shown} more lines. Use browser_snapshot with find, or scroll.`);
  const errors = tab.console.filter((e) => e.seq > live.consoleRead && e.level === 'error').length;
  if (errors) lines.push('', `${errors} new console error${errors > 1 ? 's' : ''}: see browser_console.`);
  return lines.join('\n');
}

const num = (v: unknown, name: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number`);
  return n;
};

export function browserTools(o: BrowserToolOptions): CustomTool[] {
  let tookOver = false;
  /** The member's tab, once any person who took control handed it back. */
  const act = async <T>(fn: (live: LiveTab) => Promise<T>): Promise<T> => {
    const live = await o.hub.open(o.runId, o.agent, o);
    if (live.control === 'human') {
      await live.whenMemberMayAct(o.signal);
      tookOver = true;
    }
    live.touch();
    try {
      return await timeLimit(fn(live), ACTION_TIMEOUT_MS);
    } finally {
      live.touch();
    }
  };
  /** A note when a person used the browser while the member waited. */
  const note = (text: string): string => {
    if (!tookOver) return text;
    tookOver = false;
    return `A person used this browser while you waited; the page may have changed.\n\n${text}`;
  };

  const clickRef = async (live: LiveTab, ref: number, clickCount = 1) => {
    const at = await live.tab.call<{ x: number; y: number; element: string; covered: string | null; error?: string }>('locate', ref);
    if (at.error) throw new Error(at.error);
    if (at.covered) throw new Error(`[${ref}] ${at.element} is covered by ${at.covered} (a dialog, banner or overlay?). Close that first, or click by x and y.`);
    await live.tab.click(at.x, at.y, { clickCount });
    return at.element;
  };

  const tools: CustomTool[] = [
    {
      name: 'browser_open',
      description:
        'Open a page in your browser and read it. Give a web address (http://localhost:5173, https://example.com) or a file in your working folder (index.html, dist/about.html): covibe serves the working folder over http, so links, styles and scripts load. People can watch this browser live in covibe. Returns a snapshot of the page (see browser_snapshot).',
      params: { url: { type: 'string', description: 'A web address, or a path in your working folder.' } },
      run: (args) =>
        act(async (live) => {
          const url = await live.resolve(String(args.url ?? ''));
          await live.tab.goto(url);
          return note(await pageReport(live));
        }),
    },
    {
      name: 'browser_snapshot',
      description:
        'Read the page in your browser as text: headings, text, and every element you can use, numbered like [12] button "Sign in" or [7] textbox "Email" value="". Use the numbers with browser_click, browser_type and browser_select. Cheaper than a screenshot; take a screenshot when the look matters.',
      params: { find: { type: 'string', optional: true, description: 'Only lines containing this text (case-insensitive).' } },
      run: (args) => act(async (live) => note(await pageReport(live, { maxChars: SNAPSHOT_CHARS, find: typeof args.find === 'string' && args.find ? args.find : undefined }))),
    },
    {
      name: 'browser_click',
      description: 'Click an element by its number from the snapshot (or a point by x and y in the window). Returns the page afterwards.',
      params: {
        ref: { type: 'number', optional: true, description: 'Element number from the snapshot.' },
        x: { type: 'number', optional: true, description: 'Window x in pixels (with y, instead of ref).' },
        y: { type: 'number', optional: true, description: 'Window y in pixels.' },
        double: { type: 'boolean', optional: true, description: 'Double-click.' },
      },
      run: (args) =>
        act(async (live) => {
          const count = args.double ? 2 : 1;
          let what: string;
          if (args.ref !== undefined && args.ref !== null) what = `[${args.ref}] ${await clickRef(live, num(args.ref, 'ref'), count)}`;
          else if (args.x !== undefined && args.y !== undefined) {
            const x = num(args.x, 'x');
            const y = num(args.y, 'y');
            await live.tab.click(x, y, { clickCount: count });
            what = `the point ${x},${y}`;
          } else throw new Error('give ref (a number from the snapshot), or x and y');
          await live.tab.settle();
          return note(`Clicked ${what}.\n\n${await pageReport(live)}`);
        }),
    },
    {
      name: 'browser_type',
      description: 'Type into a text field or editable area by its number from the snapshot. Replaces what is in it unless append is true; submit presses Enter afterwards.',
      params: {
        ref: { type: 'number', description: 'Element number from the snapshot.' },
        text: { type: 'string', description: 'The text to type.' },
        append: { type: 'boolean', optional: true, description: 'Add to the current text instead of replacing it.' },
        submit: { type: 'boolean', optional: true, description: 'Press Enter afterwards (submit a form or search).' },
      },
      run: (args) =>
        act(async (live) => {
          const ref = num(args.ref, 'ref');
          const text = String(args.text ?? '');
          const element = await clickRef(live, ref);
          if (!(await live.tab.call<boolean>('focused', ref))) throw new Error(`[${ref}] ${element} does not take typing.`);
          if (!args.append) {
            await live.tab.call('selectAll', ref);
            if (!text) await live.tab.press('Backspace');
          }
          if (text) await live.tab.insertText(text);
          if (args.submit) {
            await live.tab.press('Enter');
            await live.tab.settle();
            return note(`Typed into [${ref}] ${element} and pressed Enter.\n\n${await pageReport(live)}`);
          }
          const snap = await live.tab.snapshot({ query: `[${ref}] ` });
          return note(`Typed into [${ref}] ${element}. Now: ${snap.text.trim() || '(the field is gone)'}`);
        }),
    },
    {
      name: 'browser_press',
      description: 'Press a key or a combination in the page: Enter, Escape, Tab, ArrowDown, Backspace, Space, Control+A, Shift+Tab, ControlOrMeta+Z… It goes to whatever has focus.',
      params: { key: { type: 'string', description: 'Key or combination, e.g. "Enter" or "Shift+Tab".' } },
      run: (args) =>
        act(async (live) => {
          const key = String(args.key ?? '');
          await live.tab.press(key);
          await live.tab.settle();
          return note(`Pressed ${key}.\n\n${await pageReport(live)}`);
        }),
    },
    {
      name: 'browser_select',
      description: 'Choose an option in a drop-down (select) by its number from the snapshot. option: the option’s value or its text.',
      params: {
        ref: { type: 'number', description: 'Element number of the drop-down.' },
        option: { type: 'string', description: 'Value or visible text of the option.' },
      },
      run: (args) =>
        act(async (live) => {
          const ref = num(args.ref, 'ref');
          const res = await live.tab.call<{ selected?: string; error?: string }>('selectOption', ref, String(args.option ?? ''));
          if (res.error) throw new Error(res.error);
          await live.tab.settle();
          return note(`Selected "${res.selected}" in [${ref}].\n\n${await pageReport(live)}`);
        }),
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the page: by screens in a direction, or until an element (by number) is in view.',
      params: {
        direction: { type: 'string', optional: true, enum: ['down', 'up', 'left', 'right'], description: 'Which way (default down).' },
        screens: { type: 'number', optional: true, description: 'How far, in window heights (default 1).' },
        ref: { type: 'number', optional: true, description: 'Scroll this element into view instead.' },
      },
      run: (args) =>
        act(async (live) => {
          const tab = live.tab;
          if (args.ref !== undefined && args.ref !== null) {
            const at = await tab.call<{ error?: string; element: string }>('locate', num(args.ref, 'ref'));
            if (at.error) throw new Error(at.error);
          } else {
            const dir = String(args.direction ?? 'down');
            const amount = (args.screens === undefined ? 1 : num(args.screens, 'screens')) * 0.85;
            const { width, height } = tab.viewport;
            const dx = dir === 'right' ? width * amount : dir === 'left' ? -width * amount : 0;
            const dy = dir === 'down' ? height * amount : dir === 'up' ? -height * amount : 0;
            await tab.wheel(width / 2, height / 2, dx, dy);
            await new Promise((r) => setTimeout(r, 250));
          }
          const s = await tab.call<ScrollInfo>('scrollInfo');
          return note(scrollLine(s));
        }),
    },
    {
      name: 'browser_navigate',
      description: 'Go back, forward, or reload the page.',
      params: { action: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'back, forward or reload' } },
      run: (args) =>
        act(async (live) => {
          const action = String(args.action) as 'back' | 'forward' | 'reload';
          if (!['back', 'forward', 'reload'].includes(action)) throw new Error('action is back, forward or reload');
          if (!(await live.tab.history(action))) throw new Error(`there is no page to go ${action} to`);
          return note(await pageReport(live));
        }),
    },
    {
      name: 'browser_screenshot',
      description: 'See the visible part of the page as an image: layout, colors, spacing, what is cut off. Use browser_snapshot for text and element numbers.',
      params: {},
      run: () =>
        act(async (live): Promise<ToolOutput> => {
          const [jpeg, title] = await Promise.all([live.tab.screenshot(), live.tab.title()]);
          const s = await live.tab.call<ScrollInfo>('scrollInfo');
          return { text: note(`Screenshot of ${title ? `${title} — ` : ''}${cleanUrl(live.tab.url)}. ${scrollLine(s)}`), images: [{ data: jpeg.toString('base64'), mediaType: 'image/jpeg' }] };
        }),
    },
    {
      name: 'browser_resize',
      description: 'Resize the browser window to check a layout at another size, e.g. 390×844 for a phone, 768×1024 for a tablet, 1280×800 (the default) for a laptop.',
      params: {
        width: { type: 'number', description: 'Window width in pixels (240–3840).' },
        height: { type: 'number', description: 'Window height in pixels (240–2400).' },
      },
      run: (args) =>
        act(async (live) => {
          const width = Math.min(3840, Math.max(240, num(args.width, 'width')));
          const height = Math.min(2400, Math.max(240, num(args.height, 'height')));
          await live.tab.setViewport({ width, height });
          await new Promise((r) => setTimeout(r, 200));
          return note(`The window is ${width}×${height} now.\n\n${await pageReport(live)}`);
        }),
    },
    {
      name: 'browser_wait',
      description: 'Wait until text appears on the page (or disappears), or for a number of seconds (at most 30).',
      params: {
        text: { type: 'string', optional: true, description: 'Wait until the page shows this text.' },
        gone: { type: 'string', optional: true, description: 'Wait until this text is no longer on the page.' },
        seconds: { type: 'number', optional: true, description: 'How long to wait at most (default 10; alone, just wait this long).' },
      },
      run: (args) =>
        act(async (live) => {
          const limit = Math.min(MAX_WAIT_S, Math.max(0, args.seconds === undefined ? 10 : num(args.seconds, 'seconds'))) * 1000;
          const appear = typeof args.text === 'string' && args.text ? args.text : undefined;
          const gone = typeof args.gone === 'string' && args.gone ? args.gone : undefined;
          if (!appear && !gone) {
            await new Promise((r) => setTimeout(r, limit));
            return note(`Waited ${limit / 1000} s.\n\n${await pageReport(live)}`);
          }
          const end = Date.now() + limit;
          for (;;) {
            const text = String((await live.tab.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) ?? '');
            if ((!appear || text.includes(appear)) && (!gone || !text.includes(gone))) return note(`Done waiting.\n\n${await pageReport(live)}`);
            if (Date.now() > end) throw new Error(`waited ${limit / 1000} s, but ${appear ? `"${appear}" did not appear` : `"${gone}" is still there`}`);
            await new Promise((r) => setTimeout(r, 250));
          }
        }),
    },
    {
      name: 'browser_console',
      description: 'Read the page’s console: logs, warnings, errors, uncaught exceptions, failed requests and dialogs. Shows what is new since you last read it.',
      params: { all: { type: 'boolean', optional: true, description: 'Show everything kept, not only what is new.' } },
      run: (args) =>
        act(async (live) => {
          const entries = live.tab.console.filter((e) => args.all || e.seq > live.consoleRead);
          live.consoleRead = live.tab.console.at(-1)?.seq ?? live.consoleRead;
          if (!entries.length) return note(args.all ? 'The console is empty.' : 'Nothing new in the console.');
          return note(entries.map((e) => `${e.level === 'log' ? '' : `${e.level}: `}${e.text}`).join('\n'));
        }),
    },
    {
      name: 'browser_evaluate',
      description: 'Run JavaScript in the page and get its value back as JSON (awaits promises), e.g. document.querySelectorAll("img:not([alt])").length or getComputedStyle(document.body).fontFamily.',
      params: { expression: { type: 'string', description: 'A JavaScript expression.' } },
      run: (args) =>
        act(async (live) => {
          const value = await live.tab.evaluate(String(args.expression ?? ''));
          const out = value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
          return note(out.length > 8000 ? `${out.slice(0, 8000)}… [${out.length - 8000} more chars]` : out);
        }),
    },
  ];
  return tools;
}
