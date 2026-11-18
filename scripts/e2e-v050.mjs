#!/usr/bin/env node
/**
 * v0.5.0 自测：本轮 7 条改动的回归验证。
 *
 *   1. 仓库浏览：左树自动展开并滚到当前目录
 *   2. 项目列表：主题色 / 当前加粗 / 非工作副本灰掉 / 右键移除
 *   3. 打开已有文件夹：访达选目录（桌面外壳才有桥，浏览器里走提示分支）
 *   4. 设置：忽略 .DS_Store，默认开，关掉后后端真的不过滤
 *   5. 本地目录：树形展开
 *   6/7. 页签叫法：待提交 / 待更新
 *
 * 前置：Chrome 以 --remote-debugging-port=9222 常驻；服务跑在 5183。
 * 用法：node scripts/e2e-v050.mjs http://127.0.0.1:5183
 */

import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const [, , base, outDirArg] = process.argv;
if (!base) {
  console.error('用法: node scripts/e2e-v050.mjs <baseUrl> [截图目录]');
  process.exit(1);
}
const outDir = outDirArg || 'screens';
// 截图目录可能被清理过，先确保存在（否则 writeFile 直接 ENOENT）
mkdirSync(outDir, { recursive: true });
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

  const results = [];
  const check = (name, ok, detail) => results.push([name, ok, detail]);

  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.data, 'base64'));
  };

  /** 用真实鼠标事件点一个元素（React Aria 走 pointer 事件，合成 click 不稳） */
  const clickAt = async (selector, opt = {}) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到元素 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
      });
    }
    await sleep(opt.wait ?? 500);
  };

  /** 按按钮上的文字找元素，再用真实鼠标点（分段控件不是 role=tab） */
  const clickText = async (text, wait = 800) => {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find((b) =>
        b.textContent.trim().startsWith(${JSON.stringify(text)})
      );
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到按钮：${text}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };

  const nav = async (path, wait = 2600) => {
    await send('Page.navigate', { url: `${base}${path}` });
    await sleep(wait);
  };

  // ---------- 1. 主界面：页签叫法 / 项目列表样式 ----------
  await nav('/?tab=local');

  const tabs = await evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="tab"], button')].map((b) => b.textContent.trim());
    return {
      hasCommit: items.some((t) => t.startsWith('待提交')),
      hasUpdate: items.some((t) => t.startsWith('待更新')),
      oldUpload: items.some((t) => t.startsWith('待上传')),
      oldSync: items.some((t) => t.startsWith('待同步')),
    };
  })()`);
  check('页签改为「待提交」', tabs.hasCommit, JSON.stringify(tabs));
  check('页签改为「待更新」', tabs.hasUpdate, JSON.stringify(tabs));
  check('旧叫法「待上传/待同步」已消失', !tabs.oldUpload && !tabs.oldSync, JSON.stringify(tabs));

  const sidebar = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('nav button')];
    return rows.map((btn) => {
      const nameEl = btn.querySelector('span[class*="text-body-2-medium"]');
      const cs = nameEl ? getComputedStyle(nameEl) : null;
      return {
        text: btn.textContent.trim(),
        current: btn.getAttribute('aria-current'),
        cls: nameEl ? nameEl.className : '',
        weight: cs ? cs.fontWeight : null,
      };
    });
  })()`);
  const active = sidebar.find((r) => r.current === 'true');
  const broken = sidebar.find((r) => r.text.includes('已丢失') || r.text.includes('无 .svn'));
  check('项目名用主题色类', Boolean(active && active.cls.includes('text-accent')), JSON.stringify(active));
  check('当前项目名字加粗', Boolean(active && Number(active.weight) >= 600), JSON.stringify(active));
  check('非工作副本项目灰掉', Boolean(broken && broken.cls.includes('text-text-tertiary')), JSON.stringify(broken));

  // 右键菜单：用真实右键事件（React Aria 的 popover 依赖真实指针）
  const rightClick = async (selector) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + 40, y: r.top + 20 };
    })()`);
    if (!box) throw new Error(`找不到 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
    }
    await sleep(450);
  };
  await rightClick('nav button[aria-current="true"]');
  const menuItems = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
  check('右键菜单含「移除项目」', menuItems.includes('移除项目'), JSON.stringify(menuItems));
  check('右键菜单含「在访达中显示」', menuItems.includes('在访达中显示'), JSON.stringify(menuItems));
  await shoot('20-projects-list');
  // 关掉菜单：真实 Esc 键（合成 KeyboardEvent 不会进 React Aria 的焦点处理）
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await sleep(400);
  let menuClosed = await evaluate(`document.querySelectorAll('[role="menu"]').length === 0`);
  if (!menuClosed) {
    // 兜底：点一下空白处，非模态弹层会自己关
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: 900, y: 760, button: 'left', clickCount: 1 });
    }
    await sleep(400);
    menuClosed = await evaluate(`document.querySelectorAll('[role="menu"]').length === 0`);
  }
  check('右键菜单能关掉', menuClosed, `menuClosed=${menuClosed}`);

  // 点灰色的项目：不该切过去，而是明确说明为什么打不开
  const brokenIdx = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('nav button')];
    return rows.findIndex((b) => /无 \.svn|已丢失/.test(b.textContent));
  })()`);
  if (brokenIdx >= 0) {
    await clickAt('nav button[data-project-broken="true"]', { wait: 900 });
    const toastText = await evaluate(`document.body.innerText`);
    check('点灰色项目会说明原因', /打不开这个项目/.test(toastText), '');
    await shoot('27-broken-project');
  } else {
    check('点灰色项目会说明原因', false, '列表里没有非工作副本项目');
  }

  // ---------- 2. 设置：忽略 .DS_Store ----------
  await nav('/?dialog=settings', 1800);
  const sw = await evaluate(`(() => {
    const el = document.querySelector('[aria-label="忽略 .DS_Store"]');
    if (!el) return null;
    return { checked: el.checked === true || el.getAttribute('aria-checked') === 'true', text: el.outerHTML.slice(0, 160) };
  })()`);
  check('设置里有「忽略 .DS_Store」开关', Boolean(sw), JSON.stringify(sw));
  check('默认是开启状态', Boolean(sw && sw.checked), JSON.stringify(sw));
  await shoot('21-settings');

  await clickAt('[aria-label="忽略 .DS_Store"]', { wait: 900 });
  const offState = await evaluate(`fetch('/api/settings').then(r => r.json())`);
  check('关掉开关后后端保存为 false', offState.ignoreDsStore === false, JSON.stringify(offState));
  await clickAt('[aria-label="忽略 .DS_Store"]', { wait: 900 });
  const onState = await evaluate(`fetch('/api/settings').then(r => r.json())`);
  check('再打开后恢复 true', onState.ignoreDsStore === true, JSON.stringify(onState));

  // ---------- 3. 本地目录：树形 ----------
  await nav('/?tab=files', 2600);
  const treeBefore = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-local-tree-row]')];
    return rows.map((r) => r.getAttribute('data-local-tree-row'));
  })()`);
  check('本地目录有根节点', treeBefore.includes(''), JSON.stringify(treeBefore.slice(0, 8)));
  check('根目录下默认列出子项', treeBefore.length > 1, `${treeBefore.length} 行`);

  await clickAt('[data-local-tree-row="docs"]', { wait: 1200 });
  const treeAfter = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-local-tree-row]')];
    return {
      paths: rows.map((r) => r.getAttribute('data-local-tree-row')),
      hasDs: document.body.innerText.includes('.DS_Store'),
      indents: rows.map((r) => parseInt(getComputedStyle(r).paddingLeft, 10)),
    };
  })()`);
  const nested = treeAfter.paths.filter((p) => p.startsWith('docs/'));
  check('展开 docs 后出现子项', nested.length > 0, JSON.stringify(nested));
  check('树形缩进随层级增加', Math.max(...treeAfter.indents) > Math.min(...treeAfter.indents), JSON.stringify(treeAfter.indents.slice(0, 8)));
  check('忽略 .DS_Store 后列表里看不到它', treeAfter.hasDs === false, `hasDs=${treeAfter.hasDs}`);
  await shoot('22-local-tree');

  // ---------- 4. 仓库浏览：左树自动定位 ----------
  await nav('/?dialog=repo', 3200);
  const repoRoot = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-repo-tree] [data-tree-url]')];
    return rows.map((r) => r.getAttribute('data-tree-url'));
  })()`);
  check('仓库浏览已加载左侧树', repoRoot.length > 0, JSON.stringify(repoRoot.slice(0, 3)));

  await clickAt('tr[data-kind="dir"][data-name="src"]', { wait: 1600 });
  const afterSrc = await evaluate(`(() => {
    const box = document.querySelector('[data-repo-tree]');
    const active = box && box.querySelector('[data-tree-active="true"]');
    const rows = [...box.querySelectorAll('[data-tree-url]')].map((r) => r.getAttribute('data-tree-url'));
    if (!active) return { active: null, rows };
    const br = box.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    return {
      active: active.getAttribute('data-tree-url'),
      name: active.textContent.trim(),
      rows,
      visible: ar.top >= br.top - 2 && ar.bottom <= br.bottom + 2,
    };
  })()`);
  check('点右侧目录后左树高亮到 src', Boolean(afterSrc.active && afterSrc.active.endsWith('/src')), JSON.stringify(afterSrc).slice(0, 200));
  check('高亮行在可视范围内', afterSrc.visible === true, `visible=${afterSrc.visible}`);

  await clickAt('tr[data-kind="dir"][data-name="main"]', { wait: 1600 });
  const afterMain = await evaluate(`(() => {
    const box = document.querySelector('[data-repo-tree]');
    const active = box.querySelector('[data-tree-active="true"]');
    const rows = [...box.querySelectorAll('[data-tree-url]')].map((r) => r.getAttribute('data-tree-url'));
    return { active: active ? active.getAttribute('data-tree-url') : null, rows };
  })()`);
  check('再下一层后左树展开到 main', Boolean(afterMain.active && afterMain.active.endsWith('/main')), JSON.stringify(afterMain).slice(0, 240));
  check(
    '祖先链已展开（trunk → src → main）',
    afterMain.rows.length >= repoRoot.length + 2,
    `${repoRoot.length} → ${afterMain.rows.length}`
  );
  await shoot('23-repo-tree-locate');

  // ---------- 5. 打开已有文件夹：有「选择…」入口 ----------
  await nav('/?dialog=add', 1600);
  const addDlg = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '选择…');
    return { found: Boolean(btn), body: document.body.innerText.includes('打开已有的 SVN 文件夹') };
  })()`);
  check('打开文件夹弹窗有「选择…」按钮', addDlg.found, JSON.stringify(addDlg));
  await shoot('24-add-project');

  // ---------- 6. 提交按钮在「待提交」页签下 + 冲突标红 ----------
  await nav('/?tab=local', 2800);
  const commitUi = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.trim().startsWith('提交')
    );
    const header = document.querySelector('header');
    const conflicts = [...document.querySelectorAll('[data-conflict="true"]')];
    return {
      hasBtn: Boolean(btn),
      inHeader: Boolean(header && btn && header.contains(btn)),
      conflictCount: conflicts.length,
      labeled: conflicts.every((r) => r.innerText.includes('冲突')),
      // Tailwind v4 输出 oklch 颜色，比对 class 比比对 rgb 更稳
      nameRed: conflicts.every((r) => {
        const span = [...r.querySelectorAll('span')].find((x) => x.className.includes('text-body-2-medium'));
        return span ? span.className.includes('text-red-700') : false;
      }),
      badgeRed: conflicts.every((r) => {
        const b = [...r.querySelectorAll('span')].find((x) => x.textContent.trim() === '冲突');
        return b ? b.className.includes('bg-red-600') : false;
      }),
      disabled: btn ? btn.disabled : null,
    };
  })()`);
  check('提交按钮在列表里，不在工具栏', commitUi.hasBtn && !commitUi.inHeader, JSON.stringify(commitUi));
  check(
    '冲突文件标了「冲突」且名字是红色',
    commitUi.conflictCount > 0 && commitUi.labeled && commitUi.nameRed && commitUi.badgeRed,
    JSON.stringify(commitUi)
  );
  await shoot('31-commit-in-tab');

  // 切到「待更新」：提交按钮应当消失（它只属于待提交）
  await clickText('待更新', 1200);
  const inRemote = await evaluate(
    `![...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('提交'))`
  );
  check('「待更新」页签下不显示提交按钮', inRemote === true, String(inRemote));

  // ---------- 7. 提交历史：时间要精确到秒 ----------
  await nav('/?dialog=log', 2600);
  const logInfo = await evaluate(`(() => {
    const text = document.body.innerText;
    const dates = [...document.querySelectorAll('span')]
      .map((s) => s.textContent.trim())
      .filter((t) => /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(t));
    return { dates: dates.slice(0, 3), relative: /昨天|分钟前|小时前/.test(text) };
  })()`);
  check('提交历史时间精确到秒', logInfo.dates.length > 0, JSON.stringify(logInfo.dates));
  check('提交历史不用「昨天」这类相对时间', logInfo.relative === false, String(logInfo.relative));
  await shoot('30-log-datetime');

  // 深色主题：确认主题色/灰态在深色下也可读（截图留档）
  await nav('/?theme=dark&tab=files', 2600);
  await shoot('25-dark-local-tree');
  await nav('/?theme=dark&tab=local', 2400);
  await shoot('26-dark-list');

  // ---------- 汇总 ----------
  check('页面无 JS 异常', errors.length === 0, errors.join(' | '));

  console.log('');
  let failed = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed} / ${results.length} 通过`);

  ws.close();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('自测脚本出错：', e.message);
  process.exit(1);
});
