// A minimal zip writer for delivery bundles: deflate, no extras, fixed dates,
// so the same folder always makes the same bytes (and the same bundle hash).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  data: Buffer;
}

/** Every file under a folder, sorted, as zip entries. Hidden files and symlinks are left out. */
export function folderEntries(root: string, limitBytes = Infinity): ZipEntry[] {
  const out: ZipEntry[] = [];
  let total = 0;
  const walk = (dir: string, prefix: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (item.name.startsWith('.')) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path, `${prefix}${item.name}/`);
      else if (item.isFile()) {
        total += statSync(path).size;
        if (total > limitBytes) throw new Error(`the deliverables are larger than ${Math.round(limitBytes / (1 << 20))} MB`);
        out.push({ name: `${prefix}${item.name}`, data: readFileSync(path) });
      }
    }
  };
  walk(root, '');
  return out;
}

export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00, the zip epoch.
  const time = 0;
  const date = 0x21;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = deflateRawSync(e.data, { level: 9 });
    const stored = packed.length >= e.data.length;
    const body = stored ? e.data : packed;
    const crc = crc32(e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    parts.push(head, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(stored ? 0 : 8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
