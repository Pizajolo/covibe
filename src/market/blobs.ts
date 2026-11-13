// Files of any size through the relay. A file is cut into chunks, each chunk
// is encrypted under the file's own key and stored under its hash; what names
// the file (the order's sealed input, or the sealed delivery) lists the
// hashes, so the hash on-chain covers every byte. Nothing here holds a whole
// file in memory: footage goes from disk to the relay and back chunk by chunk.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { openChunk, sealChunk, sha256Hex } from './crypto.js';
import type { Relay } from './relay.js';
import type { BlobRef } from './types.js';

/** Bytes of a file per chunk: small enough for any relay's upload limit, large enough to keep the list short. */
export const CHUNK_BYTES = 4 << 20;
const MIN_CHUNK = 64 << 10;
const MAX_CHUNK = 32 << 20;

type Blobs = Pick<Relay, 'putBlob' | 'blob'>;

/** Encrypt a file from disk and store it in the relay. */
export async function putFile(relay: Blobs, path: string): Promise<{ size: number; blob: BlobRef }> {
  const key = randomBytes(32);
  const size = statSync(path).size;
  const chunks: string[] = [];
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    for (let at = 0; at < size; at += CHUNK_BYTES) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, at);
      const sealed = sealChunk(key, chunks.length, buf.subarray(0, n));
      const hash = await relay.putBlob(sealed);
      if (hash !== sha256Hex(sealed)) throw new Error('the relay stored a different chunk than was sent');
      chunks.push(hash);
    }
  } finally {
    closeSync(fd);
  }
  return { size, blob: { key: key.toString('base64'), chunk: CHUNK_BYTES, chunks } };
}

/** What is wrong with a file reference a stranger sent (undefined when it can be fetched). */
export function blobProblem(ref: unknown, size: unknown): string | undefined {
  const r = ref as Partial<BlobRef> | null;
  if (!r || typeof r !== 'object' || typeof r.key !== 'string' || typeof r.chunk !== 'number' || !Array.isArray(r.chunks)) return 'its reference is malformed';
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return 'its size is missing';
  if (Buffer.from(r.key, 'base64').length !== 32) return 'its key is malformed';
  if (!Number.isInteger(r.chunk) || r.chunk < MIN_CHUNK || r.chunk > MAX_CHUNK) return 'its chunk size is out of range';
  if (r.chunks.some((h) => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))) return 'a chunk hash is malformed';
  if (r.chunks.length !== Math.ceil(size / r.chunk)) return 'its size and its chunks do not agree';
  return undefined;
}

/**
 * Fetch a file from the relay to disk, checking each chunk against its hash
 * and its key. The file must come out exactly `size` bytes long, so what was
 * checked against the listing's limit is what is written.
 */
export async function fetchFile(relay: Blobs, ref: BlobRef, size: number, dest: string): Promise<void> {
  const problem = blobProblem(ref, size);
  if (problem) throw new Error(problem);
  const key = Buffer.from(ref.key, 'base64');
  mkdirSync(dirname(dest), { recursive: true });
  const fd = openSync(dest, 'w');
  let written = 0;
  try {
    for (const [i, hash] of ref.chunks.entries()) {
      const sealed = await relay.blob(hash);
      if (sha256Hex(sealed) !== hash) throw new Error(`chunk ${i + 1} in the relay does not match its hash`);
      const plain = openChunk(key, i, sealed);
      written += plain.length;
      if (written > size || (i < ref.chunks.length - 1 && plain.length !== ref.chunk)) throw new Error('the file is not the size the order says');
      writeSync(fd, plain);
    }
    if (written !== size) throw new Error('the file is not the size the order says');
  } catch (err) {
    closeSync(fd);
    rmSync(dest, { force: true });
    throw err;
  }
  closeSync(fd);
}
