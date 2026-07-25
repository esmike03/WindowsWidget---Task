'use strict';

/**
 * Generates assets/icon.png, assets/tray.png and assets/icon.ico with no
 * image dependencies — a small signed-distance rasteriser plus a hand-rolled
 * PNG/ICO writer. Run with `npm run icon`.
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets');

// ── raster helpers ────────────────────────────────────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Alpha-over composite of a straight-alpha source onto an RGBA buffer. */
function over(buf, i, r, g, b, a) {
  if (a <= 0) return;
  const da = buf[i + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  buf[i] = Math.round((r * a + buf[i] * da * (1 - a)) / outA);
  buf[i + 1] = Math.round((g * a + buf[i + 1] * da * (1 - a)) / outA);
  buf[i + 2] = Math.round((b * a + buf[i + 2] * da * (1 - a)) / outA);
  buf[i + 3] = Math.round(outA * 255);
}

const SS = 3; // supersampling grid per axis

function render(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const s = size;
  const pad = s * 0.055;
  const hw = s / 2 - pad;
  const radius = s * 0.235;

  // note bars: [yCentre, halfWidth, alpha]
  const bars = [
    [0.365, 0.235, 0.96],
    [0.5, 0.235, 0.72],
    [0.635, 0.145, 0.5],
  ];
  const barH = s * 0.042;
  const barR = barH;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;

      let cov = 0;
      let gr = 0;
      let gg = 0;
      let gb = 0;
      const barCov = [0, 0, 0];

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const d = sdRoundRect(px, py, s / 2, s / 2, hw, hw, radius);
          const c = clamp01(0.5 - d);
          if (c > 0) {
            cov += c;
            // diagonal indigo → violet gradient, lifted slightly at the top
            const t = clamp01((px / s) * 0.55 + (py / s) * 0.45);
            const lift = clamp01(1 - py / s) * 0.06;
            gr += (mix(0x6d, 0xa7, t) + lift * 255 * 0.3) * c;
            gg += (mix(0x7c, 0x8b, t) + lift * 255 * 0.3) * c;
            gb += (mix(0xf5, 0xfa, t) + lift * 255 * 0.2) * c;
          }

          for (let b = 0; b < bars.length; b++) {
            const [cy, halfW] = bars[b];
            const bd = sdRoundRect(px, py, s * 0.5, s * cy, s * halfW, barH / 2, barR);
            barCov[b] += clamp01(0.5 - bd);
          }
        }
      }

      const n = SS * SS;
      const a = cov / n;
      if (a > 0) {
        over(buf, i, Math.round(gr / cov), Math.round(gg / cov), Math.round(gb / cov), a);
      }
      for (let b = 0; b < bars.length; b++) {
        const ba = (barCov[b] / n) * bars[b][2] * Math.min(1, a * 1.6);
        if (ba > 0) over(buf, i, 255, 255, 255, ba);
      }
    }
  }
  return buf;
}

// ── PNG writer ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO writer (PNG-compressed entries, Vista+) ───────────────────────────

function toIco(pngs) {
  const dir = Buffer.alloc(6 + pngs.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(pngs.length, 4);

  let offset = dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0;
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(buf.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });

  return Buffer.concat([dir, ...pngs.map((p) => p.buf)]);
}

// ── run ───────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, buf: toPng(render(size), size) }));

fs.writeFileSync(path.join(OUT, 'icon.png'), pngs.find((p) => p.size === 256).buf);
fs.writeFileSync(path.join(OUT, 'tray.png'), pngs.find((p) => p.size === 32).buf);
fs.writeFileSync(path.join(OUT, 'icon.ico'), toIco(pngs));

console.log('wrote assets/icon.png, assets/tray.png, assets/icon.ico');
