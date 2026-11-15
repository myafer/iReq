'use strict';

/**
 * SSE（text/event-stream）消息分帧。
 *
 * 代理只负责转发字节，这里额外把流按 SSE 规范切成一条条消息，
 * 让「服务端推了几条、间隔多大、每条什么内容」看得见。
 *
 * 规范细节（写错就会把一条消息拆成两条）：
 *  - 消息之间用空行分隔，行尾可以是 \n、\r\n 或 \r
 *  - 一行里 `data:` 后面紧跟一个空格才算分隔符，多个 data 行用 \n 连接
 *  - 以 `:` 开头的是注释，常用于心跳，单独计数，不当消息
 *  - `event:` / `id:` / `retry:` 是消息的元数据
 *
 * 与帧解析一样，纯逻辑，可脱离网络单测。
 */

const MAX_PREVIEW = 4096; // 单条消息预览上限（字符）

class SseParser {
  /**
   * @param {{ limit?: number, startAt?: number }} [opts]
   */
  constructor(opts = {}) {
    this.limit = Number(opts.limit) || 400;
    this.startAt = Number(opts.startAt) || Date.now();
    this.buf = '';
    this.messages = [];
    this.count = 0;
    this.dropped = 0;
    this.comments = 0;
    this.bytes = 0;
    this._event = '';
    this._id = '';
    this._data = [];
    this._retry = null;
    this._hasFields = false;
  }

  /** 喂一个数据块，返回本次切出来的消息 */
  push(chunk) {
    if (chunk === null || chunk === undefined) return [];
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (!text) return [];
    this.bytes += Buffer.byteLength(text);
    this.buf += text;

    const out = [];
    let idx;
    // 逐行消费：行尾 \r\n / \n / \r（\r 单独出现时也可能是行尾）
    while ((idx = this.buf.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buf.slice(0, idx);
      const eolLen = this.buf.startsWith('\r\n', idx) ? 2 : 1;
      this.buf = this.buf.slice(idx + eolLen);
      const msg = this._line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  _line(line) {
    if (line === '') return this._dispatch();
    if (line.startsWith(':')) {
      this.comments += 1;
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    // 规范：冒号后紧跟的单个空格要吃掉，后面的空格是内容的一部分
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this._data.push(value);
      this._hasFields = true;
    } else if (field === 'event') {
      this._event = value;
      this._hasFields = true;
    } else if (field === 'id') {
      this._id = value;
      this._hasFields = true;
    } else if (field === 'retry') {
      const n = Number(value);
      if (Number.isFinite(n)) this._retry = n;
      this._hasFields = true;
    }
    return null;
  }

  _dispatch() {
    // 空行但没有任何字段：连续空行，不算消息
    if (!this._hasFields) return null;
    const data = this._data.join('\n');
    // 规范：data 缓冲为空时不算一条消息（只有 event: / retry: 的那种块）
    if (!data) {
      this._event = '';
      this._id = '';
      this._data = [];
      this._retry = null;
      this._hasFields = false;
      return null;
    }
    const size = Buffer.byteLength(data);
    const rec = {
      i: this.count + 1,
      at: Date.now() - this.startAt,
      event: this._event || 'message',
      id: this._id || '',
      retry: this._retry,
      size,
      preview: data.slice(0, MAX_PREVIEW),
      truncated: data.length > MAX_PREVIEW,
    };
    this.count += 1;
    if (this.messages.length >= this.limit) this.dropped += 1;
    else this.messages.push(rec);

    this._event = '';
    this._id = '';
    this._data = [];
    this._retry = null;
    this._hasFields = false;
    return rec;
  }

  /** 流结束时把没有空行收尾的最后一条也算上（很多服务端就不发结尾空行） */
  flush() {
    if (this.buf.length) {
      // 剩下的一行没有行尾，按一行处理
      const rest = this.buf;
      this.buf = '';
      this._line(rest);
    }
    return this._dispatch();
  }

  result() {
    return {
      messages: this.messages,
      count: this.count,
      dropped: this.dropped,
      comments: this.comments,
      bytes: this.bytes,
    };
  }
}

module.exports = { SseParser, MAX_PREVIEW };
