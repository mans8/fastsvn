#!/usr/bin/env node
/**
 * 本轮改动自测：
 *   1. 「提交 N」按钮缩小、放在「已选 x 个」后面（不再通栏）
 *   2. 待提交支持树形视图（默认仍是平铺）
 *   3. 本地目录右键：更新 / 删除 / 新建子目录
 *   4. 本地目录支持方向键：↑↓ 移动、→ 展开、← 收起、Enter 打开
 *
 * 本地目录的增删改会真的动磁盘，所以自建一个临时仓库来测，跑完即清理。
 *
 * 用法：node scripts/e2e-tree-actions.mjs <baseUrl>
 * 前置：Chrome 以 --remote-debugging-port=9222 常驻；本机有 svn / svnadmin。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const [, , base] = process.argv;
if (!base) {
  console.error('用法: node scripts/e2e-tree-actions.mjs <baseUrl>');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

mkdirSync('screens', { recursive: true });
const ROOT = '/tmp/fastsvn-actions-demo';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const REPO = join(ROOT, 'repo');
const SEED = join(ROOT, 'seed');
const WC = join(ROOT, '工作副本');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

function makeFixtures() {
  execFileSync('svnadmin', ['create', REPO]);
  mkdirSync(join(SEED, 'trunk', 'docs'), { recursive: true });
  mkdirSync(join(SEED, 'trunk', 'src'), { recursive: true });
  writeFileSync(join(SEED, 'trunk', 'README.md'), '# 演示\n');
  writeFileSync(join(SEED, 'trunk', 'docs', 'guide.md'), '# 指南\n');
  writeFileSync(join(SEED, 'trunk', 'src', 'main.ts'), 'export const a = 1;\n');
  svn(['import', SEED, `file://${REPO}`, '-m', 'init']);
  svn(['checkout', `file://${REPO}/trunk`, WC]);

  // 造一点改动：待提交列表才有内容（两个目录 + 一个未纳入的文件）
  writeFileSync(join(WC, 'README.md'), '# 演示\n\n本地改了一行\n');
  writeFileSync(join(WC, 'docs', 'guide.md'), '# 指南\n\n又补了一行\n');
  writeFileSync(join(WC, 'src', 'extra.ts'), 'export const b = 2;\n');
}

async function main() {
  console.log('准备测试仓库…');
  makeFixtures();
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

  /** 用真实鼠标点一个元素（React Aria 走 pointer 事件，合成 click 不稳） */
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

  const clickText = async (text, wait = 700) => {
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

  const rightClick = async (selector, wait = 500) => {
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

  const fillInput = async (selector, value) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
  };

  const menuItems = () => evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);

  // ---------- 准备：切到临时项目 ----------
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2800);
  await clickAt(`[data-project-path="${WC}"]`, 2600);

  // ---------- 1. 提交按钮 ----------
  const btn = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('提交'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const row = b.parentElement.getBoundingClientRect();
    const list = document.querySelector('section').getBoundingClientRect();
    return { text: b.textContent.trim(), width: Math.round(r.width), rowWidth: Math.round(row.width), listWidth: Math.round(list.width) };
  })()`);
  check('提交按钮文案是「提交 + 数量」', Boolean(btn && /^提交\s*\d+$/.test(btn.text)), JSON.stringify(btn));
  check('提交按钮是窄按钮（不是通栏）', Boolean(btn && btn.width < 110 && btn.width < btn.rowWidth * 0.4), JSON.stringify(btn));

  const order = await evaluate(`(() => {
    const spans = [...document.querySelectorAll('span')].filter((s) => /^已选 \\d+ (?:个|项)$/.test(s.textContent.trim()));
    const count = spans[0];
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('提交'));
    if (!count || !b) return null;
    return count.getBoundingClientRect().right <= b.getBoundingClientRect().left;
  })()`);
  check('提交按钮在「已选 x 个」后面', order === true, String(order));
  await shoot('33-commit-compact');

  // ---------- 2. 待提交树形视图 ----------
  const flatRows = await evaluate(`document.querySelectorAll('[data-conflict]').length + document.querySelectorAll('section button[class*="rounded-lg"]').length`);
  const toggle = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('切换为树形'));
    return b ? true : false;
  })()`);
  check('有待提交的视图切换按钮', toggle === true, '');
  await clickAt('button[aria-label="切换为树形视图"]', 900);
  const treeInfo = await evaluate(`(() => {
    const dirs = [...document.querySelectorAll('[data-tree-dir]')].map((d) => d.getAttribute('data-tree-dir'));
    const fileRows = [...document.querySelectorAll('section button')].filter((b) => b.textContent.includes('README.md')).length;
    return { dirs, fileRows, flat: ${flatRows} };
  })()`);
  check('树形视图按目录分组', treeInfo.dirs.length > 0, JSON.stringify(treeInfo));
  await shoot('34-commit-tree');

  // 折叠 docs → 它里面的 guide.md 应当从列表里消失
  await clickAt('[data-tree-dir="docs"]', 700);
  const listAfterCollapse = await evaluate(`document.querySelector('section .thin-scroll')?.innerText || ''`);
  check('折叠目录后子文件不显示', !listAfterCollapse.includes('guide.md'), listAfterCollapse.replace(/\s+/g, ' ').slice(0, 80));
  await clickAt('[data-tree-dir="docs"]', 700);
  const listAfterExpand = await evaluate(`document.querySelector('section .thin-scroll')?.innerText || ''`);
  check('再展开又显示回来', listAfterExpand.includes('guide.md'), '');
  await clickAt('button[aria-label="切换为列表视图"]', 700);

  // ---------- 3. 本地目录右键操作 ----------
  await clickText('本地目录', 2600);
  await rightClick('[data-local-tree-row=""]');
  const rootMenu = await menuItems();
  check('根目录右键有「新建子目录 / 更新」', rootMenu.includes('新建子目录…') && rootMenu.includes('更新'), JSON.stringify(rootMenu));
  check('根目录右键没有「删除」', !rootMenu.includes('删除…'), JSON.stringify(rootMenu));

  await clickMenuItem('新建子目录…', 1200);
  await fillInput('[role="dialog"] input', '新建测试目录');
  await clickText('创建', 1600);
  const created2 = existsSync(join(WC, '新建测试目录'));
  check('新建子目录真的落盘', created2, join(WC, '新建测试目录'));
  const inTree = await evaluate(`[...document.querySelectorAll('[data-local-tree-row]')].map((r) => r.getAttribute('data-local-tree-row')).includes('新建测试目录')`);
  check('新建后目录树里能看到它', inTree === true, '');
  await shoot('35-local-actions');

  await rightClick('[data-local-tree-row="新建测试目录"]');
  const dirMenu = await menuItems();
  check('目录右键有「更新 / 删除」', dirMenu.includes('更新') && dirMenu.includes('删除…'), JSON.stringify(dirMenu));
  await clickMenuItem('更新', 1600);
  const toastUpdate = await evaluate(`document.body.innerText.includes('已更新')`);
  check('右键「更新」有结果反馈', toastUpdate === true, '');

  await rightClick('[data-local-tree-row="新建测试目录"]');
  await clickMenuItem('删除…', 1600);
  const confirmText = await evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="alertdialog"]')].pop();
    return d ? d.innerText.replace(/\\s+/g, ' ').slice(0, 90) : 'NO_DIALOG';
  })()`);
  check('删除有二次确认', /删除/.test(confirmText), confirmText);
  await clickText('删除', 1600);
  check('删除后磁盘上没有了', !existsSync(join(WC, '新建测试目录')), '');

  // ---------- 4. 键盘操作 ----------
  await clickAt('[role="tree"]', 600);
  const cursor0 = await evaluate(`document.querySelector('[data-cursor="true"]')?.getAttribute('data-local-tree-row')`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await sleep(500);
  const cursor1 = await evaluate(`document.querySelector('[data-cursor="true"]')?.getAttribute('data-local-tree-row')`);
  check('方向键 ↓ 能移动光标', cursor1 !== cursor0 && cursor1 !== null, `${cursor0} → ${cursor1}`);

  // → 展开光标所在的目录（先移到 docs）
  await evaluate(`(() => {
    const el = document.querySelector('[data-local-tree-row="docs"]');
    if (el) el.click();
    return true;
  })()`);
  await sleep(600);
  await evaluate(`(() => {
    const el = document.querySelector('[data-local-tree-row="docs"]');
    const r = el.getBoundingClientRect();
    el.focus();
    return true;
  })()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await sleep(600);
  const afterLeft = await evaluate(`document.querySelectorAll('[data-local-tree-row^="docs/"]').length`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(800);
  const afterRight = await evaluate(`document.querySelectorAll('[data-local-tree-row^="docs/"]').length`);
  check('方向键 ← 收起、→ 展开目录', afterLeft === 0 && afterRight > 0, `${afterLeft} → ${afterRight}`);
  await shoot('36-local-keyboard');

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
