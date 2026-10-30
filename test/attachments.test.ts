// Files a person gives the team with a goal, a question or a chat message:
// kept with the run outside the project, readable by every member, and named
// in what members read.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachmentNote, attachmentsDir, kindOf, safeName } from '../src/engine/attachments.js';
import { runTeam } from '../src/engine/engine.js';
import { loadTeam } from '../src/config/load.js';
import { EventStore } from '../src/events/store.js';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { RunDetail } from '../src/server/api-types.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

let server: CovibeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('attachments', () => {
  it('names files safely, knows what they are, and tells members where they are', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('C:\\Users\\me\\logo.png')).toBe('logo.png');
    expect(safeName('.env')).toBe('env');
    expect(safeName('')).toBe('file');
    expect([kindOf('a.PNG'), kindOf('b.pdf'), kindOf('c.mov'), kindOf('d.docx'), kindOf('e.md'), kindOf('f.zip')]).toEqual(['image', 'pdf', 'video', 'document', 'text', 'file']);
    const note = attachmentNote([
      { name: 'logo.png', path: '/x/logo.png', size: 2048, kind: 'image' },
      { name: 'brief.docx', path: '/x/brief.docx', size: 3 << 20, kind: 'document' },
    ]);
    expect(note).toContain('The human attached 2 files with the goal:\n- /x/logo.png (image, 2 KB)\n- /x/brief.docx (office document, 3.0 MB)');
    expect(note).toContain('Read tool');
    expect(note).toContain('Office documents need a skill');
    expect(attachmentNote([])).toBe('');
  });

  it('go with a goal on the command line: copied next to the run, readable by every member', async () => {
    const repo = tempRepo();
    const outside = tempDir();
    writeFiles(outside, { 'mockup.png': 'png bytes' });
    const runner = new ScriptedRunner({ builder: () => ({ text: 'ok' }), reviewer: () => ({ structured: { blocking_count: 0, findings: [] } }) });
    const store = new EventStore(join(tempDir(), 'covibe.db'));
    const team = loadTeam(new URL('../examples/build-and-review/team.yaml', import.meta.url).pathname);
    const outcome = await runTeam({ team, repo, goal: 'Build the page in the mockup', store, runner, files: [join(outside, 'mockup.png')] });
    expect(outcome.status).toBe('succeeded');
    const dir = attachmentsDir(repo, outcome.runId);
    expect(readFileSync(join(dir, 'mockup.png'), 'utf8')).toBe('png bytes');
    for (const inv of runner.calls) {
      expect(inv.prompt).toContain(`# Goal\nBuild the page in the mockup\n\nThe human attached a file with the goal:\n- ${join(dir, 'mockup.png')} (image`);
      expect(inv.readDirs).toContain(dir);
    }
    // The run keeps the user's goal as they wrote it.
    expect(store.getRun(outcome.runId)!.goal).toBe('Build the page in the mockup');
    expect(store.events(outcome.runId).find((e) => e.type === 'run.started')!.data.attachments).toEqual([{ name: 'mockup.png', path: join(dir, 'mockup.png'), size: 9, kind: 'image' }]);
    await expect(runTeam({ team, repo, goal: 'x', store, runner, files: [join(outside, 'missing.png')] })).rejects.toThrow(/is not a file/);
    store.close();
  });

  it('go with goals, questions and chat messages through the app', async () => {
    const library = new Library(tempDir('covibe-home-'));
    const runner = new ScriptedRunner({
      builder: () => ({ text: 'Built it.' }),
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
    const upload = async (name: string, data: Buffer | string) => {
      const res = await fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: typeof data === 'string' ? data : new Uint8Array(data) });
      expect(res.ok).toBe(true);
      return (await res.json()) as { id: string; name: string; size: number; kind: string };
    };
    const finish = async (projectId: string, runId: string) => {
      for (let i = 0; ; i++) {
        const d = await api<RunDetail>('GET', `/api/runs/${projectId}/${runId}`);
        if (d.summary.status !== 'running') return d;
        if (i > 400) throw new Error('run did not finish');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const repo = tempRepo();
    const project = await api('POST', '/api/projects', { path: repo });
    const team = await api('POST', '/api/teams', { name: 'web', template: 'build-and-review' });

    const logo = await upload('logo.png', PNG);
    expect(logo).toMatchObject({ name: 'logo.png', size: PNG.length, kind: 'image' });
    const brief = await upload('../brief.pdf', '%PDF-1.4 brief');
    expect(brief.name).toBe('brief.pdf');

    // An unknown upload fails the goal before a run exists.
    await expect(api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'x', attachments: ['nope-nope'] })).rejects.toMatchObject({ status: 400 });
    await expect(api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'x', attachments: 'logo' })).rejects.toThrow(/list of upload ids/);
    expect(await api('GET', `/api/runs?project=${project.id}`)).toEqual([]);

    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Use our logo and the brief', attachments: [logo.id, brief.id] });
    const detail = await finish(project.id, runId);
    const dir = attachmentsDir(repo, runId);
    expect(detail.events.find((e) => e.type === 'run.started')!.data.attachments).toEqual([
      { name: 'logo.png', path: join(dir, 'logo.png'), size: PNG.length, kind: 'image' },
      { name: 'brief.pdf', path: join(dir, 'brief.pdf'), size: 14, kind: 'pdf' },
    ]);
    expect(runner.callsFor('builder')[0]!.prompt).toContain(`- ${join(dir, 'logo.png')} (image`);
    // They are not in the project, so nothing commits them.
    expect(existsSync(join(repo, 'logo.png'))).toBe(false);
    const files = await api<{ files: { path: string }[] }>('GET', `/api/runs/${project.id}/${runId}/files`);
    expect(files.files.map((f) => f.path)).not.toContain('logo.png');
    // An upload is used once.
    await expect(api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'again', attachments: [logo.id] })).rejects.toThrow(/no longer there/);

    // The app shows them.
    const shown = await fetch(`${base}/api/runs/${project.id}/${runId}/attachment?path=logo.png&token=t`);
    expect([shown.status, shown.headers.get('content-type')]).toEqual([200, 'image/png']);
    expect(Buffer.from(await shown.arrayBuffer())).toEqual(PNG);
    await expect(api('GET', `/api/runs/${project.id}/${runId}/attachment?path=../../x`)).rejects.toMatchObject({ status: 404 });

    // A chat message after the run, with a screenshot.
    const shot = await upload('screenshot.png', PNG);
    await api('POST', `/api/runs/${project.id}/${runId}/chat`, { agent: 'builder', message: 'The header looks like this now', attachments: [shot.id] });
    for (let i = 0; runner.callsFor('builder').length < 2; i++) {
      if (i > 200) throw new Error('no reply');
      await new Promise((r) => setTimeout(r, 25));
    }
    const reply = runner.callsFor('builder')[1]!;
    expect(reply.prompt).toMatch(/^The header looks like this now\n\nThe human attached a file with this message:\n- .*\/chat-\d+\/screenshot\.png \(image/);
    expect(reply.readDirs).toContain(dir);
    const after = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
    const mine = after.threads.builder!.find((i) => i.kind === 'human')!;
    expect(mine).toMatchObject({ text: 'The header looks like this now', attachments: [{ name: 'screenshot.png', kind: 'image' }] });
    expect(mine.attachments![0]!.path.startsWith(dir)).toBe(true);

    // A question with a file.
    const doc = await upload('notes.md', '# notes');
    const asked = await api('POST', '/api/ask', { project: project.id, team: team.id, agent: 'reviewer', question: 'Does the code match these notes?', attachments: [doc.id] });
    await finish(project.id, asked.runId);
    const question = runner.callsFor('reviewer').at(-1)!;
    expect(question.prompt).toContain(`- ${join(attachmentsDir(repo, asked.runId), 'notes.md')} (text`);
    expect(question.readDirs).toContain(attachmentsDir(repo, asked.runId));
  });
});
