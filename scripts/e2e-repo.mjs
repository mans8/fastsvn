/**
 * 仓库浏览器自测。
 *
 * 为什么要单独写：这个弹窗里有多处"只有运行时才暴露"的行为——
 * 列宽拖拽必须用真实指针事件（setPointerCapture 对合成事件失效）、
 * 文件内容要等异步 cat 回来、目录缓存要看真实请求数、检出弹窗要叠在窗口之上。
 *
 * 用法：Chrome 需以 --remote-debugging-port=9222 常驻
 *   node scripts/e2e-repo.mjs http://127.0.0.1:5183/
 */
const PORT = 9222;
const base = (process.argv[2] || 'http://127.0.0.1:5183/').replace(/\/+$/, '');
const url = `${base}/?dialog=repo&theme=light`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
const target = await created.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
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

const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
});

// 统计仓库列表请求次数（验证目录缓存）
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__repoListCalls = [];
    const __of = window.fetch;
    window.fetch = function (...args) {
      const u = String(args[0] && args[0].url ? args[0].url : args[0]);
      if (u.includes('/api/repo/list')) window.__repoListCalls.push(u);
      return __of.apply(this, args);
    };
  `,
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  →  ${detail}` : ''}`);
};

await send('Page.navigate', { url });
await sleep(6000);

// ---------- 1. 头部与地址 ----------
check('标题下没有多余描述', await evaluate(`!document.body.innerText.includes('不用先检出')`));

check(
  '标题与图标同一行',
  await evaluate(`(() => {
    const h = [...document.querySelectorAll('[role="dialog"] h2')].find(e => e.innerText.includes('浏览仓库'));
    if (!h) return false;
    const icon = h.querySelector('svg');
    if (!icon) return false;
    const a = icon.getBoundingClientRect(), b = h.getBoundingClientRect();
    return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 6;
  })()`)
);

const addr = await evaluate(`document.querySelector('[role="dialog"] input')?.value || ''`);
check('仓库地址无百分号编码', addr.length > 0 && !/%[0-9A-F]{2}/i.test(addr), addr);

check(
  '仓库地址标签与输入框同一行',
  await evaluate(`(() => {
    const label = [...document.querySelectorAll('span')].find(e => e.textContent.trim() === '仓库地址');
    const input = document.querySelector('[role="dialog"] input');
    if (!label || !input) return false;
    const a = label.getBoundingClientRect(), b = input.getBoundingClientRect();
    return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 8;
  })()`)
);

// ---------- 2. 表头与行 ----------
const headers = await evaluate(
  `[...document.querySelectorAll('[role="dialog"] thead th')].map(t => t.innerText.trim()).join('|')`
);
check(
  '表头六列顺序正确',
  headers === '名称|提交人|提交时间|版本号|说明|操作',
  headers
);

check(
  '版本号不带 r 前缀',
  await evaluate(`(() => {
    const cells = [...document.querySelectorAll('[role="dialog"] tbody tr')].map(tr => tr.children[3]?.innerText.trim());
    return cells.length > 0 && cells.every(v => v === '—' || /^\\d+$/.test(v));
  })()`),
  await evaluate(`[...document.querySelectorAll('[role="dialog"] tbody tr')].slice(0,3).map(tr=>tr.children[3]?.innerText.trim()).join(', ')`)
);

check(
  '提交时间包含年份',
  await evaluate(`(() => {
    const cells = [...document.querySelectorAll('[role="dialog"] tbody tr')].map(tr => tr.children[2]?.innerText.trim()).filter(Boolean);
    return cells.length > 0 && cells.every(v => /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/.test(v));
  })()`),
  await evaluate(`[...document.querySelectorAll('[role="dialog"] tbody tr')][0]?.children[2]?.innerText.trim() || ''`)
);

check(
  '提交时间不换行',
  await evaluate(`(() => {
    const cells = [...document.querySelectorAll('[role="dialog"] tbody tr')].slice(0, 5);
    if (!cells.length) return false;
    return cells.every(tr => {
      const td = tr.children[2];
      const cs = getComputedStyle(td);
      return cs.whiteSpace === 'nowrap' && td.innerText.indexOf(String.fromCharCode(10)) === -1;
    });
  })()`)
);

check(
  '有提交人列且显示值',
  await evaluate(`(() => {
    const v = [...document.querySelectorAll('[role="dialog"] tbody tr')].map(tr => tr.children[1]?.innerText.trim());
    return v.length > 0 && v.some(x => x && x !== '—');
  })()`),
  await evaluate(`[...document.querySelectorAll('[role="dialog"] tbody tr')].slice(0,2).map(tr=>tr.children[1]?.innerText.trim()).join(', ')`)
);

check(
  '行与行之间没有分割线',
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="dialog"] tbody tr')];
    return rows.length > 0 && rows.every(tr => {
      const cs = getComputedStyle(tr);
      return parseFloat(cs.borderTopWidth) === 0 && parseFloat(cs.borderBottomWidth) === 0;
    });
  })()`)
);

check('底部不再显示完整地址', await evaluate(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const foot = [...dlg.querySelectorAll('div')].find(d => /个目录 · .* 个文件/.test(d.innerText) && d.children.length < 8);
  return foot ? !foot.innerText.includes('://') : true;
})()`));

check(
  '右下角没有「关闭」按钮',
  await evaluate(`![...document.querySelectorAll('[role="dialog"] button')].some(b => b.innerText.trim() === '关闭')`)
);

check(
  '底部保留 检出目录',
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('[role="dialog"] button')].map(b => b.innerText.trim());
    return t.includes('检出目录') && !t.includes('下载');
  })()`)
);

check(
  '每行操作列都有下载按钮',
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="dialog"] tbody tr')];
    return rows.length > 0 && rows.every(tr => {
      const btn = tr.lastElementChild?.querySelector('button[aria-label^="下载 "]');
      return Boolean(btn);
    });
  })()`),
  await evaluate(`(() => {
    const tr = document.querySelector('[role="dialog"] tbody tr');
    return tr?.lastElementChild?.querySelector('button')?.getAttribute('aria-label') || '';
  })()`)
);

check('有刷新按钮', await evaluate(`!!document.querySelector('[aria-label="重新加载当前目录"]')`));

// ---------- 3. 列宽拖拽 ----------
const before = await evaluate(`document.querySelector('[role="dialog"] table col')?.getBoundingClientRect().width`);
const thBox = await evaluate(`(() => {
  const th = document.querySelector('[role="dialog"] thead th');
  const r = th.getBoundingClientRect();
  return { x: Math.round(r.right), y: Math.round(r.top + r.height / 2) };
})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: thBox.x - 2, y: thBox.y, button: 'left', clickCount: 1 });
await sleep(120);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thBox.x + 58, y: thBox.y, button: 'left' });
await sleep(160);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: thBox.x + 58, y: thBox.y, button: 'left', clickCount: 1 });
await sleep(300);
const after = await evaluate(`document.querySelector('[role="dialog"] table col')?.getBoundingClientRect().width`);
check('列宽可拖拽调整', typeof before === 'number' && Math.round(after - before) >= 40, `${Math.round(before)}px → ${Math.round(after)}px`);

// ---------- 4. 目录缓存 ----------
const firstDir = await evaluate(`(() => {
  const tr = document.querySelector('[role="dialog"] tbody tr[data-kind="dir"]');
  if (!tr) return null;
  const name = tr.dataset.name;
  tr.click();
  return name;
})()`);
await sleep(1200);

if (firstDir) {
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === 'fastsvn-demo-repo' || b.classList.contains('font-mono'))?.click()`);
  // 回根目录：点面包屑第一个
  await evaluate(`document.querySelector('[role="dialog"] .font-mono')?.click()`);
  await sleep(900);
  const beforeCalls = await evaluate(`window.__repoListCalls.length`);
  await evaluate(`(() => {
    const tr = [...document.querySelectorAll('[role="dialog"] tbody tr[data-kind="dir"]')].find(x => x.dataset.name === ${JSON.stringify(firstDir)});
    tr?.click();
  })()`);
  await sleep(900);
  const afterCalls = await evaluate(`window.__repoListCalls.length`);
  check('再次点同一目录命中缓存', afterCalls === beforeCalls, `${beforeCalls} → ${afterCalls} 次 /api/repo/list`);

  // 刷新按钮应强制重新请求
  await evaluate(`document.querySelector('[aria-label="重新加载当前目录"]')?.click()`);
  await sleep(900);
  const afterRefresh = await evaluate(`window.__repoListCalls.length`);
  check('刷新按钮强制重新请求', afterRefresh > afterCalls, `${afterCalls} → ${afterRefresh} 次`);
} else {
  check('再次点同一目录命中缓存', false, '当前目录没有子目录，跳过测试');
  check('刷新按钮强制重新请求', false, '跳过');
}

// ---------- 5. 点开文件看内容 ----------
await evaluate(`document.querySelector('[role="dialog"] .font-mono')?.click()`);
await sleep(800);
// 当前目录可能只有目录（仓库根下是 trunk），最多往下钻三层找文件
for (let i = 0; i < 3; i++) {
  const hasFile = await evaluate(`!!document.querySelector('[role="dialog"] tbody tr[data-kind="file"]')`);
  if (hasFile) break;
  await evaluate(`document.querySelector('[role="dialog"] tbody tr[data-kind="dir"]')?.click()`);
  await sleep(1200);
}
const fileName = await evaluate(`(() => {
  const row = document.querySelector('[role="dialog"] tbody tr[data-kind="file"]');
  if (!row) return null;
  const name = row.dataset.name;
  row.click();
  return name;
})()`);
await sleep(1500);
const fileView = await evaluate(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const hasBack = [...dlg.querySelectorAll('button')].some(b => b.innerText.trim() === '返回');
  const hasDownload = [...dlg.querySelectorAll('button')].some(b => b.innerText.trim() === '下载');
  return { hasBack, hasDownload, lines: dlg.querySelectorAll('.font-mono').length > 0 };
})()`);
check('点文件能打开内容', Boolean(fileName) && fileView.hasBack && fileView.lines, fileName || '没有文件可点');
check('文件视图里有下载按钮', fileView.hasDownload);

await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === '返回')?.click()`);
await sleep(700);
check('返回后回到目录列表', await evaluate(`document.querySelectorAll('[role="dialog"] tbody tr').length > 0`));

// ---------- 6. 检出不离窗 ----------
await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === '检出目录')?.click()`);
await sleep(1500);
const stack = await evaluate(`(() => {
  const dlgs = [...document.querySelectorAll('[role="dialog"]')];
  const last = dlgs[dlgs.length - 1];
  const inputs = [...last.querySelectorAll('input')].map(i => i.value);
  return {
    count: dlgs.length,
    title: last.querySelector('h2')?.innerText.trim() || '',
    inputs,
    hasStart: last.innerText.includes('开始检出'),
  };
})()`);
check(
  '检出目录不关闭浏览窗口',
  stack.count >= 2 &&
    (await evaluate(`[...document.querySelectorAll('[role="dialog"]')].some(d => d.innerText.includes('浏览仓库'))`)),
  `${stack.count} 个弹窗叠加`
);
const coAddr = stack.inputs.find((v) => v.includes('://')) || '';
check(
  '检出弹窗预填地址且可读',
  Boolean(coAddr) && !/%[0-9A-F]{2}/i.test(coAddr) && stack.hasStart,
  coAddr.slice(0, 60)
);

// 关掉检出弹窗，仓库浏览还在
await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === '取消')?.click()`);
await sleep(900);
check(
  '关掉检出后仍在浏览窗口',
  await evaluate(`(() => {
    const dlgs = [...document.querySelectorAll('[role="dialog"]')];
    return dlgs.length === 1 && dlgs[0].innerText.includes('浏览仓库');
  })()`)
);

// ---------- 7. 下载入口 ----------
await evaluate(`document.querySelector('[role="dialog"] tbody tr button[aria-label^="下载 "]')?.click()`);
await sleep(2200);
const dl = await evaluate(`(() => {
  const dlgs = [...document.querySelectorAll('[role="dialog"]')];
  const last = dlgs[dlgs.length - 1];
  return { title: last.querySelector('h2')?.innerText.trim() || '', text: last.innerText.includes('开始下载') };
})()`);
check('下载入口打开下载弹窗', dl.title.includes('下载') && dl.text, `${dl.title}`);

check('无运行时异常', errors.length === 0, errors.join(' / ').slice(0, 160));

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);

await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
ws.close();
process.exit(failed ? 1 : 0);
