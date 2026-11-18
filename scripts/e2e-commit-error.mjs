#!/usr/bin/env node
/**
 * 提交失败时的错误文案回归。
 *
 * 背景：E175002 是「DAV 请求失败」的通用错误码——服务器钩子拒绝、路径没写权限、
 * 网关返回非 2xx 都会用它。之前 humanize() 只要看到 E175002 就回
 * 「连不上服务器，检查一下网络或仓库地址」，把服务器给的真实原因吞掉了，
 * 用户照着提示去查网络，永远查不到问题。
 *
 * 本测试用假的 svn 可执行文件模拟两种服务端拒绝，确认：
 *   1. 钩子拒绝 → 文案里带钩子输出，不能是「连不上」
 *   2. 路径无写权限（E175013）→ 文案说明权限，不能是「连不上」
 *   3. 错误事件同时带原始 stderr，界面上可以展开查看
 *
 * 用法：node scripts/e2e-commit-error.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SERVER = new URL('../server.js', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-commit-error-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

/** 假 svn：只实现被调用到的子命令，commit 按环境变量里的场景输出错误 */
function writeFakeSvn(dir, stderrText) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'svn');
  const quoted = `'${stderrText.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  --version) echo "1.14.5"; exit 0 ;;
esac
case "$2" in
  info) printf '%s' '<?xml version="1.0"?><info><entry kind="dir" path="." revision="1"><url>file:///fake/repo</url><repository><root>file:///fake/repo</root></repository></entry></info>'; exit 0 ;;
  status) printf '%s' '<?xml version="1.0"?><status></status>'; exit 0 ;;
  list) exit 0 ;;
  commit) printf '%s' ${quoted} >&2; exit 1 ;;
esac
exit 0
`
  );
  fs.chmodSync(bin, 0o755);
}

async function startServer(fakeSvn, home) {
  fs.mkdirSync(home, { recursive: true });
  const wc = path.join(home, 'wc');
  fs.mkdirSync(path.join(wc, '.svn'), { recursive: true });
  fs.writeFileSync(path.join(wc, '.svn', 'wc.db'), '');
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      FASTSVN_HOME: home,
      FASTSVN_SVN: fakeSvn,
      FASTSVN_KEYCHAIN_HELPER: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`启动超时 ${out}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /LISTENING (\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (d) => (out += d));
  });
  return { child, port, wc };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        if (line.startsWith('data: ')) data += line.slice(6);
      }
      try {
        return { event, payload: JSON.parse(data) };
      } catch {
        return { event, payload: null };
      }
    });
}

async function commitWith(server, wc, files) {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/commit/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wc, files, message: '测试提交' }),
  });
  return parseSse(await res.text()).find((e) => e.event === 'error' || e.event === 'done');
}

try {
  // 场景 1：服务器 pre-commit 钩子拒绝（外层就是 E175002）
  {
    const home = path.join(tmp, 'hook-home');
    const hookErr =
      "svn: E175002: Commit failed (details follow):\n" +
      "svn: E175002: Commit blocked by pre-commit hook (exit code 1) with output:\n" +
      '禁止提交 .jar 二进制文件，请走制品库\n';
    const fake = path.join(tmp, 'hook-svn');
    writeFakeSvn(fake, hookErr);
    const server = await startServer(path.join(fake, 'svn'), home);
    try {
      const ev = await commitWith(server, server.wc, ['gateway.jar']);
      const msg = String(ev?.payload?.message ?? '');
      check('钩子拒绝不再报「连不上服务器」', !msg.includes('连不上'), msg);
      check('钩子拒绝带出服务器给的原因', msg.includes('禁止提交 .jar'), msg);
      check('错误事件附带原始报错', String(ev?.payload?.detail ?? '').includes('pre-commit hook'), String(ev?.payload?.detail ?? ''));
    } finally {
      server.child.kill('SIGTERM');
    }
  }

  // 场景 2：路径没有写权限
  {
    const home = path.join(tmp, 'forbidden-home');
    const permErr =
      "svn: E175002: Commit failed (details follow):\n" +
      "svn: E175013: Access to '/svn/icc/build/project/restricted' forbidden\n";
    const fake = path.join(tmp, 'forbidden-svn');
    writeFakeSvn(fake, permErr);
    const server = await startServer(path.join(fake, 'svn'), home);
    try {
      const ev = await commitWith(server, server.wc, ['restricted/x.txt']);
      const msg = String(ev?.payload?.message ?? '');
      check('无写权限不再报「连不上服务器」', !msg.includes('连不上'), msg);
      check('无写权限说明是服务器拒绝', /权限|forbidden|拒绝/i.test(msg), msg);
    } finally {
      server.child.kill('SIGTERM');
    }
  }

  // 场景 3：真的连不上时仍然说连不上
  {
    const home = path.join(tmp, 'offline-home');
    const netErr =
      "svn: E170013: Unable to connect to a repository at URL 'https://xwsvn.example.com/svn/icc'\n" +
      "svn: E175002: Could not resolve host: xwsvn.example.com\n";
    const fake = path.join(tmp, 'offline-svn');
    writeFakeSvn(fake, netErr);
    const server = await startServer(path.join(fake, 'svn'), home);
    try {
      const ev = await commitWith(server, server.wc, ['a.txt']);
      const msg = String(ev?.payload?.message ?? '');
      check('真正的连接失败仍然提示检查网络', msg.includes('连不上'), msg);
    } finally {
      server.child.kill('SIGTERM');
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed} / ${results.length} 通过`);
if (failed) process.exitCode = 1;
