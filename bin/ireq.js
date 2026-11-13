#!/usr/bin/env node
'use strict';

/**
 * iReq CLI
 *   ireq start [-p 9090] [-u 9091] [--bind 0.0.0.0] [--ui-host 127.0.0.1]
 *                 [--data <dir>] [--ca-dir <dir>] [--no-persist] [--no-ui] [--passthrough a.com,b.com]
 *   ireq ca [--print]      查看 / 导出根证书
 *   ireq mcp [--url <u>] [--token <t>]   stdio 版 MCP 服务（把 iReq 给 AI 客户端用）
 *   ireq --version
 */

const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { resolveCaDir } = require('../src/ca-dirs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const map = { p: 'port', u: 'ui', d: 'data', b: 'bind' };
      const key = map[a[1]] || a[1];
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const HELP = `
iReq —— 轻量跨平台 HTTP(S) 抓包 / Mock / 重放

用法:
  ireq start [选项]          启动代理 + 控制台
    -p, --port <n>              代理端口，默认 9090
    -u, --ui <n>                控制台端口，默认 9091
    -b, --bind <host>           代理监听地址，默认 0.0.0.0（手机可连）
        --ui-host <host>        控制台监听地址，默认 127.0.0.1
    -d, --data <dir>            数据目录（流量/规则），默认 ./data
        --ca-dir <dir>          根证书档案目录，默认 ~/.ireq/ca（各形态共用）
        --no-persist            不把流量写入 JSONL
        --no-ui                 只起代理，不起控制台
        --passthrough <list>    跳过解密的域名，逗号分隔（证书固定的 App 用）
        --max-flows <n>         内存保留条数，默认 2000

  ireq ca                   打印根证书路径
  ireq ca --print           把根证书 PEM 输出到终端
  ireq local status         查看本机系统代理状态
  ireq local on|off         接管 / 释放本机系统代理（抓本机浏览器、桌面 App 的流量）

  ireq mcp                  把 iReq 以 stdio 形式接给 AI 客户端（MCP）
      --url <url>             MCP 端点，默认 http://127.0.0.1:9091/mcp
      --token <token>         访问令牌（在控制台「设置 › MCP 接入」生成）
      --timeout-ms <n>        单次调用超时，默认 120000
    说明：先在控制台打开 MCP 接入并生成令牌；令牌只显示一次。
          支持 HTTP 的客户端可直接连 --url，不需要这个桥。

安装根证书（只需一次，桌面版在「证书与连接」里可一键安装）:
  macOS   security add-trusted-cert -r trustRoot \\
            -k "$HOME/Library/Keychains/login.keychain-db" ~/.ireq/ca/reqlite-ca.pem
  iOS     手机代理指向本机 9090 后，浏览器打开 http://<你的IP>:9091/ca.pem 安装，
          再到 设置 > 通用 > 关于本机 > 证书信任设置 里把 iReq 打开
  Android 同上装 .pem（7.0+ 需要装到「用户证书」；App 默认不信任用户证书时需另行处理）
  备份    控制台「证书与连接」可导出 .p12（含私钥），换机器/重装后导入即可复用同一张 CA
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'start';

  if (args.version || args.v) {
    console.log(require('../package.json').version);
    return;
  }
  if (cmd === 'help' || args.help || args.h) {
    console.log(HELP);
    return;
  }

  // pkg 快照里的 __dirname 只读：数据目录默认放到可执行文件同级（--data 可覆盖）
  const defaultData = process.pkg || __dirname.startsWith('/snapshot')
    ? path.join(path.dirname(process.execPath), 'data')
    : path.join(__dirname, '..', 'data');
  const dataDir = path.resolve(args.data || defaultData);

  if (cmd === 'ca') {
    const caPath = path.join(resolveCaDir({ caDir: args['ca-dir'] }), 'reqlite-ca.pem');
    if (!fs.existsSync(caPath)) {
      console.log('根证书还没生成，先运行一次 `ireq start` 即可。');
      process.exitCode = 1;
      return;
    }
    if (args.print) {
      process.stdout.write(fs.readFileSync(caPath, 'utf8'));
    } else {
      console.log(caPath);
    }
    return;
  }

  if (cmd === 'local') {
    const { SystemProxy } = require('../src/system-proxy');
    const sp = new SystemProxy({ proxyPort: Number(args.port) || 9090, dataDir });
    const action = args._[1] || 'status';
    if (action === 'on' || action === 'off') {
      const r = action === 'on' ? sp.enable() : sp.disable();
      if (!r.ok) {
        console.error('操作失败:', r.error);
        console.error('可以在终端手动执行：\n' + (action === 'on' ? sp.commands().on : sp.commands().off));
        process.exitCode = 1;
        return;
      }
      console.log(
        action === 'on'
          ? `已接管本机系统代理（${r.status.service} → 127.0.0.1:${sp.proxyPort}），现在能抓到本机浏览器的流量了。`
          : `已释放本机系统代理（${r.status.service}），原始配置${r.restored ? '已恢复' : '可能未完全恢复，请检查'}。`
      );
      if (action === 'on') console.log('停止服务时会自动还原；若进程被强杀，执行 `ireq local off`。');
      return;
    }
    const st = sp.status();
    console.log(`平台        : ${st.platform}（${st.supported ? '支持自动设置' : '需手动设置'}）`);
    console.log(`网络服务    : ${st.service || '—'}`);
    console.log(`Web 代理    : ${st.web ? `${st.web.enabled ? '开' : '关'} ${st.web.host}:${st.web.port}` : '—'}`);
    console.log(`安全 Web    : ${st.secure ? `${st.secure.enabled ? '开' : '关'} ${st.secure.host}:${st.secure.port}` : '—'}`);
    console.log(`iReq 接管: ${st.ours ? '是' : '否'}`);
    console.log(`\n开启命令:\n${sp.commands(st.service).on}\n\n关闭命令:\n${sp.commands(st.service).off}`);
    return;
  }

  if (cmd === 'mcp') {
    const { runStdio } = require('../src/mcp-stdio');
    await runStdio({
      url: args.url,
      token: args.token,
      timeoutMs: Number(args['timeout-ms']) || 120000,
    });
    return;
  }

  if (cmd !== 'start') {
    console.log(`未知命令: ${cmd}`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const passthrough = String(args.passthrough || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const app = await createApp({
    proxyPort: Number(args.port) || 9090,
    uiPort: Number(args.ui) || 9091,
    bindHost: args.bind || '0.0.0.0',
    uiHost: args['ui-host'] || '127.0.0.1',
    dataDir,
    caDir: args['ca-dir'],
    persist: !args['no-persist'],
    maxFlows: Number(args['max-flows']) || 2000,
    config: { passthrough },
  });

  const info = await app.start({ withUi: !args['no-ui'] });

  const line = '─'.repeat(52);
  console.log(line);
  console.log('  iReq 已启动');
  console.log(line);
  console.log(`  代理端口   : ${info.proxyPort}  (HTTP/HTTPS)`);
  if (info.uiPort) console.log(`  控制台     : http://127.0.0.1:${info.uiPort}`);
  console.log(`  手机可连   : ${info.lan.map((ip) => `${ip}:${info.proxyPort}`).join('  ') || '未检测到局域网 IP'}`);
  console.log(`  手机装证书 : ${info.lan.map((ip) => `http://${ip}:${info.proxyPort}/`).join('  ') || `http://127.0.0.1:${info.proxyPort}/`}`);
  console.log(`  根证书     : ${info.caPath}`);
  console.log(`  抓本机流量 : 控制台「设置 › 本机抓包」一键接管，或执行 ireq local on`);
  if (info.restored) console.log(`  历史记录   : 已恢复 ${info.restored} 条（今天）`);
  if (app.ca.created) console.log('  ↳ 首次运行，已生成新的根证书，需要信任一次（桌面版可一键安装）');
  if (app.ca.migratedFrom) console.log(`  ↳ 已复用旧目录的根证书：${app.ca.migratedFrom}`);
  console.log(line);
  console.log('  Ctrl+C 停止');
  console.log('');

  const shutdown = async () => {
    console.log('\n正在停止…');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
