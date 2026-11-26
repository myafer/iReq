'use strict';

/**
 * 解密范围的测试辅助。
 *
 * 默认解密范围是「只解密指定域名 / 应用」，而大多数套件验证的是解密链路本身
 * （握手失败、自动跳过、证书信任…）。它们跑之前要先把范围切到「全部解密」，
 * 跑完再还原 —— 否则默认值一改，一堆套件会因为「流量被隧道了」而假失败。
 */

const { UI } = require('./_env');

const put = (body) =>
  fetch(UI + '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);

async function readScope() {
  try {
    const cfg = await (await fetch(UI + '/api/config')).json();
    return cfg.mitmScope || null;
  } catch (_) {
    return null;
  }
}

/** 把范围切成「全部解密」，返回原来的配置以便还原 */
async function ensureMitmAll() {
  const before = await readScope();
  await put({ mitmScope: { mode: 'all', domains: [], apps: [] } });
  return before;
}

async function restoreScope(before) {
  await put({ mitmScope: before || { mode: 'list', domains: [], apps: [] } });
}

module.exports = { ensureMitmAll, restoreScope, readScope };
