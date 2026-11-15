'use strict';

/**
 * WebSocket 帧解析（RFC 6455）。
 *
 * 只做「看得见」这件事，不改转发行为：
 *  - 客户端 → 服务端的帧带掩码，必须解掩码才能读出文本；服务端 → 客户端不带
 *  - 分片消息只认首片的 opcode，后续 continuation 片单独记一行（和浏览器 DevTools 一致）
 *  - permessage-deflate 协商成功后 RSV1 置位的帧是压缩的：这里不做流式 inflate
 *    （上下文接管 + 分段尾字节，写错就会解出乱码），只标 compressed 并给体积
 *  - 超过上限后继续计数但不再留帧，dropped 告诉用户「还有多少没记」
 *
 * 解析器是纯逻辑，脱离网络就能单测。
 */

const MAX_FRAME_KEEP = 4 * 1024 * 1024; // 单帧超过 4MB 就不缓冲了，只记体积
const MAX_FRAME_BAIL = 64 * 1024 * 1024; // 超过这个长度基本可以断定不是合法帧，停止解析
const MAX_PREVIEW = 2048; // 文本帧预览上限（字符）
const MAX_PREVIEW_BYTES = 512 * 1024; // 单条连接所有预览的总字节上限

const OPCODES = { 0: 'cont', 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

function opcodeName(n) {
  return OPCODES[n] || 'op' + n;
}

/** 控制帧只记最少信息：close 带状态码 */
function controlPreview(op, payload) {
  if (op === 'close' && payload && payload.length >= 2) {
    return 'close ' + payload.readUInt16BE(0);
  }
  return null;
}

class FrameParser {
  /**
   * @param {{ dir?: 'up'|'down', limit?: number, startAt?: number, seq?: {n:number} }} [opts]
   *   dir=up 表示客户端 → 服务端（帧带掩码）；down 反之
   *   seq 是两个方向共用的序号源：同一毫秒内的帧靠它保持真实到达顺序
   */
  constructor(opts = {}) {
    this.dir = opts.dir === 'down' ? 'down' : 'up';
    this.limit = Number(opts.limit) || 200;
    this.startAt = Number(opts.startAt) || Date.now();
    this.buf = Buffer.alloc(0);
    this.frames = [];
    this.count = 0;
    this.bytes = 0;
    this.dropped = 0;
    this.compressed = 0;
    this.previewBytes = 0;
    this.previewDropped = 0;
    this._skip = 0; // 超大帧：跳过 payload，不缓冲
    this._frag = null; // 正在拼的分片消息（只留预览与首片 opcode）
    this._fragOp = null; // 分片消息首片的 opcode：continuation 片靠它决定按文本解还是二进制
    this.seq = opts.seq && typeof opts.seq.n === 'number' ? opts.seq : { n: 0 };
  }

  /** 喂原始字节，返回本次解析出的帧（大部分时候是 0 或 1 个） */
  push(chunk) {
    if (!chunk || !chunk.length) return [];
    if (this.dead) return [];
    this.bytes += chunk.length;
    const out = [];

    // 上一个超大帧还没跳过完：先把它吃掉
    if (this._skip > 0) {
      const eat = Math.min(this._skip, chunk.length);
      this._skip -= eat;
      chunk = chunk.subarray(eat);
      if (!chunk.length) return out;
    }

    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = this._parseOne();
      if (!frame) break;
      if (frame.skip) {
        this._skip = frame.skip;
        out.push(this._record(frame));
        break;
      }
      out.push(this._record(frame));
    }
    return out;
  }

  /** 解析一个完整帧；数据不够就返回 null 等下一块 */
  _parseOne() {
    const b = this.buf;
    if (b.length < 2) return null;
    const b0 = b[0];
    const b1 = b[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv1 = (b0 & 0x40) !== 0;
    const op = opcodeName(b0 & 0x0f);
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      // 超过 2^53 的帧在 JS 里没法精确表示，也不该出现在正常流量里
      len = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
      off = 10;
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }

    // 超大帧：不缓冲 payload，交给 push 逐块丢弃
    if (len > MAX_FRAME_KEEP) {
      if (b.length < off) return null;
      const available = b.length - off;
      this.buf = Buffer.alloc(0);
      // 离谱的长度（多半是协商不一致 / 不是 WebSocket）：记一条然后停止解析，
      // 继续按这个长度 skip 只会把后面的流量全部吃掉
      const bogus = len > MAX_FRAME_BAIL;
      if (bogus) this.dead = true;
      return { fin, rsv1, op, masked, size: len, payload: null, skip: bogus ? 0 : Math.max(0, len - available) };
    }

    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    this.buf = b.subarray(off + len);
    if (masked && mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    return { fin, rsv1, op, masked, size: len, payload };
  }

  /** 把解析结果变成一条可展示的记录 */
  _record(f) {
    this.count += 1;
    const compressed = !!f.rsv1;
    if (compressed) this.compressed += 1;

    let preview = null;
    let truncated = false;
    // 分片消息：continuation 片沿用它首片的 opcode 决定要不要按文本解，
    // 否则多段文本消息除了第一段全是空白
    const effOp = f.op === 'cont' ? this._fragOp : f.op;
    if (f.op !== 'cont' && !f.fin) this._fragOp = f.op;
    if (f.op === 'cont' && f.fin) this._fragOp = null;
    if (f.payload && !compressed) {
      if (effOp === 'text') {
        const text = f.payload.toString('utf8');
        preview = text.slice(0, MAX_PREVIEW);
        truncated = text.length > preview.length;
      } else if (f.op === 'close' || f.op === 'ping' || f.op === 'pong') {
        preview = controlPreview(f.op, f.payload);
      }
      // binary 不给预览：转 base64 只会让人更看不懂
    }

    if (preview && this.previewBytes + preview.length > MAX_PREVIEW_BYTES) {
      preview = null;
      this.previewDropped += 1;
    }
    if (preview) this.previewBytes += preview.length;

    const rec = {
      i: this.count,
      // 全局到达序号：两个方向各自解析，同一毫秒的帧只能靠它排顺序
      seq: this.seq.n++,
      dir: this.dir,
      op: f.op,
      size: f.size,
      at: Date.now() - this.startAt,
      fin: !!f.fin,
      masked: !!f.masked,
      compressed,
      preview,
      truncated,
    };

    // 分片：首片记住 opcode，后续 continuation 片在 UI 里要能看出是同一个消息
    if (f.op === 'cont') rec.cont = true;

    if (f.skip) rec.big = true;
    if (this.frames.length >= this.limit) this.dropped += 1;
    else this.frames.push(rec);
    return rec;
  }

  /** 已记录的帧（按到达顺序）；超出上限的部分只在 count / dropped 里体现 */
  result() {
    return {
      dir: this.dir,
      frames: this.frames,
      count: this.count,
      dropped: this.dropped,
      bytes: this.bytes,
      compressed: this.compressed,
      previewDropped: this.previewDropped,
    };
  }
}

/** 把两个方向合并成一条时间线：按到达序号排，同一毫秒也不会串序 */
function mergeDirections(up, down) {
  const all = []
    .concat((up && up.frames) || [], (down && down.frames) || [])
    .sort((a, b) => (a.seq || 0) - (b.seq || 0) || a.at - b.at);
  return all;
}

module.exports = { FrameParser, opcodeName, mergeDirections, MAX_PREVIEW, MAX_FRAME_KEEP };
