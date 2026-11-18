#!/usr/bin/env node
/**
 * 目录删除提交回归：只勾目录（子项在界面上收在目录行里）也必须真的删掉。
 *
 * 背景：svn status 对「整个目录被删」只给一条记录，而提交用的是
 * `--depth empty` —— 只提交列出的节点。只给目录时 svn 返回成功，
 * 但仓库里什么都没删。界面把子项收进目录行后，这条路径就是唯一的提交方式，
 * 所以必须保证服务端会展开目录的子项。
 *
 * 覆盖两种状态：
 *   missing（在访达里删掉）→ 服务端先 svn delete，再展开提交
 *   deleted（已经 svn delete 排进删除）→ 直接展开提交
 *
 * 用法：node scripts/e2e-deleted-dir-commit.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-deleted-dir-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app;
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

try {
  const repo = path.join(tmp, 'repo');
  const wc = path.join(tmp, 'wc');
  execFileSync('svnadmin', ['create', repo]);
  svn(['checkout', '-q', `file://${repo}`, wc]);

  // 两个目录：gone 直接从磁盘删掉（missing），staged 走 svn delete（D）
  for (const dir of ['gone', 'staged']) {
    fs.mkdirSync(path.join(wc, dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wc, dir, '1.sql'), 'one\n');
    fs.writeFileSync(path.join(wc, dir, 'sub', '2.sql'), 'two\n');
  }
  svn(['add', path.join(wc, 'gone'), path.join(wc, 'staged')]);
  svn(['commit', '-q', '-m', 'seed', wc]);

  fs.rmSync(path.join(wc, 'gone'), { recursive: true });
  svn(['delete', '-q', path.join(wc, 'staged')]);

  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'working-copies.json'), JSON.stringify({ paths: [wc], aliases: {} }));
  app = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    env: { ...process.env, HOME: home, PORT: '0', FASTSVN_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`启动超时 ${out}`)), 8000);
    app.stdout.on('data', (d) => {
      out += d;
      const m = /LISTENING (\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    app.stderr.on('data', (d) => (out += d));
  });
  const base = `http://127.0.0.1:${port}`;

  const status = await (await fetch(`${base}/api/status?path=${encodeURIComponent(wc)}&force=1`)).json();
  const gone = status.local?.find((f) => f.path === 'gone');
  const staged = status.local?.find((f) => f.path === 'staged');
  check('两种删除状态都识别为目录', gone?.isDir === true && staged?.isDir === true, JSON.stringify({ gone: gone?.kind, staged: staged?.kind }));
  const goneChild = status.local?.find((f) => f.path === 'gone/1.sql');
  check('missing 目录的子项仍在状态里', Boolean(goneChild), JSON.stringify(goneChild?.kind));

  // 只提交目录本身 —— 与界面把子项收进目录行后发出的请求一致
  const res = await fetch(`${base}/api/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wc, files: ['gone', 'staged'], message: '删除两个目录' }),
  });
  const body = await res.json();
  check('提交接口成功', res.ok && body.revision > 0, `HTTP ${res.status} ${JSON.stringify(body)}`);

  const tree = svn(['list', '-R', `file://${repo}`]).trim();
  check('仓库里两个目录都被删掉', tree === '', tree || '(空)');
  const after = svn(['status', wc]).trim();
  check('工作副本状态清空', after === '', after || '(空)');
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed} / ${results.length} 通过`);
if (failed) process.exitCode = 1;
