#!/usr/bin/env node
/**
 * 树形视图里「新增目录」只占一行的回归（真浏览器）。
 *
 * 场景：mix-receiver 下新增 plugins 目录，里面放一个 jar，svn add 整个目录。
 * svn status 会同时给出 `A plugins` 和 `A plugins/xxx.jar` 两条；
 * 树形视图按路径分组时，`plugins` 既被当成父节点，又被当成目录条目本身，
 * 于是同一个名字出现两次（一行带勾选框、一行是目录节点）。
 *
 * 期望：只出现一行 plugins —— 既是目录（可折叠），也带勾选框和状态字母。
 *
 * 用法：node scripts/e2e-tree-added-dir.mjs（自起服务 + 无头 Chrome 9222）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-tree-added-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app, target, ws;
try {
  const repo = path.join(tmp, 'repo');
  const wc = path.join(tmp, 'wc');
  execFileSync('svnadmin', ['create', repo]);
  execFileSync('svn', ['mkdir', '-m', 'init', `file://${repo}/trunk`]);
  execFileSync('svn', ['checkout', '-q', `file://${repo}/trunk`, wc]);

  const mixRel = 'gateway/mix-receiver';
  const pluginsRel = `${mixRel}/plugins`;
  const jarRel = `${pluginsRel}/gateway-plugin-apppush-custom-5.3.1.jar`;
  fs.mkdirSync(path.join(wc, mixRel, 'conf'), { recursive: true });
  fs.writeFileSync(path.join(wc, mixRel, 'conf', 'app.properties'), 'k=v\n');
  execFileSync('svn', ['add', path.join(wc, 'gateway')]);
  execFileSync('svn', ['commit', '-q', '-m', 'seed', wc]);

  // 新增 plugins 目录 + jar，整个目录 svn add（和真实操作一致）
  fs.mkdirSync(path.join(wc, pluginsRel));
  fs.writeFileSync(path.join(wc, jarRel), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  execFileSync('svn', ['add', path.join(wc, pluginsRel)]);

  const statusLines = execFileSync('svn', ['status'], { cwd: wc, encoding: 'utf8' }).trim();
  check(
    '前置：status 同时给出目录和子文件两条',
    statusLines.includes(`A       ${pluginsRel}`) && statusLines.includes(`A       ${jarRel}`),
    statusLines.replace(/\n/g, ' | ')
  );

  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'working-copies.json'), JSON.stringify({ paths: [wc], aliases: {} }));
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

  const created = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' });
  target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  const pendingCalls = new Map();
  let id = 0;
  const send = (m, p = {}) => new Promise((res, rej) => {
    const n = ++id;
    pendingCalls.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method: m, params: p }));
    setTimeout(() => { if (pendingCalls.has(n)) { pendingCalls.delete(n); rej(new Error(m)); } }, 20000);
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pendingCalls.has(m.id)) {
      const p = pendingCalls.get(m.id);
      pendingCalls.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', () => j(new Error('cdp')), { once: true });
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result?.value;
  };
  const click = async (selector) => {
    const box = await ev(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    if (!box) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    return true;
  };

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(2800);

  const tabs = await ev(`(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^(待提交|未纳入)/.test(t)))()`);
  check('待提交按 status 条目计数', tabs.some((t) => t === '待提交 · 2'), JSON.stringify(tabs));

  // 切到树形视图
  const toTree = await ev(`(() => { const b=document.querySelector('[aria-label="切换为树形视图"]'); b?.click(); return Boolean(b); })()`);
  check('有树形视图切换按钮', toTree === true, String(toTree));
  await sleep(500);

  // 关键断言：plugins 在树里只能出现一次
  const pluginsRows = await ev(`(() => [...document.querySelectorAll('[data-tree-dir="${pluginsRel}"],[data-file-row="${pluginsRel}"]')].length)()`);
  check('plugins 只占一行', pluginsRows === 1, `出现 ${pluginsRows} 行`);

  const rowText = await ev(`(() => { const el=document.querySelector('[data-file-row="${pluginsRel}"]') ?? document.querySelector('[data-tree-dir="${pluginsRel}"]'); return el?.innerText.replace(/\\s+/g,' ') ?? ''; })()`);
  check('目录行带状态字母 A', /(^|\s)A(\s|$)/.test(rowText), rowText);
  check('目录行说明文件数', /1 个文件/.test(rowText), rowText);

  const hasCheckbox = await ev(`(() => Boolean((document.querySelector('[data-file-row="${pluginsRel}"]') ?? document.querySelector('[data-tree-dir="${pluginsRel}"]'))?.querySelector('input[type=checkbox]')))()`);
  check('目录行可勾选', hasCheckbox === true, String(hasCheckbox));

  const jarRow = await ev(`(() => { const el=document.querySelector('[data-file-row="${jarRel}"]'); return el?.innerText.replace(/\\s+/g,' ') ?? ''; })()`);
  check('jar 子文件作为子行出现一次', /gateway-plugin-apppush/.test(jarRow), jarRow || '(缺失)');

  // 折叠目录行：子文件应当收起；再点一次恢复
  await click(`[data-file-row="${pluginsRel}"]`);
  await sleep(400);
  const hiddenAfter = await ev(`(() => [...document.querySelectorAll('[data-file-row="${jarRel}"]')].length)()`);
  check('点目录行可折叠子文件', hiddenAfter === 0, String(hiddenAfter));
  await click(`[data-tree-dir="${pluginsRel}"]`);
  await sleep(400);
  const shownAgain = await ev(`(() => [...document.querySelectorAll('[data-file-row="${jarRel}"]')].length)()`);
  check('再点一次恢复展开', shownAgain === 1, String(shownAgain));

  // 取消勾选目录行，提交按钮应只剩 jar 一项
  const boxChecked = await ev(`(() => { const i=document.querySelector('[data-file-row="${pluginsRel}"]')?.querySelector('input[type=checkbox]'); return i?.checked ?? null; })()`);
  check('目录行默认勾选', boxChecked === true, String(boxChecked));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  try { ws?.close(); } catch {}
  if (target) await fetch(`http://127.0.0.1:9222/json/close/${target.id}`).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed} / ${results.length} 通过`);
if (failed) process.exitCode = 1;
