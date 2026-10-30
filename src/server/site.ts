// Serving a run's files as a website, so people (and members' browsers) can
// click through what the team built. Each site gets its own local port: its
// own origin, so the site's scripts cannot reach the app or its token, and
// root-relative links (/styles.css) work. A random key, traded for a cookie on
// the first request, keeps other programs and web pages out.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, posix, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const SITE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

/** Folders never served or listed. */
const HIDDEN = new Set(['.git', '.covibe']);

export interface SiteFile {
  path: string;
  size: number;
}

/** Where a site's files come from: a git ref, or a folder on disk. */
export interface SiteSource {
  /** What it serves, for people: "branch covibe/…", "your checkout", a folder. */
  readonly label: string;
  /** A file's contents; undefined when there is no such file. */
  read(path: string): Promise<Buffer | undefined>;
  isDir(path: string): Promise<boolean>;
  list(): Promise<SiteFile[]>;
}

const hidden = (path: string) => path.split('/').some((p) => HIDDEN.has(p));

/** Clean a request path into a relative one ("a/b.html"); undefined when it tries to leave the root. */
export function relPath(path: string): string | undefined {
  let p: string;
  try {
    p = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (p.includes('\0') || p.includes('\\')) return undefined;
  const n = posix.normalize(`/${p}`);
  if (n.split('/').includes('..')) return undefined;
  return n.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** The files of a commit, read with git (a run's result branch). The ref is resolved on every read, so the site follows new merges. */
export function gitSource(repo: string, ref: string): SiteSource {
  let cached: { sha: string; files: Map<string, number>; dirs: Set<string> } | undefined;
  const tree = async () => {
    const sha = (await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo })).stdout.trim();
    if (cached?.sha === sha) return cached;
    const out = (await exec('git', ['ls-tree', '-r', '-l', '-z', sha], { cwd: repo, maxBuffer: 64 << 20 })).stdout;
    const files = new Map<string, number>();
    const dirs = new Set<string>(['']);
    for (const row of out.split('\0')) {
      // <mode> SP <type> SP <object> SP+ <size> TAB <path>
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const [, type, , size] = row.slice(0, tab).split(/ +/);
      const path = row.slice(tab + 1);
      if (type !== 'blob' || hidden(path)) continue;
      files.set(path, Number(size) || 0);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    cached = { sha, files, dirs };
    return cached;
  };
  return {
    label: `branch ${ref}`,
    async read(path) {
      const t = await tree();
      if (!t.files.has(path)) return undefined;
      const { stdout } = await exec('git', ['cat-file', 'blob', `${t.sha}:${path}`], { cwd: repo, encoding: 'buffer', maxBuffer: 256 << 20 });
      return stdout;
    },
    async isDir(path) {
      return (await tree()).dirs.has(path);
    },
    async list() {
      return [...(await tree()).files].map(([path, size]) => ({ path, size }));
    },
  };
}

/**
 * The files in a folder on disk (a checkout, a member's worktree). Symlinks
 * that lead outside the folder are not followed. Listing uses git when the
 * folder is a repository, so ignored files (node_modules, builds) stay out.
 */
export function diskSource(root: string, label = root): SiteSource {
  const base = realpathSync(resolve(root));
  const locate = (path: string): string | undefined => {
    if (hidden(path)) return undefined;
    const full = resolve(base, path);
    if (full !== base && !full.startsWith(base + sep)) return undefined;
    try {
      const real = realpathSync(full);
      return real === base || real.startsWith(base + sep) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    label,
    async read(path) {
      const full = locate(path);
      if (!full || !statSync(full).isFile()) return undefined;
      return readFileSync(full);
    },
    async isDir(path) {
      const full = locate(path);
      return !!full && statSync(full).isDirectory();
    },
    async list() {
      const out = await exec('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: base, maxBuffer: 64 << 20 }).then(
        (r) => r.stdout.split('\0').filter(Boolean),
        () => walk(base),
      );
      const files: SiteFile[] = [];
      for (const path of out) {
        const full = locate(path);
        if (!full) continue;
        try {
          const s = statSync(full);
          if (s.isFile()) files.push({ path, size: s.size });
        } catch {
          // deleted since git listed it
        }
      }
      return files;
    },
  };
}

/** Relative paths of the files under a folder that is not a repository (no node_modules; at most `max`). */
function walk(root: string, max = 10_000): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (HIDDEN.has(e.name) || e.name === 'node_modules') continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path);
      else if (e.isFile()) out.push(path);
    }
  };
  visit('');
  return out;
}

/**
 * Added to HTML pages shown inside the app: tells the app which page is open
 * (so its address bar and file list follow your clicks), takes back, forward
 * and reload from it, and keeps the site's own new-tab links in the preview.
 */
export const PREVIEW_BRIDGE = `<script data-covibe-preview>(()=>{const p=window.parent;if(!p||p===window)return;const post=()=>p.postMessage({covibePreview:{path:location.pathname+location.search+location.hash,title:document.title}},'*');addEventListener('DOMContentLoaded',post);addEventListener('load',post);addEventListener('hashchange',post);addEventListener('popstate',post);for(const k of['pushState','replaceState']){const f=history[k];history[k]=function(...a){const r=f.apply(this,a);post();return r}}addEventListener('message',e=>{if(e.source!==p)return;const c=e.data&&e.data.covibe;if(c==='back')history.back();else if(c==='forward')history.forward();else if(c==='reload')location.reload()});addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[target]');if(a&&a.target!=='_self'&&a.origin===location.origin){e.preventDefault();location.href=a.href}},true)})()</script>`;

/**
 * Runs in a page shown inside the app: on {covibe: 'pick'} it highlights the
 * element under the pointer and, on a click, tells the app which one it was
 * (a selector, its text, where it is), so a person can leave feedback on it.
 * Escape or {covibe: 'unpick'} ends it.
 */
function pickElements() {
  const parent = window.parent;
  if (!parent || parent === window) return;
  let box: HTMLDivElement | undefined;
  let picking = false;
  const cssEscape = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let at: Element | null = el;
    while (at && at.nodeType === 1 && parts.length < 6) {
      if (at.id) {
        parts.unshift(`#${cssEscape(at.id)}`);
        break;
      }
      let part = at.tagName.toLowerCase();
      const cls = [...at.classList].filter((c) => /^[a-zA-Z][\w-]{0,30}$/.test(c)).slice(0, 2);
      if (cls.length) part += cls.map((c) => `.${cssEscape(c)}`).join('');
      const p: Element | null = at.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === at!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(at) + 1})`;
      }
      parts.unshift(part);
      if (at.tagName === 'BODY') break;
      at = p;
    }
    return parts.join(' > ');
  };
  const show = (el: Element | null) => {
    if (!box) return;
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const stop = () => {
    picking = false;
    box?.remove();
    box = undefined;
    document.documentElement.style.cursor = '';
  };
  const target = (e: Event) => (e.target instanceof Element && e.target !== box ? e.target : null);
  addEventListener('mousemove', (e) => picking && show(target(e)), true);
  addEventListener(
    'click',
    (e) => {
      if (!picking) return;
      e.preventDefault();
      e.stopPropagation();
      const el = target(e);
      stop();
      if (!el) return;
      const r = el.getBoundingClientRect();
      const text = ((el as HTMLElement).innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      parent.postMessage(
        {
          covibePick: {
            selector: selectorOf(el),
            tag: el.tagName.toLowerCase(),
            text,
            path: location.pathname + location.search + location.hash,
            title: document.title,
            rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY: Math.round(scrollY) },
          },
        },
        '*',
      );
    },
    true,
  );
  addEventListener(
    'keydown',
    (e) => {
      if (picking && e.key === 'Escape') {
        stop();
        parent.postMessage({ covibePick: null }, '*');
      }
    },
    true,
  );
  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const c = e.data && (e.data as { covibe?: unknown }).covibe;
    if (c === 'unpick') stop();
    if (c !== 'pick' || picking) return;
    picking = true;
    box = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', border: '2px solid #ff6a3d', background: 'rgba(255,106,61,.12)', borderRadius: '3px', display: 'none' });
    document.documentElement.appendChild(box);
    document.documentElement.style.cursor = 'crosshair';
  });
}

/** PREVIEW_BRIDGE plus element picking for feedback (see pickElements). */
// `__name`: what esbuild (tsx, vitest) adds to functions it keeps the names of; tsc adds nothing.
export const FEEDBACK_BRIDGE = `${PREVIEW_BRIDGE}<script data-covibe-pick>(()=>{const __name=(f)=>f;(${pickElements.toString()})()})()</script>`;

/** Put a script at the very start of an HTML page (right after <head>, else first). */
export function injectHtml(html: string, script: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + script + html.slice(doctype[0].length);
  return script + html;
}

export interface SiteOptions {
  /** Script to add to every HTML page (see PREVIEW_BRIDGE). */
  inject?: string;
  /** Called on every request (to keep the site open while it is used). */
  onRequest?: () => void;
}

/** One site on its own port. Open it with url(): the key in it is traded for a cookie. */
export class SiteServer {
  readonly key = randomBytes(18).toString('base64url');
  lastUsed = Date.now();

  private constructor(
    private readonly server: Server,
    readonly port: number,
    readonly source: SiteSource,
  ) {}

  static async start(source: SiteSource, opts: SiteOptions = {}): Promise<SiteServer> {
    let site!: SiteServer;
    const server = createServer((req, res) => {
      site.lastUsed = Date.now();
      opts.onRequest?.();
      handle(site, req, res, opts).catch((err) => {
        if (!res.headersSent) text(res, 500, `Could not serve this file: ${(err as Error).message}`);
        else res.destroy();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    site = new SiteServer(server, (server.address() as AddressInfo).port, source);
    return site;
  }

  get cookie() {
    return `covibe_site_${this.port}`;
  }

  /** The address that opens `path` (default the site's root), with the key that lets the browser in. */
  url(path = '/', host = '127.0.0.1'): string {
    const u = new URL(path.startsWith('/') ? path : `/${path}`, `http://${host}:${this.port}`);
    u.searchParams.set('covibe_key', this.key);
    return u.toString();
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }
}

async function handle(site: SiteServer, req: IncomingMessage, res: ServerResponse, opts: SiteOptions) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return text(res, 403, 'forbidden host');
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'This preview serves files only.');
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  const given = url.searchParams.get('covibe_key');
  if (given !== null) {
    if (given !== site.key) return text(res, 403, 'This preview link has expired. Open it again from covibe.');
    url.searchParams.delete('covibe_key');
    res.writeHead(302, {
      location: url.pathname + url.search,
      'set-cookie': `${site.cookie}=${site.key}; Path=/; HttpOnly; SameSite=Strict`,
      'cache-control': 'no-store',
    });
    return res.end();
  }
  if (cookieOf(req, site.cookie) !== site.key) return text(res, 403, 'Open this preview from covibe.');

  const rel = relPath(url.pathname);
  if (rel === undefined) return text(res, 400, 'bad path');
  let path = rel;
  let data: Buffer | undefined;
  if (await site.source.isDir(rel)) {
    // A folder: its index page, with a trailing slash so relative links resolve inside it.
    if (rel && !url.pathname.endsWith('/')) {
      res.writeHead(301, { location: `${url.pathname}/${url.search}`, 'cache-control': 'no-store' });
      return res.end();
    }
    path = rel ? `${rel}/index.html` : 'index.html';
    data = await site.source.read(path);
    if (!data) return html(res, 404, listingPage(rel, await site.source.list()));
  } else {
    data = await site.source.read(rel);
    // A single-page app's own routes (/settings) are its index page.
    if (!data && !extname(rel) && (req.headers.accept ?? '').includes('text/html')) {
      const index = await site.source.read('index.html');
      if (index) {
        path = 'index.html';
        data = index;
      }
    }
    if (!data) return html(res, 404, `<!doctype html><title>Not found</title><p style="font:14px system-ui;margin:2em">There is no <code>${escapeHtml(rel || '/')}</code> in ${escapeHtml(site.source.label)}.</p>`);
  }
  const type = SITE_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  if (opts.inject && type.startsWith('text/html')) data = Buffer.from(injectHtml(data.toString('utf8'), opts.inject));
  // Video and audio players seek with byte ranges.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const size = data.length;
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    start = Math.max(0, start);
    end = Math.max(start, end);
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    return res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
  }
  res.writeHead(200, {
    'accept-ranges': 'bytes', 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function listingPage(dir: string, files: SiteFile[]): string {
  const prefix = dir ? `${dir}/` : '';
  const names = new Set<string>();
  for (const f of files) if (f.path.startsWith(prefix)) names.add(f.path.slice(prefix.length).replace(/\/.*$/, '/'));
  const items = [...names].sort().map((n) => `<li><a href="${encodeURI(n)}">${escapeHtml(n)}</a></li>`);
  return `<!doctype html><title>${escapeHtml(dir || '/')}</title><div style="font:14px system-ui;margin:2em"><p>No index.html in <code>/${escapeHtml(dir)}</code>.</p><ul>${items.join('')}</ul></div>`;
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Whether a buffer looks like text (no NUL byte near the start). */
export function isText(data: Buffer): boolean {
  return !data.subarray(0, 8000).includes(0);
}
