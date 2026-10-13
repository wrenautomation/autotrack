#!/usr/bin/env node
/** Draws the toolbar icons (a red record dot on a dark rounded square) as PNGs, no deps. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Coverage of a pixel by a shape, 4×4 supersampled, for soft edges. */
function cover(x, y, inside) {
  let n = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) n++;
  return n / 16;
}

function png(size) {
  const r = size * 0.22; // corner radius
  const square = (x, y) => {
    const dx = Math.max(r - x, 0, x - (size - r));
    const dy = Math.max(r - y, 0, y - (size - r));
    return dx * dx + dy * dy <= r * r;
  };
  const c = size / 2;
  const dot = (x, y) => (x - c) ** 2 + (y - c) ** 2 <= (size * 0.27) ** 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const a = cover(x, y, square);
      const d = cover(x, y, dot);
      const px = [
        Math.round(28 + (229 - 28) * d),
        Math.round(28 + (57 - 28) * d),
        Math.round(32 + (53 - 32) * d),
        Math.round(255 * a),
      ];
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(join(out, `${size}.png`), png(size));
console.log(`icons written to ${out}`);
