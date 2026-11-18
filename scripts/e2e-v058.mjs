#!/usr/bin/env node
/**
 * FastSVN UI / 交互回归自测：
 *   1. 提交历史左右两栏的上下边距收紧
 *   2. 项目右键支持设置别名（显示名），清空恢复目录名
 *   3. 工具栏左侧新增「收起 / 展开侧边栏」按钮，状态可持久
 *   4. 「添加已有项目」的 + 从品牌行移到「我的项目」这行
 *   5. 品牌块改成 名字 + 版本号 两行
 *
 * 自建临时仓库，跑完即清理。
 *
 * 用法：node scripts/e2e-v058.mjs <baseUrl>
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const [, , base] = process.argv;
if (!base) {
  console.error('用法: node scripts/e2e-v058.mjs <baseUrl>');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

mkdirSync('screens', { recursive: true });
const ROOT = '/tmp/fastsvn-v058-demo';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const REPO = join(ROOT, 'repo');
const SEED = join(ROOT, 'seed');
const WC = join(ROOT, '别名演示');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

function makeFixtures() {
  execFileSync('svnadmin', ['create', REPO]);
  mkdirSync(join(SEED, 'trunk', 'docs'), { recursive: true });
  writeFileSync(join(SEED, 'trunk', 'README.md'), '# 演示项目\n\n第一版说明\n');
  writeFileSync(join(SEED, 'trunk', 'docs', 'guide.md'), '# 指南\n\n初始内容\n');
  svn(['import', SEED, `file://${REPO}`, '-m', '初始导入']);
  svn(['checkout', `file://${REPO}/trunk`, WC]);
  // 本地改一点：待提交里有内容，右键菜单才有意义
  writeFileSync(join(WC, 'README.md'), '# 演示项目\n\n第一版说明\n本地补的一行\n');
}

async function main() {
  console.log('准备测试仓库…');
  makeFixtures();
  // 折叠状态存在 localStorage：先按展开态开始，避免上一轮的影响
  await fetch(`${base}/api/working-copies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: WC }),
  });

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
      }, 25_000);
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.text ?? 'unknown');
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('无法连接 CDP')), { once: true });
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`screens/${name}.png`, Buffer.from(r.data, 'base64'));
  };
  const clickAt = async (selector, wait = 700) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 80), y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到元素 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };
  const rightClick = async (selector, wait = 600) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 80), y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到元素 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
    }
    await sleep(wait);
  };
  const clickMenuItem = async (text, wait = 900) => {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes(${JSON.stringify(text)}));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`菜单里没有「${text}」`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };
  const waitFor = async (expression, timeout = 6000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    return false;
  };
  // 清掉上一轮可能留下的折叠状态
  const resetSidebarState = async () => {
    await send('Page.navigate', { url: `${base}/?tab=local` });
    await sleep(1500);
    await evaluate(`localStorage.removeItem('fastsvn.sidebar')`);
  };
  await resetSidebarState();

  // ---------- 1. 品牌块 + 「我的项目」的 + ----------
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2800);

  const brand = await evaluate(`(() => {
    const row = document.querySelector('[data-brand-row]');
    if (!row) return null;
    const [name, ver] = [...row.children];
    if (!name || !ver) return null;
    const n = name.getBoundingClientRect();
    const v = ver.getBoundingClientRect();
    return {
      name: name.textContent.trim(),
      version: ver.textContent.trim(),
      nameSize: parseFloat(getComputedStyle(name).fontSize),
      verSize: parseFloat(getComputedStyle(ver).fontSize),
      sameLine: Math.abs(n.top + n.height / 2 - (v.top + v.height / 2)) < 6,
      versionOnRight: v.left >= n.right - 2,
    };
  })()`);
  check(
    '品牌区一行：FastSVN 居左、版本号小字跟右',
    Boolean(
      brand &&
        brand.name === 'FastSVN' &&
        /^V\d/.test(brand.version) &&
        brand.sameLine &&
        brand.versionOnRight &&
        brand.nameSize > brand.verSize
    ),
    JSON.stringify(brand)
  );

  const addBtn = await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="添加已有项目"]');
    if (!btn) return null;
    const brandRow = document.querySelector('[data-brand-row]');
    const section = [...document.querySelectorAll('div')].find((d) => d.textContent.trim().startsWith('我的项目') && d.querySelector('button[aria-label="添加已有项目"]'));
    const b = btn.getBoundingClientRect();
    const label = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === '我的项目');
    const l = label ? label.getBoundingClientRect() : null;
    return {
      inBrandRow: Boolean(brandRow && brandRow.contains(btn)),
      sameRowAsLabel: Boolean(l && Math.abs((b.top + b.height / 2) - (l.top + l.height / 2)) < 12),
      inSection: Boolean(section),
      size: Math.round(b.width),
    };
  })()`);
  check(
    '+ 不再挂在品牌行，而是跟「我的项目」同一行',
    Boolean(addBtn && !addBtn.inBrandRow && addBtn.sameRowAsLabel && addBtn.inSection),
    JSON.stringify(addBtn)
  );
  await shoot('55-brand-projects');

  // ---------- 2. 侧边栏折叠 ----------
  const toggle0 = await evaluate(`(() => {
    const btn = document.querySelector('[data-toolbar] button');
    return btn ? { label: btn.getAttribute('aria-label'), x: Math.round(btn.getBoundingClientRect().left) } : null;
  })()`);
  check('工具栏最左侧是侧栏开关', Boolean(toggle0 && toggle0.label === '收起侧边栏' && toggle0.x < 260), JSON.stringify(toggle0));

  // 图标是"圆角方框 + 左侧竖线"，不再是带三角形的 Remix 图标
  const toggleIcon = await evaluate(`(() => {
    const btn = document.querySelector('[data-sidebar-toggle]');
    const svg = btn?.querySelector('svg');
    if (!svg) return null;
    return { rect: svg.querySelectorAll('rect').length, line: svg.querySelectorAll('line').length, path: svg.querySelectorAll('path').length };
  })()`);
  check(
    '侧栏图标是方框 + 竖线（没有三角箭头）',
    Boolean(toggleIcon && toggleIcon.rect === 1 && toggleIcon.line === 1 && toggleIcon.path === 0),
    JSON.stringify(toggleIcon)
  );

  await clickAt('[data-toolbar] button', 700);
  const collapsed = await evaluate(`(() => ({
    aside: document.querySelectorAll('aside').length,
    label: document.querySelector('[data-toolbar] button')?.getAttribute('aria-label'),
    shell: document.querySelector('[data-app-shell]')?.getAttribute('data-sidebar'),
    titleX: Math.round(document.querySelector('[data-toolbar] div span')?.getBoundingClientRect().left ?? 0),
  }))()`);
  check(
    '点一下就收起侧边栏，按钮变成「展开侧边栏」',
    collapsed.aside === 0 && collapsed.label === '展开侧边栏' && collapsed.shell === 'closed',
    JSON.stringify(collapsed)
  );
  check('收起后内容区左移（标题更靠左）', collapsed.titleX < 240, `标题 x=${collapsed.titleX}`);

  // 侧栏一收起，「设置」入口也跟着没了：工具栏要补一个
  const settingsEntry = await evaluate(`Boolean([...document.querySelectorAll('[data-toolbar] button')].find((b) => b.getAttribute('aria-label') === '设置'))`);
  check('侧栏收起时工具栏补上「设置」入口', settingsEntry === true, String(settingsEntry));
  await shoot('56-sidebar-collapsed');

  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2600);
  const stillCollapsed = await evaluate(`document.querySelectorAll('aside').length === 0`);
  check('收起状态刷新后仍保留', stillCollapsed === true, String(stillCollapsed));

  await clickAt('[data-toolbar] button', 700);
  const expanded = await evaluate(`(() => ({
    aside: document.querySelectorAll('aside').length,
    label: document.querySelector('[data-toolbar] button')?.getAttribute('aria-label'),
  }))()`);
  check('再点一下能展开回来', expanded.aside === 1 && expanded.label === '收起侧边栏', JSON.stringify(expanded));

  // ---------- 3. 勾选状态不应滚动整页（WKWebView 会把焦点 checkbox 滚出文档） ----------
  await clickAt(`[data-project-path="${WC}"]`, 2400);
  const checkboxBefore = await evaluate(`(() => {
    const row = document.querySelector('[data-file-row="README.md"]');
    return Boolean(row?.querySelector('input[type="checkbox"]')?.checked);
  })()`);
  await clickAt('[data-file-row="README.md"] label', 500);
  const checkboxAfter = await evaluate(`(() => ({
    checked: document.querySelector('[data-file-row="README.md"] input[type="checkbox"]')?.checked,
    scrollY,
    viewport: document.documentElement.clientHeight,
    documentHeight: document.documentElement.scrollHeight,
    rootHeight: Math.round(document.querySelector('#root').getBoundingClientRect().height),
  }))()`);
  check('点击文件复选框会取消勾选', checkboxBefore === true && checkboxAfter.checked === false, JSON.stringify(checkboxAfter));
  check(
    '取消勾选不会滚动/压缩整页',
    checkboxAfter.scrollY === 0 && checkboxAfter.documentHeight === checkboxAfter.viewport && checkboxAfter.rootHeight === checkboxAfter.viewport,
    JSON.stringify(checkboxAfter)
  );

  // ---------- 4. 项目别名与右键路径 ----------
  await rightClick(`[data-project-path="${WC}"]`);
  const menuItems = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
  check('项目右键有「设置别名…」', menuItems.includes('设置别名…'), JSON.stringify(menuItems));
  check('项目右键有「复制路径」', menuItems.includes('复制路径'), JSON.stringify(menuItems));

  await evaluate(`(() => {
    window.__copiedProjectPath = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__copiedProjectPath = text; } },
    });
  })()`);
  await clickMenuItem('复制路径', 400);
  const copiedPath = await evaluate('window.__copiedProjectPath');
  check('点击「复制路径」写入项目完整路径', copiedPath === WC, String(copiedPath));

  await rightClick(`[data-project-path="${WC}"]`);
  await clickMenuItem('设置别名', 900);

  const dialogOpened = await waitFor(`Boolean(document.querySelector('[role="dialog"] input'))`, 4000);
  check('点开是设置别名的输入弹窗', dialogOpened === true, String(dialogOpened));

  const filled = await evaluate(`(() => {
    const i = document.querySelector('[role="dialog"] input');
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, '我的订单项目（旧版）');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === '保存');
    b?.click();
    return Boolean(b);
  })()`);
  await sleep(1400);

  const aliased = await evaluate(`(() => {
    const row = document.querySelector('[data-project-path="${WC}"]');
    const chip = row?.querySelector('[data-project-alias]');
    const headerChip = document.querySelector('[data-toolbar] [data-project-alias]');
    return {
      listName: row ? row.querySelector('span[class*="text-body-2-medium"]')?.textContent?.trim() : null,
      listChip: chip ? chip.textContent.trim() : null,
      // 被省略号截断时 scrollWidth 会明显大于 clientWidth
      chipClipped: chip ? chip.scrollWidth > chip.clientWidth + 1 : false,
      headerClipped: headerChip ? headerChip.scrollWidth > headerChip.clientWidth + 1 : false,
      title: document.querySelector('[data-toolbar] [data-project-title]')?.textContent?.trim(),
      headerChip: document.querySelector('[data-toolbar] [data-project-alias]')?.textContent?.trim(),
      toast: document.body.innerText.includes('已设置别名'),
    };
  })()`);
  check(
    '别名不替代项目名，只在名字后面挂小标签',
    Boolean(
      aliased.listName === '别名演示' &&
        aliased.title === '别名演示' &&
        aliased.listChip === '我的订单项目（旧版）' &&
        aliased.headerChip === '我的订单项目（旧版）' &&
        aliased.chipClipped === false &&
        aliased.headerClipped === false
    ),
    JSON.stringify(aliased)
  );
  check('设置别名有结果提示', aliased.toast === true, String(aliased.toast));
  await shoot('57-alias-applied');

  // 再打开：输入框应当预填当前别名
  await rightClick(`[data-project-path="${WC}"]`);
  await clickMenuItem('设置别名', 900);
  const prefilled = await evaluate(`document.querySelector('[role="dialog"] input')?.value ?? null`);
  check('再次设置时预填当前别名', prefilled === '我的订单项目（旧版）', String(prefilled));

  // 清空 → 恢复目录名
  await evaluate(`(() => {
    const i = document.querySelector('[role="dialog"] input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.trim() === '保存');
    b?.click();
    return Boolean(b);
  })()`);
  await sleep(1400);
  const cleared = await evaluate(`(() => {
    const row = document.querySelector('[data-project-path="${WC}"]');
    return {
      listName: row ? row.querySelector('span[class*="text-body-2-medium"]')?.textContent?.trim() : null,
      listChip: row?.querySelector('[data-project-alias]')?.textContent ?? null,
      title: document.querySelector('[data-toolbar] [data-project-title]')?.textContent?.trim(),
      headerChip: document.querySelector('[data-toolbar] [data-project-alias]')?.textContent ?? null,
    };
  })()`);
  check(
    '清空别名后标签消失、名字仍是目录名',
    cleared.listName === '别名演示' && cleared.title === '别名演示' && !cleared.listChip && !cleared.headerChip,
    JSON.stringify(cleared)
  );

  // ---------- 5. 提交历史上下边距 ----------
  await clickAt('button[aria-label="提交历史"]', 2800);
  await waitFor(`Boolean(document.querySelector('[role="dialog"] [role="separator"]'))`, 6000);
  const gaps = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const sep = dlg?.querySelector('[role="separator"]');
    const panel = sep?.previousElementSibling;
    const desc = dlg?.querySelector('p');
    if (!dlg || !panel) return null;
    const pr = panel.getBoundingClientRect();
    const dr = dlg.getBoundingClientRect();
    return {
      top: Math.round(pr.top - (desc ? desc.getBoundingClientRect().bottom : 0)),
      bottom: Math.round(dr.bottom - pr.bottom),
      height: Math.round(pr.height),
    };
  })()`);
  check('两栏与标题之间不留大空隙（≤ 12px）', Boolean(gaps && gaps.top <= 12), JSON.stringify(gaps));
  check('两栏与弹窗底部之间不留大空隙（≤ 26px）', Boolean(gaps && gaps.bottom <= 26), JSON.stringify(gaps));
  await shoot('58-log-tight');

  // ---------- 6. 桌面壳：品牌区在红黄绿下面 ----------
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2600);
  await evaluate(`document.body.classList.add('in-app')`);
  await sleep(400);
  const brandPos = await evaluate(`(() => {
    const row = document.querySelector('[data-brand-row]');
    const cs = getComputedStyle(row);
    return { top: parseFloat(cs.paddingTop), left: parseFloat(cs.paddingLeft) };
  })()`);
  check(
    '桌面壳下品牌区让到红黄绿下方（顶 44 / 左 16）',
    Boolean(brandPos && brandPos.top >= 40 && brandPos.left <= 20),
    JSON.stringify(brandPos)
  );
  await shoot('66-inapp-brand');

  // ---------- 7. 设置弹窗：运行信息不带横线 ----------
  await send('Page.navigate', { url: `${base}/?dialog=settings` });
  await sleep(2400);
  const settingsInfo = await evaluate(`(() => {
    const dl = document.querySelector('[role="dialog"] dl');
    if (!dl) return null;
    const rows = [...dl.children];
    const bordered = rows.filter((r) => {
      const cs = getComputedStyle(r);
      return cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none';
    }).length;
    const engine = [...dl.querySelectorAll('dt')].find((d) => d.textContent.includes('svn 引擎'));
    return {
      cls: dl.className,
      bordered,
      engine: engine ? engine.nextElementSibling.textContent.trim() : null,
    };
  })()`);
  check(
    '运行信息各行之间没有横线',
    Boolean(settingsInfo && !settingsInfo.cls.includes('divide') && settingsInfo.bordered === 0),
    JSON.stringify(settingsInfo)
  );
  check(
    'svn 引擎标明内嵌 / 系统 + 版本号',
    Boolean(settingsInfo && /已就绪 · (内嵌|系统) \d/.test(settingsInfo.engine ?? '')),
    settingsInfo ? settingsInfo.engine : 'no row'
  );
  await shoot('68-settings-clean');

  check('页面无 JS 异常', errors.length === 0, errors.join(' | '));
  ws.close();

  // ---------- 清理 ----------
  await fetch(`${base}/api/working-copies`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: WC }),
  });
  rmSync(ROOT, { recursive: true, force: true });

  console.log('');
  let failed = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed} / ${results.length} 通过`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('自测脚本出错：', e.message);
  try {
    await fetch(`${base}/api/working-copies`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: WC }),
    });
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
