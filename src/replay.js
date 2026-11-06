'use strict';

/**
 * 重放：拿一条历史请求（可改 method / url / headers / body）直接打上游，
 * 结果作为一条新 flow 记录。重放不经过 Mock 规则，方便对比真实返回。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const { decompress, isTextual } = require('./proxy');

const SKIP_REQ_HEADERS = [
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'proxy-connection',
  'accept-encoding',
];

function bufferFromFlow(flow, overrides) {
  if (overrides && overrides.body !== undefined && overrides.body !== null) {
    if (overrides.bodyBase64) return Buffer.from(String(overrides.body), 'base64');
    return Buffer.from(String(overrides.body), 'utf8');
  }
  if (flow.reqBodyBase64) return Buffer.from(flow.reqBodyBase64, 'base64');
  if (typeof flow.reqBody === 'string') return Buffer.from(flow.reqBody, 'utf8');
  return Buffer.alloc(0);
}

function replay({ store, flow, overrides = {} }) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    let target;
    try {
      target = new URL(overrides.url || flow.url);
    } catch (err) {
      resolve({ error: 'URL 不合法: ' + (err && err.message) });
      return;
    }

    const method = String(overrides.method || flow.method || 'GET').toUpperCase();
    const body = bufferFromFlow(flow, overrides);
    const headers = {};
    const src = overrides.headers || flow.reqHeaders || {};
    for (const [k, v] of Object.entries(src)) {
      if (SKIP_REQ_HEADERS.includes(String(k).toLowerCase())) continue;
      headers[k] = v;
    }
    headers.host = target.host;
    if (body.length) headers['content-length'] = String(body.length);

    const isSecure = target.protocol === 'https:';
    const transport = isSecure ? https : http;

    const finish = (fields) => {
      const record = {
        id: randomUUID(),
        ts: Date.now(),
        method,
        url: target.toString(),
        host: target.hostname,
        scheme: target.protocol.replace(':', ''),
        path: (target.pathname || '/') + (target.search || ''),
        reqHeaders: headers,
        reqBody: typeof flow.reqBody === 'string' && !overrides.body ? flow.reqBody : body.toString('utf8'),
        reqBodyBase64: null,
        reqBodyTruncated: false,
        reqSize: body.length,
        duration: Number((process.hrtime.bigint() - startedAt) / 1000000n),
        replayOf: flow.id,
        ...fields,
      };
      store.add(record);
      resolve({ flow: record });
    };

    let upstream;
    try {
      upstream = transport.request({
        method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: Number(target.port) || (isSecure ? 443 : 80),
        path: (target.pathname || '/') + (target.search || ''),
        headers,
        rejectUnauthorized: false,
        servername: isSecure && !/^\d+\.\d+\.\d+\.\d+$/.test(target.hostname) ? target.hostname : undefined,
      });
    } catch (err) {
      finish({ status: 0, resHeaders: {}, resBody: null, resSize: 0, error: String(err && err.message) });
      return;
    }

    upstream.setTimeout(120000, () => upstream.destroy(new Error('上游响应超时（120s）')));

    upstream.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const decoded = decompress(raw, res.headers['content-encoding']);
        const textual = isTextual(res.headers['content-type']);
        finish({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          resHeaders: { ...res.headers },
          resContentType: res.headers['content-type'],
          resSize: size,
          resBody: textual ? decoded.toString('utf8') : null,
          resBodyBase64: textual ? null : decoded.toString('base64'),
          resBodyTruncated: size > 2 * 1024 * 1024,
        });
      });
      res.on('error', (err) => {
        finish({ status: 0, resHeaders: {}, resBody: null, resSize: size, error: String(err && err.message) });
      });
    });

    upstream.on('error', (err) => {
      finish({ status: 0, resHeaders: {}, resBody: null, resSize: 0, error: String(err && err.message) });
    });

    upstream.end(body.length ? body : undefined);
  });
}

module.exports = { replay };
