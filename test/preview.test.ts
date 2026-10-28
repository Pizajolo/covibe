import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Library } from '../src/server/library.js';
import { startServer, type CovibeServer } from '../src/server/app.js';
import type { RunDetail, RunFiles } from '../src/server/api-types.js';
import { diskSource, gitSource, injectHtml, PREVIEW_BRIDGE, relPath, SiteServer } from '../src/server/site.js';
import { ScriptedRunner, tempDir, tempRepo, writeFiles } from './helpers.js';

const sites: SiteServer[] = [];
let server: CovibeServer | undefined;
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  await server?.close();
  server = undefined;
});

/** Open a site like a browser would: trade the key for the cookie, then fetch with it. */
async function browse(site: SiteServer) {
  const first = await fetch(site.url('/'), { redirect: 'manual' });
  expect(first.status).toBe(302);
  const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
  return (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${site.port}${path}`, { ...init, redirect: 'manual', headers: { cookie, ...(init.headers ?? {}) } });
}

const commitAll = (dir: string, branch: string) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('checkout', '-q', '-b', branch);
  git('add', '-A');
  git('commit', '-q', '-m', 'site');
  git('checkout', '-q', 'main');
};

describe('site server', () => {
  it('cleans request paths and refuses ones that leave the root', () => {
    expect(relPath('/a/b.html')).toBe('a/b.html');
    expect(relPath('/a/./c/../b.html')).toBe('a/b.html');
    expect(relPath('/')).toBe('');
    expect(relPath('/docs/')).toBe('docs');
    expect(relPath('/%2e%2e/secret')).toBe('secret');
    expect(relPath('/a\\..\\b')).toBeUndefined();
    expect(relPath('/a%00b')).toBeUndefined();
  });

  it('adds the bridge right after <head>', () => {
    expect(injectHtml('<!doctype html><html><head><title>x</title></head></html>', '<s>')).toBe('<!doctype html><html><head><s><title>x</title></head></html>');
    expect(injectHtml('<!DOCTYPE html><p>hi', '<s>')).toBe('<!DOCTYPE html><s><p>hi');
    expect(injectHtml('<p>hi', '<s>')).toBe('<s><p>hi');
  });

  it('serves a branch as a website behind a key, with folders, single-page routes and 404s', async () => {
    const repo = tempRepo();
    writeFiles(repo, {
      'index.html': '<!doctype html><html><head><title>Home</title></head><body><a href="/about/">About</a></body></html>',
      'about/index.html': '<html><head></head><body>About us</body></html>',
      'styles/site.css': 'body { color: red }',
      'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    commitAll(repo, 'covibe/site');
    const site = await SiteServer.start(gitSource(repo, 'covibe/site'), { inject: PREVIEW_BRIDGE });
    sites.push(site);

    // Without the key or its cookie: nothing.
    expect((await fetch(`http://127.0.0.1:${site.port}/`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${site.port}/?covibe_key=wrong`)).status).toBe(403);
    const hostStatus = await new Promise<number>((resolve, reject) =>
      request(`http://127.0.0.1:${site.port}/`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
        .on('error', reject)
        .end(),
    );
    expect(hostStatus).toBe(403);

    const first = await fetch(site.url('/about/'), { redirect: 'manual' });
    expect(first.headers.get('location')).toBe('/about/');
    expect(first.headers.get('set-cookie')).toMatch(new RegExp(`^covibe_site_${site.port}=${site.key}; Path=/; HttpOnly; SameSite=Strict`));

    const get = await browse(site);
    const home = await get('/');
    expect(home.headers.get('content-type')).toMatch(/text\/html/);
    const body = await home.text();
    expect(body).toContain('<head>' + PREVIEW_BRIDGE + '<title>Home</title>');
    expect(await (await get('/styles/site.css')).text()).toBe('body { color: red }');
    expect((await get('/styles/site.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect((await get('/img/logo.svg')).headers.get('content-type')).toBe('image/svg+xml');
    // A folder without its trailing slash moves to it, so relative links work.
    const about = await get('/about');
    expect([about.status, about.headers.get('location')]).toEqual([301, '/about/']);
    expect(await (await get('/about/')).text()).toContain('About us');
    // A client-side route falls back to the index page; a missing asset does not.
    const route = await get('/pricing', { headers: { accept: 'text/html' } });
    expect([route.status, (await route.text()).includes('<title>Home</title>')]).toEqual([200, true]);
    expect((await get('/missing.js')).status).toBe(404);
    expect((await get('/.git/config')).status).toBe(404);
    expect((await get('/', { method: 'POST' })).status).toBe(405);
  });

  it('follows new commits on the branch', async () => {
    const repo = tempRepo();
    writeFiles(repo, { 'index.html': 'one' });
    commitAll(repo, 'covibe/live');
    const site = await SiteServer.start(gitSource(repo, 'covibe/live'));
    sites.push(site);
    const get = await browse(site);
    expect(await (await get('/')).text()).toBe('one');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('checkout', '-q', 'covibe/live');
    writeFiles(repo, { 'index.html': 'two' });
    git('commit', '-q', '-am', 'two');
    git('checkout', '-q', 'main');
    expect(await (await get('/')).text()).toBe('two');
  });

  it('serves a folder on disk without leaving it', async () => {
    const outside = tempDir();
    writeFiles(outside, { 'secret.txt': 'keep out' });
    const root = tempDir();
    writeFiles(root, { 'index.html': 'hello', 'docs/a.md': '# A' });
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    const site = await SiteServer.start(diskSource(root));
    sites.push(site);
    const get = await browse(site);
    expect(await (await get('/')).text()).toBe('hello');
    expect((await get('/docs/a.md')).headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect((await get('/leak.txt')).status).toBe(404);
    expect((await get('/..%2f..%2fetc/passwd')).status).toBe(404);
    // A folder without index.html lists what is in it.
    expect(await (await get('/docs/')).text()).toContain('a.md');
  });
});

describe('run files', () => {
  it('lists a run’s files with what changed, reads them, and serves them as a site', async () => {
    const library = new Library(tempDir('covibe-home-'));
    const runner = new ScriptedRunner({
      builder: () => ({ write: { 'site/index.html': '<html><head></head><body>New site</body></html>', 'site/logo.png': '\0PNG' }, text: 'Built.' }),
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
    const team = await api('POST', '/api/teams', { name: 'duo', template: 'build-and-review' });
    const { runId } = await api('POST', '/api/runs', { project: project.id, team: team.id, goal: 'Make a site' });
    for (let i = 0; ; i++) {
      const d = await api<RunDetail>('GET', `/api/runs/${project.id}/${runId}`);
      if (d.summary.status !== 'running') break;
      if (i > 200) throw new Error('run did not finish');
      await new Promise((r) => setTimeout(r, 50));
    }

    const files = await api<RunFiles>('GET', `/api/runs/${project.id}/${runId}/files`);
    expect(files.source).toEqual({ kind: 'branch', ref: expect.stringMatching(/^covibe\//) });
    expect(files.files).toEqual([
      { path: 'README.md', size: 6, changed: false },
      { path: 'site/index.html', size: 47, changed: true },
      { path: 'site/logo.png', size: 4, changed: true },
    ]);

    expect(await api('GET', `/api/runs/${project.id}/${runId}/file?path=site/index.html`)).toMatchObject({ binary: false, content: expect.stringContaining('New site') });
    expect(await api('GET', `/api/runs/${project.id}/${runId}/file?path=site/logo.png`)).toEqual({ path: 'site/logo.png', size: 4, binary: true });
    await expect(api('GET', `/api/runs/${project.id}/${runId}/file?path=nope.txt`)).rejects.toMatchObject({ status: 404 });
    await expect(api('GET', `/api/runs/${project.id}/${runId}/file?path=../../etc/passwd`)).rejects.toMatchObject({ status: 404 });

    const preview = await api('POST', `/api/runs/${project.id}/${runId}/preview`);
    expect(preview).toMatchObject({ port: expect.any(Number), key: expect.any(String), label: expect.stringMatching(/^branch covibe\//) });
    // The same run keeps its site.
    expect((await api('POST', `/api/runs/${project.id}/${runId}/preview`)).port).toBe(preview.port);
    const first = await fetch(`http://127.0.0.1:${preview.port}/site/?covibe_key=${preview.key}`, { redirect: 'manual' });
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
    const page = await fetch(`http://127.0.0.1:${preview.port}/site/`, { headers: { cookie } });
    expect(await page.text()).toContain('New site');
  });
});
