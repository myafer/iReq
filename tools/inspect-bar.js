'use strict';

/** 逐行主色分析：找出“横贯整行的浅色条” */

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
  } else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  pos += 12 + len;
}
const channels = colorType === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * channels;
const out = Buffer.alloc(height * stride);
let prev = Buffer.alloc(stride);
for (let y = 0; y < height; y++) {
  const f = raw[y * (stride + 1)];
  const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? cur[x - channels] : 0;
    const b = prev[x];
    const c = x >= channels ? prev[x - channels] : 0;
    if (f === 1) cur[x] = (cur[x] + a) & 0xff;
    else if (f === 2) cur[x] = (cur[x] + b) & 0xff;
    else if (f === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff;
    else if (f === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
  cur.copy(out, y * stride);
  prev = cur;
}
const at = (x, y) => {
  const i = y * stride + x * channels;
  return [out[i], out[i + 1], out[i + 2]];
};

// 每行取主色（按 8 级量化）与占比
const profile = [];
for (let y = 0; y < height; y++) {
  const counts = new Map();
  for (let x = 0; x < width; x += 2) {
    const [r, g, b] = at(x, y);
    const key = `${r >> 3},${g >> 3},${b >> 3}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) ((best = k), (bestN = n));
  const [qr, qg, qb] = best.split(',').map(Number);
  const share = bestN / Math.ceil(width / 2);
  const lum = (qr * 8 + qg * 8 + qb * 8) / 3;
  profile.push({ y, color: [qr * 8 + 4, qg * 8 + 4, qb * 8 + 4], share, lum });
}

// 打印每 8px 的取样，便于肉眼定位
console.log('size', width, 'x', height);
console.log('y : 主色 / 主色占比');
for (let y = 0; y < height; y += 8) {
  const p = profile[y];
  console.log(
    `${String(y).padStart(4)} : rgb(${p.color.join(',')}) ${(p.share * 100).toFixed(0)}%`
  );
}

// 找整行主色占比高且比上下邻域更亮的连续带
const candidates = [];
let start = null;
for (let y = 0; y < height; y++) {
  const p = profile[y];
  const isFlat = p.share > 0.85;
  const up = y > 6 ? profile[y - 6] : null;
  const brighter = up && p.lum - up.lum >= 4;
  if (isFlat && brighter) {
    if (start === null) start = y;
  } else if (start !== null && y - start > 2) {
    candidates.push({ y0: start, y1: y - 1 });
    start = null;
  } else if (!isFlat) start = null;
}
console.log('\n可疑浅色横条:', JSON.stringify(candidates));
