// Feedback pinned on a run's result, sent as a new goal on it; files opened in
// their own app; media served so players can seek.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorText, cleanItem, feedbackGoal, timecode } from '../src/server/feedback.js';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import { diskSource, SiteServer } from '../src/server/site.js';
import type { FeedbackList, OpenedFile, RunDetail } from '../src/server/api-types.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles, type ScriptedTurn } from './helpers.js';

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('feedback comments', () => {
  it('keeps what a comment points at, and drops what does not belong', () => {
    const item = cleanItem({ target: 'file', path: 'final/teaser.mp4', kind: 'video', at: 12.44, until: 15, comment: '  Cut this shorter  ', region: { x: 2, y: 0 }, junk: true });
    expect(item).toMatchObject({ target: 'file', path: 'final/teaser.mp4', kind: 'video', at: 12.4, until: 15, comment: 'Cut this shorter' });
    expect(item).not.toHaveProperty('region');
    expect(item).not.toHaveProperty('junk');
    expect(item.id).toMatch(/^[0-9a-f]{12}$/);
    expect(() => cleanItem({ path: 'a.md', comment: ' ' })).toThrow(/needs text/);
    expect(() => cleanItem({ comment: 'x' })).toThrow(/file or page/);
    // An end before the start is no stretch.
    expect(cleanItem({ path: 'a.mp4', kind: 'video', at: 5, until: 2, comment: 'x' })).not.toHaveProperty('until');
  });

  it('writes a goal that says where each comment points', () => {
    expect(timecode(75.4)).toBe('1:15.4');
    expect(timecode(5)).toBe('0:05');
    const items = [
      cleanItem({ path: 'final/teaser.mp4', kind: 'video', at: 12.4, until: 15, comment: 'The cut is too abrupt' }),
      cleanItem({ path: 'assets/logo.png', kind: 'image', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 }, comment: 'Make the mark bigger' }),
      cleanItem({ target: 'app', path: '/pricing', kind: 'page', element: { selector: 'section.hero > h1', tag: 'h1', text: 'Simple pricing' }, comment: 'Say “per month”\nand show the yearly price' }),
      cleanItem({ path: 'docs/proposal.md', kind: 'text', quote: 'We will ship in Q3.', comment: 'Q4 now' }),
      cleanItem({ path: 'report.pdf', kind: 'pdf', page: 3, comment: 'Chart is unreadable' }),
    ];
    expect(anchorText(items[0]!)).toBe('final/teaser.mp4, from 0:12.4 to 0:15');
    expect(anchorText(items[1]!)).toBe('assets/logo.png, the area from 10% to 40% across and 20% to 45% down');
    const goal = feedbackGoal('Cut a teaser and build the pricing page', items, 'Overall: good start.');
    expect(goal.split('\n')[0]).toBe('Feedback on "Cut a teaser and build the pricing page" (5 comments)');
    expect(goal).toContain("The previous run's goal was: Cut a teaser and build the pricing page");
    expect(goal).toContain('Overall note from the human: Overall: good start.');
    expect(goal).toContain('1. On final/teaser.mp4, from 0:12.4 to 0:15:\n   The cut is too abrupt');
    expect(goal).toContain('3. On the running app, page /pricing, the element `section.hero > h1` ("Simple pricing"):\n   Say “per month”\n   and show the yearly price');
    expect(goal).toContain('4. On docs/proposal.md:\n   About this passage: "We will ship in Q3."\n   Q4 now');
    expect(goal).toContain('5. On report.pdf, page 3:');
  });
});

describe('feedback through the app', () => {
  it('collects comments on a run, sends them as a new goal on its result, and opens files in their app', async () => {
    const library = new Library(tempDir('covibe-home-'));
    const runner = new ScriptedRunner({
      builder: (_inv, n): ScriptedTurn => (n === 0 ? { write: { 'docs/plan.docx': 'PK fake word file', 'index.html': '<h1>Shop</h1>' }, text: 'done' } : { write: { 'index.html': '<h1>Shop, per month</h1>' }, text: 'fixed' }),
      reviewer: () => ({ structured: { blocking_count: 0, findings: [] } }),
    });
    server = await startServer({ library, runner, token: 't' });
    const base = `http://127.0.0.1:${server.port}`;
    const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
      return json as T;
    };
    const finish = async (runId: string) => {
      for (let i = 0; ; i++) {
        const d = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
        if (d.summary.status !== 'running') return d;
        if (i > 400) throw new Error('run did not finish');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const project = await api('POST', '/api/projects', { path: tempRepo() });
    const team = await api('POST', '/api/teams', { name: 'web', template: 'build-and-review' });
    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Build a shop page' });
    const first = await finish(runId);
    expect(first.summary.status).toBe('succeeded');
    const fb = `/api/runs/${project.id}/${runId}/feedback`;

    expect(await api<FeedbackList>('GET', fb)).toEqual({ items: [], sent: [] });
    await api('POST', fb, { target: 'app', path: '/', kind: 'page', element: { selector: 'h1', tag: 'h1', text: 'Shop' }, comment: 'Say per month' });
    let list = await api<FeedbackList>('POST', fb, { target: 'file', path: 'docs/plan.docx', kind: 'file', comment: 'Add a budget table' });
    expect(list.items.map((i) => i.comment)).toEqual(['Say per month', 'Add a budget table']);
    // Removing one keeps the rest.
    list = await api<FeedbackList>('PUT', fb, { items: list.items.slice(0, 1) });
    expect(list.items).toHaveLength(1);
    await api('POST', fb, { target: 'file', path: 'docs/plan.docx', kind: 'file', comment: 'Add a budget table' });

    // An office file comes out as a copy from the result branch, for its own app.
    const opened = await api<OpenedFile>('POST', `/api/runs/${project.id}/${runId}/open`, { path: 'docs/plan.docx' });
    expect(opened.copy).toBe(true);
    expect(readFileSync(opened.path, 'utf8')).toBe('PK fake word file');
    // A path cannot leave the run's files: this one is looked up inside them.
    await expect(api('POST', `/api/runs/${project.id}/${runId}/open`, { path: '../../tmp/x.pdf' })).rejects.toThrow(/there is no tmp\/x\.pdf in branch/);
    await expect(api('POST', `/api/runs/${project.id}/${runId}/open`, { path: 'nope.docx' })).rejects.toMatchObject({ status: 404 });
    // Programs and scripts are never opened: that would run them.
    for (const path of ['server.js', 'tools/run.command', 'bin/app']) {
      await expect(api('POST', `/api/runs/${project.id}/${runId}/open`, { path, launch: true })).rejects.toThrow(/opens documents, media and images/);
    }

    // Sending starts a new goal on the result, with every comment in it.
    const sent = await api<{ runId: string }>('POST', `${fb}/send`, { note: 'Nearly there' });
    const second = await finish(sent.runId);
    expect(second.summary.goal).toMatch(/^Feedback on "Build a shop page" \(2 comments\)\n\nThe human reviewed the result of the previous run/);
    expect(second.summary.goal).toContain('Overall note from the human: Nearly there');
    expect(second.summary.goal).toContain('1. On the running app, page /, the element `h1` ("Shop"):\n   Say per month');
    expect(second.summary.goal).toContain('2. On docs/plan.docx:\n   Add a budget table');
    // It builds on the first run's branch.
    expect(runner.callsFor('builder')[1]!.cwd).not.toBe(runner.callsFor('builder')[0]!.cwd);
    const files = await api<{ files: { path: string }[] }>('GET', `/api/runs/${project.id}/${sent.runId}/files`);
    expect(files.files.map((f) => f.path)).toContain('docs/plan.docx');
    // The comments are cleared, the old run says where they went.
    expect(await api<FeedbackList>('GET', fb)).toEqual({ items: [], sent: [{ runId: sent.runId, at: expect.any(String), count: 2 }] });
    const again = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
    expect(again.events.find((e) => e.type === 'feedback.sent')?.data).toEqual({ run_id: sent.runId, count: 2 });
    await expect(api('POST', `${fb}/send`, {})).rejects.toThrow(/no feedback/);
  });
});

describe('media in the preview', () => {
  it('answers byte ranges, so players can seek', async () => {
    const dir = tempDir();
    writeFiles(dir, { 'clip.mp4': '0123456789' });
    const site = await SiteServer.start(diskSource(dir));
    try {
      const enter = await fetch(site.url('/clip.mp4'), { redirect: 'manual' });
      const cookie = enter.headers.get('set-cookie')!.split(';')[0]!;
      const part = await fetch(`http://127.0.0.1:${site.port}/clip.mp4`, { headers: { cookie, range: 'bytes=2-5' } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(await part.text()).toBe('2345');
      const end = await fetch(`http://127.0.0.1:${site.port}/clip.mp4`, { headers: { cookie, range: 'bytes=-3' } });
      expect(await end.text()).toBe('789');
      const whole = await fetch(`http://127.0.0.1:${site.port}/clip.mp4`, { headers: { cookie } });
      expect([whole.status, whole.headers.get('accept-ranges'), whole.headers.get('content-type')]).toEqual([200, 'bytes', 'video/mp4']);
      expect((await fetch(`http://127.0.0.1:${site.port}/clip.mp4`, { headers: { cookie, range: 'bytes=20-' } })).status).toBe(416);
    } finally {
      await site.close();
    }
    expect(existsSync(dir)).toBe(true);
  });
});
