// The pictures, videos and files a storefront shows as examples. They live in
// the team folder (storefront/…), next to storefront.yaml which names them,
// and go to the relay as listing media when the storefront is published.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MarketError } from './types.js';

/** What a listing page can show (the relay accepts the same types). */
export const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain' };
export const MEDIA_DIR = 'storefront';
/** An example is one upload to the relay, so it stays below a relay's usual limit. */
export const MAX_EXAMPLE_BYTES = 60 << 20;

export const mediaTypeOf = (file: string): string | undefined => MEDIA[extname(file).toLowerCase()];

/** The file an example names, checked to be media inside the team folder. */
export function mediaPath(teamDir: string, rel: string): string {
  const root = resolve(teamDir);
  const path = resolve(root, rel);
  if (!path.startsWith(root + sep) || !mediaTypeOf(path)) throw new MarketError(`"${rel}" is not an example file of this team`);
  return path;
}

/** Keep an uploaded example in the team's storefront folder. Returns the path storefront.yaml names it by. */
export async function saveMedia(teamDir: string, name: string, body: Readable): Promise<{ file: string; size: number; type: string }> {
  const clean = name.replace(/\\/g, '/').split('/').pop()!.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file';
  const type = mediaTypeOf(clean);
  if (!type) throw new MarketError(`a storefront can show ${Object.keys(MEDIA).join(' ')}; "${clean}" is none of these`);
  const dir = join(teamDir, MEDIA_DIR);
  mkdirSync(dir, { recursive: true });
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let file = join(dir, clean);
  for (let i = 2; existsSync(file); i++) file = join(dir, `${stem}-${i}${ext}`);
  let size = 0;
  try {
    await pipeline(
      body,
      async function* (source) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > MAX_EXAMPLE_BYTES) throw new MarketError(`${clean} is larger than ${MAX_EXAMPLE_BYTES >> 20} MB; an example on the page should be a short clip or a picture`);
          yield chunk;
        }
      },
      createWriteStream(file),
    );
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  return { file: relative(teamDir, file).split(sep).join('/'), size, type };
}

/** Send an example to the app's page, with byte ranges so a video can be skipped through. */
export function sendMedia(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!existsSync(path)) throw new MarketError('that example file is no longer in the team folder');
  const size = statSync(path).size;
  const head = { 'content-type': mediaTypeOf(path)!, 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...head, 'content-length': size });
  createReadStream(path).pipe(res);
}
