#!/usr/bin/env node
/**
 * 交互自测：在真实浏览器里模拟输入并断言界面反应。
 *
 * 存在的理由：类型检查能发现 API 用错，但发现不了"输入框打不进去字"这类
 * 只在运行时暴露的问题（BoardUI 的 Input 是 React Aria 风格的 onChange(value)，
 * 与原生 onChange(event) 不同，写错时页面不报错、只是没反应）。
 *
 * 用法：node scripts/e2e.mjs <url> [等待毫秒]
 * 前置：Chrome 以 --remote-debugging-port=9222 常驻。
 */

const PORT = process.env.CDP_PORT || 9222;
const [, , url, waitArg] = process.argv;
if (!url) {
  console.error('用法: node scripts/e2e.mjs <url> [waitMs]');
  process.exit(1);
}
const waitMs = Number(waitArg ?? 2500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里把值写进受控输入框，并让 React 收到变更 */
const FILL = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'NOT_FOUND';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`;

async function main() {
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
      }, 20_000);
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
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.text ?? 'unknown');
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('无法连接 CDP')), { once: true });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  // 直接打开检出弹窗：这个脚本测的是弹窗里的输入与联动
  await send('Page.navigate', { url: `${url}${url.includes('?') ? '&' : '?'}dialog=checkout` });
  await sleep(waitMs);

  const results = [];

  // 1) 检出对话框：地址输入 → 本地路径应自动跟随
  const urlInput = 'input[placeholder*="svn.example.com"]';
  const filled = await evaluate(FILL(urlInput, 'https://svn.example.com/repo/myrepo/trunk'));
  results.push(['地址输入框可写入', filled === 'https://svn.example.com/repo/myrepo/trunk', filled]);

  await sleep(300);
  const suggested = await evaluate(`(() => {
    const el = document.querySelector('input[placeholder*="Downloads"]');
    return el ? el.value : 'NOT_FOUND';
  })()`);
  results.push(['本地路径自动推导', suggested === '~/Downloads/trunk', suggested]);

  // 2) 本地路径可手改
  const pathFilled = await evaluate(FILL('input[placeholder*="Downloads"]', '/tmp/e2e-target'));
  results.push(['本地路径可写入', pathFilled === '/tmp/e2e-target', pathFilled]);

  // 3) 开始检出按钮此时应可用
  await sleep(200);
  const canStart = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.textContent.includes('开始检出'));
    return b ? !b.disabled : 'NOT_FOUND';
  })()`);
  results.push(['开始检出按钮已启用', canStart === true, canStart]);

  const text = await evaluate('document.body.innerText');
  results.push(['无运行时异常', errors.length === 0, errors.join(' | ') || '无']);

  const pass = results.filter((r) => r[1]).length;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${String(detail).slice(0, 90)}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  console.log('页面片段:', String(text).replace(/\s+/g, ' ').slice(0, 180));

  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  ws.close();
  process.exit(pass === results.length ? 0 : 2);
}

main().catch((e) => {
  console.error('自测失败:', e.message);
  process.exit(1);
});
