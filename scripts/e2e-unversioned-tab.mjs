#!/usr/bin/env node
/**
 * 「待提交 / 未纳入」拆分回归（真浏览器）。
 *
 * 场景：访达里把 sp12-x 改名成 sp13-x。
 *  - 待提交里只出现旧目录一条，说明「整个目录已删除 · 含 2 个文件」，可展开；
 *  - 未纳入里出现新目录，可展开、可「全部加入」；
 *  - 「全部加入」不会把疑似改名的新路径直接加进去（否则历史断掉）；
 *  - 点「修复」后自动切回待提交，旧/新两条互相说明，并且都已勾选。
 *
 * 用法：node scripts/e2e-unversioned-tab.mjs（自起服务 + 无头 Chrome 9222）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-unversioned-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app, target, ws;
try {
  const repo = path.join(tmp, 'repo');
  const wc = path.join(tmp, 'wc');
  execFileSync('svnadmin', ['create', repo]);
  execFileSync('svn', ['mkdir', '-m', 'init', `file://${repo}/trunk`]);
  execFileSync('svn', ['checkout', '-q', `file://${repo}/trunk`, wc]);

  const oldRel = 'patch/sp12-x';
  const newRel = 'patch/sp13-x';
  fs.mkdirSync(path.join(wc, oldRel), { recursive: true });
  fs.writeFileSync(path.join(wc, oldRel, 'a.sql'), 'a\n');
  fs.writeFileSync(path.join(wc, oldRel, 'b.sql'), 'b\n');
  execFileSync('svn', ['add', path.join(wc, 'patch')]);
  execFileSync('svn', ['commit', '-q', '-m', 'seed', wc]);

  // 访达改名 + 一个无关的未纳入文件
  fs.renameSync(path.join(wc, oldRel), path.join(wc, newRel));
  fs.writeFileSync(path.join(wc, 'newfile.txt'), 'hello\n');

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
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(2800);

  const tabs = await ev(`(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^(待提交|未纳入|待更新|本地目录)/.test(t)))()`);
  check('待提交只算一个目录行', tabs.some((t) => t === '待提交 · 1'), JSON.stringify(tabs));
  check('未纳入单独计数', tabs.some((t) => t === '未纳入 · 2'), JSON.stringify(tabs));

  const oldRow = await ev(`(() => document.querySelector('[data-file-row="${oldRel}"]')?.innerText.replace(/\\s+/g,' ') ?? '')()`);
  check('旧目录行说明整目录已删 + 文件数', /整个目录已删除/.test(oldRow) && /2 个文件/.test(oldRow), oldRow);
  const oldHidden = await ev(`(() => document.querySelectorAll('[data-file-row^="${oldRel}/"]').length)()`);
  check('旧目录的子项不再重复占行', oldHidden === 0, String(oldHidden));

  // 点旧目录行：右侧仍显示删除内容，同时行内展开文件
  const oldBox = await ev(`(() => { const r=document.querySelector('[data-file-row="${oldRel}"]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: oldBox.x, y: oldBox.y, button: 'left', clickCount: 1 });
  await sleep(700);
  const oldChildren = await ev(`(() => document.querySelector('[data-dir-children="${oldRel}"]')?.innerText.replace(/\\s+/g,' ') ?? '')()`);
  check('旧目录展开能看到 2 个 sql', /a\.sql/.test(oldChildren) && /b\.sql/.test(oldChildren), oldChildren);

  // 切到「未纳入」
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('未纳入')); b?.click(); return Boolean(b); })()`);
  await sleep(500);
  const newRow = await ev(`(() => document.querySelector('[data-file-row="${newRel}"]')?.innerText.replace(/\\s+/g,' ') ?? '')()`);
  check('未纳入行标出文件数', /2 个文件/.test(newRow), newRow);
  const addAllBtn = await ev(`(() => Boolean([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='全部加入')))()`);
  check('未纳入页签头有「全部加入」', addAllBtn === true, String(addAllBtn));

  // 全部加入：只加 newfile.txt，疑似改名的 sp13 应被跳过
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='全部加入'); b?.click(); return true; })()`);
  await sleep(400);
  const dlgText = await ev(`document.querySelector('[role="alertdialog"]')?.innerText.replace(/\\s+/g,' ') ?? ''`);
  check('加入确认框提示会跳过疑似改名', /疑似改名/.test(dlgText), dlgText.slice(0, 160));
  await ev(`(() => { const b=[...document.querySelectorAll('[role="alertdialog"] button')].find(x=>x.textContent.trim()==='全部加入'); b?.click(); return true; })()`);
  await sleep(1800);
  const tabsAfterAdd = await ev(`(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^(待提交|未纳入)/.test(t)))()`);
  check('加入后回到待提交且多出 newfile', tabsAfterAdd.includes('待提交 · 2'), JSON.stringify(tabsAfterAdd));
  check('疑似改名的目录仍留在未纳入', tabsAfterAdd.includes('未纳入 · 1'), JSON.stringify(tabsAfterAdd));
  const newfileRow = await ev(`(() => document.querySelector('[data-file-row="newfile.txt"]')?.innerText.replace(/\\s+/g,' ') ?? '')()`);
  check('newfile.txt 已进入待提交', /newfile\.txt/.test(newfileRow), newfileRow);

  // 修复改名：确认后自动切回待提交，两条互相说明
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='修复'); b?.click(); return Boolean(b); })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('[role="alertdialog"] button')].find(x=>x.textContent.trim()==='确认修复改名'); b?.click(); return Boolean(b); })()`);
  await sleep(2200);
  const tabsAfterRepair = await ev(`(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^(待提交|未纳入)/.test(t)))()`);
  check('修复后停在待提交', tabsAfterRepair.some((t) => t === '待提交 · 3'), JSON.stringify(tabsAfterRepair));
  check('修复后未纳入清空', !tabsAfterRepair.some((t) => t === '未纳入 · 1'), JSON.stringify(tabsAfterRepair));

  const oldAfter = await ev(`(() => document.querySelector('[data-file-row="${oldRel}"]')?.innerText.replace(/\\s+/g,' ') ?? '')()`);
  const newAfter = await ev(`(() => document.querySelector('[data-file-row="${newRel}"]')?.innerText.replace(/\\s+/g,' ') ?? '')()`);
  check('旧行说清移到哪', /已移至/.test(oldAfter) && oldAfter.includes(newRel), oldAfter);
  check('新行说清从哪来', /移自/.test(newAfter) && newAfter.includes(oldRel), newAfter);
  const checkedCount = await ev(`(() => [...document.querySelectorAll('input[type=checkbox]')].filter(el => (el.getAttribute('aria-label')||'').startsWith('选择') && el.checked).length)()`);
  check('改名两条都已勾选', checkedCount === 3, String(checkedCount));
  const commitText = await ev(`(() => [...document.querySelectorAll('button')].find(x=>/^提交 \\d+$/.test(x.textContent.trim()))?.textContent.trim() ?? '')()`);
  check('提交按钮按项数计', commitText === '提交 3', commitText);

  // 真的提交一次：改名要成对落库，历史保留、旧路径消失
  const commitBox = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^提交 \\d+$/.test(x.textContent.trim())); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  if (commitBox) for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: commitBox.x, y: commitBox.y, button: 'left', clickCount: 1 });
  await sleep(700);
  await ev(`(() => { const t=document.querySelector('[role="dialog"] textarea'); t?.focus(); return Boolean(t); })()`);
  await send('Input.insertText', { text: '改名并保留历史' });
  await sleep(200);
  const submitBox = await ev(`(() => { const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>x.textContent.trim()==='提交 3 项'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  if (submitBox) for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: submitBox.x, y: submitBox.y, button: 'left', clickCount: 1 });
  let done = false;
  for (let i = 0; i < 120; i++) {
    if (await ev(`Boolean(document.querySelector('[role="dialog"] [data-commit-status="done"]'))`)) { done = true; break; }
    await sleep(100);
  }
  check('改名提交成功', done, await ev(`document.querySelector('[role="dialog"]')?.innerText.replace(/\\s+/g,' ').slice(0,240) ?? ''`));

  const log = execFileSync('svn', ['log', '-v', '-l', '1', `file://${repo}/trunk`], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  check('仓库里旧路径已删除、新路径是复制', /D \/trunk\/patch\/sp12-x/m.test(log) && /A \/trunk\/patch\/sp13-x \(from \/trunk\/patch\/sp12-x/m.test(log), log.split('\n').slice(0, 10).join(' | '));
  const tree = execFileSync('svn', ['list', '-R', `file://${repo}/trunk`], { encoding: 'utf8' }).trim();
  check('仓库里只剩改名后的目录', /sp13-x\/a\.sql/.test(tree) && /sp13-x\/b\.sql/.test(tree) && !/sp12-x/.test(tree), tree);
  const statusLeft = execFileSync('svn', ['status', wc], { encoding: 'utf8' }).trim();
  check('提交后工作副本干净', statusLeft === '', statusLeft || '(空)');
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
