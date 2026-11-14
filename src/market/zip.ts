// A zip archive of a few files, written in memory. For deliveries that go to a
// marketplace which takes only a handful of flat files (see agentmarket.ts).
import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';

/** DOS date and time, as zip stores them. */
function dosTime(d: Date): { time: number; date: number } {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** Zip files under their names (forward slashes, folders included). Names are stored as UTF-8. */
export function zipFiles(files: { name: string; path: string }[], now = new Date()): Buffer {
  const { time, date } = dosTime(now);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const plain = readFileSync(f.path);
    const packed = deflateRawSync(plain);
    // Media that does not shrink is stored as it is.
    const stored = packed.length >= plain.length;
    const data = stored ? plain : packed;
    const name = Buffer.from(f.name, 'utf8');
    const head = Buffer.alloc(26);
    head.writeUInt16LE(20, 0); // version needed
    head.writeUInt16LE(0x0800, 2); // UTF-8 names
    head.writeUInt16LE(stored ? 0 : 8, 4);
    head.writeUInt16LE(time, 6);
    head.writeUInt16LE(date, 8);
    head.writeUInt32LE(crc32(plain), 10);
    head.writeUInt32LE(data.length, 14);
    head.writeUInt32LE(plain.length, 18);
    head.writeUInt16LE(name.length, 22);
    head.writeUInt16LE(0, 24);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), head, name, data]);
    // Comment length, disk and attributes stay 0; then where the file's local header starts.
    const entry = Buffer.alloc(14);
    entry.writeUInt32LE(offset, 10);
    central.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), head, entry, name]));
    parts.push(local);
    offset += local.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
