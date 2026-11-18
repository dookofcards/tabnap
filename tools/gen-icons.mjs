// Icon generator (run: node tools/gen-icons.mjs) — writes raw PNGs with no
// image libraries. Design: a crescent moon and stars on an indigo tile — "TabNap". Rendered with
// 4x4 supersampling for smooth edges at every size.
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const SS = 4; // supersamples per axis

function png(size, colorAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca] = colorAt(u, v);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      raw.set(
        alpha > 0
          ? [r / a, g / a, b / a, alpha].map(Math.round)
          : [0, 0, 0, 0],
        row + 1 + x * 4,
      );
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BG = [79, 70, 229];
const MOON = [254, 243, 199];
const STAR = [199, 210, 254];
const CLEAR = [0, 0, 0, 0];

const dist = (u, v, x, y) => Math.hypot(u - x, v - y);
// Rounded-square tile with a crescent moon (a bigger disc minus an offset one)
// and two small stars.
function inTile(u, v) {
  const r = 0.22;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return dist(u, v, cx, cy) <= r;
}

function colorAt(u, v) {
  if (!inTile(u, v)) return CLEAR;
  if (dist(u, v, 0.45, 0.55, ) <= 0.27 && dist(u, v, 0.58, 0.45) > 0.24) {
    return [...MOON, 255];
  }
  if (dist(u, v, 0.74, 0.28) <= 0.055 || dist(u, v, 0.82, 0.5) <= 0.035) {
    return [...STAR, 255];
  }
  return [...BG, 255];
}

await mkdir("src/icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(`src/icons/icon${size}.png`, png(size, colorAt));
  console.log(`wrote src/icons/icon${size}.png`);
}
