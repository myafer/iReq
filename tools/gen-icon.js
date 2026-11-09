'use strict';

/**
 * 生成应用图标 PNG（512x512，RGBA，圆角矩形 + 信号弧）。
 * 纯 Node 实现：像素绘制 + zlib 压缩 + 手写 PNG/ICO 容器。
 * 用法：node tools/gen-icon.js
 * 产物：build/icon.png（512）、build/icon.ico（内嵌 256 PNG）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const cx = 176;
const cy = 336;

// 圆角矩形 SDF
function roundedRectSdf(x, y, half, r) {
  const qx = Math.abs(x) - (half - r);
  const qy = Math.abs(y) - (half - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** 在 RGBA 缓冲上做 source-over 混合 */
function blend(px, i, r, g, b, a) {
  if (a <= 0) return;
  const da = px[i + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  px[i] = Math.round((r * a + px[i] * da * (1 - a)) / outA);
  px[i + 1] = Math.round((g * a + px[i + 1] * da * (1 - a)) / outA);
  px[i + 2] = Math.round((b * a + px[i + 2] * da * (1 - a)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function draw() {
  const px = Buffer.alloc(S * S * 4);
  const HALF = S / 2;
  const BG = [43, 38, 34]; // 深棕 #2B2622
  const Y = [255, 222, 23]; // 品牌黄 #FFDE17

  // 信号弧：圆心 (cx,cy)，向右上展开（数学角度 -80° ~ -8°）
  const arcs = [
    { r: 74, w: 36, alpha: 1.0 },
    { r: 140, w: 36, alpha: 0.72 },
    { r: 206, w: 36, alpha: 0.42 },
  ];
  const A0 = (-80 * Math.PI) / 180;
  const A1 = (-8 * Math.PI) / 180;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const nx = x - HALF;
      const ny = y - HALF;

      // 背景圆角矩形（带 1.5px 抗锯齿）
      const bgA = 1 - smooth(-1.5, 1.5, roundedRectSdf(nx, ny, HALF - 14, 104));
      if (bgA > 0) blend(px, i, BG[0], BG[1], BG[2], bgA);

      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(-dy, dx); // 屏幕坐标翻转 Y 成数学坐标

      // 信号弧
      for (const a of arcs) {
        const inArc = ang >= A0 && ang <= A1 ? 1 : smooth(-0.02, 0.02, Math.min(ang - A0, A1 - ang) + 0.01);
        const band = 1 - smooth(a.w / 2 - 1.2, a.w / 2 + 1.2, Math.abs(dist - a.r));
        const alpha = band * inArc * a.alpha;
        if (alpha > 0) blend(px, i, Y[0], Y[1], Y[2], alpha);
      }

      // 中心圆点
      const dot = 1 - smooth(26, 30, dist);
      if (dot > 0) blend(px, i, Y[0], Y[1], Y[2], dot);
    }
  }
  return px;
}

/* ---------------- PNG 编码 ---------------- */

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO 封装（内嵌 PNG，Vista+ 支持） ---------------- */

function encodeIco(png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 -> 0
  entry[1] = 0; // height 256 -> 0
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png256.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png256]);
}

/* ---------------- main ---------------- */

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(draw(), S);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);

// 256px 用 sips 缩一份再封 ico
const { execFileSync } = require('child_process');
const tmp256 = path.join(outDir, 'icon-256.png');
execFileSync('sips', ['-z', '256', '256', path.join(outDir, 'icon.png'), '--out', tmp256], { stdio: 'pipe' });
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(fs.readFileSync(tmp256)));
fs.unlinkSync(tmp256);

console.log('icon.png (512) + icon.ico 已生成到 build/');
