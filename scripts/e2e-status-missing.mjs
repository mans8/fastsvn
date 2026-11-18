#!/usr/bin/env node
/**
 * 回归：svn status item=missing 不能映射成 scheduled-delete；旁边存在同名副本时也要区分。
 * 用法：node scripts/e2e-status-missing.mjs <baseUrl>
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , base] = process.argv;
if (!base) throw new Error('用法：node scripts/e2e-status-missing.mjs <baseUrl>');
const ROOT = `/tmp/fastsvn-status-missing-${process.pid}`;
const REPO = join(ROOT, 'repo');
const SEED = join(ROOT, 'seed');
const WC = join(ROOT, 'wc');
const TRACKED_REL = 'gateway/push-server';
const COPY_REL = 'gateway/push-server 2';
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

async function main() {
  try {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(SEED, 'trunk', 'gateway', 'push-server', 'conf'), { recursive: true });
    writeFileSync(join(SEED, 'trunk', 'gateway', 'push-server', 'conf', 'application.yml'), 'server: push\n');
    execFileSync('svnadmin', ['create', REPO]);
    svn(['import', SEED, `file://${REPO}`, '-m', 'initial']);
    svn(['checkout', `file://${REPO}/trunk`, WC]);

    const tracked = join(WC, TRACKED_REL);
    const duplicate = join(WC, COPY_REL);
    cpSync(tracked, duplicate, { recursive: true });
    rmSync(tracked, { recursive: true, force: true });

    const add = await fetch(`${base}/api/working-copies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: WC }),
    });
    if (!add.ok) throw new Error(`无法加入测试工作副本：HTTP ${add.status}`);

    const response = await fetch(`${base}/api/status?path=${encodeURIComponent(WC)}&force=1`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `状态查询失败：HTTP ${response.status}`);
    const missing = payload.local.find((f) => f.path === TRACKED_REL);
    const duplicateStatus = payload.local.find((f) => f.path === COPY_REL);

    check('版控中的原目录显示为 missing，不冒充已计划删除', missing?.kind === 'missing', JSON.stringify(missing));
    check('missing 用「D 本地已删除」与普通删除同一套视觉', missing?.label === '本地已删除' && missing?.letter === 'D', `${missing?.letter} ${missing?.label}`);
    check('带“2”的存在副本单独显示为未纳入', duplicateStatus?.kind === 'unversioned', JSON.stringify(duplicateStatus));
    check('同名副本不应被误判成改名候选', (payload.renameCandidates ?? []).length === 0, JSON.stringify(payload.renameCandidates));
    check('磁盘状态符合测试场景', !existsSync(tracked) && existsSync(duplicate), `${existsSync(tracked)} / ${existsSync(duplicate)}`);

    let failures = 0;
    for (const [name, pass, detail] of results) {
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
      if (!pass) failures++;
    }
    console.log(`\n${results.length - failures} / ${results.length} 通过`);
    if (failures) process.exitCode = 1;
  } finally {
    try {
      await fetch(`${base}/api/working-copies`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: WC }),
      });
    } catch { /* ignore */ }
    rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('自测失败：', e.message);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
