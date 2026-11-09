'use strict';

/** 把截图降采样成 ASCII 灰度图，便于在终端里“看”版面结构 */

const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
const COLS = Number(process.argv[3]) || 68;
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

const ramp = ' .:-=+*#%@';
const cellW = width / COLS;
const cellH = cellW * 2.1;
const rows = Math.floor(height / cellH);

let header = '    ';
for (let cx = 0; cx < COLS; cx += 10) header += String(Math.round(cx * cellW)).padEnd(10);
console.log('图宽 ' + width + ' 高 ' + height + '（每列 ' + cellW.toFixed(1) + 'px，每行 ' + cellH.toFixed(1) + 'px）');
console.log(header);

for (let ry = 0; ry < rows; ry++) {
  let line = '';
  for (let cx = 0; cx < COLS; cx++) {
    let sum = 0;
    let n = 0;
    const x0 = Math.floor(cx * cellW);
    const y0 = Math.floor(ry * cellH);
    for (let y = y0; y < Math.min(y0 + cellH, height); y += 2) {
      for (let x = x0; x < Math.min(x0 + cellW, width); x += 2) {
        const i = y * stride + x * channels;
        sum += (out[i] * 0.299 + out[i + 1] * 0.587 + out[i + 2] * 0.114);
        n++;
      }
    }
    const lum = n ? sum / n : 0;
    // 暗背景上提升对比：0..255 -> 0..9
    const idx = Math.min(ramp.length - 1, Math.round((lum / 255) * (ramp.length - 1) * 2.2));
    line += ramp[idx];
  }
  console.log(String(Math.round(ry * cellH)).padStart(4) + line);
}

// 找出“亮块”区域（lum>150 的连通网格），粗略报告
const bright = [];
for (let ry = 0; ry < rows; ry++) {
  for (let cx = 0; cx < COLS; cx++) {
    const x0 = Math.floor(cx * cellW);
    const y0 = Math.floor(ry * cellH);
    let sum = 0;
    let n = 0;
    for (let y = y0; y < Math.min(y0 + cellH, height); y += 2)
      for (let x = x0; x < Math.min(x0 + cellW, width); x += 2) {
        const i = y * stride + x * channels;
        sum += out[i] * 0.299 + out[i + 1] * 0.587 + out[i + 2] * 0.114;
        n++;
      }
    if (n && sum / n > 150) bright.push([Math.round(x0), Math.round(y0)]);
  }
}
console.log('\n亮区格子数:', bright.length);
if (bright.length) {
  const xs = bright.map((b) => b[0]);
  const ys = bright.map((b) => b[1]);
  console.log(
    '亮区范围: x ' + Math.min(...xs) + '..' + Math.max(...xs) + '  y ' + Math.min(...ys) + '..' + Math.max(...ys)
  );
}
