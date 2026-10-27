// Spotting a member that drives a browser (Playwright, Puppeteer, headless
// Chromium…), so the app can show what it looks at.

const BROWSER_COMMAND = /\b(playwright|puppeteer|chromium|chrome|headless|webkit|firefox|selenium|cypress|browser)\b/i;
const BROWSER_TOOL = /browser|playwright|puppeteer|chrome/i;
const URL_RE = /\bhttps?:\/\/[^\s'"`<>)\]}]+/;

/** For a tool call that uses a browser: the page it goes to, when the call names one. */
export function browserActivity(tool: string, input: unknown): { url?: string } | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  let text: string;
  if (tool === 'Bash') {
    text = typeof i.command === 'string' ? i.command : '';
    if (!BROWSER_COMMAND.test(text)) return undefined;
  } else if (BROWSER_TOOL.test(tool)) {
    // MCP browser tools (mcp__playwright__browser_navigate {url}, …).
    text = typeof i.url === 'string' ? i.url : JSON.stringify(input ?? '');
  } else {
    return undefined;
  }
  const url = URL_RE.exec(text)?.[0]?.replace(/[.,;:]+$/, '');
  return url ? { url } : {};
}
