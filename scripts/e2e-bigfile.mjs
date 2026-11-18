#!/usr/bin/env node
/**
 * 大文件自测：确认「非文本 + 超过 10MB」的文件不再被读差异。
 *
 * 复现的原始问题：往工作副本里丢一个大 zip，
 *   - `svn diff` 会把整个文件读进内存再按行解析
 *   - 未纳入版本管理的文件还会被 readFile + split('\n') 数行数
 * 结果是扫描/点开文件时界面长时间卡住。
 *
 * 这个脚本自己造仓库（不碰演示仓库），造完即清理。
 *
 * 用法：node scripts/e2e-bigfile.mjs <baseUrl>
 * 前置：Chrome 以 --remote-debugging-port=9222 常驻；本机有 svn / svnadmin。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const [, , base] = process.argv;
if (!base) {
  console.error('用法: node scripts/e2e-bigfile.mjs <baseUrl>');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

mkdirSync('screens', { recursive: true });
// 固定路径而不是 mkdtemp：截图里的项目名/路径要能看，跑完仍然删干净
const ROOT = '/tmp/fastsvn-bigfile-demo';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const REPO = join(ROOT, 'repo');
const WC = join(ROOT, '大文件示例');
const SEED = join(ROOT, 'seed');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

function makeFixtures() {
  execFileSync('svnadmin', ['create', REPO]);
  execFileSync('mkdir', ['-p', join(SEED, 'trunk')]);
  writeFileSync(join(SEED, 'trunk', 'note.md'), '# 说明\n\n第一行\n');
  svn(['import', SEED, `file://${REPO}`, '-m', 'init']);
  svn(['checkout', `file://${REPO}/trunk`, WC]);

  // 1) 未纳入版本管理的大 zip（30MB 随机内容）
  execFileSync('dd', ['if=/dev/urandom', `of=${join(WC, 'big-assets.zip')}`, 'bs=1m', 'count=30'], {
    stdio: 'ignore',
  });
  // 2) 未纳入版本管理的大文本（16MB）
  const line = '2026-11-11 14:00:00 INFO  order-service handled request id=abcdef0123456789 in 12ms\n';
  writeFileSync(join(WC, 'access-big.log'), line.repeat(200000));
  // 3) 已纳入版本管理、扩展名看不出来的大二进制（12MB），改一下制造 modified
  execFileSync('dd', ['if=/dev/urandom', `of=${join(WC, 'blob.datax')}`, 'bs=1m', 'count=12'], {
    stdio: 'ignore',
  });
  svn(['add', join(WC, 'blob.datax')]);
  svn(['commit', WC, '-m', 'add blob']);
  execFileSync('dd', ['if=/dev/urandom', `of=${join(WC, 'blob.datax')}`, 'bs=1m', 'count=12', 'conv=notrunc'], {
    stdio: 'ignore',
  });
  // 4) 小文本改动：确保"该比对的还在比对"
  writeFileSync(join(WC, 'note.md'), '# 说明\n\n第一行\n第二行\n');
}

async function main() {
  console.log('准备测试仓库…');
  makeFixtures();

  // 加进项目列表（直接调接口，少一步人工）
  await fetch(`${base}/api/working-copies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: WC }),
  });

  const t0 = Date.now();
  const status = await (await fetch(`${base}/api/status?path=${encodeURIComponent(WC)}&force=1`)).json();
  const took = Date.now() - t0;
  const byName = Object.fromEntries(status.local.map((f) => [f.name, f]));

  check('扫描大文件不再卡住（< 3s）', took < 3000, `${took} ms，后端自报 ${status.tookMs} ms`);
  check(
    '30MB zip：识别为非文本且跳过差异',
    byName['big-assets.zip']?.binary === true && byName['big-assets.zip']?.diffSkipped === true,
    JSON.stringify(byName['big-assets.zip'])
  );
  check(
    '16MB 文本：标记为大文件、不数行数',
    byName['access-big.log']?.big === true &&
      byName['access-big.log']?.diffSkipped === true &&
      byName['access-big.log']?.added === 0,
    JSON.stringify(byName['access-big.log'])
  );
  check(
    '未知扩展名的 12MB 二进制：靠嗅探识别',
    byName['blob.datax']?.binary === true && byName['blob.datax']?.diffSkipped === true,
    JSON.stringify(byName['blob.datax'])
  );
  check(
    '小文本改动照常统计行数',
    byName['note.md']?.added > 0 && byName['note.md']?.diffSkipped === false,
    JSON.stringify(byName['note.md'])
  );

  // 单文件差异
  const zipDiff = await (
    await fetch(`${base}/api/diff?path=${encodeURIComponent(WC)}&file=big-assets.zip&kind=unversioned`)
  ).json();
  check('zip 的 diff 直接跳过并说明原因', zipDiff.skipped === true && Boolean(zipDiff.message), zipDiff.message);
  const blobDiff = await (
    await fetch(`${base}/api/diff?path=${encodeURIComponent(WC)}&file=blob.datax&kind=modified`)
  ).json();
  check('12MB 二进制的 diff 也跳过', blobDiff.skipped === true && blobDiff.binary === true, JSON.stringify(blobDiff).slice(0, 120));
  const noteDiff = await (
    await fetch(`${base}/api/diff?path=${encodeURIComponent(WC)}&file=note.md&kind=modified`)
  ).json();
  check('小文本差异正常返回', noteDiff.skipped !== true && noteDiff.lines.length > 0, `${noteDiff.lines.length} 行`);

  // ---------- 界面 ----------
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  const errors = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 25_000);
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate 抛错');
    return r.result?.value;
  };
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.text ?? 'unknown');
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('无法连接 CDP')), { once: true });
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2800);

  const clickAt = async (selector, wait = 700) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 80), y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到元素 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };

  await clickAt(`[data-project-path="${WC}"]`, 2600);
  const listText = await evaluate(`document.querySelector('section')?.innerText ?? ''`);
  check('列表里大文本显示「大文件」', listText.includes('大文件'), '');
  check('列表里大 zip 显示体积', /30 MB/.test(listText), '');

  const listShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('screens/28-bigfile-list.png', Buffer.from(listShot.data, 'base64'));

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('section button')].find((x) => x.innerText.includes('big-assets.zip'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1200);
  const paneText = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
  check('右侧面板说明为什么不做对比', /大文件不做逐行对比/.test(paneText), '');
  check('面板给出体积与原因', /30 MB/.test(paneText) && /不是文本/.test(paneText), '');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('screens/29-bigfile-diff.png', Buffer.from(shot.data, 'base64'));

  check('页面无 JS 异常', errors.length === 0, errors.join(' | '));
  ws.close();

  // ---------- 清理 ----------
  await fetch(`${base}/api/working-copies`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: WC }),
  });
  rmSync(ROOT, { recursive: true, force: true });

  console.log('');
  let failed = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed} / ${results.length} 通过`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('自测脚本出错：', e.message);
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
