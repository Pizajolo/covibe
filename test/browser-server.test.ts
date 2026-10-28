// A member with `browser: true` through the whole app: its tools, the run's
// events, and people watching and driving its tab through the API.
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { playwrightProvider } from '../src/browser/playwright.js';
import { loadTeam } from '../src/config/load.js';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { LiveBrowser, RunDetail } from '../src/server/api-types.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const probe = playwrightProvider();
const available = await probe
  .newContext({})
  .then(async (c) => (await c.close(), true))
  .catch(() => false)
  .finally(() => probe.close());

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('browser in the team file', () => {
  it('is off unless a member or the defaults turn it on', () => {
    const dir = tempDir();
    writeFiles(dir, {
      'team.yaml': `version: 1
name: web
defaults:
  browser: true
agents:
  dev: { prompt: "do\\nit", tools: [Read] }
  docs: { prompt: "do\\nit", tools: [Read], browser: false }
workflow:
  steps:
    - { id: a, agent: dev }
`,
      'plain.yaml': `version: 1
name: plain
agents:
  dev: { prompt: "do\\nit", tools: [Read] }
workflow:
  steps:
    - { id: a, agent: dev }
`,
      'bad.yaml': `version: 1
name: bad
agents:
  dev: { prompt: "do\\nit", tools: [Read], browser: "yes" }
workflow:
  steps:
    - { id: a, agent: dev }
`,
    });
    const team = loadTeam(`${dir}/team.yaml`);
    expect([team.agents.dev!.browser, team.agents.docs!.browser]).toEqual([true, false]);
    expect(loadTeam(`${dir}/plain.yaml`).agents.dev!.browser).toBe(false);
    expect(() => loadTeam(`${dir}/bad.yaml`)).toThrow(/browser/);
  });
});

describe.skipIf(!available)('live browser through the app', () => {
  it('opens a member’s page, records it, and lets a person watch, take control and drive it', async () => {
    const library = new Library(tempDir('covibe-home-'));
    let chats = 0;
    const runner = new ScriptedRunner({
      builder: (inv, n) => {
        // Its browser tools are there, and the prompt says so.
        expect(inv.customTools?.map((t) => t.name)).toContain('browser_open');
        expect(inv.systemPrompt).toContain('You have a browser');
        if (n === 0) {
          return {
            write: { 'index.html': '<!doctype html><title>Demo</title><h1>Hello</h1><a href="next.html">Next</a><input aria-label="Name">', 'next.html': '<!doctype html><title>Next</title><p>Second page</p>' },
            call: [{ tool: 'browser_open', args: { url: 'index.html' } }],
            text: 'Built and checked.',
          };
        }
        chats++;
        return { call: [{ tool: 'browser_snapshot', args: {} }], text: 'Looked again.' };
      },
      reviewer: (inv) => (inv.outputSchema ? { structured: { blocking_count: 0, findings: [] } } : { text: 'ok' }),
    });
    server = await startServer({ library, runner, token: 't' });
    const base = `http://127.0.0.1:${server.port}`;
    const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
      return json as T;
    };
    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const team = await api('POST', '/api/teams', { name: 'web', template: 'build-and-review' });
    await api('POST', `/api/teams/${team.id}/edit`, { ops: [{ op: 'set', path: ['agents', 'builder', 'browser'], value: true }] });
    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Make a page' });
    let detail: RunDetail;
    for (let i = 0; ; i++) {
      detail = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
      if (detail.summary.status !== 'running') break;
      if (i > 300) throw new Error('run did not finish');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(detail.summary.status).toBe('succeeded');
    expect(runner.toolResults[0]!.result).toMatch(/^Page: Demo — http:\/\/127\.0\.0\.1:\d+\/index\.html/);
    const types = detail.events.filter((e) => e.type.startsWith('browser.')).map((e) => [e.type, e.agent]);
    expect(types).toEqual([
      ['browser.opened', 'builder'],
      ['browser.page', 'builder'],
    ]);
    // The tab stays open after the run, so people can look at the result.
    const builder = detail.summary.agents.find((a) => a.name === 'builder')!;
    expect(builder.browser).toMatchObject({ live: true, control: 'member', url: expect.stringMatching(/index\.html$/) });
    expect(detail.browsers).toEqual([
      { agent: 'builder', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/), title: 'Demo', viewport: { width: 1280, height: 800 }, control: 'member', provider: 'Chromium (Playwright)' },
    ]);
    const b = `/api/runs/${project.id}/${runId}/browser/builder`;
    await expect(api('GET', `/api/runs/${project.id}/${runId}/browser/reviewer`)).rejects.toMatchObject({ status: 404 });

    // Watch it: a multipart stream of JPEG frames, starting with the current page.
    const firstFrame = await new Promise<Buffer>((resolve, reject) => {
      const req = request(`${base}${b}/live?token=t`, (res) => {
        expect(res.headers['content-type']).toBe('multipart/x-mixed-replace; boundary=covibeframe');
        let buf = Buffer.alloc(0);
        res.on('data', (c: Buffer) => {
          buf = Buffer.concat([buf, c]);
          // --covibeframe, headers, a blank line, the JPEG, then the next boundary.
          const start = buf.indexOf('\r\n\r\n');
          const end = start > 0 ? buf.indexOf('\r\n--covibeframe', start) : -1;
          if (end > 0) {
            req.destroy();
            resolve(buf.subarray(start + 4, end));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(firstFrame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // The member is not working, so people may drive it; navigating takes paths of its working folder too.
    expect(await api<LiveBrowser>('POST', `${b}/navigate`, { url: 'next.html' })).toMatchObject({ title: 'Next', url: expect.stringMatching(/next\.html$/) });
    expect(await api<LiveBrowser>('POST', `${b}/navigate`, { action: 'back' })).toMatchObject({ title: 'Demo' });
    await expect(api('POST', `${b}/navigate`, { url: 'file:///etc/passwd' })).rejects.toMatchObject({ status: 400 });
    await expect(api('POST', `${b}/input`, { type: 'jump' })).rejects.toMatchObject({ status: 400 });
    // Type into the page with the keyboard: Tab past the link into the field.
    await api('POST', `${b}/input`, { type: 'key', key: 'Tab' });
    await api('POST', `${b}/input`, { type: 'key', key: 'Tab' });
    await api('POST', `${b}/input`, { type: 'text', text: 'Ann' });

    // Take control: the member's next browser call waits until it is handed back.
    expect(await api<LiveBrowser>('POST', `${b}/control`, { by: 'human' })).toMatchObject({ control: 'human' });
    await api('POST', `/api/runs/${project.id}/${runId}/chat`, { agent: 'builder', message: 'look again' });
    await new Promise((r) => setTimeout(r, 400));
    expect(chats).toBe(1);
    expect(runner.toolResults).toHaveLength(1);
    await api('POST', `${b}/control`, { by: 'member' });
    for (let i = 0; runner.toolResults.length < 2; i++) {
      if (i > 100) throw new Error('the member never got the browser back');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runner.toolResults[1]!.result).toMatch(/^A person used this browser while you waited/);
    // What the person typed is on the page the member reads.
    expect(runner.toolResults[1]!.result).toMatch(/textbox "Name" value="Ann" focused/);
    const after = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
    expect(after.events.filter((e) => e.type === 'browser.control').map((e) => e.data.by)).toEqual(['human', 'member']);

    // Close it.
    await api('DELETE', b);
    const closed = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
    expect(closed.browsers).toEqual([]);
    expect(closed.summary.agents.find((a) => a.name === 'builder')!.browser?.live).toBeUndefined();
  });
});
