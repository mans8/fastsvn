#!/usr/bin/env node
/**
 * 「修改仓库地址」（svn relocate）回归：
 * 服务器搬家（同一个仓库换了地址）能重定向成功，且应用立刻认得新地址；
 * 换仓库（UUID 不同）、换路径（等于切换）、地址不可达都要在预检阶段拒绝；
 * 新地址需要账号时，带上凭据能成功。
 *
 * 用法：node scripts/e2e-relocate.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-relocate-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
const svn = (args) => execFileSync('svn', ['--non-interactive', ...args], { encoding: 'utf8' });

// 测试用的账号会写进 macOS 钥匙串：结束时按 URL 哈希删掉
const KEYCHAIN_HELPER =
  process.env.FASTSVN_KEYCHAIN_HELPER || new URL('../native/svn-credential-store', import.meta.url).pathname;
const keychainAccounts = [];
function forgetCreds(url) {
  const account = createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex');
  keychainAccounts.push(account);
  try {
    execFileSync(KEYCHAIN_HELPER, ['delete', account], { stdio: 'ignore' });
  } catch {
    /* 本来就没有 */
  }
}

let app;
let svnserve = null;
let svnservePidFile = null;
try {
  // ---- 场景一：仓库目录搬家（UUID 不变） ----
  const repoOld = path.join(tmp, 'repo-old');
  const repoNew = path.join(tmp, 'repo-new');
  const wc = path.join(tmp, 'wc');
  execFileSync('svnadmin', ['create', repoOld]);
  svn(['mkdir', '--parents', '-m', 'init', `file://${repoOld}/trunk`, `file://${repoOld}/branches/2.0`]);
  fs.writeFileSync(path.join(tmp, 'hello.txt'), 'hello\n');
  svn(['import', '-m', 'seed', path.join(tmp, 'hello.txt'), `file://${repoOld}/trunk/hello.txt`]);
  svn(['checkout', '-q', `file://${repoOld}/trunk`, wc]);
  fs.renameSync(repoOld, repoNew); // 服务器换地址：仓库根变了，UUID 不变

  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'working-copies.json'), JSON.stringify({ paths: [wc], aliases: {} }));

  // ---- 场景二：需要账号的仓库（svnserve, anon-access = none） ----
  const authRoot = path.join(tmp, 'auth');
  const authRepo = path.join(authRoot, 'repo');
  const authRepoNew = path.join(authRoot, 'repo2');
  const authWc = path.join(tmp, 'auth-wc');
  const svnPort = 36_000 + (process.pid % 28_000);
  const authUrlOld = `svn://127.0.0.1:${svnPort}/repo/trunk`;
  const authUrlNew = `svn://127.0.0.1:${svnPort}/repo2/trunk`;
  forgetCreds(authUrlOld);
  forgetCreds(authUrlNew);
  forgetCreds(`svn://127.0.0.1:${svnPort}/repo`);
  forgetCreds(`svn://127.0.0.1:${svnPort}/repo2`);

  fs.mkdirSync(path.join(authRoot, 'seed', 'trunk'), { recursive: true });
  execFileSync('svnadmin', ['create', authRepo]);
  fs.writeFileSync(
    path.join(authRepo, 'conf', 'svnserve.conf'),
    '[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = fastsvn-e2e-relocate\n'
  );
  fs.writeFileSync(path.join(authRepo, 'conf', 'passwd'), '[users]\nalice = secret\n');
  fs.writeFileSync(path.join(authRoot, 'seed', 'trunk', 'README.md'), '# 私有仓库\n');
  svn(['import', '-m', 'init', path.join(authRoot, 'seed'), `file://${authRepo}`]);

  svnservePidFile = path.join(authRoot, 'svnserve.pid');
  spawn(
    'svnserve',
    ['-d', '--listen-port', String(svnPort), '-r', authRoot, '--pid-file', svnservePidFile],
    { stdio: 'ignore' }
  );
  svnserve = svnservePidFile;
  await new Promise((r) => setTimeout(r, 300));
  const authCred = ['--username', 'alice', '--password', 'secret'];
  svn(['checkout', '-q', ...authCred, authUrlOld, authWc]);
  fs.cpSync(authRepo, authRepoNew, { recursive: true }); // 同一仓库换个路径（UUID 保留）

  // ---- 场景三：中文路径（svn 输出是百分号编码，前端展示成中文） ----
  const cnOld = path.join(tmp, '仓库-旧');
  const cnNew = path.join(tmp, '仓库-新');
  const cnWc = path.join(tmp, 'cn-wc');
  execFileSync('svnadmin', ['create', cnOld]);
  svn(['mkdir', '--parents', '-m', 'init', `file://${cnOld}/中文目录`]);
  svn(['checkout', '-q', `file://${cnOld}/中文目录`, cnWc]);
  fs.renameSync(cnOld, cnNew);

  fs.writeFileSync(
    path.join(home, 'data', 'working-copies.json'),
    JSON.stringify({ paths: [wc, authWc, cnWc], aliases: {} })
  );

  app = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    env: { ...process.env, HOME: home, PORT: '0', FASTSVN_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`启动超时 ${out}`)), 8000);
    app.stdout.on('data', (d) => {
      out += d;
      const m = /LISTENING (\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    app.stderr.on('data', (d) => (out += d));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body, headers = {}) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const get = async (p) => (await fetch(`${base}${p}`)).json();
  const relocate = (wcPath, url, creds) =>
    post(
      '/api/working-copies/relocate',
      { path: wcPath, url },
      creds ? { 'x-svn-auth': Buffer.from(JSON.stringify(creds)).toString('base64') } : {}
    );

  // 打开对话框时预填的当前地址
  const info = await get(`/api/working-copies/info?path=${encodeURIComponent(wc)}`);
  check(
    'info 给出当前仓库地址与仓库根',
    info.url === `file://${repoOld}/trunk` && info.root === `file://${repoOld}` && Boolean(info.uuid),
    JSON.stringify(info)
  );

  // 成功：仓库根变了
  const ok = await relocate(wc, `file://${repoNew}/trunk`);
  check(
    '仓库搬家后重定向成功',
    ok.ok === true && ok.stage === 'verify' && ok.newUrl === `file://${repoNew}/trunk`,
    JSON.stringify(ok)
  );
  const after = await get(`/api/status?path=${encodeURIComponent(wc)}&force=1`);
  check('成功后状态里立刻是新地址', after.info?.url === `file://${repoNew}/trunk`, String(after.info?.url));

  // 缓存没清的话，这里还会拿旧地址去问服务器（旧地址已经被搬走了）
  const afterRemote = await get(
    `/api/status?path=${encodeURIComponent(wc)}&force=1&remote=1&forceRemote=1`
  );
  check(
    '成功后远端查询用的是新地址',
    !afterRemote.error && Array.isArray(afterRemote.remote),
    String(afterRemote.error ?? 'ok')
  );

  // 换路径 = 切换，不是重定向
  const switchTry = await relocate(wc, `file://${repoNew}/branches/2.0`);
  check(
    '换路径被拒绝并说明是切换',
    switchTry.ok === false &&
      switchTry.stage === 'precheck' &&
      /切换/.test(switchTry.error ?? ''),
    JSON.stringify(switchTry.error)
  );

  // 同一个仓库但 URL 没变
  const same = await relocate(wc, `file://${repoNew}/trunk`);
  check(
    '地址没变时给出提示',
    same.ok === false && same.stage === 'precheck' && /一样|相同/.test(same.error ?? ''),
    JSON.stringify(same.error)
  );

  // 另一个仓库（UUID 不同）
  const otherRepo = path.join(tmp, 'other-repo');
  execFileSync('svnadmin', ['create', otherRepo]);
  svn(['mkdir', '-m', 'init', `file://${otherRepo}/trunk`]);
  const other = await relocate(wc, `file://${otherRepo}/trunk`);
  check(
    '另一个仓库被拒绝并说明 UUID 不同',
    other.ok === false && other.stage === 'precheck' && /UUID|同一个仓库/.test(other.error ?? ''),
    JSON.stringify(other.error)
  );

  // 地址不可达
  const nope = await relocate(wc, `file://${path.join(tmp, 'nope')}/trunk`);
  check(
    '不可达地址在预检就失败',
    nope.ok === false && nope.stage === 'precheck',
    JSON.stringify({ stage: nope.stage, error: nope.error })
  );

  // 非法协议
  const badScheme = await relocate(wc, 'ftp://example.com/repo/trunk');
  check(
    '不支持的协议被拒绝',
    badScheme.ok === false && badScheme.stage === 'precheck' && /http/.test(badScheme.error ?? ''),
    JSON.stringify(badScheme.error)
  );

  // 中文路径：界面填的是解码后的中文地址，svn 存的是百分号编码
  const cnMoved = await relocate(cnWc, `file://${cnNew}/中文目录`);
  check(
    '中文路径的仓库搬家后成功',
    cnMoved.ok === true && cnMoved.stage === 'verify',
    JSON.stringify({ stage: cnMoved.stage, error: cnMoved.error })
  );
  const cnAfter = await get(`/api/status?path=${encodeURIComponent(cnWc)}&force=1`);
  check(
    '中文路径重定向后地址更新',
    String(cnAfter.info?.url ?? '').includes('%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95'),
    String(cnAfter.info?.url)
  );

  // 需要账号：先不带凭据 → 预检告诉前端要登录
  const needAuth = await relocate(authWc, authUrlNew);
  check(
    '需要账号时预检标记 needsAuth',
    needAuth.ok === false && needAuth.stage === 'precheck' && needAuth.needsAuth === true,
    JSON.stringify({ needsAuth: needAuth.needsAuth, error: needAuth.error })
  );
  // 补上账号后再来
  const authed = await relocate(authWc, authUrlNew, { username: 'alice', password: 'secret' });
  check(
    '补上账号后重定向成功',
    authed.ok === true && authed.stage === 'verify' && authed.newUrl === authUrlNew,
    JSON.stringify(authed)
  );
  const authAfter = await get(`/api/status?path=${encodeURIComponent(authWc)}&force=1`);
  check('需要账号的仓库重定向后地址也更新了', authAfter.info?.url === authUrlNew, String(authAfter.info?.url));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  if (svnserve) {
    try {
      const pid = Number(fs.readFileSync(svnserve, 'utf8').trim());
      if (pid) process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
  }
  for (const account of keychainAccounts) {
    try {
      execFileSync(KEYCHAIN_HELPER, ['delete', account], { stdio: 'ignore' });
    } catch {
      /* 没写进去 */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed} / ${results.length} 通过`);
if (failed) process.exitCode = 1;
