#!/usr/bin/env node
/**
 * 右键复制路径自测（v0.6.26）：
 *   1. 本地目录树：文件 / 目录 / 根节点都能复制绝对路径；子项还能复制相对路径；
 *      根节点不显示「复制相对路径」；「在访达中显示」出现在菜单里。
 *   2. 变更列表（待提交）：文件行能复制绝对 / 相对路径；
 *      已缺失的条目也能复制（只写剪贴板，不碰磁盘）。
 *   3. 仓库浏览：右侧列表行与左侧目录树行都有右键菜单，
 *      「复制地址」给解码后的完整 URL，「复制仓库路径」给 /trunk/... 形式；
 *      表格行包了 ContextMenuTrigger 后仍是正常表格行。
 *
 * 剪贴板用 navigator.clipboard.writeText 的 stub 拦截，不依赖系统权限。
 * 自建临时仓库，跑完即清理。
 *
 * 用法：node scripts/e2e-copy-path.mjs <baseUrl>
 * 前置：Chrome 以 --remote-debugging-port=9222 常驻；本机有 svn / svnadmin。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const [, , rawBase] = process.argv;
if (!rawBase) {
  console.error('用法: node scripts/e2e-copy-path.mjs <baseUrl>');
  process.exit(1);
}
const base = rawBase.replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

mkdirSync('screens', { recursive: true });
const ROOT = '/tmp/fastsvn-copy-demo';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const REPO = join(ROOT, 'repo');
const SEED = join(ROOT, 'seed');
const WC = join(ROOT, '工作副本');
const TRUNK_URL = `file://${REPO}/trunk`;

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

function makeFixtures() {
  execFileSync('svnadmin', ['create', REPO]);
  mkdirSync(join(SEED, 'trunk', 'docs'), { recursive: true });
  mkdirSync(join(SEED, 'trunk', 'src'), { recursive: true });
  writeFileSync(join(SEED, 'trunk', 'README.md'), '# 演示项目\n');
  writeFileSync(join(SEED, 'trunk', 'docs', 'guide.md'), '# 指南\n');
  writeFileSync(join(SEED, 'trunk', 'src', 'main.ts'), 'export const a = 1;\n');
  svn(['import', SEED, `file://${REPO}`, '-m', '初始导入']);
  svn(['checkout', `${TRUNK_URL}`, WC]);

  // 一个本地修改：待提交列表有普通文件可复制
  writeFileSync(join(WC, 'README.md'), '# 演示项目\n\n本地改了一行\n');
  // 一个缺失文件：验证「已删除 / 不见了」的条目也能复制路径文本
  unlinkSync(join(WC, 'docs', 'guide.md'));
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`screens/${name}.png`, Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (expression, timeout = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    return false;
  };
  const rightClick = async (selector, wait = 600) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 90), y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到元素 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
    }
    await sleep(wait);
  };
  const clickAt = async (selector, wait = 800) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 90), y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到元素 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };
  const clickButton = async (text, wait = 900) => {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到按钮「${text}」`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };
  /** 机器上可能已经有很多项目：每次导航后明确切到测试工作副本 */
  const selectProject = async () => {
    const ready = await waitFor(
      `Boolean(document.querySelector('[data-project-path="${WC}"]'))`,
      12_000
    );
    if (!ready) throw new Error('侧边栏里没有测试项目');
    await clickAt(`[data-project-path="${WC}"]`, 1200);
  };
  const clickMenuItem = async (text, wait = 700) => {
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
  const menuTexts = () =>
    evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
  const stubClipboard = () =>
    evaluate(`(() => {
      window.__copied = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.__copied = text; } },
      });
      return true;
    })()`);
  const copied = () => evaluate('window.__copied');

  // ---------- 1. 本地目录树 ----------
  await send('Page.navigate', { url: `${base}/?tab=files` });
  await sleep(1500);
  await selectProject();
  // 切换项目会把页签重置回「待提交」，再点回「本地目录」
  await clickButton('本地目录', 1200);
  const treeReady = await waitFor(`Boolean(document.querySelector('[data-local-tree-row="README.md"]'))`);
  check('本地目录树已加载', treeReady === true, String(treeReady));
  await stubClipboard();

  await rightClick('[data-local-tree-row="README.md"]');
  const fileMenu = await menuTexts();
  check(
    '本地树文件右键有复制路径 / 复制相对路径 / 在访达中显示',
    ['复制路径', '复制相对路径', '在访达中显示'].every((t) => fileMenu.includes(t)),
    JSON.stringify(fileMenu)
  );
  await shoot('69-copy-local-menu');

  await clickMenuItem('复制路径');
  check('本地树文件复制绝对路径', (await copied()) === join(WC, 'README.md'), await copied());

  await rightClick('[data-local-tree-row="README.md"]');
  await clickMenuItem('复制相对路径');
  check('本地树文件复制相对路径', (await copied()) === 'README.md', await copied());

  await rightClick('[data-local-tree-row="docs"]');
  await clickMenuItem('复制路径');
  check('本地树目录复制绝对路径', (await copied()) === join(WC, 'docs'), await copied());

  await rightClick('[data-local-tree-row="docs"]');
  await clickMenuItem('复制相对路径');
  check('本地树目录复制相对路径', (await copied()) === 'docs', await copied());

  await rightClick('[data-local-tree-row=""]');
  const rootMenu = await menuTexts();
  check(
    '本地树根节点隐藏「复制相对路径」',
    rootMenu.includes('复制路径') && !rootMenu.includes('复制相对路径'),
    JSON.stringify(rootMenu)
  );
  await clickMenuItem('复制路径');
  check('本地树根节点复制工作副本绝对路径', (await copied()) === WC, await copied());

  // ---------- 2. 变更列表 ----------
  await send('Page.navigate', { url: `${base}/?tab=local` });
  await sleep(1500);
  await selectProject();
  const listReady = await waitFor(`Boolean(document.querySelector('[data-file-row="README.md"]'))`);
  check('待提交列表已加载', listReady === true, String(listReady));
  await stubClipboard();

  await rightClick('[data-file-row="README.md"]');
  const changeMenu = await menuTexts();
  check(
    '变更列表文件右键有复制路径 / 复制相对路径',
    changeMenu.includes('复制路径') && changeMenu.includes('复制相对路径'),
    JSON.stringify(changeMenu)
  );
  await shoot('70-copy-change-menu');

  await clickMenuItem('复制路径');
  check('变更列表复制绝对路径', (await copied()) === join(WC, 'README.md'), await copied());

  await rightClick('[data-file-row="README.md"]');
  await clickMenuItem('复制相对路径');
  check('变更列表复制相对路径', (await copied()) === 'README.md', await copied());

  // 缺失条目：磁盘上已经没有了，但路径文本照样能复制
  const missingReady = await waitFor(`Boolean(document.querySelector('[data-file-row="docs/guide.md"]'))`);
  check('缺失条目出现在待提交里', missingReady === true, String(missingReady));
  if (missingReady) {
    await rightClick('[data-file-row="docs/guide.md"]');
    await clickMenuItem('复制路径');
    check(
      '缺失条目也能复制绝对路径',
      (await copied()) === join(WC, 'docs', 'guide.md'),
      await copied()
    );
  }

  // ---------- 3. 仓库浏览 ----------
  await send('Page.navigate', { url: `${base}/` });
  await sleep(1500);
  await selectProject();
  await clickButton('浏览仓库', 1200);
  const repoReady = await waitFor(
    `Boolean(document.querySelector('[role="dialog"] tbody tr[data-name="README.md"]'))`,
    12_000
  );
  check('仓库浏览已连上并列出文件', repoReady === true, String(repoReady));
  await stubClipboard();

  const layout = await evaluate(`(() => {
    const tr = document.querySelector('[role="dialog"] tbody tr[data-name="README.md"]');
    if (!tr) return null;
    const r = tr.getBoundingClientRect();
    return {
      display: getComputedStyle(tr).display,
      width: Math.round(r.width),
      height: Math.round(r.height),
      cells: tr.children.length,
    };
  })()`);
  check(
    '仓库表格行仍是正常表格行（ContextMenuTrigger 没破坏布局）',
    Boolean(layout && layout.display === 'table-row' && layout.width > 200 && layout.height > 0 && layout.cells === 6),
    JSON.stringify(layout)
  );

  await rightClick('[role="dialog"] tbody tr[data-name="README.md"]');
  const repoMenu = await menuTexts();
  check(
    '仓库右侧行右键有复制地址 / 复制仓库路径',
    repoMenu.includes('复制地址') && repoMenu.includes('复制仓库路径'),
    JSON.stringify(repoMenu)
  );
  await shoot('71-copy-repo-menu');

  await clickMenuItem('复制地址');
  check(
    '仓库行复制完整地址（解码后）',
    (await copied()) === `${TRUNK_URL}/README.md`,
    await copied()
  );

  await rightClick('[role="dialog"] tbody tr[data-name="README.md"]');
  await clickMenuItem('复制仓库路径');
  check('仓库行复制仓库内路径', (await copied()) === '/trunk/README.md', await copied());

  await rightClick(`[data-tree-url="${TRUNK_URL}"]`);
  const treeMenu = await menuTexts();
  check(
    '仓库左侧目录树右键有复制地址 / 复制仓库路径',
    treeMenu.includes('复制地址') && treeMenu.includes('复制仓库路径'),
    JSON.stringify(treeMenu)
  );
  await clickMenuItem('复制地址');
  check('仓库左树复制完整地址', (await copied()) === TRUNK_URL, await copied());

  await rightClick(`[data-tree-url="${TRUNK_URL}"]`);
  await clickMenuItem('复制仓库路径');
  check('仓库左树复制仓库内路径', (await copied()) === '/trunk', await copied());

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
