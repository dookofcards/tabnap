// Minimal deterministic ZIP writer.
//
// This replaces two platform-specific shell-outs that disagreed with each
// other: PowerShell's Compress-Archive writes "\" path separators, which the
// ZIP spec forbids (APPNOTE 4.4.17.1 requires "/"), while `zip -r` writes
// them correctly. Same source, different artifact depending on which machine
// built it — bad for a project whose store listing claims it is reproducible
// from public source.
//
// Timestamps are fixed rather than taken from the filesystem so identical
// input always produces byte-identical output.
import { crc32, deflateRawSync } from "node:zlib";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// 2020-01-01 00:00:00 in DOS date/time format.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;

async function walk(dir, prefix = "") {
  const found = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      found.push(...(await walk(path.join(dir, dirent.name), name)));
    } else {
      found.push({ name, file: path.join(dir, dirent.name) });
    }
  }
  return found;
}

function localHeader(entry) {
  const buf = Buffer.alloc(30 + entry.rawName.length);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4); // version needed to extract
  buf.writeUInt16LE(UTF8_NAMES, 6);
  buf.writeUInt16LE(DEFLATE, 8);
  buf.writeUInt16LE(DOS_TIME, 10);
  buf.writeUInt16LE(DOS_DATE, 12);
  buf.writeUInt32LE(entry.crc, 14);
  buf.writeUInt32LE(entry.deflated.length, 18);
  buf.writeUInt32LE(entry.size, 22);
  buf.writeUInt16LE(entry.rawName.length, 26);
  buf.writeUInt16LE(0, 28); // extra field length
  entry.rawName.copy(buf, 30);
  return buf;
}

function centralHeader(entry) {
  const buf = Buffer.alloc(46 + entry.rawName.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(20, 4); // version made by
  buf.writeUInt16LE(20, 6); // version needed to extract
  buf.writeUInt16LE(UTF8_NAMES, 8);
  buf.writeUInt16LE(DEFLATE, 10);
  buf.writeUInt16LE(DOS_TIME, 12);
  buf.writeUInt16LE(DOS_DATE, 14);
  buf.writeUInt32LE(entry.crc, 16);
  buf.writeUInt32LE(entry.deflated.length, 20);
  buf.writeUInt32LE(entry.size, 24);
  buf.writeUInt16LE(entry.rawName.length, 28);
  buf.writeUInt16LE(0, 30); // extra field length
  buf.writeUInt16LE(0, 32); // comment length
  buf.writeUInt16LE(0, 34); // disk number start
  buf.writeUInt16LE(0, 36); // internal attributes
  buf.writeUInt32LE(0, 38); // external attributes
  buf.writeUInt32LE(entry.offset, 42);
  entry.rawName.copy(buf, 46);
  return buf;
}

/** Zip every file under `dir` into `outPath`, paths relative to `dir`. */
export async function zipDirectory(dir, outPath) {
  // Sorted so entry order is stable across filesystems.
  const files = (await walk(dir)).sort((a, b) => (a.name < b.name ? -1 : 1));

  const chunks = [];
  const entries = [];
  let offset = 0;

  for (const { name, file } of files) {
    const contents = await readFile(file);
    const entry = {
      rawName: Buffer.from(name, "utf8"),
      crc: crc32(contents) >>> 0,
      size: contents.length,
      deflated: deflateRawSync(contents, { level: 9 }),
      offset,
    };
    const header = localHeader(entry);
    chunks.push(header, entry.deflated);
    offset += header.length + entry.deflated.length;
    entries.push(entry);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of entries) {
    const header = centralHeader(entry);
    chunks.push(header);
    centralSize += header.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // comment length
  chunks.push(end);

  await writeFile(outPath, Buffer.concat(chunks));
  return files.map((f) => f.name);
}
