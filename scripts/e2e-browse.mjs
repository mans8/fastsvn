#!/usr/bin/env node
/**
 * 浏览能力自测：本地目录树展开 + 文件预览 + 仓库浏览器。
 *
 * 用法：node scripts/e2e-browse.mjs <baseUrl>
 * 前置：Chrome 以 --remote-debugging-port=9222 常驻。
 */

const PORT = process.env.CDP_PORT || 9222;
const [, , baseArg] = process.argv;
const base = (baseArg || 'http://127.0.0.1:5183/').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(url, waitMs, fn) {
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
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
  await send('Page.navigate', { url });
  await sleep(waitMs);

  try {
    return await fn({ evaluate, errors, sleep });
  } finally {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
    ws.close();
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${String(detail).slice(0, 110)}`);
};

async function testLocalBrowser() {
  console.log('\n— 本地目录浏览 —');
  await session(`${base}/?tab=files&theme=light`, 5000, async ({ evaluate, errors }) => {
    // 1) 根目录应列出目录与文件
    const rootNames = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('button')].filter(b => b.querySelector('.status-letter') || b.textContent.includes('README'));
      return document.body.innerText.match(/assets|docs|src|web|README\\.md/g) || [];
    })()`);
    check('根目录列出内容', Array.isArray(rootNames) && rootNames.length > 0, String(rootNames));

    // 2) 点 docs 展开（树形：原地展开，不再下钻换页）
    await evaluate(`(() => {
      const b = document.querySelector('[data-local-tree-row="docs"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(1500);
    const inDocs = await evaluate(`[...document.querySelectorAll('[data-local-tree-row^="docs/"]')].map(e => e.getAttribute('data-local-tree-row'))`);
    check('展开子目录后显示其内容', Array.isArray(inDocs) && inDocs.some((p) => p.includes('接口说明')), JSON.stringify(inDocs));

    // 3) 点第一个文件 → 右侧出现内容
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('接口说明.md'));
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(1200);
    const preview = await evaluate(`(() => {
      const pre = document.querySelector('pre');
      return pre ? pre.textContent.slice(0, 60) : 'NO_PRE';
    })()`);
    check('点文件显示内容预览', preview !== 'NO_PRE' && preview.length > 0, String(preview));

    // 4) 再点一次 docs 收起
    await evaluate(`(() => {
      const b = document.querySelector('[data-local-tree-row="docs"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);
    const collapsed = await evaluate(`document.querySelectorAll('[data-local-tree-row^="docs/"]').length`);
    check('再次点击可收起目录', collapsed === 0, `${collapsed} 行子项`);

    check('无运行时异常', errors.length === 0, errors.join(' | ') || '无');
  });
}

async function testRepoBrowser() {
  console.log('\n— 仓库浏览器 —');
  await session(`${base}/?dialog=repo&theme=light`, 7000, async ({ evaluate, errors }) => {
    // 1) 地址应已预填
    const url = await evaluate(`(() => {
      const el = document.querySelector('input[placeholder*="svn.example.com"]');
      return el ? el.value : 'NO_INPUT';
    })()`);
    check('地址自动预填当前项目', String(url).startsWith('file://') || String(url).startsWith('http'), url);

    // 2) 表格应有内容且列齐全
    const headers = await evaluate(`(() => {
      const ths = [...document.querySelectorAll('th')].map(t => t.textContent.trim());
      return ths.join('|');
    })()`);
    check('表头六列齐全', headers === '名称|提交人|提交时间|版本号|说明|操作', headers);

    const rowCount = await evaluate(`document.querySelectorAll('tbody tr').length`);
    check('列出条目', rowCount >= 4, `${rowCount} 行`);

    // 3) 名称列不应被截断成 "a..."
    // 只取名称元素本身：行内还有"打开/查看"提示和文件大小，用 td.innerText 会混进来
    const firstName = await evaluate(`(() => {
      const el = document.querySelector('tbody tr td span.truncate');
      return el ? el.textContent.trim() : 'NONE';
    })()`);
    check('目录名完整显示', ['assets', 'docs', 'src', 'web'].includes(firstName), firstName);

    // 4) 点目录行 → 右侧切到该目录
    await evaluate(`(() => {
      const tr = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('docs'));
      if (tr) tr.click();
      return !!tr;
    })()`);
    await sleep(1800);
    const afterClick = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('tbody tr')].map(r => r.innerText);
      return rows.join(' ;; ').slice(0, 160);
    })()`);
    check('点目录后进入下一层', /接口说明/.test(afterClick), afterClick);

    check('无运行时异常', errors.length === 0, errors.join(' | ') || '无');
  });
}

async function main() {
  await testLocalBrowser();
  await testRepoBrowser();
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 2);
}

main().catch((e) => {
  console.error('自测失败:', e.message);
  process.exit(1);
});
