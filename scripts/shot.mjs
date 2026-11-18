#!/usr/bin/env node
/**
 * 延时截图工具（基于 Chrome DevTools Protocol）
 *
 * 为什么不用 `chrome --screenshot`：那条路在页面 load 后立刻截，抓不到
 * 异步进行中的状态（比如检出进度）。这里可以精确控制等待时间。
 *
 * 用法：
 *   node scripts/shot.mjs <url> <输出路径> [等待毫秒=3000] [宽=1440] [高=900]
 *
 * 前置：Chrome 以 --remote-debugging-port=9222 常驻运行。
 */

import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const [, , url, out, waitArg, wArg, hArg] = process.argv;

if (!url || !out) {
  console.error('用法: node scripts/shot.mjs <url> <out.png> [waitMs] [width] [height]');
  process.exit(1);
}

const waitMs = Number(waitArg ?? 3000);
const width = Number(wArg ?? 1440);
const height = Number(hArg ?? 900);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 新开一个标签页，避免复用已有页面的状态
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  if (!created.ok) throw new Error(`无法创建标签页: HTTP ${created.status}`);
  const target = await created.json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

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
      }, 30_000);
    });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('无法连接 CDP')), { once: true });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.text ?? 'unknown');
    }
  });

  await send('Page.navigate', { url });
  await sleep(waitMs);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));

  // 顺手把页面标题与可读文本带出来，便于断言
  const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  const text = await send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0, 400)',
    returnByValue: true,
  });

  console.log(
    JSON.stringify({
      out,
      waitMs,
      title: title.result?.value,
      errors: consoleErrors,
      textPreview: String(text.result?.value ?? '').replace(/\s+/g, ' ').slice(0, 260),
    })
  );

  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
