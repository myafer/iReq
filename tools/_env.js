'use strict';

/**
 * 自检脚本共用的服务端地址。
 *
 * 默认 9090（代理）/ 9091（控制台）；跑隔离实例时用环境变量覆盖：
 *   REQLITE_UI_PORT=9294 REQLITE_PROXY_PORT=9293 npm run check
 * 所有自检都从这里取地址，避免连到旧实例上「假绿」。
 */
const UI_PORT = Number(process.env.REQLITE_UI_PORT || 9091);
const PROXY_PORT = Number(process.env.REQLITE_PROXY_PORT || 9090);
const UI = `http://127.0.0.1:${UI_PORT}`;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const UI_HOST = `127.0.0.1:${UI_PORT}`;
const PROXY_HOST = `127.0.0.1:${PROXY_PORT}`;

module.exports = { UI_PORT, PROXY_PORT, UI, PROXY_URL, UI_HOST, PROXY_HOST };
