'use strict';

/** 纵向扫描：找出“贯穿全高”的亮色竖条，并打印其精确范围与颜色 */

const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
const buf = fs.readFileSync(file);
let pos = 8;
let width = 0;
let height = 0;
let colorType = 0;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
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

const lum = (x, y) => {
  const i = y * stride + x * channels;
  return out[i] * 0.299 + out[i + 1] * 0.587 + out[i + 2] * 0.114;
};
const rgb = (x, y) => {
  const i = y * stride + x * channels;
  return [out[i], out[i + 1], out[i + 2]];
};

// 每列统计：亮像素比例（>110）与中位亮度
const cols = [];
for (let x = 0; x < width; x++) {
  let bright = 0;
  let sum = 0;
  for (let y = 0; y < height; y += 3) {
    const l = lum(x, y);
    if (l > 110) bright++;
    sum += l;
  }
  const n = Math.ceil(height / 3);
  cols.push({ x, brightRatio: bright / n, mean: sum / n });
}

// 连续亮列
const bands = [];
let cur = null;
for (const c of cols) {
  if (c.brightRatio > 0.5) {
    if (!cur) cur = { x0: c.x, x1: c.x };
    else cur.x1 = c.x;
  } else if (cur) {
    bands.push(cur);
    cur = null;
  }
}
if (cur) bands.push(cur);

console.log(`图 ${width}x${height}`);
console.log('贯穿全高的亮竖条:');
if (!bands.length) console.log('  无');
bands.forEach((b) => {
  const cx = Math.round((b.x0 + b.x1) / 2);
  const samples = [Math.round(height * 0.15), Math.round(height * 0.3), Math.round(height * 0.5), Math.round(height * 0.7)]
    .map((y) => rgb(cx, y).join(','))
    .join(' | ');
  console.log(`  x ${b.x0}..${b.x1}（宽 ${b.x1 - b.x0 + 1}px，占画面 ${(((b.x1 - b.x0 + 1) / width) * 100).toFixed(0)}%）颜色 ${samples}`);
});

// 横向取样：中间行两侧颜色，确认左右分区
const midY = Math.round(height * 0.5);
const scan = [];
for (let x = 0; x < width; x += 16) scan.push(`${x}:${rgb(x, midY).join(',')}`);
console.log('\ny=' + midY + ' 横扫颜色:');
console.log('  ' + scan.join('  '));
