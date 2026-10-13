/**
 * RGBA → baseline JPEG (4:2:0), with an area-average downscale on the way in. node-screenshots
 * encodes JPEG but cannot resize, and a Retina or 4K capture must come down to 1920 px.
 */

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18,
  24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37,
  47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];
// Annex K Huffman tables: code counts per length 1..16, then symbols.
const DC_LUMA = {
  counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const DC_CHROMA = {
  counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const AC_LUMA = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};

type Huff = { code: Uint16Array; len: Uint8Array };

function buildHuff(spec: { counts: number[]; symbols: number[] }): Huff {
  const code = new Uint16Array(256);
  const len = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < (spec.counts[l - 1] ?? 0); i++) {
      const s = spec.symbols[k++] ?? 0;
      code[s] = c++;
      len[s] = l;
    }
    c <<= 1;
  }
  return { code, len };
}

const H = {
  dcY: buildHuff(DC_LUMA),
  acY: buildHuff(AC_LUMA),
  dcC: buildHuff(DC_CHROMA),
  acC: buildHuff(AC_CHROMA),
};

const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379];

function scaledQuant(base: number[], quality: number): { table: Uint8Array; fdtbl: Float32Array } {
  const q = Math.min(100, Math.max(1, quality));
  const sf = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const table = new Uint8Array(64);
  const fdtbl = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    const v = Math.min(255, Math.max(1, Math.floor(((base[i] ?? 1) * sf + 50) / 100)));
    table[ZIGZAG[i] ?? 0] = v;
  }
  for (let r = 0, k = 0; r < 8; r++)
    for (let c = 0; c < 8; c++, k++)
      fdtbl[k] = 1 / ((table[ZIGZAG[k] ?? 0] ?? 1) * (AAN[r] ?? 1) * (AAN[c] ?? 1) * 8);
  return { table, fdtbl };
}

class Bits {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private acc = 0;
  private bits = 0;
  byte(b: number): void {
    if (this.n >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = b;
  }
  word(w: number): void {
    this.byte((w >> 8) & 0xff);
    this.byte(w & 0xff);
  }
  put(code: number, len: number): void {
    this.acc = (this.acc << len) | code;
    this.bits += len;
    while (this.bits >= 8) {
      const b = (this.acc >> (this.bits - 8)) & 0xff;
      this.byte(b);
      if (b === 0xff) this.byte(0);
      this.bits -= 8;
    }
    this.acc &= (1 << this.bits) - 1;
  }
  flush(): void {
    if (this.bits > 0) this.put((1 << (8 - this.bits)) - 1, 8 - this.bits);
  }
}

const block = new Float32Array(64);
const quant = new Int32Array(64);

/** Forward AAN DCT over `block`, quantized into `quant` in zigzag order. */
function fdct(fdtbl: Float32Array): void {
  const d = block;
  for (let i = 0; i < 64; i += 8) {
    const t0 = (d[i] as number) + (d[i + 7] as number);
    const t7 = (d[i] as number) - (d[i + 7] as number);
    const t1 = (d[i + 1] as number) + (d[i + 6] as number);
    const t6 = (d[i + 1] as number) - (d[i + 6] as number);
    const t2 = (d[i + 2] as number) + (d[i + 5] as number);
    const t5 = (d[i + 2] as number) - (d[i + 5] as number);
    const t3 = (d[i + 3] as number) + (d[i + 4] as number);
    const t4 = (d[i + 3] as number) - (d[i + 4] as number);
    const t10 = t0 + t3;
    const t13 = t0 - t3;
    const t11 = t1 + t2;
    const t12 = t1 - t2;
    d[i] = t10 + t11;
    d[i + 4] = t10 - t11;
    const z1 = (t12 + t13) * Math.SQRT1_2;
    d[i + 2] = t13 + z1;
    d[i + 6] = t13 - z1;
    const a = t4 + t5;
    const b = t5 + t6;
    const c = t6 + t7;
    const z5 = (a - c) * 0.382683433;
    const z2 = 0.5411961 * a + z5;
    const z4 = 1.306562965 * c + z5;
    const z3 = b * Math.SQRT1_2;
    const z11 = t7 + z3;
    const z13 = t7 - z3;
    d[i + 5] = z13 + z2;
    d[i + 3] = z13 - z2;
    d[i + 1] = z11 + z4;
    d[i + 7] = z11 - z4;
  }
  for (let i = 0; i < 8; i++) {
    const t0 = (d[i] as number) + (d[i + 56] as number);
    const t7 = (d[i] as number) - (d[i + 56] as number);
    const t1 = (d[i + 8] as number) + (d[i + 48] as number);
    const t6 = (d[i + 8] as number) - (d[i + 48] as number);
    const t2 = (d[i + 16] as number) + (d[i + 40] as number);
    const t5 = (d[i + 16] as number) - (d[i + 40] as number);
    const t3 = (d[i + 24] as number) + (d[i + 32] as number);
    const t4 = (d[i + 24] as number) - (d[i + 32] as number);
    const t10 = t0 + t3;
    const t13 = t0 - t3;
    const t11 = t1 + t2;
    const t12 = t1 - t2;
    d[i] = t10 + t11;
    d[i + 32] = t10 - t11;
    const z1 = (t12 + t13) * Math.SQRT1_2;
    d[i + 16] = t13 + z1;
    d[i + 48] = t13 - z1;
    const a = t4 + t5;
    const b = t5 + t6;
    const c = t6 + t7;
    const z5 = (a - c) * 0.382683433;
    const z2 = 0.5411961 * a + z5;
    const z4 = 1.306562965 * c + z5;
    const z3 = b * Math.SQRT1_2;
    const z11 = t7 + z3;
    const z13 = t7 - z3;
    d[i + 40] = z13 + z2;
    d[i + 24] = z13 - z2;
    d[i + 8] = z11 + z4;
    d[i + 56] = z11 - z4;
  }
  for (let k = 0; k < 64; k++)
    quant[ZIGZAG[k] as number] = Math.round((d[k] as number) * (fdtbl[k] as number));
}

function bitLen(v: number): number {
  let a = v < 0 ? -v : v;
  let n = 0;
  while (a) {
    n++;
    a >>= 1;
  }
  return n;
}

function encodeBlock(out: Bits, prevDc: number, dc: Huff, ac: Huff): number {
  const diff = (quant[0] as number) - prevDc;
  const n = bitLen(diff);
  out.put(dc.code[n] as number, dc.len[n] as number);
  if (n) out.put(diff < 0 ? diff + (1 << n) - 1 : diff, n);
  let zeros = 0;
  for (let k = 1; k < 64; k++) {
    const v = quant[k] as number;
    if (v === 0) {
      zeros++;
      continue;
    }
    while (zeros > 15) {
      out.put(ac.code[0xf0] as number, ac.len[0xf0] as number);
      zeros -= 16;
    }
    const s = bitLen(v);
    const sym = (zeros << 4) | s;
    out.put(ac.code[sym] as number, ac.len[sym] as number);
    out.put(v < 0 ? v + (1 << s) - 1 : v, s);
    zeros = 0;
  }
  if (zeros) out.put(ac.code[0] as number, ac.len[0] as number);
  return quant[0] as number;
}

/** For each source index along one axis, the output index it averages into. */
function buckets(src: number, dst: number): Int32Array {
  const b = new Int32Array(src);
  for (let i = 0; i < src; i++) b[i] = Math.min(dst - 1, Math.floor((i * dst) / src));
  return b;
}

export interface Planes {
  width: number;
  height: number;
  y: Float32Array; // width × height, level-shifted (−128)
  cb: Float32Array; // ceil(w/2) × ceil(h/2)
  cr: Float32Array;
}

/**
 * Downscale RGBA (or BGRA with `bgr`) to `width`×`height` YCbCr planes by area average:
 * every source pixel adds into the output pixel it falls in, one pass over the capture.
 */
export function toPlanes(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  width: number,
  height: number,
  bgr = false,
): Planes {
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : new Uint8Array(rgba);
  const px = new Uint32Array(aligned.buffer, aligned.byteOffset, srcW * srcH);
  const col = buckets(srcW, width);
  const row = buckets(srcH, height);
  const colN = new Int32Array(width);
  for (let i = 0; i < srcW; i++) {
    const c = col[i] as number;
    colN[c] = (colN[c] as number) + 1;
  }
  const sr = new Int32Array(width);
  const sg = new Int32Array(width);
  const sb = new Int32Array(width);
  const r8 = new Uint8Array(width * height);
  const g8 = new Uint8Array(width * height);
  const b8 = new Uint8Array(width * height);
  const rs = bgr ? 16 : 0;
  const bs = bgr ? 0 : 16;
  let sy = 0;
  for (let oy = 0; oy < height; oy++) {
    sr.fill(0);
    sg.fill(0);
    sb.fill(0);
    let rows = 0;
    while (sy < srcH && row[sy] === oy) {
      const base = sy * srcW;
      for (let sx = 0; sx < srcW; sx++) {
        const v = px[base + sx] as number;
        const c = col[sx] as number;
        sr[c] = ((sr[c] as number) + ((v >>> rs) & 255)) | 0;
        sg[c] = ((sg[c] as number) + ((v >>> 8) & 255)) | 0;
        sb[c] = ((sb[c] as number) + ((v >>> bs) & 255)) | 0;
      }
      sy++;
      rows++;
    }
    const o = oy * width;
    for (let ox = 0; ox < width; ox++) {
      const inv = 1 / ((colN[ox] as number) * rows || 1);
      r8[o + ox] = (sr[ox] as number) * inv + 0.5;
      g8[o + ox] = (sg[ox] as number) * inv + 0.5;
      b8[o + ox] = (sb[ox] as number) * inv + 0.5;
    }
  }
  const y = new Float32Array(width * height);
  for (let i = 0; i < y.length; i++)
    y[i] = 0.299 * (r8[i] as number) + 0.587 * (g8[i] as number) + 0.114 * (b8[i] as number) - 128;
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const cb = new Float32Array(cw * ch);
  const cr = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    const y0 = cy * 2 * width;
    const y1 = Math.min(cy * 2 + 1, height - 1) * width;
    for (let cx = 0; cx < cw; cx++) {
      const x0 = cx * 2;
      const x1 = Math.min(x0 + 1, width - 1);
      const r =
        ((r8[y0 + x0] as number) +
          (r8[y0 + x1] as number) +
          (r8[y1 + x0] as number) +
          (r8[y1 + x1] as number)) /
        4;
      const g =
        ((g8[y0 + x0] as number) +
          (g8[y0 + x1] as number) +
          (g8[y1 + x0] as number) +
          (g8[y1 + x1] as number)) /
        4;
      const b =
        ((b8[y0 + x0] as number) +
          (b8[y0 + x1] as number) +
          (b8[y1 + x0] as number) +
          (b8[y1 + x1] as number)) /
        4;
      cb[cy * cw + cx] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[cy * cw + cx] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
  }
  return { width, height, y, cb, cr };
}

function loadBlock(plane: Float32Array, pw: number, ph: number, bx: number, by: number): void {
  if (bx + 8 <= pw && by + 8 <= ph) {
    for (let r = 0, k = 0; r < 8; r++) {
      let p = (by + r) * pw + bx;
      for (let c = 0; c < 8; c++) block[k++] = plane[p++] as number;
    }
    return;
  }
  for (let r = 0; r < 8; r++) {
    const py = Math.min(ph - 1, by + r);
    for (let c = 0; c < 8; c++) {
      const px = Math.min(pw - 1, bx + c);
      block[r * 8 + c] = plane[py * pw + px] as number;
    }
  }
}

function segment(out: Bits, marker: number, body: number[]): void {
  out.word(marker);
  out.word(body.length + 2);
  for (const b of body) out.byte(b);
}

function huffSegment(spec: { counts: number[]; symbols: number[] }, cls: number): number[] {
  return [cls, ...spec.counts, ...spec.symbols];
}

/** Encode YCbCr planes as a baseline 4:2:0 JPEG. */
export function encodePlanes(p: Planes, quality = 70): Buffer {
  const { width: w, height: h } = p;
  const lq = scaledQuant(LUMA_Q, quality);
  const cq = scaledQuant(CHROMA_Q, quality);
  const out = new Bits();
  out.word(0xffd8);
  segment(out, 0xffe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  segment(out, 0xffdb, [0, ...lq.table, 1, ...cq.table]);
  segment(out, 0xffc0, [
    8,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  segment(out, 0xffc4, [
    ...huffSegment(DC_LUMA, 0x00),
    ...huffSegment(AC_LUMA, 0x10),
    ...huffSegment(DC_CHROMA, 0x01),
    ...huffSegment(AC_CHROMA, 0x11),
  ]);
  segment(out, 0xffda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  const cw = (w + 1) >> 1;
  const ch = (h + 1) >> 1;
  let dy = 0;
  let dcb = 0;
  let dcr = 0;
  for (let my = 0; my < h; my += 16) {
    for (let mx = 0; mx < w; mx += 16) {
      for (let b = 0; b < 4; b++) {
        loadBlock(p.y, w, h, mx + (b & 1) * 8, my + (b >> 1) * 8);
        fdct(lq.fdtbl);
        dy = encodeBlock(out, dy, H.dcY, H.acY);
      }
      loadBlock(p.cb, cw, ch, mx >> 1, my >> 1);
      fdct(cq.fdtbl);
      dcb = encodeBlock(out, dcb, H.dcC, H.acC);
      loadBlock(p.cr, cw, ch, mx >> 1, my >> 1);
      fdct(cq.fdtbl);
      dcr = encodeBlock(out, dcr, H.dcC, H.acC);
    }
  }
  out.flush();
  out.word(0xffd9);
  return Buffer.from(out.buf.buffer, 0, out.n);
}

/** Output size for a capture: the long side at most `max`, aspect kept. */
export function fitSize(w: number, h: number, max = 1920): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export function encodeJpeg(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  opts: { max?: number; quality?: number; bgr?: boolean } = {},
): Buffer {
  const { width, height } = fitSize(srcW, srcH, opts.max ?? 1920);
  return encodePlanes(toPlanes(rgba, srcW, srcH, width, height, opts.bgr), opts.quality ?? 70);
}
