#!/usr/bin/env node
/**
 * 本轮 6 条改动自测：
 *   1. 提交按钮与视图切换按钮换位；树形行更紧、不显示路径
 *   2. 「更新到最新」与右键「更新」都要说清更新了什么（没有更新也要说）
 *   3. 本地目录去掉键盘提示
 *   4. 提交历史：点记录 → 看文件 → 点文件 → 看具体改动
 *   5. 待提交右键支持「打开」
 *   6. 本地目录右键「查看历史」→ 同样的三级下钻
 *
 * 自建临时仓库（含一个"同事"工作副本用于制造远端更新），跑完即清理。
 *
 * 用法：node scripts/e2e-v054.mjs <baseUrl>
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const [, , base] = process.argv;
if (!base) {
  console.error('用法: node scripts/e2e-v054.mjs <baseUrl>');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

mkdirSync('screens', { recursive: true });
const ROOT = '/tmp/fastsvn-log-demo';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const REPO = join(ROOT, 'repo');
const SEED = join(ROOT, 'seed');
const WC = join(ROOT, '工作副本');
const PEER = join(ROOT, '同事的副本');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

function makeFixtures() {
  execFileSync('svnadmin', ['create', REPO]);
  mkdirSync(join(SEED, 'trunk', 'docs'), { recursive: true });
  mkdirSync(join(SEED, 'trunk', 'src'), { recursive: true });
  writeFileSync(join(SEED, 'trunk', 'README.md'), '# 演示项目\n\n第一版说明\n');
  writeFileSync(join(SEED, 'trunk', 'docs', 'guide.md'), '# 指南\n\n初始内容\n');
  writeFileSync(join(SEED, 'trunk', 'src', 'main.ts'), 'export const a = 1;\n');
  // 深层长路径：用来验证左栏文件列表的横向滚动
  const deepDir = join(SEED, 'trunk', 'src', 'very', 'deeply', 'nested', 'module', 'components');
  mkdirSync(deepDir, { recursive: true });
  writeFileSync(join(deepDir, 'some-really-long-file-name-with-a-tail.ts'), 'export const deep = 1;\n');
  svn(['import', SEED, `file://${REPO}`, '-m', '初始导入']);
  svn(['checkout', `file://${REPO}/trunk`, WC]);
  svn(['checkout', `file://${REPO}/trunk`, PEER]);

  // 同事提交一版：README.md 改动（让"更新到最新"有东西可更新）
  writeFileSync(join(PEER, 'README.md'), '# 演示项目\n\n第一版说明\n同事补的一行\n');
  svn(['commit', PEER, '-m', '同事更新了说明']);

  // 本地也改一个文件：待提交里才有内容
  writeFileSync(join(WC, 'docs', 'guide.md'), '# 指南\n\n初始内容\n本地补的一行\n');
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
      const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}));
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
  const bodyText = () => evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
  const waitFor = async (expression, timeout = 6000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    return false;
  };

  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2800);
  await clickAt(`[data-project-path="${WC}"]`, 2600);

  // ---------- 1. 按钮换位 + 树形紧凑 ----------
  const order = await evaluate(`(() => {
    const toggle = document.querySelector('button[aria-label="切换为树形视图"]');
    const commit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('提交'));
    if (!toggle || !commit) return null;
    return { toggleX: Math.round(toggle.getBoundingClientRect().left), commitX: Math.round(commit.getBoundingClientRect().left) };
  })()`);
  check('视图切换按钮在提交按钮左边（已换位）', Boolean(order && order.toggleX < order.commitX), JSON.stringify(order));

  const flatHeight = await evaluate(`(() => {
    const row = [...document.querySelectorAll('section button')].find((b) => b.textContent.includes('guide.md'));
    return row ? Math.round(row.getBoundingClientRect().height) : 0;
  })()`);
  await clickAt('button[aria-label="切换为树形视图"]', 900);
  const treeInfo = await evaluate(`(() => {
    const row = [...document.querySelectorAll('section button')].find((b) => b.textContent.includes('guide.md'));
    return row
      ? { height: Math.round(row.getBoundingClientRect().height), text: row.innerText.replace(/\\n/g, '|') }
      : null;
  })()`);
  check('树形行更紧凑', Boolean(treeInfo && treeInfo.height < flatHeight), `平铺 ${flatHeight}px → 树形 ${treeInfo?.height}px`);
  check('树形行不再显示路径', Boolean(treeInfo && !treeInfo.text.includes('docs')), JSON.stringify(treeInfo));
  await shoot('38-tree-compact');
  await clickAt('button[aria-label="切换为列表视图"]', 700);

  // ---------- 5. 右键「打开」 ----------
  await rightClick('[data-file-row="docs/guide.md"]');
  const fileMenu = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
  check('待提交右键有「打开」', fileMenu.includes('打开'), JSON.stringify(fileMenu));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);

  // ---------- 2. 更新提示 ----------
  await clickText('更新到最新', 3000);
  const updateToast = await bodyText();
  check('更新后有明细提示', /更新了 1 个文件/.test(updateToast) && /README\.md/.test(updateToast), updateToast.slice(0, 160));
  await shoot('39-update-toast');

  await clickText('更新到最新', 2600);
  const noChangeToast = await bodyText();
  check('没有更新时也有提示', /已经是最新的/.test(noChangeToast), noChangeToast.slice(0, 140));

  // ---------- 3 & 6. 本地目录：无键盘提示 + 右键查看历史 ----------
  await clickText('本地目录', 2600);
  const dirText = await bodyText();
  check('本地目录去掉了键盘提示', !/↑↓ 移动/.test(dirText), '');

  await rightClick('[data-local-tree-row=""]');
  const rootMenu = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
  check('本地目录右键有「查看历史」', rootMenu.includes('查看历史'), JSON.stringify(rootMenu));
  await clickMenuItem('更新', 2200);
  const localUpdateToast = await bodyText();
  check('本地目录右键更新也有提示', /已更新到最新/.test(localUpdateToast) && /已经是最新的/.test(localUpdateToast), localUpdateToast.slice(-160));

  await rightClick('[data-local-tree-row="docs"]');
  await clickMenuItem('查看历史', 2200);
  const logTitle = await bodyText();
  check('右键「查看历史」打开的是该目录的历史', /「docs」的提交历史/.test(logTitle), logTitle.slice(0, 120));

  // ---------- 4 & 6. 历史 → 文件 → 具体改动 ----------
  const fileDiffFlow = async (label, opts = {}) => {
    await waitFor(`Boolean(document.querySelector('[role="dialog"] [data-log-entry]'))`, 8000);
    // 第一条默认展开；万一没展开就点一下
    if (!(await evaluate(`document.querySelectorAll('[data-log-file]').length > 0`))) {
      await evaluate(`document.querySelector('[role="dialog"] [data-log-entry]').click()`);
      await waitFor(`document.querySelectorAll('[data-log-file]').length > 0`, 5000);
    }
    const files = await evaluate(`[...document.querySelectorAll('[data-log-file]')].map((e) => e.getAttribute('data-log-file'))`);

    check(`${label}：记录下方能看到改动的文件`, files.length > 0, JSON.stringify(files));
    if (!files.length) return;

    // 收起 / 再展开
    await evaluate(`document.querySelector('[role="dialog"] [data-log-entry]').click()`);
    await sleep(400);
    const collapsed = await evaluate(`document.querySelectorAll('[data-log-file]').length`);
    await evaluate(`document.querySelector('[role="dialog"] [data-log-entry]').click()`);
    await waitFor(`document.querySelectorAll('[data-log-file]').length > 0`, 4000);
    check(`${label}：文件列表可收起再展开`, collapsed === 0, `收起后 ${collapsed} 个文件行`);

    // 长路径：左栏应当出现横向滚动，而不是把路径截断
    // （只有展开的那条记录里含长路径时才有意义，所以只在指定的那一轮断言）
    if (opts.horizontal) {
    const hScroll = await evaluate(`(() => {
      const sc = document.querySelector('[role="dialog"] .always-scroll');
      // barPx = 横向滚动条实际占掉的高度（>0 说明滚动条是可见的，不是悬浮隐藏）
      return sc ? { scrollWidth: sc.scrollWidth, clientWidth: sc.clientWidth, barPx: sc.offsetHeight - sc.clientHeight } : null;
    })()`);
    check(`${label}：长路径可横向滚动`, Boolean(hScroll && hScroll.scrollWidth > hScroll.clientWidth), JSON.stringify(hScroll));
    await shoot('49-log-longpath');
    }

    // 中间拖拽条：拖一下，左栏变宽
    const widths = await evaluate(`(() => {
      const sep = document.querySelector('[role="dialog"] [role="separator"]');
      const pane = sep ? sep.previousElementSibling : null;
      if (!sep || !pane) return null;
      const r = sep.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, before: Math.round(pane.getBoundingClientRect().width) };
    })()`);
    if (widths) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: widths.x, y: widths.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: widths.x + 120, y: widths.y, button: 'left' });
      await sleep(200);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: widths.x + 120, y: widths.y, button: 'left', clickCount: 1 });
      await sleep(400);
      const after = await evaluate(`(() => {
        const sep = document.querySelector('[role="dialog"] [role="separator"]');
        const pane = sep ? sep.previousElementSibling : null;
        return pane ? Math.round(pane.getBoundingClientRect().width) : 0;
      })()`);
      check(`${label}：中间拖拽可调整左右宽度`, after > widths.before + 60, `${widths.before}px → ${after}px`);
    }

    await clickAt('[data-log-file]', 500);
    await waitFor(`document.querySelectorAll('[role="dialog"] .diff-line').length > 0`, 6000);
    const diffInfo = await evaluate(`(() => {
      const lines = document.querySelectorAll('[role="dialog"] .diff-line').length;
      const text = document.querySelector('[role="dialog"]')?.innerText.replace(/\\s+/g, ' ') || '';
      return { lines, text: text.slice(0, 120) };
    })()`);
    check(`${label}：点文件在右侧看到具体改动`, diffInfo.lines > 0, JSON.stringify(diffInfo));
  };

  await fileDiffFlow('本地目录历史', { horizontal: true });
  await shoot('40-log-file-diff');

  // 整仓历史（工具栏那个入口）：重新打开页面用 ?dialog=log 更稳，
  // 省得和上一个弹窗的关闭动画较劲
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2800);
  await clickAt(`[data-project-path="${WC}"]`, 2600);
  // 弹窗打开时侧边栏点不到，所以先选项目再开历史
  await clickAt('button[aria-label="提交历史"]', 2600);

  await fileDiffFlow('工具栏提交历史');

  // ---------- 看过的文件改动要缓存（弹窗关闭前有效） ----------
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2600);
  await clickAt(`[data-project-path="${WC}"]`, 2600);
  await clickAt('button[aria-label="提交历史"]', 2600);
  await waitFor(`document.querySelectorAll('[data-log-file]').length > 0`, 8000);
  await evaluate(`(() => { window.__diffReqs = []; const of = window.fetch; window.fetch = (u, i) => { if (String(u).includes('/api/log/diff')) window.__diffReqs.push(String(u)); return of(u, i); }; return true })()`);
  await clickAt('[data-log-file]', 1400);
  await clickAt('[data-log-file]', 1400); // 同一个文件再点一次：应当命中缓存
  const diffReqs = await evaluate(`window.__diffReqs.length`);
  check('重复看同一个文件不再请求后端（缓存）', diffReqs === 1, `/api/log/diff 请求 ${diffReqs} 次`);

  // ---------- 本地目录：双击文件用默认应用打开 ----------
  // 拦掉这个请求，避免自测真的去启动编辑器；只验证点击路径
  await evaluate(`(() => {
    window.__opened = [];
    const of = window.fetch;
    window.fetch = (u, i) => {
      if (String(u).includes('/api/open')) {
        window.__opened.push(String(u));
        return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return of(u, i);
    };
    return true;
  })()`);
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await sleep(700);
  await clickText('本地目录', 2600);
  const fileRowBox = await evaluate(`(() => {
    const el = document.querySelector('[data-local-tree-row="README.md"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + 60, y: r.top + r.height / 2 };
  })()`);
  if (fileRowBox) {
    // 一次双击的标准序列：第二对事件带 clickCount=2，浏览器才会派发一次 dblclick
    for (const [type, count] of [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]) {
      await send('Input.dispatchMouseEvent', { type, x: fileRowBox.x, y: fileRowBox.y, button: 'left', clickCount: count });
    }
    await sleep(900);
  }
  const openedCount = await evaluate(`window.__opened?.length ?? 0`);
  check('双击文件调用默认应用打开', openedCount === 1, `open 调用 ${openedCount} 次`);

  // ---------- 浏览仓库：行距收紧 ----------
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(2600);
  await clickAt(`[data-project-path="${WC}"]`, 2600);
  await clickText('浏览仓库', 3400);
  const repoRow = await evaluate(`(() => {
    const tr = document.querySelector('[role="dialog"] tbody tr');
    return tr ? Math.round(tr.getBoundingClientRect().height) : 0;
  })()`);
  // 改之前每行 36px（py-[6px]），现在是 30px
  check('浏览仓库行距收紧', repoRow > 0 && repoRow <= 32, `行高 ${repoRow}px`);
  await shoot('47-repo-tight');

  // ---------- 弹窗去图标 / 去重复关闭 ----------
  await send('Page.navigate', { url: `${base}/?dialog=settings` });
  await sleep(2200);
  const dlgChrome = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    return {
      icons: dlg.querySelectorAll('[class*="size-10"][class*="rounded-full"]').length,
      closeBtns: [...dlg.querySelectorAll('button')].filter((b) => b.textContent.trim() === '关闭').length,
      hasX: Boolean(dlg.querySelector('button[aria-label="Close"]')),
    };
  })()`);
  check('弹窗标题没有圆形图标', Boolean(dlgChrome && dlgChrome.icons === 0), JSON.stringify(dlgChrome));
  check('有右上角 × 时不再有底部「关闭」', Boolean(dlgChrome && dlgChrome.hasX && dlgChrome.closeBtns === 0), JSON.stringify(dlgChrome));

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
