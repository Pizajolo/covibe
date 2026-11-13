// From a finished run to a delivery: which gates passed, the files of the
// deliverables folder, and the signed receipt whose hash goes on-chain.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { RunEvent } from '../events/types.js';
import { publicKeyOf, sha256Hex, signMessage, verifyMessage } from './crypto.js';
import type { Receipt } from './types.js';

/**
 * How each required gate ended: its last result in the run. A gate that never
 * ran did not pass. The engine evaluates gates itself (see Engine.run), so
 * these are its verdicts, not a model's.
 */
export function gateResults(events: RunEvent[], required: string[]): { name: string; passed: boolean }[] {
  const last = new Map<string, boolean>();
  for (const e of events) if ((e.type === 'gate.passed' || e.type === 'gate.failed') && e.step) last.set(e.step, e.type === 'gate.passed');
  return required.map((name) => ({ name, passed: last.get(name) === true }));
}

/** The hash that stands for the full event log, which holds prompts and stays with the owner. */
export function eventLogHash(events: RunEvent[]): string {
  return sha256Hex(events.map((e) => JSON.stringify(e)).join('\n'));
}

export interface DeliverableFile {
  /** Path inside the deliverables folder, with forward slashes. */
  name: string;
  path: string;
  size: number;
}

/** Every file under a folder, sorted. Hidden files and symlinks are left out. */
export function folderFiles(root: string, limitBytes = Infinity): DeliverableFile[] {
  const out: DeliverableFile[] = [];
  let total = 0;
  const walk = (dir: string, prefix: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (item.name.startsWith('.')) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path, `${prefix}${item.name}/`);
      else if (item.isFile()) {
        const size = statSync(path).size;
        total += size;
        if (total > limitBytes) throw new Error(`the deliverables are larger than ${Math.round(limitBytes / (1 << 20))} MB`);
        out.push({ name: `${prefix}${item.name}`, path, size });
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * The files to deliver: the deliverables folder of the workspace, or, for a
 * team that works in git worktrees, that folder on the run's result branch
 * (checked out to a temporary folder; call `done` once the files were sent).
 */
export function collectDeliverables(workspace: string, folder: string, branch: string | undefined, limitBytes: number): { files: DeliverableFile[]; done(): void } {
  if (!branch) return { files: existsSync(join(workspace, folder)) ? folderFiles(join(workspace, folder), limitBytes) : [], done: () => undefined };
  const tmp = mkdtempSync(join(tmpdir(), 'covibe-bundle-'));
  const done = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const tar = join(tmp, 'out.tar');
    try {
      execFileSync('git', ['archive', '--format=tar', '-o', tar, branch, '--', folder], { cwd: workspace, stdio: 'ignore' });
    } catch {
      done();
      return { files: [], done: () => undefined };
    }
    execFileSync('tar', ['-xf', tar, '-C', tmp], { stdio: 'ignore' });
    rmSync(tar, { force: true });
    return { files: existsSync(join(tmp, folder)) ? folderFiles(join(tmp, folder), limitBytes) : [], done };
  } catch (err) {
    done();
    throw err;
  }
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.zip': 'application/zip' };

/** A delivered file's media type by its name, so the customer's browser can show a video or an image in place. */
export const mediaType = (name: string): string | undefined => TYPES[extname(name).toLowerCase()];

/** Sign a receipt with the owner's NEAR key. The signature covers the JSON of every other field, in this order. */
export function signReceipt(receipt: Omit<Receipt, 'public_key' | 'signature'>, privateKey: string): Receipt {
  const body: Receipt = { ...receipt, public_key: publicKeyOf(privateKey) };
  return { ...body, signature: signMessage(privateKey, JSON.stringify(body)) };
}

export function verifyReceipt(receipt: Receipt): boolean {
  const { signature, ...body } = receipt;
  return !!signature && verifyMessage(receipt.public_key, JSON.stringify(body), signature);
}
