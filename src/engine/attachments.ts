// Files a person gives the team with a goal, a question or a chat message:
// images, documents, footage. They are kept with the run, outside the project
// (so they are never committed), and every member of the run may read them;
// the members' prompts list where they are.
import { randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { covibeHome, repoKey } from '../home.js';

/** One file given to a run. */
export interface Attachment {
  name: string;
  /** Where it is on this computer (members read it there). */
  path: string;
  size: number;
  kind: 'image' | 'pdf' | 'video' | 'audio' | 'document' | 'text' | 'file';
}

/** Largest file one upload may be. */
export const MAX_UPLOAD_BYTES = 1 << 30;
/** Uploads not given to a run within this long are removed. */
const UPLOAD_TTL_MS = 24 * 60 * 60_000;

export class AttachmentError extends Error {}

/** Where a run's files are: outside the project, one folder per run. */
export function attachmentsDir(repo: string, runId: string): string {
  return join(covibeHome(), 'attachments', repoKey(repo), runId);
}

function uploadsRoot(): string {
  return join(covibeHome(), 'uploads');
}

export function kindOf(name: string): Attachment['kind'] {
  const ext = extname(name).toLowerCase();
  if (/^\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/.test(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (/^\.(mp4|mov|m4v|webm|mkv|avi)$/.test(ext)) return 'video';
  if (/^\.(mp3|wav|m4a|ogg|aiff?|flac)$/.test(ext)) return 'audio';
  if (/^\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|key|pages|numbers)$/.test(ext)) return 'document';
  if (/^\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|css|js|ts|tsx|jsx|py|go|rs|java|rb|sh|sql|log)$/.test(ext)) return 'text';
  return 'file';
}

/** A file name that is safe on disk: no folders, no leading dots, no control characters. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (base || 'file').slice(0, 120);
}

/** A name not taken in `dir` yet (logo.png, logo-2.png, …). */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem}-${i}${ext}`))) return `${stem}-${i}${ext}`;
}

/** Keep a file a person is sending (before the run or message it goes with exists). Returns its id. */
export async function saveUpload(name: string, body: Readable, maxBytes = MAX_UPLOAD_BYTES): Promise<{ id: string; name: string; size: number; kind: Attachment['kind'] }> {
  sweepUploads();
  const id = randomBytes(9).toString('base64url');
  const dir = join(uploadsRoot(), id);
  mkdirSync(dir, { recursive: true });
  const clean = safeName(name);
  const file = join(dir, clean);
  let size = 0;
  try {
    await pipeline(
      body,
      async function* (source) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > maxBytes) throw new AttachmentError(`${clean} is larger than ${Math.round(maxBytes / (1 << 20))} MB`);
          yield chunk;
        }
      },
      createWriteStream(file),
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { id, name: clean, size, kind: kindOf(clean) };
}

/**
 * Move uploads into a run's folder (`sub`: a folder of their own, for a chat
 * message's). Throws when an id is unknown, before anything is moved.
 */
export function takeUploads(ids: string[], repo: string, runId: string, sub?: string): Attachment[] {
  const found = ids.map((id) => {
    if (!/^[\w-]{6,40}$/.test(id)) throw new AttachmentError(`unknown upload "${id}"`);
    const dir = join(uploadsRoot(), id);
    const name = existsSync(dir) ? readdirSync(dir)[0] : undefined;
    if (!name) throw new AttachmentError('a file you added is no longer there; add it again');
    return { dir, name };
  });
  const out = found.map(({ dir, name }) => place(join(dir, name), name, repo, runId, sub, true));
  for (const { dir } of found) rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Copy files from this computer into a run's folder (the command line's --attach). */
export function attachFiles(paths: string[], repo: string, runId: string, sub?: string): Attachment[] {
  for (const p of paths) if (!existsSync(p) || !statSync(p).isFile()) throw new AttachmentError(`${p} is not a file`);
  return paths.map((p) => place(p, basename(p), repo, runId, sub, false));
}

function place(from: string, name: string, repo: string, runId: string, sub: string | undefined, move: boolean): Attachment {
  const dir = sub ? join(attachmentsDir(repo, runId), sub) : attachmentsDir(repo, runId);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, freeName(dir, safeName(name)));
  if (move) {
    try {
      renameSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  } else copyFileSync(from, to);
  return { name: basename(to), path: to, size: statSync(to).size, kind: kindOf(to) };
}

/** Make sure a run's folder exists (members may read it from the start of their turn; files come in later with chat). */
export function ensureAttachmentsDir(repo: string, runId: string): string {
  const dir = attachmentsDir(repo, runId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.keep'), '');
  }
  return dir;
}

function sweepUploads() {
  const root = uploadsRoot();
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    try {
      if (Date.now() - statSync(join(root, id)).mtimeMs > UPLOAD_TTL_MS) rmSync(join(root, id), { recursive: true, force: true });
    } catch {
      // removed meanwhile
    }
  }
}

const kb = (n: number) => (n < 1 << 20 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

const HOW: Record<Attachment['kind'], string> = {
  image: 'image',
  pdf: 'PDF',
  video: 'video',
  audio: 'audio',
  document: 'office document',
  text: 'text',
  file: 'file',
};

/** What a member is told about the files given with a goal or a message. */
export function attachmentNote(files: Attachment[], what = 'with the goal'): string {
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.path} (${HOW[f.kind]}, ${kb(f.size)})`);
  const tips = [
    'Look at them with the Read tool: it shows images and PDFs as they are, and text files as text.',
    files.some((f) => f.kind === 'video' || f.kind === 'audio') ? 'For video and audio, use ffprobe and frame grabs with ffmpeg if you have a shell.' : '',
    files.some((f) => f.kind === 'document') ? 'Office documents need a skill (docx, xlsx, pptx) or a converter to read.' : '',
    'They are outside the project: to use one in it (a logo, a photo), copy it in with a shell command if you have one, or ask a teammate who does.',
  ].filter(Boolean);
  return `The human attached ${files.length === 1 ? 'a file' : `${files.length} files`} ${what}:\n${lines.join('\n')}\n${tips.join(' ')}`;
}
