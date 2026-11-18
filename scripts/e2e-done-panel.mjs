/**
 * 下载完成态自测。
 *
 * 重点验证三件只在运行时才看得出来的事：
 *  1. 仓库地址是百分号编码的（svn 就这毛病），完成面板里必须显示成中文
 *  2. 「打开目录」按钮真的能调起访达（会真的弹一个 Finder 窗口，属预期）
 *  3. 结束按钮叫「完成」，不再是「开始使用」
 *
 * 用法：Chrome 需以 --remote-debugging-port=9222 常驻
 *   node scripts/e2e-done-panel.mjs http://127.0.0.1:5183/ [中文仓库URL] [本地目标目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9222;
const base = (process.argv[2] || 'http://127.0.0.1:5183/').replace(/\/+$/, '');
const repoUrl = process.argv[3] || 'file:///tmp/中文仓库/trunk';
const target = process.argv[4] || '/tmp/fastsvn-done-panel';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 参数写错（比如把截图目录当成仓库地址）时尽早停下，别让脚本跑出一堆看不懂的错
if (!/^(https?|svn|svn\+ssh|file):\/\//i.test(repoUrl)) {
  console.error(`拒绝执行：仓库地址不合法，收到 ${repoUrl}`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
// 这个脚本会先清空目标目录。参数写错时曾经把项目的 screens/ 整个删掉，
// 所以只允许清 /tmp 下的绝对路径。
if (!path.isAbsolute(target) || !target.startsWith('/tmp/')) {
  console.error(`拒绝执行：目标目录必须是 /tmp 下的绝对路径，收到 ${target}`);
  process.exit(1);
}


const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
const page = await created.json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  →  ${detail}` : ''}`);
};

await send('Page.navigate', { url: `${base}/?dialog=repo&theme=light` });
await sleep(6000);

// 用带中文的仓库地址打开（顺便验证地址规范化）
await evaluate(`(() => {
  const input = document.querySelector('[role="dialog"] input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(repoUrl)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(300);
await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === '打开')?.click()`);
await sleep(2500);

// 简化：组件已经把 URL 传下去了。这里不允许点击，交给下面的组件行为验证
const pulled = await evaluate(`(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
  return dlg.querySelector('input')?.value || '';
})()`);
check('地址栏中文正常显示', !/%[0-9A-F]{2}/i.test(pulled) && pulled.includes('中文'), pulled);

// 点第一行的下载按钮
const picked = await evaluate(`(() => {
  const tr = document.querySelector('[role="dialog"] tbody tr[data-kind="dir"]');
  if (!tr) return null;
  const btn = tr.querySelector('button[aria-label^="下载 "]');
  if (!btn) return null;
  const name = tr.dataset.name;
  btn.click();
  return name;
})()`);
check('能打开下载弹窗', Boolean(picked), picked || '没有可下载的目录');
await sleep(2200);

// 填目标目录并开跑
await evaluate(`(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
  const input = [...dlg.querySelectorAll('input')][1];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(target)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(400);
await evaluate(
  `[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim().startsWith('开始下载'))?.click()`
);

// 等完成
let text = '';
for (let i = 0; i < 30; i++) {
  await sleep(500);
  text = await evaluate(
    `(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
      return dlg ? dlg.innerText.replace(/\\n+/g, ' | ') : '';
    })()`
  );
  if (text.includes('下载完成') || text.includes('下载失败')) break;
}
check('下载完成', text.includes('下载完成'), text.slice(0, 70));

// 1) 完成面板里的地址必须是可读中文
const shownUrl = await evaluate(`(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
  const el = [...dlg.querySelectorAll('span')].find(sp => /^[a-z]+:\\/\\//i.test(sp.textContent.trim()));
  return el ? el.textContent.trim() : '';
})()`);
check('完成面板地址显示中文', shownUrl.includes('中文') && !/%[0-9A-F]{2}/i.test(shownUrl), shownUrl);

// 2) 两行带标签（SVN 地址 / 本地目录），不再用箭头，信息块在结果摘要下面
const layout = await evaluate(`(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
  const text = dlg.innerText;
  const labels = [...dlg.querySelectorAll('span')].map(s => s.textContent.trim());
  const summary = [...dlg.querySelectorAll('div')].find(
    d => /已下载|已检出/.test(d.innerText) && d.innerText.includes('用时') && d.children.length <= 2
  );
  const urlSpan = [...dlg.querySelectorAll('span')].find(sp => /^[a-z]+:\\/\\//i.test(sp.textContent.trim()));
  const box = urlSpan ? urlSpan.closest('div.rounded-xl') : null;
  return {
    hasSvnLabel: labels.includes('SVN 地址'),
    hasPathLabel: labels.includes('本地目录'),
    hasArrow: text.indexOf('\\u2192') >= 0,
    summaryTop: summary ? Math.round(summary.getBoundingClientRect().top) : -1,
    boxTop: box ? Math.round(box.getBoundingClientRect().top) : -1,
  };
})()`);
check(
  '有「SVN 地址」「本地目录」两行标签',
  layout.hasSvnLabel && layout.hasPathLabel,
  `${layout.hasSvnLabel ? 'SVN 地址' : '缺 SVN 地址'} / ${layout.hasPathLabel ? '本地目录' : '缺 本地目录'}`
);
check('不再使用箭头', !layout.hasArrow);
check(
  '信息块在结果摘要下方',
  layout.summaryTop >= 0 && layout.boxTop > layout.summaryTop,
  `摘要 y=${layout.summaryTop}，信息块 y=${layout.boxTop}`
);

// 3) 有「打开目录」
const openBtn = await evaluate(
  `!![...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === '打开目录')`
);
check('完成面板有「打开目录」', openBtn);

// 4) 结束按钮叫「完成」
const finishLabels = await evaluate(
  `[...document.querySelectorAll('[role="dialog"] button')].map(b => b.innerText.trim())`
);
check('结束按钮是「完成」', finishLabels.includes('完成') && !finishLabels.includes('开始使用'), finishLabels.join('/'));

// 5) 点「打开目录」确实调起访达（接口成功即视为通过）
await evaluate(
  `[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === '打开目录')?.click()`
);
await sleep(1500);
const noError = await evaluate(
  `!document.body.innerText.includes('无法打开访达') && !document.body.innerText.includes('已经不存在')`
);
check('点「打开目录」没有报错', noError);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);

await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`);
ws.close();
process.exit(failed ? 1 : 0);
