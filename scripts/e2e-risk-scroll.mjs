#!/usr/bin/env node
// 提交弹窗风险提醒回归：9 条全渲染、可滚动、文件清单高度不被挤掉。
// 用法：node scripts/e2e-risk-scroll.mjs（自建仓库 + 无头 Chrome 9222）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const CDP = 9222;
const SERVER = new URL('../server.js', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-risk-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app;
let target, ws;

try {
  const repo = path.join(tmp, 'repo');
  const wc = path.join(tmp, 'wc');
  execFileSync('svnadmin', ['create', repo]);
  execFileSync('svn', ['mkdir', '-m', 'init', `file://${repo}/trunk`]);
  execFileSync('svn', ['checkout', '-q', `file://${repo}/trunk`, wc]);
  fs.mkdirSync(path.join(wc, 'lib'), { recursive: true });
  const jars = [];
  for (let i = 1; i <= 9; i++) {
    const file = path.join(wc, 'lib', `icc-http-crypto-jdbc-custom-5.3.${i}.jar`);
    fs.writeFileSync(file, Buffer.alloc(1024, 0));
    jars.push(file);
  }
  execFileSync('svn', ['add', path.join(wc, 'lib')]);
    const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'working-copies.json'), JSON.stringify({ paths: [wc], aliases: {} }));
  app = spawn(process.execPath, [SERVER], {
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

  const created = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' });
  target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('cdp')), { once: true }); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?dialog=commit` });
  await sleep(2800);

  const info = await evaluate(`(() => {
    const list = document.querySelector('[role="dialog"] [data-risk-list]');
    const rows = list ? [...list.querySelectorAll('li')] : [];
    const fileList = [...document.querySelectorAll('[role="dialog"] div')].find((d) => d.textContent.trim() === '将提交的文件')?.nextElementSibling;
    return {
      count: rows.length,
      scrollable: list ? list.scrollHeight > list.clientHeight + 2 : false,
      scrollHeight: list?.scrollHeight ?? 0,
      clientHeight: list?.clientHeight ?? 0,
      header: document.querySelector('[role="dialog"]')?.innerText.match(/提交前留意这些文件/)?.[0] ?? '',
      hint: /可滚动查看全部/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''),
      summary: /看不到文本差异/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''),
      fileListHeight: fileList ? Math.round(fileList.getBoundingClientRect().height) : 0,
      paths: rows.slice(0, 2).map((r) => r.querySelector('code')?.textContent),
    };
  })()`);
  check('风险项全部渲染（9 条）', info.count === 9, JSON.stringify(info));
  check('标题说明要留意什么', info.header === '提交前留意这些文件', info.header);
  check('超出高度时可滚动', info.scrollable === true, JSON.stringify(info));
  check('不再显示「可滚动查看全部」', info.hint === false, String(info.hint));
  check('摘要说明二进制看不到差异', info.summary === true, String(info.summary));
  check('文件清单仍保持足够高度（≥ 200）', info.fileListHeight >= 200, String(info.fileListHeight));
  check('列表里显示完整相对路径', (info.paths?.[0] ?? '').startsWith('lib/'), JSON.stringify(info.paths));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/Users/admin/WorkBuddy/2026-11-10-15-12-01/fastsvn/screens/commit-risk-scroll-0613.png', Buffer.from(shot.data, 'base64'));

  // 滚到底部，确认最后几项可见
  await evaluate(`(() => { const l = document.querySelector('[role="dialog"] [data-risk-list]'); l.scrollTop = l.scrollHeight; return true; })()`);
  await sleep(300);
  const last = await evaluate(`(() => {
    const list = document.querySelector('[role="dialog"] [data-risk-list]');
    const rows = [...list.querySelectorAll('li')];
    const r = rows[rows.length - 1].getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return { visible: r.bottom <= box.bottom + 1 && r.top >= box.top - 1, text: rows[rows.length - 1].innerText };
  })()`);
  check('滚到底能看到最后一条', last.visible === true, JSON.stringify(last));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  try { ws?.close(); } catch {}
  if (target) await fetch(`http://127.0.0.1:${CDP}/json/close/${target.id}`).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed} / ${results.length} 通过`);
if (failed) process.exitCode = 1;
