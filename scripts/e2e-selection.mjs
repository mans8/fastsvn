#!/usr/bin/env node
/**
 * 勾选状态自测：验证「已选 N 个」会随勾选、刷新、筛选、切页签正确更新。
 *
 * 针对的是两类回归：
 *   1. 数字用的是全局 checked.size —— 切页签/开筛选时它不会跟着变
 *   2. 每次刷新把勾选重置为全选 —— 用户取消勾选后一刷新就"自己跳回去"
 *
 * 用法：node scripts/e2e-selection.mjs <url>
 */

const PORT = process.env.CDP_PORT || 9222;
const [, , url, waitArg] = process.argv;
if (!url) {
  console.error('用法: node scripts/e2e-selection.mjs <url>');
  process.exit(1);
}
const waitMs = Number(waitArg ?? 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await ws.send(
    JSON.stringify({
      id: ++nextId,
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
    })
  );
  await send('Page.navigate', { url });
  await sleep(waitMs);

  const results = [];
  const check = (name, ok, detail) => results.push([name, ok, detail]);

  // 读取「已选N个 / 未选择 / N个文件待更新」这段小字
  const readCount = () =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('span')].find((s) =>
        /^(已选 \\d+ 个|未选择|\\d+ 个文件待更新|正在检查服务器…|服务器上没有新内容)$/.test(s.textContent.trim())
      );
      return el ? el.textContent.trim() : 'NOT_FOUND';
    })()`);

  // 只点"行内文件"的复选框（aria-label 形如「选择 xxx」），
  // 跳过表头那个「全选」——否则测的是全选而不是单行勾选
  const clickFileCheckbox = (index) =>
    evaluate(`(() => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
        .filter((el) => (el.getAttribute('aria-label') || '').startsWith('选择'));
      const el = boxes[${index}];
      if (!el) return 'NO_ROW_CHECKBOX_' + boxes.length;
      el.click();
      return 'clicked:' + (el.checked ? 'on' : 'off');
    })()`);

  const clickButtonByLabel = (label) =>
    evaluate(`(() => {
      const b = document.querySelector('button[aria-label="${label}"]');
      if (!b) return 'NOT_FOUND';
      b.click();
      return 'ok';
    })()`);

  const clickByText = (text) =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}));
      if (!b) return 'NOT_FOUND';
      b.click();
      return 'ok';
    })()`);

  // 1) 初始：应显示已选 N 个，N = 本地改动数
  const initial = await readCount();
  const initialNum = Number(/已选 (\d+) 个/.exec(initial)?.[1] ?? -1);
  check('初始显示已选数量', initialNum > 0, initial);

  // 2) 取消勾选第一个 → 数字应减 1
  await clickFileCheckbox(0);
  await sleep(400);
  const afterUncheck = await readCount();
  const uncheckedNum = Number(/已选 (\d+) 个/.exec(afterUncheck)?.[1] ?? 0);
  check(
    '取消勾选后数量立即 -1',
    initialNum >= 0 && uncheckedNum === initialNum - 1,
    `${initial} → ${afterUncheck}`
  );

  // 3) 点「重新扫描」→ 数量应保持不变（不被重置成全选）
  await clickButtonByLabel('重新扫描');
  await sleep(2500);
  const afterRefresh = await readCount();
  check('刷新后勾选不被重置', afterRefresh === afterUncheck, `${afterUncheck} → ${afterRefresh}`);

  // 4) 勾回第一个 → +1
  await clickFileCheckbox(0);
  await sleep(400);
  const afterRecheck = await readCount();
  const recheckNum = Number(/已选 (\d+) 个/.exec(afterRecheck)?.[1] ?? 0);
  check('重新勾选后数量 +1', recheckNum === uncheckedNum + 1, `${afterUncheck} → ${afterRecheck}`);

  // 5) 切到「待更新」→ 应显示待更新数或空态，而不是另一页签的已选数
  await clickByText('待更新');
  await sleep(3000);
  const remoteTab = await readCount();
  check(
    '待更新页签显示自己的语义',
    /文件可同步|没有新内容|正在检查服务器/.test(remoteTab),
    remoteTab
  );

  // 6) 切回「待提交」→ 勾选数量应还在
  await clickByText('待提交');
  await sleep(600);
  const backToLocal = await readCount();
  check('切回待提交后勾选保持', backToLocal === afterRecheck, `${afterRecheck} → ${backToLocal}`);

  check('无运行时异常', errors.length === 0, errors.join(' | ') || '无');

  const pass = results.filter((r) => r[1]).length;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${String(detail).slice(0, 100)}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);

  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  ws.close();
  process.exit(pass === results.length ? 0 : 2);
}

main().catch((e) => {
  console.error('自测失败:', e.message);
  process.exit(1);
});
