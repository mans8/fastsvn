#!/usr/bin/env node
/**
 * 改名检测 + 修复回归（自起服务，纯 API，不依赖浏览器）。
 *
 * 场景对齐真实缺陷：A(A1.sql,A2.sql) 已提交，用户在访达里把 A 改成 B，
 * SVN 只看到 missing + unversioned；客户端应自动检测出改名候选，
 * 用户确认后执行修复，把它还原成 svn move（D + A(copied)，历史保留）。
 *
 * 用法：node scripts/e2e-rename-repair.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-rename-repair-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app;
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

try {
  const repo = path.join(tmp, 'repo');
  const wc = path.join(tmp, 'wc');
  execFileSync('svnadmin', ['create', repo]);
  svn(['checkout', '-q', `file://${repo}`, wc]);
  const a = path.join(wc, 'A');
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, 'A1.sql'), 'A1 original\n');
  fs.writeFileSync(path.join(a, 'A2.sql'), 'A2 original\n');
  svn(['add', a]);
  svn(['commit', '-q', '-m', 'init A', wc]);

  // 用户在访达里改名：A -> B，并在 B 里继续编辑 + 新增文件
  fs.renameSync(a, path.join(wc, 'B'));
  fs.writeFileSync(path.join(wc, 'B', 'A1.sql'), 'A1 edited\n');
  fs.writeFileSync(path.join(wc, 'B', 'new.sql'), 'brand new\n');

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
  const statusUrl = `${base}/api/status?path=${encodeURIComponent(wc)}&force=1`;

  // 1. 检测：状态里应带出改名候选，且磁盘不被改动
  const before = await (await fetch(statusUrl)).json();
  const cand = (before.renameCandidates ?? []).find((c) => c.from === 'A' && c.to === 'B');
  check('status 自动检测出 A→B 改名候选', Boolean(cand), JSON.stringify(before.renameCandidates));
  check('候选给出高置信度（内容一致）', (cand?.confidence ?? 0) >= 0.8, String(cand?.confidence));
  check('检测阶段不改磁盘：B 仍是未纳入', before.local?.find((f) => f.path === 'B')?.kind === 'unversioned', JSON.stringify(before.local?.find((f) => f.path === 'B')));
  check('检测阶段 A 仍是 missing', before.local?.find((f) => f.path === 'A')?.kind === 'missing', JSON.stringify(before.local?.find((f) => f.path === 'A')));

  // 2. 非法配对应被拒绝（防止把两个无关文件硬凑成改名）
  const bad = await fetch(`${base}/api/rename-repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wc, from: 'A2.sql', to: 'B/new.sql' }),
  });
  check('非法配对被拒绝', bad.status !== 200, `HTTP ${bad.status}`);

  // 3. 修复：确认后执行
  const repair = await fetch(`${base}/api/rename-repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wc, from: 'A', to: 'B', confidence: cand?.confidence }),
  });
  const repairBody = await repair.json();
  check('修复接口成功', repair.ok === true, `HTTP ${repair.status} ${JSON.stringify(repairBody)}`);

  const after = await (await fetch(statusUrl)).json();
  const deleted = after.local?.find((f) => f.path === 'A');
  const added = after.local?.find((f) => f.path === 'B');
  check('旧路径变成已删除', deleted?.kind === 'deleted' && deleted?.letter === 'D', JSON.stringify(deleted));
  check('新路径变成 A(copied) 保留历史', added?.kind === 'added' && added?.copied === true && /保留历史/.test(added?.label ?? ''), JSON.stringify(added));
  check('修复后不再报改名候选', (after.renameCandidates ?? []).length === 0, JSON.stringify(after.renameCandidates));
  check('用户在 B 里的编辑被保留', fs.readFileSync(path.join(wc, 'B', 'A1.sql'), 'utf8') === 'A1 edited\n', fs.readFileSync(path.join(wc, 'B', 'A1.sql'), 'utf8'));
  check('B 里新增的文件还在', fs.existsSync(path.join(wc, 'B', 'new.sql')));

  // svn 层面确认历史可追溯：B 的 log 里能追到 init A
  let log = '';
  try { log = svn(['log', path.join(wc, 'B')]); } catch { /* 修复失败时节点不存在 */ }
  check('新路径可追溯到旧路径的历史', /init A/.test(log), log.trim() || '(log 不可用)');
  const xml = svn(['status', '--xml', wc]);
  check('svn status 里新目录带 copied=true', /path="[^"]*\/B"[^>]*>[\s\S]*?item="added"[\s\S]*?copied="true"/.test(xml), 'B should be copied');

  // 单文件改名后又编辑：仍应被检测出来（内容不再逐字节相同）
  const single = path.join(tmp, 'single');
  execFileSync('svnadmin', ['create', path.join(tmp, 'repo2')]);
  svn(['checkout', '-q', `file://${path.join(tmp, 'repo2')}`, single]);
  fs.writeFileSync(path.join(single, 'old.txt'), 'line one\nline two\nline three\n');
  svn(['add', path.join(single, 'old.txt')]);
  svn(['commit', '-q', '-m', 'init old', single]);
  fs.renameSync(path.join(single, 'old.txt'), path.join(single, 'new.txt'));
  fs.writeFileSync(path.join(single, 'new.txt'), 'line one\nline two edited\nline three\n');
  fs.writeFileSync(path.join(single, 'dup.txt'), 'unrelated\n');
  svn(['add', path.join(single, 'dup.txt')]);
  svn(['commit', '-q', '-m', 'add dup', single]);
  fs.rmSync(path.join(single, 'dup.txt'));
  // 单文件场景需要独立状态缓存，换一个 home 重启服务太重；直接调 status 用新 WC
  fs.writeFileSync(path.join(home, 'working-copies.json'), JSON.stringify({ paths: [single], aliases: {} }));
  await fetch(`${base}/api/working-copies`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${base}/api/working-copies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: single }),
  });
  const singleSt = await (await fetch(`${base}/api/status?path=${encodeURIComponent(single)}&force=1`)).json();
  const fileCand = (singleSt.renameCandidates ?? []).find((c) => c.from === 'old.txt' && c.to === 'new.txt');
  check('单文件改名后又编辑仍能检测', Boolean(fileCand), JSON.stringify(singleSt.renameCandidates));
  check('无关的 missing 文件不被凑成改名', !(singleSt.renameCandidates ?? []).some((c) => c.from === 'dup.txt'), JSON.stringify(singleSt.renameCandidates));
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
