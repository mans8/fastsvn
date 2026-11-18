#!/usr/bin/env node
/**
 * 回归：仓库不可达 / 未提供凭据时，改名检测仍必须成立。
 *
 * 真实缺陷：目录被改名后，旧目录在磁盘上已不存在。对"不存在的路径"
 * 执行 `svn list -r BASE` / `svn info -r BASE` 时，svn 不会读本地元数据，
 * 而是解析成仓库 URL 去连服务器。远程仓库需要凭据，而状态/改名检测走的是
 * 无凭据的本地 svn 调用，于是这些命令必然失败 → 目录类型未知、内容分 0，
 * 候选为空。file:// 仓库的测试因为不需要认证，永远发现不了这个问题。
 *
 * 这里把仓库移走，模拟"仓库访问不可用"，验证检测只靠本地信息也能完成。
 * 用法：node scripts/e2e-rename-offline.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-rename-offline-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app;
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

try {
  const repo = path.join(tmp, 'repo');
  const wc = path.join(tmp, 'wc');
  execFileSync('svnadmin', ['create', repo]);
  svn(['checkout', '-q', `file://${repo}`, wc]);
  const oldDir = path.join(wc, 'patch', 'sp13', 'append', 'sp12-加密平台切换，建库时不要执行');
  fs.mkdirSync(oldDir, { recursive: true });
  for (const name of ['1.创建备份表.sql', '2.清空表.sql', '3.恢复数据.sql', '4.删除备份表.sql']) {
    fs.writeFileSync(path.join(oldDir, name), `${name} content\n`);
  }
  fs.writeFileSync(path.join(oldDir, '.DS_Store'), 'noise');
  svn(['add', '--parents', oldDir]);
  svn(['commit', '-q', '-m', 'init sql', wc]);

  // 访达里改名：旧目录整体消失，新目录未纳入版本控制
  const newDir = path.join(wc, 'patch', 'sp13', 'append', 'sp13-加密平台切换，建库时不要执行');
  fs.renameSync(oldDir, newDir);

  // 仓库不可达：任何走服务器的 svn 命令都会失败（等同于远程仓库要求凭据）
  const repoOffline = `${repo}-offline`;
  fs.renameSync(repo, repoOffline);

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

  const statusUrl = `http://127.0.0.1:${port}/api/status?path=${encodeURIComponent(wc)}&force=1`;
  const res = await fetch(statusUrl);
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || `状态查询失败：HTTP ${res.status}`);

  const relOld = 'patch/sp13/append/sp12-加密平台切换，建库时不要执行';
  const relNew = 'patch/sp13/append/sp13-加密平台切换，建库时不要执行';
  const missing = payload.local?.find((f) => f.path === relOld);
  const unversioned = payload.local?.find((f) => f.path === relNew);

  check('旧目录显示为 missing', missing?.kind === 'missing', JSON.stringify(missing));
  check('新目录显示为未纳入', unversioned?.kind === 'unversioned', JSON.stringify(unversioned));
  check('旧目录的版控子文件也出现在状态里', payload.local?.some((f) => f.path.startsWith(`${relOld}/`) && f.kind === 'missing'));
  // 目录行要能说清里面有几个文件（界面据此显示「含 4 个文件」并允许展开）
  check('旧目录标出 4 个文件', missing?.isDir === true && missing?.childCount === 4 && missing?.children?.length === 4, JSON.stringify(missing && { isDir: missing.isDir, childCount: missing.childCount }));
  check('新目录标出 4 个文件', unversioned?.isDir === true && unversioned?.childCount === 4 && unversioned?.children?.length === 4, JSON.stringify(unversioned && { isDir: unversioned.isDir, childCount: unversioned.childCount }));

  const cand = (payload.renameCandidates ?? []).find((c) => c.from === relOld && c.to === relNew);
  check('仓库不可达时仍检测出目录改名', Boolean(cand), JSON.stringify(payload.renameCandidates));
  check('候选置信度足够高', (cand?.confidence ?? 0) >= 0.8, String(cand?.confidence));
  check('候选标记为目录改名', cand?.fromIsDir === true && cand?.toIsDir === true, JSON.stringify(cand));
  check('检测阶段不改磁盘：新目录仍是未纳入', payload.local?.find((f) => f.path === relNew)?.kind === 'unversioned');
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
