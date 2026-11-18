#!/usr/bin/env node
// 损坏工作副本回归：.svn 被清空时应判定为非工作副本，接口给可执行的提示。
// 用法：node scripts/e2e-invalid-wc.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-invalid-wc-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app;
try {
  const repo = path.join(tmp, 'repo');
  const good = path.join(tmp, 'good-wc');
  const broken = path.join(tmp, 'broken-wc');
  execFileSync('svnadmin', ['create', repo]);
  execFileSync('svn', ['mkdir', '-m', 'init', `file://${repo}/trunk`]);
  execFileSync('svn', ['checkout', '-q', `file://${repo}/trunk`, good]);
  fs.writeFileSync(path.join(good, 'a.txt'), 'hello\n');
  execFileSync('svn', ['add', path.join(good, 'a.txt')]);
  execFileSync('svn', ['commit', '-q', '-m', 'add', good]);
  fs.writeFileSync(path.join(good, 'a.txt'), 'hello world\n');
  // 模拟 /tmp 清理：.svn 目录还在，但里面被搬空了
  fs.mkdirSync(path.join(broken, '.svn'), { recursive: true });

  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'working-copies.json'), JSON.stringify({ paths: [broken, good], aliases: {} }));
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
  const items = await (await fetch(`${base}/api/working-copies`)).json();
  const bad = items.items.find((i) => i.path === broken);
  const okItem = items.items.find((i) => i.path === good);
  check('空的 .svn 判定为非工作副本', bad?.isWc === false && bad?.exists === true, JSON.stringify(bad));
  check('正常副本仍判定为工作副本', okItem?.isWc === true, JSON.stringify(okItem));

  const st = await (await fetch(`${base}/api/status?path=${encodeURIComponent(broken)}&force=1`)).json();
  check('status 给出可读提示', /不是可用的工作副本/.test(st.error ?? '') && !/E155007|E155016/.test(st.error ?? ''), String(st.error));
  const ls = await (await fetch(`${base}/api/ls?path=${encodeURIComponent(broken)}&dir=`)).json();
  check('本地目录给出同样的提示', /不是可用的工作副本/.test(ls.error ?? ''), String(ls.error));
  const goodSt = await (await fetch(`${base}/api/status?path=${encodeURIComponent(good)}&force=1`)).json();
  check('正常副本待提交仍有文件', (goodSt.local?.length ?? 0) === 1, JSON.stringify(goodSt.local?.map((f) => f.path)));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed} / ${results.length} 通过`);
if (failed) process.exitCode = 1;
