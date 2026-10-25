#!/usr/bin/env node
/*
 * Draws the EBPG Posting Helper icons (16, 32, 48, 128 px) with no dependencies:
 * the Guild's sprout mark (green disc, lemon sun, cream ground line and stem, sage leaves),
 * rasterized with 4x4 supersampling and written as PNG through zlib.
 *   node tools/make-icons.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128];

const C = {
  fern: [0x2F, 0x5D, 0x46],
  sage: [0xA8, 0xC4, 0x9A],
  cream: [0xF7, 0xF3, 0xE8],
  lemon: [0xF2, 0xC1, 0x4E]
};

// Geometry in the mark's 64-unit space (same as the SVG in pages/*.html and src/panel.js).
function cubic(p0, p1, p2, p3, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ]);
  }
  return pts;
}
const ground = [...cubic([10, 45], [20, 40], [27, 40], [33, 43], 24), ...cubic([33, 43], [40, 46], [47, 45], [54, 41], 24).slice(1)];
const stem = [[29, 41], [29, 24]];
const leafR = [...cubic([29, 29], [29, 22.5], [33.5, 19], [39.5, 19], 24), ...cubic([39.5, 19], [39.5, 25], [35, 29], [29, 29], 24).slice(1)];
const leafL = [...cubic([29, 33], [29, 27.5], [24.5, 24], [18.5, 24.5], 24), ...cubic([18.5, 24.5], [18.5, 30], [23, 33], [29, 33], 24).slice(1)];

function distToSeg(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((x - a[0]) * dx + (y - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + t * dx - x, py = a[1] + t * dy - y;
  return Math.sqrt(px * px + py * py);
}
function distToLine(x, y, pts) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSeg(x, y, pts[i - 1], pts[i]));
  return d;
}
function inside(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Small icons get heavier lines so the sprout still reads at 16 px.
// At 16 px the sprout is drawn larger and solid cream (no sun) so it stays legible.
function colorAt(x, y, size) {
  const dx = x - 32, dy = y - 32;
  if (dx * dx + dy * dy > 32 * 32) return null;
  let col = C.fern;
  if (size <= 16) {
    const k = 1.22, gx = 32 + (x - 32) / k, gy = 35 + (y - 35) / k;
    if (distToLine(gx, gy, ground) <= 2.6) col = C.cream;
    if (distToLine(gx, gy, stem) <= 2.6) col = C.cream;
    for (const leaf of [leafR, leafL]) if (inside(gx, gy, leaf) || distToLine(gx, gy, leaf) <= 1.6) col = C.cream;
    return col;
  }
  const stroke = (size <= 32 ? 4.4 : size <= 48 ? 3.8 : 3.2) / 2;
  const sx = x - 45, sy = y - 20;
  if (sx * sx + sy * sy <= 6.5 * 6.5) col = C.lemon;
  if (distToLine(x, y, ground) <= stroke) col = C.cream;
  if (distToLine(x, y, stem) <= stroke) col = C.cream;
  for (const leaf of [leafR, leafL]) {
    if (inside(x, y, leaf)) col = C.sage;
    if (distToLine(x, y, leaf) <= stroke) col = C.cream;
  }
  return col;
}

function render(size) {
  const N = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = (pxl + (sx + 0.5) / N) * 64 / size;
          const y = (py + (sy + 0.5) / N) * 64 / size;
          const col = colorAt(x, y, size);
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const i = (py * size + pxl) * 4;
      if (a) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a); }
      px[i + 3] = Math.round(255 * a / (N * N));
    }
  }
  return px;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const s of SIZES) {
    const file = path.join(OUT, `icon-${s}.png`);
    fs.writeFileSync(file, png(s, render(s)));
    console.log('wrote', path.relative(process.cwd(), file));
  }
}

module.exports = { png, render, crc32 };
