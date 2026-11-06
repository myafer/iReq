'use strict';

/** 极简 PNG 解码（8bit RGB/RGBA，非隔行）+ 找“整行或大面积接近纯白”的横条 */

const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
const buf = fs.readFileSync(file);

let pos = 8;
let width = 0;
let height = 0;
let colorType = 0;
let bitDepth = 0;
const idat = [];

while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
  } else if (type === 'IDAT') {
    idat.push(data);
  } else if (type === 'IEND') break;
  pos += 12 + len;
}

if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
  console.log('unsupported', { bitDepth, colorType });
  process.exit(1);
}

const channels = colorType === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * channels;

const out = Buffer.alloc(height * stride);
let prev = Buffer.alloc(stride);

for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  const cur = Buffer.from(line);
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? cur[x - channels] : 0;
    const b = prev[x];
    const c = x >= channels ? prev[x - channels] : 0;
    switch (filter) {
      case 1: cur[x] = (cur[x] + a) & 0xff; break;
      case 2: cur[x] = (cur[x] + b) & 0xff; break;
      case 3: cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff; break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        break;
      }
      default: break;
    }
  }
  cur.copy(out, y * stride);
  prev = cur;
}

const px = (x, y) => {
  const i = y * stride + x * channels;
  return [out[i], out[i + 1], out[i + 2]];
};

// 逐行统计“白像素（>=246）连续区间”
const rows = [];
for (let y = 0; y < height; y++) {
  let white = 0;
  let firstW = -1;
  let lastW = -1;
  for (let x = 0; x < width; x++) {
    const [r, g, b] = px(x, y);
    if (r >= 246 && g >= 246 && b >= 246) {
      white++;
      if (firstW < 0) firstW = x;
      lastW = x;
    }
  }
  rows.push({ y, white, ratio: white / width, firstW, lastW });
}

// 找出白占比高的连续带
const bands = [];
let cur = null;
for (const r of rows) {
  if (r.ratio > 0.55) {
    if (!cur) cur = { y0: r.y, y1: r.y, minX: r.firstW, maxX: r.lastW, maxRatio: r.ratio };
    else {
      cur.y1 = r.y;
      cur.minX = Math.min(cur.minX, r.firstW);
      cur.maxX = Math.max(cur.maxX, r.lastW);
      cur.maxRatio = Math.max(cur.maxRatio, r.ratio);
    }
  } else if (cur) {
    bands.push(cur);
    cur = null;
  }
}
if (cur) bands.push(cur);

console.log('size', width + 'x' + height, 'channels', channels);
console.log('整体背景色采样:', [0, 1, Math.floor(height / 2), height - 2].map((y) => px(Math.floor(width / 2), y).join(',')));
console.log('宽白带 (ratio>55%):');
bands
  .sort((a, b) => b.y1 - b.y0 - (a.y1 - a.y0))
  .slice(0, 8)
  .forEach((b) =>
    console.log(
      `  y ${b.y0}..${b.y1} (高 ${b.y1 - b.y0 + 1}px, 占画面 ${(((b.y1 - b.y0 + 1) / height) * 100).toFixed(1)}%) x ${b.minX}..${b.maxX} 最白 ${(b.maxRatio * 100).toFixed(0)}%`
    )
  );

// 每 40px 抽一行看颜色，帮助定位分区
console.log('纵向切片（y: 中间像素色）:');
for (let y = 0; y < height; y += 40) {
  const [r, g, b] = px(Math.floor(width / 2), y);
  const r2 = rows[y];
  console.log(`  ${String(y).padStart(4)}: rgb(${r},${g},${b}) 白占比 ${(r2.ratio * 100).toFixed(0)}%`);
}
