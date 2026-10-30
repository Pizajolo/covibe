// How people see a running app inside covibe: a proxy on a port of its own in
// front of the app's port, which adds the preview bridge to its pages (the
// address bar follows clicks; elements can be picked for feedback) and lets
// it be framed. Everything else, websockets for hot reload included, passes
// through as it is. Members' browsers use the app's own address.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { FEEDBACK_BRIDGE, injectHtml } from '../server/site.js';

/** Response headers that would keep the page out of a frame or block the bridge. */
const DROP = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'content-length', 'content-encoding', 'transfer-encoding']);

export class AppView {
  lastUsed = Date.now();
  private sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly port: number,
    readonly target: number,
  ) {}

  static async start(target: number, opts: { onRequest?: () => void } = {}): Promise<AppView> {
    let view!: AppView;
    const server = createServer((req, res) => {
      view.lastUsed = Date.now();
      opts.onRequest?.();
      view.forward(req, res);
    });
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      view.lastUsed = Date.now();
      opts.onRequest?.();
      const up = connect(target, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i]!;
          lines.push(`${name}: ${name.toLowerCase() === 'host' ? `127.0.0.1:${target}` : req.rawHeaders[i + 1]}`);
        }
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) up.write(head);
        socket.pipe(up);
        up.pipe(socket);
      });
      const end = () => {
        socket.destroy();
        up.destroy();
      };
      up.on('error', end);
      socket.on('error', end);
      view.sockets.add(socket);
      socket.on('close', () => view.sockets.delete(socket));
    });
    server.on('connection', (s) => {
      view.sockets.add(s);
      s.on('close', () => view.sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    view = new AppView(server, (server.address() as AddressInfo).port, target);
    return view;
  }

  private forward(req: IncomingMessage, res: ServerResponse) {
    const headers = { ...req.headers, host: `127.0.0.1:${this.target}` };
    // Pages come back uncompressed so the bridge can go in.
    delete headers['accept-encoding'];
    const up = request({ host: '127.0.0.1', port: this.target, method: req.method, path: req.url, headers }, (ur) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !DROP.has(k)) out[k] = v;
      // Redirects to the app's own address stay in the view.
      if (typeof out.location === 'string') out.location = out.location.replace(new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${this.target}`), '');
      const html = String(ur.headers['content-type'] ?? '').startsWith('text/html');
      if (!html) {
        if (ur.headers['content-length']) out['content-length'] = ur.headers['content-length'];
        if (ur.headers['content-encoding']) out['content-encoding'] = ur.headers['content-encoding'];
        res.writeHead(ur.statusCode ?? 502, out);
        ur.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      ur.on('data', (c: Buffer) => chunks.push(c));
      ur.on('end', () => {
        const body = Buffer.from(injectHtml(Buffer.concat(chunks).toString('utf8'), FEEDBACK_BRIDGE));
        res.writeHead(ur.statusCode ?? 200, { ...out, 'content-length': body.length, 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
      });
      ur.on('error', () => res.destroy());
    });
    up.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><p style="font:14px system-ui;margin:2em">The app does not answer (${err.message}). It may still be starting, or it stopped: see its log.</p>`);
    });
    req.pipe(up);
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}
