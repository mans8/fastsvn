/**
 * 下载（svn export）端到端自测。
 *
 * 只测"弹窗能打开"是不够的：这里真的填路径、真的点开始、真的检查落盘。
 * 注意 BoardUI 的 Input 是受控组件，**直接改 .value 不会触发 React**，
 * 必须用原生 setter + dispatchEvent('input')，否则测出来的是假通过。
 *
 * 用法：Chrome 需以 --remote-debugging-port=9222 常驻
 *   node scripts/e2e-download.mjs http://127.0.0.1:5183/ /tmp/某个空目录
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = 9222;
const base = (process.argv[2] || 'http://127.0.0.1:5183/').replace(/\/+$/, '');
const target = process.argv[3] || '/tmp/fastsvn-download-e2e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 「下载」现在在每行的操作列里：取第一个目录行，下载它
const picked = await evaluate(`(() => {
  const tr = document.querySelector('[role="dialog"] tbody tr[data-kind="dir"]')
    || document.querySelector('[role="dialog"] tbody tr');
  if (!tr) return null;
  const btn = tr.querySelector('button[aria-label^="下载 "]');
  if (!btn) return null;
  const name = tr.dataset.name;
  btn.click();
  return name;
})()`);
check('能从操作列发起下载', Boolean(picked), picked || '没有可下载的行');
await sleep(2200);

// 先记下默认值（后面会被测试改成临时目录，测完就看不到默认值了）
const defaultTarget = await evaluate(
  `[...document.querySelectorAll('[role="dialog"]')].pop().querySelectorAll('input')[1]?.value || ''`
);
check(
  '默认路径在「下载」目录',
  defaultTarget.startsWith('~/Downloads/') || defaultTarget.includes('/Downloads/'),
  defaultTarget
);

// 受控输入：用原生 setter + input 事件，React 才会更新 state
const filled = await evaluate(`(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
  const input = [...dlg.querySelectorAll('input')][1];
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(target)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(400);
check('能填入保存位置', filled && (await evaluate(
  `[...document.querySelectorAll('[role="dialog"]')].pop().querySelectorAll('input')[1].value === ${JSON.stringify(target)}`
)));

// 访达选目录按钮：浏览器环境没有原生通道，只验证按钮存在且带说明
const picker = await evaluate(`(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
  const b = [...dlg.querySelectorAll('button')].find(x => x.innerText.trim().startsWith('选择'));
  return b ? (b.getAttribute('aria-label') || '') : '';
})()`);
check('有「选择…」目录按钮', picker.length > 0, picker);

const started = await evaluate(
  `(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim().startsWith('开始下载'));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`
);
check('开始下载按钮可用并已点击', started);

// 等任务结束（最多 15 秒）
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
check('下载完成', text.includes('下载完成'), text.slice(0, 80));
check('未把下载目录当成项目打开', !text.includes('已经加到左侧项目列表'));

const stat = fs.existsSync(target) ? fs.statSync(target) : null;
const hasSvn = fs.existsSync(path.join(target, '.svn'));
const files = stat && stat.isDirectory() ? fs.readdirSync(target) : [];
check('内容真的落盘', Boolean(stat) && files.length > 0, `${target} → ${files.length} 项`);
check('导出不带 .svn', !hasSvn);

const layers = await evaluate(`[...document.querySelectorAll('[role="dialog"]')].length`);
check('下载完成后浏览窗口仍在', layers === 2, `${layers} 个弹窗叠加`);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);

await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`);
ws.close();
process.exit(failed ? 1 : 0);
