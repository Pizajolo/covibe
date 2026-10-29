import { execFile } from 'node:child_process';
import { constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import { folderRunsRoot } from '../home.js';
import { scopeMatcher } from './scope.js';

// Plain folders (no git): members work in the folder itself, so there is no
// branch to review and merge. covibe keeps what it needs instead: a record of
// which files each member changed, and copies of the files as they were when
// the run started, so the whole run can be undone.

const exec = promisify(execFile);

/** Size and modification time: enough to tell that a file changed. */
export interface FileStat {
  size: number;
  mtimeMs: number;
}

export type Snapshot = Map<string, FileStat>;

/** A member that can change files, and where. `scope` undefined = anywhere. */
export interface Writer {
  name: string;
  scope: string[] | undefined;
}

/** Folders never looked into: covibe's own, version control, dependencies. */
const SKIP_DIRS = new Set(['.covibe', '.git', '.svn', '.hg', 'node_modules']);
/** Files the operating system or an open Office document write on their own. */
const SKIP_FILE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\._.*)$/;
const MAX_FILES = 200_000;

/** Copies made the slow way (no copy-on-write clone) stop at these sizes. */
const MAX_COPY_FILE = 50 * 1024 * 1024;
const MAX_COPY_TOTAL = 1024 * 1024 * 1024;

/** Every file under `root` with its size and modification time (paths use "/"). */
export function snapshot(root: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), r);
      } else if (e.isFile() && !SKIP_FILE.test(e.name)) {
        const s = statOf(join(dir, e.name));
        if (s) out.set(r, s);
      }
    }
  };
  walk(root, '');
  return out;
}

function statOf(path: string): FileStat | null {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

function same(a: FileStat | null | undefined, b: FileStat | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** A file as it was when the run started; `saved`: a copy is kept. */
type Original = FileStat & { saved?: boolean };

/** A file the run changed: who changed it, and how the run left it (null = deleted). */
interface Change {
  by: string[];
  now: FileStat | null;
}

export interface FolderCollect {
  /** Files this member changed in its write scope. */
  files: string[];
  added: string[];
  modified: string[];
  deleted: string[];
  /** Files changed outside its write scope (by its shell commands). They stay; undoing the run reverts them. */
  outside: string[];
}

export interface FolderChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  by: string[];
  additions: number;
  deletions: number;
}

/** The folder a run keeps its record and copies in. */
function runDir(root: string, runId: string) {
  return join(folderRunsRoot(root), runId);
}

/** True when `runId` ran in the plain folder `root`. */
export function isFolderRun(root: string, runId: string): boolean {
  return existsSync(join(runDir(root, runId), 'original.json'));
}

/**
 * One run's work in a plain folder. The engine takes a snapshot when the run
 * starts (and copies the files), and after each member's turn compares the
 * folder with what it last knew to see what that member changed.
 */
export class FolderRun {
  /** Members working right now: a change in their scope is theirs to claim. */
  private readonly active = new Set<string>();

  private constructor(
    readonly root: string,
    readonly runId: string,
    private readonly writers: Writer[],
    /** The folder as covibe last knew it. */
    private baseline: Snapshot,
    private readonly original: Record<string, Original>,
    private readonly changed: Record<string, Change>,
  ) {}

  /** Start a run: snapshot the folder and keep copies of the files the team may change. */
  static async start(root: string, runId: string, writers: Writer[]): Promise<FolderRun> {
    const dir = runDir(root, runId);
    const baseline = snapshot(root);
    const original: Record<string, Original> = {};
    for (const [p, s] of baseline) original[p] = { ...s };
    await mkdir(dir, { recursive: true });
    await keepCopies(root, join(dir, 'files'), original, writers);
    await writeFile(join(dir, 'original.json'), JSON.stringify({ root, createdAt: new Date().toISOString(), files: original }));
    await writeFile(join(dir, 'changes.json'), '{}');
    return new FolderRun(root, runId, writers, baseline, original, {});
  }

  /** Pick up an earlier run (to chat with its members after it ended). */
  static open(root: string, runId: string, writers: Writer[]): FolderRun | undefined {
    if (!isFolderRun(root, runId)) return undefined;
    const { original, changed } = readRecord(root, runId);
    return new FolderRun(root, runId, writers, snapshot(root), original, changed);
  }

  begin(agent: string) {
    this.active.add(agent);
  }

  end(agent: string) {
    this.active.delete(agent);
  }

  /**
   * What `agent` changed since covibe last looked. Changes in its write scope
   * are its own. A change in the scope of a teammate working at the same time
   * is left for that teammate's turn. Anything else was changed outside the
   * member's scope: it is reported, and stays, since it may be the person's
   * own edit; undoing the run reverts it.
   */
  async collect(agent: string, scope: string[] | undefined): Promise<FolderCollect> {
    const now = snapshot(this.root);
    const mine = scopeMatcher(scope);
    const others = this.writers.filter((w) => w.name !== agent && this.active.has(w.name)).map((w) => scopeMatcher(w.scope));
    const out: FolderCollect = { files: [], added: [], modified: [], deleted: [], outside: [] };
    for (const p of new Set([...this.baseline.keys(), ...now.keys()])) {
      const before = this.baseline.get(p);
      const after = now.get(p);
      if (same(before, after)) continue;
      const inScope = mine(p);
      if (!inScope && others.some((m) => m(p))) continue;
      if (inScope) {
        out.files.push(p);
        (!before ? out.added : !after ? out.deleted : out.modified).push(p);
      } else out.outside.push(p);
      if (after) this.baseline.set(p, after);
      else this.baseline.delete(p);
      const prev = this.changed[p];
      if (same(this.original[p], after)) delete this.changed[p];
      else this.changed[p] = { by: prev?.by.includes(agent) ? prev.by : [...(prev?.by ?? []), agent], now: after ?? null };
    }
    for (const list of Object.values(out)) list.sort();
    await writeFile(join(runDir(this.root, this.runId), 'changes.json'), JSON.stringify(this.changed));
    return out;
  }
}

function readRecord(root: string, runId: string): { original: Record<string, Original>; changed: Record<string, Change>; undoneAt?: string } {
  const dir = runDir(root, runId);
  const original = (JSON.parse(readFileSync(join(dir, 'original.json'), 'utf8')) as { files: Record<string, Original> }).files;
  let changed: Record<string, Change> = {};
  try {
    changed = JSON.parse(readFileSync(join(dir, 'changes.json'), 'utf8')) as Record<string, Change>;
  } catch {
    // no turn has finished yet
  }
  const undoneAt = existsSync(join(dir, 'undone.json')) ? (JSON.parse(readFileSync(join(dir, 'undone.json'), 'utf8')) as { at: string }).at : undefined;
  return { original, changed, undoneAt };
}

/**
 * Copy the files as they are into `to`. A copy-on-write clone (APFS, Btrfs,
 * XFS) costs no space, so every file is cloned when the disk can; otherwise
 * files are copied up to a size limit, those the team may change first.
 */
async function keepCopies(root: string, to: string, files: Record<string, Original>, writers: Writer[]) {
  const scopes = writers.map((w) => scopeMatcher(w.scope));
  const writable = (p: string) => scopes.some((m) => m(p));
  const order = Object.keys(files).sort((a, b) => Number(writable(b)) - Number(writable(a)));
  let clones = true;
  let budget = MAX_COPY_TOTAL;
  for (const p of order) {
    const f = files[p]!;
    const dst = join(to, p);
    await mkdir(dirname(dst), { recursive: true });
    if (clones) {
      try {
        await copyFile(join(root, p), dst, constants.COPYFILE_FICLONE_FORCE);
        f.saved = true;
        continue;
      } catch (err) {
        // The disk cannot clone (or the copy is on another disk): copy instead from now on.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') clones = false;
      }
    }
    if (f.size > MAX_COPY_FILE || f.size > budget) continue;
    try {
      await copyFile(join(root, p), dst);
      budget -= f.size;
      f.saved = true;
    } catch {
      // unreadable or gone: nothing to keep
    }
  }
}

/** The files a folder run changed, with line counts and a patch of the text files. */
export async function folderDiff(root: string, runId: string): Promise<{ files: FolderChange[]; patch: string; undoneAt?: string; note?: string }> {
  if (!isFolderRun(root, runId)) return { files: [], patch: '', note: 'This run has no record of its changes.' };
  const { original, changed, undoneAt } = readRecord(root, runId);
  const saved = join(runDir(root, runId), 'files');
  const files: FolderChange[] = [];
  let patch = '';
  let unsaved = 0;
  for (const path of Object.keys(changed).sort().slice(0, 500)) {
    const c = changed[path]!;
    const was = original[path];
    const status = !was ? 'added' : c.now ? 'modified' : 'deleted';
    const entry: FolderChange = { path, status, by: c.by, additions: 0, deletions: 0 };
    files.push(entry);
    if (was && !was.saved) {
      unsaved += 1;
      continue;
    }
    const a = was ? join(saved, path) : '/dev/null';
    const b = existsSync(join(root, path)) ? join(root, path) : '/dev/null';
    const numstat = await gitDiff(['--numstat', a, b]);
    const [add, del] = numstat.split('\t');
    entry.additions = Number(add) || 0;
    entry.deletions = Number(del) || 0;
    if (patch.length < 400_000) patch += relabel(await gitDiff([a, b]), a, b, path);
  }
  const note = unsaved ? `${unsaved} changed file${unsaved > 1 ? 's were' : ' was'} too large to keep a copy of, so ${unsaved > 1 ? 'they have' : 'it has'} no diff and cannot be undone.` : undefined;
  return { files, patch: patch.length > 400_000 ? patch.slice(0, 400_000) + '\n… (diff truncated)' : patch, ...(undoneAt ? { undoneAt } : {}), ...(note ? { note } : {}) };
}

/** `git diff --no-index` compares two files outside any repository; it exits 1 when they differ. */
async function gitDiff(args: string[]): Promise<string> {
  try {
    return (await exec('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', ...args], { maxBuffer: 32 << 20 })).stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? '';
  }
}

/** Show the file's own path in a patch instead of the copy's. */
function relabel(patch: string, a: string, b: string, path: string): string {
  const strip = (p: string) => p.replace(/^\//, '');
  let out = patch;
  for (const p of [a, b]) if (p !== '/dev/null') out = out.split(strip(p)).join(path);
  return out;
}

/**
 * Put the folder back the way it was before the run: changed and deleted
 * files come back from the copies, files the run added go. Nothing is thrown
 * away: what the run left is moved to the run's record first. A file that
 * changed again after the run (you edited it), or that had no copy, is left
 * as it is.
 */
export async function undoFolderRun(root: string, runId: string): Promise<{ restored: string[]; removed: string[]; skipped: { path: string; reason: string }[]; keptIn: string }> {
  if (!isFolderRun(root, runId)) throw new Error('this run has no record of its changes to undo');
  const dir = runDir(root, runId);
  const { original, changed } = readRecord(root, runId);
  const aside = join(dir, 'undone', new Date().toISOString().replace(/[:.]/g, '-'));
  const result = { restored: [] as string[], removed: [] as string[], skipped: [] as { path: string; reason: string }[], keptIn: aside };
  for (const path of Object.keys(changed).sort()) {
    const c = changed[path]!;
    const was = original[path];
    const target = join(root, path);
    if (!same(statOf(target), c.now)) {
      result.skipped.push({ path, reason: 'it changed again after the run' });
      continue;
    }
    if (was && !was.saved) {
      result.skipped.push({ path, reason: 'it was too large to keep a copy of' });
      continue;
    }
    if (c.now) await moveFile(target, join(aside, path));
    if (was) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(dir, 'files', path), target, constants.COPYFILE_FICLONE);
      await utimes(target, new Date(), new Date(was.mtimeMs));
      result.restored.push(path);
    } else result.removed.push(path);
    delete changed[path];
  }
  await writeFile(join(dir, 'changes.json'), JSON.stringify(changed));
  await writeFile(join(dir, 'undone.json'), JSON.stringify({ at: new Date().toISOString(), ...result }));
  return result;
}

async function moveFile(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    // another disk
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Remove what a folder run keeps (the copies and its record). Undoing it is no longer possible afterwards. */
export async function removeFolderRun(root: string, runId: string): Promise<void> {
  await rm(runDir(root, runId), { recursive: true, force: true });
}

/** Runs of a folder that keep copies on disk. */
export function folderRunIds(root: string): string[] {
  const base = folderRunsRoot(root);
  return existsSync(base) ? readdirSync(base).filter((id) => isFolderRun(root, id)) : [];
}

export { runDir as folderRunDir };

/**
 * Paths a member's shell commands may not write in a plain folder: covibe's
 * own folder, and every top-level entry its write scope cannot reach (with
 * `final/**`, everything but `final`). The OS sandbox enforces it, since in a
 * plain folder there is no worktree whose stray changes can be thrown away.
 * A scope that can match anywhere (`*.md`) leaves the top level open; the
 * file tools stay limited to the scope either way.
 */
export function denyWritePaths(root: string, scope: string[] | undefined): string[] {
  const deny = [join(root, '.covibe')];
  if (scope === undefined) return deny;
  const bases = scope.map((g) => picomatch.scan(g).base);
  if (bases.some((b) => !b)) return deny;
  const reachable = new Set(bases.map((b) => b.split('/')[0]));
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    // the folder is gone; nothing to protect
  }
  for (const name of names) if (!reachable.has(name) && name !== '.covibe') deny.push(join(root, name));
  return deny;
}
