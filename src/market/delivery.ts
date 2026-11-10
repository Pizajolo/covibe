// From a finished run to a delivery: which gates passed, the bundle of the
// deliverables folder, and the signed receipt whose hash goes on-chain.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '../events/types.js';
import { publicKeyOf, sha256Hex, signMessage, verifyMessage } from './crypto.js';
import type { Receipt } from './types.js';
import { folderEntries, type ZipEntry } from './zip.js';

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

/**
 * The files to deliver: the deliverables folder of the workspace, or, for a
 * team that works in git worktrees, that folder on the run's result branch.
 */
export function collectDeliverables(workspace: string, folder: string, branch: string | undefined, limitBytes: number): ZipEntry[] {
  if (!branch) return existsSync(join(workspace, folder)) ? folderEntries(join(workspace, folder), limitBytes) : [];
  const tmp = mkdtempSync(join(tmpdir(), 'covibe-bundle-'));
  try {
    const tar = join(tmp, 'out.tar');
    try {
      execFileSync('git', ['archive', '--format=tar', '-o', tar, branch, '--', folder], { cwd: workspace, stdio: 'ignore' });
    } catch {
      return [];
    }
    execFileSync('tar', ['-xf', tar, '-C', tmp], { stdio: 'ignore' });
    return existsSync(join(tmp, folder)) ? folderEntries(join(tmp, folder), limitBytes) : [];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Sign a receipt with the owner's NEAR key. The signature covers the JSON of every other field, in this order. */
export function signReceipt(receipt: Omit<Receipt, 'public_key' | 'signature'>, privateKey: string): Receipt {
  const body: Receipt = { ...receipt, public_key: publicKeyOf(privateKey) };
  return { ...body, signature: signMessage(privateKey, JSON.stringify(body)) };
}

export function verifyReceipt(receipt: Receipt): boolean {
  const { signature, ...body } = receipt;
  return !!signature && verifyMessage(receipt.public_key, JSON.stringify(body), signature);
}
