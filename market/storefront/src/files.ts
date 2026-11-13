// Files of any size, to and from the relay. A file is cut into chunks; each
// is encrypted in this browser under the file's own key and stored under its
// hash. The order's sealed input (or the sealed delivery) lists the hashes,
// so the hash on-chain covers every byte. The twin of src/market/blobs.ts.
import { generateFileKey, importFileKey, openChunk, sealChunk } from './crypto';
import type { Relay } from './relay';
import type { BlobRef } from './types';

const CHUNK_BYTES = 4 << 20;
/** Chunks on their way at once. */
const PARALLEL = 3;

export const fileSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1 << 20 ? `${(bytes / 1024).toFixed(0)} KB` : bytes < 1 << 30 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${(bytes / (1 << 30)).toFixed(2)} GB`);

async function pool(count: number, work: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < count; i = next++) await work(i);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
}

/** Encrypt a file and store it in the relay. `onProgress` gets the bytes sent so far. */
export async function sendFile(relay: Relay, file: File, onProgress: (sent: number) => void): Promise<{ size: number; blob: BlobRef }> {
  const { key, base64 } = await generateFileKey();
  const chunks = new Array<string>(Math.ceil(file.size / CHUNK_BYTES));
  let sent = 0;
  await pool(chunks.length, async (i) => {
    const plain = new Uint8Array(await file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer());
    chunks[i] = await relay.putBlob(await sealChunk(key, i, plain));
    sent += plain.length;
    onProgress(sent);
  });
  return { size: file.size, blob: { key: base64, chunk: CHUNK_BYTES, chunks } };
}

/** Fetch a file from the relay and decrypt it; every chunk is checked against its hash and its key. */
export async function fetchFile(relay: Relay, ref: BlobRef, size: number, type: string | undefined, onProgress: (got: number) => void): Promise<Blob> {
  const key = await importFileKey(ref.key);
  const parts = new Array<Blob>(ref.chunks.length);
  let got = 0;
  await pool(ref.chunks.length, async (i) => {
    const plain = await openChunk(key, i, await relay.blob(ref.chunks[i]!)).catch((err) => {
      throw new Error(err instanceof DOMException ? 'a part of the file could not be decrypted' : (err as Error).message);
    });
    parts[i] = new Blob([plain]);
    got += plain.length;
    onProgress(got);
  });
  const blob = new Blob(parts, type ? { type } : {});
  if (blob.size !== size) throw new Error('the file is not the size the delivery says');
  return blob;
}

export function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.split('/').pop() || 'file';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---- a zip of several files, built here (stored, not compressed: video and images do not shrink)

let table: Uint32Array | undefined;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

async function crc32(blob: Blob): Promise<number> {
  const t = crcTable();
  let c = 0xffffffff;
  for (let at = 0; at < blob.size; at += 8 << 20) {
    const bytes = new Uint8Array(await blob.slice(at, at + (8 << 20)).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The most a plain zip can hold. */
export const ZIP_LIMIT = 0xffff0000;

export async function zipFiles(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const crc = await crc32(f.blob);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // names are UTF-8
    head.setUint16(12, 0x21, true); // 1980-01-01
    head.setUint32(14, crc, true);
    head.setUint32(18, f.blob.size, true);
    head.setUint32(22, f.blob.size, true);
    head.setUint16(26, name.length, true);
    parts.push(head.buffer, name, f.blob);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, f.blob.size, true);
    dir.setUint32(24, f.blob.size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir.buffer, name);
    centralSize += 46 + name.length;
    offset += 30 + name.length + f.blob.size;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
