#!/usr/bin/env node
/**
 * 需要登录的仓库：浏览时应当给出登录框，填对账号后能列出内容。
 *
 * 自建一个 anon-access=none 的 svnserve（独立端口、realm），验证 Unicode 密码与
 * macOS Keychain 复用。测试凭据使用独立 URL/account key。
 *
 * 用法：node scripts/e2e-repo-auth.mjs <baseUrl>
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const [, , base] = process.argv;
if (!base) {
  console.error('用法: node scripts/e2e-repo-auth.mjs <baseUrl>');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

mkdirSync('screens', { recursive: true });
const ROOT = '/tmp/fastsvn-auth-e2e';
const REPO = join(ROOT, 'repo');
const SEED = join(ROOT, 'seed');
const WC = join(ROOT, 'wc');
// 每次跑都用不同端口，避免复用测试 Keychain 项。
const PORT_SVN = 36_000 + (process.pid % 28_000);
const REPO_URL = `svn://127.0.0.1:${PORT_SVN}/repo`;
const KEYCHAIN_HELPER = process.env.FASTSVN_KEYCHAIN_HELPER || join(process.cwd(), 'native', 'svn-credential-store');

function clearTestCredential() {
  if (!existsSync(KEYCHAIN_HELPER)) return;
  const account = createHash('sha256').update(REPO_URL).digest('hex');
  try {
    execFileSync(KEYCHAIN_HELPER, ['delete', account], { stdio: 'ignore' });
  } catch {
    /* Keychain item may not exist */
  }
}

const results = []; 
const check = (name, ok, detail) => results.push([name, ok, detail]);

function makeFixtures() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(SEED, { recursive: true });
  execFileSync('svnadmin', ['create', REPO]);
  writeFileSync(
    join(REPO, 'conf', 'svnserve.conf'),
    '[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = fastsvn-e2e-auth\n'
  );
  // Include Unicode so this regression catches fetch's ByteString header TypeError.
  writeFileSync(join(REPO, 'conf', 'passwd'), '[users]\nalice = secret密码\n');
  mkdirSync(join(SEED, 'trunk', 'docs'), { recursive: true });
  writeFileSync(join(SEED, 'trunk', 'README.md'), '# 私有仓库\n');
  writeFileSync(join(SEED, 'trunk', 'docs', 'a.md'), '# 文档\n');
  svn(['import', SEED, `file://${REPO}`, '-m', 'init']);
}

// svnserve 没有"前台守护"模式，-d 会自己脱离进程组，
// 所以用 --pid-file 记下 pid，结束后按 pid 停掉。
function startSvnserve() {
  const pidFile = join(ROOT, 'svnserve.pid');
  const child = spawn(
    'svnserve',
    ['-d', '--listen-port', String(PORT_SVN), '-r', ROOT, '--pid-file', pidFile],
    { stdio: 'ignore' }
  );
  child.pidFile = pidFile;
  return child;
}

function stopSvnserve(child) {
  try {
    const pid = Number(readFileSync(child.pidFile, 'utf8').trim());
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {
    /* 已经没了 */
  }
}

async function main() {
  console.log('准备需要密码的仓库…');
  clearTestCredential();
  makeFixtures();
  const serve = startSvnserve();
  await sleep(1200);

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
  const clickAt = async (selector, wait = 900) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`找不到元素 ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };
  const clickText = async (text, wait = 900) => {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) {
      const state = await evaluate(`(() => ({
        text: document.querySelector('[role="dialog"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 240) ?? '',
        buttons: [...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent.trim()),
        inputs: [...document.querySelectorAll('[role="dialog"] input')].map((i) => ({ label: i.getAttribute('aria-label'), value: i.value })),
      }))()`);
      throw new Error(`找不到按钮 ${text}；当前弹窗：${JSON.stringify(state)}`);
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(wait);
  };
  const fill = async (selector, value) => {
    const found = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
      return true;
    })()`);
    if (!found) {
      const state = await evaluate(`(() => ({
        text: document.querySelector('[role="dialog"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 240) ?? '',
        inputs: [...document.querySelectorAll('[role="dialog"] input')].map((i) => ({ label: i.getAttribute('aria-label'), value: i.value })),
      }))()`);
      throw new Error(`找不到输入框 ${selector}；当前弹窗：${JSON.stringify(state)}`);
    }
    await send('Input.insertText', { text: value });
    await sleep(200);
  };
  const waitFor = async (expression, timeout = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    return false;
  };

  const url = REPO_URL;

  // 打开仓库浏览，填地址
  await send('Page.navigate', { url: `${base}/?dialog=repo` });
  await sleep(2600);
  await fill('input[placeholder*="svn.example.com"]', url);
  await clickText('打开', 600);

  const formAppeared = await waitFor(
    `Boolean(document.querySelector('[role="dialog"] input[aria-label="SVN 用户名"]'))`,
    15000
  );
  if (!formAppeared) {
    console.log('DBG dialog:', (await evaluate(`document.querySelector('[role="dialog"]')?.innerText.replace(/\\s+/g,' ')`))?.slice(0, 240));
  }

  const afterFail = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg?.innerText.replace(/\\s+/g, ' ') ?? '';
    return {
      text: text.slice(0, 160),
      hasForm: Boolean(dlg?.querySelector('input[aria-label="SVN 用户名"]')),
      hasPass: Boolean(dlg?.querySelector('input[aria-label="SVN 密码"]')),
      passType: dlg?.querySelector('input[aria-label="SVN 密码"]')?.type ?? null,
    };
  })()`);
  check('需要登录时给出明确提示', /需要账号密码/.test(afterFail.text), afterFail.text);
  check('同时出现用户名 / 密码输入框', afterFail.hasForm && afterFail.hasPass, JSON.stringify(afterFail));
  check('密码框是 password 类型', afterFail.passType === 'password', String(afterFail.passType));
  await shoot('72-repo-auth-form');

  // 先填错密码：应当留在登录框，并说明是账号密码问题
  await fill('input[aria-label="SVN 用户名"]', 'alice');
  await fill('input[aria-label="SVN 密码"]', 'wrong-pass');
  await clickText('连接', 2600);
  const wrong = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    return {
      text: dlg?.innerText.replace(/\\s+/g, ' ').slice(0, 160) ?? '',
      hasForm: Boolean(dlg?.querySelector('input[aria-label="SVN 用户名"]')),
    };
  })()`);
  check('密码错误时明确说账号或密码不对', /账号或密码/.test(wrong.text), wrong.text);
  check('密码错误后登录框还在，可以重试', wrong.hasForm === true, String(wrong.hasForm));

  // 填对：应当列出仓库内容
  await fill('input[aria-label="SVN 密码"]', 'secret密码');
  await clickText('连接', 3200);
  const ok = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg?.innerText.replace(/\\s+/g, ' ') ?? '';
    return { text: text.slice(0, 200), hasError: /需要账号密码|账号或密码/.test(text) };
  })()`);
  check('账号正确后能列出目录内容', /trunk/.test(ok.text) && !ok.hasError, ok.text);

  const health = await (await fetch(`${base}/api/health`)).json();
  if (health.credentialStore) {
    const rememberedRes = await fetch(`${base}/api/repo/info?url=${encodeURIComponent(url)}`);
    const remembered = await rememberedRes.json();
    check(
      '关闭/重开浏览后后端从 Keychain 复用登录',
      rememberedRes.ok && remembered.root?.endsWith('/repo'),
      JSON.stringify(remembered)
    );
  } else {
    check('Keychain 复用（未提供原生助手，跳过）', true, '开发服务未配置 credential helper');
  }

  // 工作副本状态请求此前没有复用仓库浏览保存的凭据，导致待更新页误报认证失败。
  const configDir = join(ROOT, 'svn-config');
  mkdirSync(configDir, { recursive: true });
  execFileSync(
    'svn',
    [
      '--non-interactive',
      '--no-auth-cache',
      '--config-dir', configDir,
      '--username', 'alice',
      '--password', 'secret密码',
      'checkout', url, WC,
    ],
    { stdio: 'ignore' }
  );
  const statusHeaders = health.credentialStore
    ? {}
    : {
        'x-svn-auth': Buffer.from(JSON.stringify({ username: 'alice', password: 'secret密码' })).toString('base64'),
      };
  const statusRes = await fetch(
    `${base}/api/status?path=${encodeURIComponent(WC)}&remote=1&forceRemote=1`,
    { headers: statusHeaders }
  );
  const statusData = await statusRes.json();
  check(
    '待更新查询复用仓库凭据，不再误报账号权限错误',
    statusRes.ok && Array.isArray(statusData.remote),
    statusData.error || JSON.stringify(statusData)
  );

  // 提交同样要走服务器：之前只给 status 补了凭据，commit 仍会报「需要账号密码」。
  writeFileSync(join(WC, 'trunk', 'README.md'), '# 私有仓库\n\n提交认证回归\n');
  const commitRes = await fetch(`${base}/api/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...statusHeaders },
    body: JSON.stringify({ path: WC, files: [join('trunk', 'README.md')], message: '提交认证回归' }),
  });
  const commitData = await commitRes.json();
  check(
    '提交复用仓库凭据，不再报需要账号密码',
    commitRes.ok && commitData.revision > 0,
    commitData.error || `r${commitData.revision}`
  );

  const updateRes = await fetch(`${base}/api/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...statusHeaders },
    body: JSON.stringify({ path: WC }),
  });
  const updateData = await updateRes.json();
  check('更新复用仓库凭据', updateRes.ok, updateData.error || `r${updateData.revision}`);

  const logRes = await fetch(`${base}/api/log?path=${encodeURIComponent(WC)}&limit=5&verbose=1`, {
    headers: statusHeaders,
  });
  const logData = await logRes.json();
  check(
    '历史记录复用仓库凭据',
    logRes.ok && Array.isArray(logData.entries) && logData.entries.length > 0,
    logData.error || `${logData.entries?.length ?? 0} 条`
  );

  await shoot('73-repo-auth-ok');

  check('页面无 JS 异常', errors.length === 0, errors.join(' | '));
  ws.close();

  stopSvnserve(serve);
  await sleep(300);
  clearTestCredential();
  rmSync(ROOT, { recursive: true, force: true });

  console.log('');
  let failed = 0;
  for (const [name, pass, detail] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
    if (!pass) failed++;
  }
  console.log(`\n${results.length - failed} / ${results.length} 通过`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('自测脚本出错：', e.message);
  // 出错也要把 svnserve 停掉，否则它会拿着被删掉的仓库继续占端口
  try {
    execFileSync('pkill', ['-f', `svnserve -d --listen-port ${PORT_SVN}`], { stdio: 'ignore' });
  } catch {
    /* 没起也算正常 */
  }
  clearTestCredential();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
