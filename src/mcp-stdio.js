'use strict';

/**
 * stdio ⇄ HTTP 的 MCP 桥。
 *
 * 为什么要桥：MCP 客户端分两类 —— 支持 Streamable HTTP 的可以直接连
 * `http://127.0.0.1:9091/mcp`；只支持 stdio 的（桌面客户端常见）则需要一个本地进程
 * 转一手。桥本身不碰 iReq 内部状态，所有请求都带着令牌打到控制台，
 * 因此授权、限流、审计只有一份实现，不会出现「绕过令牌直连」的旁路。
 *
 * 帧格式按 MCP stdio 规范：一行一条 JSON-RPC 消息（不是 Content-Length）。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function postJson(endpoint, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = transport.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        path: (url.pathname || '/') + (url.search || ''),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': payload.length,
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** SSE 响应体里把 data: 行拼起来 —— 有些客户端/网关会把 JSON 包成事件流 */
function parseResponseBody(text, contentType) {
  if (!text) return null;
  if (String(contentType || '').includes('text/event-stream')) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    const joined = lines.map((l) => l.slice(5).trim()).join('');
    return joined ? JSON.parse(joined) : null;
  }
  return JSON.parse(text);
}

async function runStdio({ url, token, timeoutMs = 120000 } = {}) {
  const endpoint = url || process.env.IREQ_MCP_URL || 'http://127.0.0.1:9091/mcp';
  const bearer = token || process.env.IREQ_MCP_TOKEN || '';
  if (!bearer) {
    process.stderr.write(
      '缺访问令牌。先在 iReq 控制台「设置 › MCP 接入」生成令牌，然后：\n' +
        '  ireq mcp --url ' + endpoint + ' --token ireq_mcp_xxx\n' +
        '或设置环境变量 IREQ_MCP_TOKEN。\n'
    );
    process.exitCode = 2;
    return;
  }
  const headers = { authorization: 'Bearer ' + bearer };

  let buffer = '';
  const handle = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error（stdio 桥只接受一行一条 JSON）' },
      });
      return;
    }
    const isBatch = Array.isArray(msg);
    const firstId = isBatch ? (msg[0] && msg[0].id) : msg.id;
    try {
      const res = await postJson(endpoint, msg, headers, timeoutMs);
      if (res.status === 401) {
        write(rpcFail(firstId, -32001, 'MCP 令牌无效或已撤销：请到 iReq 设置里重新生成'));
        return;
      }
      if (res.status === 403) {
        write(rpcFail(firstId, -32002, 'MCP 未开启或来源被拒：请在 iReq 设置里打开 MCP 接入'));
        return;
      }
      if (res.status === 429) {
        write(rpcFail(firstId, -32003, '调用过于频繁，稍后再试'));
        return;
      }
      if (res.status !== 200 && res.status !== 202) {
        write(rpcFail(firstId, -32000, `iReq 返回 ${res.status}：${res.text.slice(0, 300)}`));
        return;
      }
      const parsed = parseResponseBody(res.text, res.headers['content-type']);
      /* 通知（202 无正文）不需要回包 */
      if (parsed) write(parsed);
    } catch (err) {
      write(rpcFail(firstId, -32000, `连不上 iReq（${endpoint}）：${(err && err.message) || err}`));
    }
  };

  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      /* 串行处理，保证响应顺序与请求一致 */
      chain = chain.then(() => handle(line));
    }
  });
  process.stdin.on('end', () => {
    if (buffer.trim()) chain = chain.then(() => handle(buffer));
    chain.then(() => process.exit(0));
  });
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function rpcFail(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message },
  };
}

module.exports = { runStdio, postJson, parseResponseBody };
