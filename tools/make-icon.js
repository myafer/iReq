'use strict';

/**
 * 从 AI 生成的图标素材中抠出黄色主体（纸飞机 + 信号弧），
 * 合成到按 Apple macOS 图标模板绘制的圆角方块（1024，824 形状区，圆角 185）。
 * 用法：node tools/make-icon.js <素材png>
 * 产物：build/icon.png（1024 RGBA）、build/icon.ico（256 内嵌）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 解码（RGB / RGBA 均支持） ---------------- */

function decodePng(file) {
  const f = fs.readFileSync(file);
  if (f.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  const w = f.readUInt32BE(16);
  const h = f.readUInt32BE(20);
  const bit = f[24];
  const ctype = f[25];
  if (bit !== 8 || (ctype !== 2 && ctype !== 6)) throw new Error('unsupported png: colortype ' + ctype);
  const ch = ctype === 6 ? 4 : 3;
  let pos = 8;
  let idat = Buffer.alloc(0);
  while (pos < f.length) {
    const ln = f.readUInt32BE(pos);
    const typ = f.toString('ascii', pos + 4, pos + 8);
    if (typ === 'IDAT') idat = Buffer.concat([idat, f.subarray(pos + 8, pos + 8 + ln)]);
    pos += 12 + ln;
  }
  const raw = zlib.inflateSync(idat);
  const stride = w * ch + 1;
  const rows = new Array(h);
  let prev = Buffer.alloc(w * ch);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * stride];
    const line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    if (ft === 1) {
      for (let i = ch; i < line.length; i++) line[i] = (line[i] + line[i - ch]) & 255;
    } else if (ft === 2) {
      for (let i = 0; i < line.length; i++) line[i] = (line[i] + prev[i]) & 255;
    } else if (ft === 3) {
      for (let i = 0; i < line.length; i++) {
        const a = i >= ch ? line[i - ch] : 0;
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255;
      }
    } else if (ft === 4) {
      for (let i = 0; i < line.length; i++) {
        const a = i >= ch ? line[i - ch] : 0;
        const c = i >= ch ? prev[i - ch] : 0;
        line[i] = (line[i] + paeth(a, prev[i], c)) & 255;
      }
    }
    rows[y] = line;
    prev = line;
  }
  return { w, h, ch, rows };
}

/* ---------------- PNG / ICO 编码 ---------------- */

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png256.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png256]);
}

/* ---------------- 主体抠取 ---------------- */

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 黄色主体 alpha：黄色 = r/g 高且明显大于 b */
function artworkAlpha(img) {
  const { w, h, ch, rows } = img;
  const alpha = new Float32Array(w * h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const r0 = rows[y];
    for (let x = 0; x < w; x++) {
      const o = x * ch;
      const r = r0[o], g = r0[o + 1], b = r0[o + 2];
      const a = smooth(24, 64, (r + g) / 2 - b) * smooth(110, 165, Math.min(r, g));
      alpha[y * w + x] = a;
      if (a > 0.5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('未检测到黄色主体');
  return { alpha, box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

/* ---------------- 目标画布：Apple 模板圆角方块 ---------------- */

const S = 1024;
const MARGIN = 100; // 形状区 824
const SHAPE = S - MARGIN * 2;
const RADIUS = 186;

function roundedRectSdf(x, y, half, r) {
  const qx = Math.abs(x) - (half - r);
  const qy = Math.abs(y) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 采样素材：双线性 */
function sampleArt(art, u, v) {
  // u,v ∈ [0,1) 相对素材 bbox
  const { w, h, ch, rows } = art.img;
  const fx = Math.min(w - 1.001, Math.max(0, u * art.box.w)) + art.box.x;
  const fy = Math.min(h - 1.001, Math.max(0, v * art.box.h)) + art.box.y;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const get = (x, y, c) => rows[Math.min(h - 1, y)][x * ch + c];
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] =
      get(x0, y0, c) * (1 - tx) * (1 - ty) +
      get(x0 + 1, y0, c) * tx * (1 - ty) +
      get(x0, y0 + 1, c) * (1 - tx) * ty +
      get(x0 + 1, y0 + 1, c) * tx * ty;
  }
  out[3] =
    art.alpha[y0 * w + x0] * (1 - tx) * (1 - ty) +
    art.alpha[y0 * w + x0 + 1] * tx * (1 - ty) +
    art.alpha[(y0 + 1) * w + x0] * (1 - tx) * ty +
    art.alpha[(y0 + 1) * w + x0 + 1] * tx * ty;
  return out;
}

function compose() {
  const src = process.argv[2];
  if (!src) throw new Error('usage: node tools/make-icon.js <素材png>');
  const img = decodePng(src);
  const art = artworkAlpha(img);
  console.log('主体 bbox:', JSON.stringify(art.box));

  // 主体在形状区内居中，四周留 96px 内边距
  const pad = 96;
  const avail = SHAPE - pad * 2;
  const scale = Math.min(avail / art.box.w, avail / art.box.h);
  const drawW = art.box.w * scale;
  const drawH = art.box.h * scale;
  const ox = MARGIN + (SHAPE - drawW) / 2;
  const oy = MARGIN + (SHAPE - drawH) / 2;

  const px = Buffer.alloc(S * S * 4);
  const half = S / 2;
  // 深棕渐变（上浅下深）
  const top = [86, 52, 30];
  const bot = [58, 38, 24];
  for (let y = 0; y < S; y++) {
    const t = y / (S - 1);
    const br = top[0] + (bot[0] - top[0]) * t;
    const bg = top[1] + (bot[1] - top[1]) * t;
    const bb = top[2] + (bot[2] - top[2]) * t;
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const shapeA = 1 - smooth(-1.5, 1.5, roundedRectSdf(x - half, y - half, half - MARGIN, RADIUS));
      if (shapeA <= 0) continue;
      // 主体采样
      const u = (x - ox) / drawW;
      const v = (y - oy) / drawH;
      let r = br, g = bg, b = bb, a = shapeA;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        const s = sampleArt({ img, box: art.box, alpha: art.alpha }, u, v);
        const sa = s[3];
        if (sa > 0) {
          r = s[0] * sa + r * (1 - sa);
          g = s[1] * sa + g * (1 - sa);
          b = s[2] * sa + b * (1 - sa);
        }
      }
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/* ---------------- main ---------------- */

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(compose(), S);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
const { execFileSync } = require('child_process');
const tmp256 = path.join(outDir, 'icon-256.png');
execFileSync('sips', ['-z', '256', '256', path.join(outDir, 'icon.png'), '--out', tmp256], { stdio: 'pipe' });
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(fs.readFileSync(tmp256)));
fs.unlinkSync(tmp256);
console.log('build/icon.png (1024 RGBA) + build/icon.ico 已生成');
