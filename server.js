'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { URL } = require('node:url');
const { createHash } = require('node:crypto');
const { createCheckoutManager } = require('./lib/checkout');
const { svnEnv } = require('./lib/svn-env');
const { detectRenameCandidates, MIN_RENAME_CONFIDENCE, relNorm } = require('./lib/rename-detect');

const PORT = Number(process.env.PORT ?? 5183);
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// v0.3 起前端是 React + Vite 构建产物；旧版 public/ 保留作回退
const WEB_DIST = path.join(ROOT, 'web', 'dist');
// 打包运行时数据放用户目录（更新应用不会丢配置）；开发时用项目内的 data/
const DATA_DIR = process.env.FASTSVN_HOME
  ? path.join(process.env.FASTSVN_HOME, 'data')
  : path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'working-copies.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SNAPSHOT_DIR = path.join(os.homedir(), 'Library/Application Support/FastSVN/snapshots');
const APP_VERSION = '0.6.24';

// ---------- svn 可执行文件解析 ----------

// app 自带的 svn（打包时由 scripts/bundle-svn.sh 放进来）。
// 有它就绝不碰系统里的 —— 用户机器上不需要装 Homebrew / svn。
const EMBEDDED_SVN = path.join(ROOT, 'svn', 'bin', 'svn');

function resolveSVN() {
  const candidates = [
    process.env.FASTSVN_SVN,
    EMBEDDED_SVN,
    '/opt/homebrew/bin/svn',
    '/usr/local/bin/svn',
    '/usr/bin/svn',
    '/opt/local/bin/svn',
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* keep looking */ }
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, 'svn');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

const SVN = resolveSVN();
const SVN_EMBEDDED = Boolean(SVN && path.resolve(SVN) === path.resolve(EMBEDDED_SVN));
const TRACE = process.env.FASTSVN_TRACE === '1';

// 版本号只问一次，界面上用来区分"内嵌 1.14.5"和"系统 1.14.5"
let svnVersionCache;
function svnVersion() {
  if (svnVersionCache !== undefined) return svnVersionCache;
  try {
    svnVersionCache = execFileSync(SVN, ['--version', '--quiet'], { encoding: 'utf8' }).trim();
  } catch {
    svnVersionCache = '';
  }
  return svnVersionCache;
}

// 参数数组传参，绝不拼 shell 字符串
function svn(args, cwd) {
  return new Promise((resolve, reject) => {
    if (!SVN) return reject(new Error('找不到 svn 命令行工具'));
    // 诊断用：FASTSVN_TRACE=1 时记录每条 svn 命令，便于确认"什么时候真的问了服务器"
    if (TRACE) process.stderr.write(`[svn] ${args.join(' ')}\n`);
    execFile(
      SVN,
      ['--non-interactive', ...args],
      {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        env: svnEnv(),
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(humanize(stderr, err.code));
          e.raw = stderr;
          e.exitCode = err.code;
          return reject(e);
        }
        resolve(stdout);
      }
    );
  });
}

// 所有 svn 子进程共用：账号从请求头来，不放进 URL（免得落进日志/历史）
function svnCreds(req) {
  const encoded = String(req.headers['x-svn-auth'] || '');
  if (encoded) {
    try {
      // Frontend sends UTF-8 JSON as Base64 because Fetch rejects Unicode header values.
      if (encoded.length > 16_384) return null;
      const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const username = typeof value?.username === 'string' ? value.username.trim() : '';
      if (!username) return null;
      return { username, password: typeof value.password === 'string' ? value.password : '' };
    } catch {
      return null;
    }
  }
  // Backward compatibility for callers using the original ASCII-only headers.
  const username = String(req.headers['x-svn-username'] || '').trim();
  if (!username) return null;
  return { username, password: String(req.headers['x-svn-password'] || '') };
}

/** 已经带了账号还失败：更可能是密码错了，别让人以为"没登录" */
function authHint(err, creds) {
  if (creds && creds.username && /需要账号密码/.test(err.message)) {
    return new Error('账号或密码不对，请重新输入');
  }
  return err;
}

/**
 * 工作副本里的操作没有登录表单可填，出错时要说清楚下一步去哪补账号，
 * 否则用户只会看到"需要账号密码"却无处可输。
 */
function wcAuthHint(err, action) {
  if (/需要账号密码/.test(err.message)) {
    return new Error(`${action}需要仓库账号：先在「浏览仓库」里登录一次这个地址（会自动记住），再回来重试。`);
  }
  if (/账号或密码不对/.test(err.message)) {
    // 能浏览但不能提交，多半是权限不够，不一定是密码错——两种可能都说清楚
    return new Error(
      `${action}被服务器拒绝：当前账号可能没有这个目录的权限，或密码已失效。可以在「浏览仓库」里换有权限的账号登录后再试。`
    );
  }
  return err;
}

/**
 * 删除目录时如果服务器上这个目录有了新提交，svn 会报 E155011。
 * 自动修好之外再给一句人话兜底，免得用户只看到一个英文错误码。
 */
function commitErrorHint(err) {
  if (/E155011|out of date/i.test(err.message)) {
    return new Error(`${err.message}（这个目录在服务器上有了新提交，先在「待更新」里更新一次再提交删除）`);
  }
  return err;
}

function authArgs(creds) {
  if (!creds || !creds.username) return [];
  const args = ['--username', creds.username];
  if (creds.password) args.push('--password', creds.password);
  return args;
}

// 密码交给 macOS Keychain；不写入配置文件或 localStorage。
const KEYCHAIN_HELPER =
  process.env.FASTSVN_KEYCHAIN_HELPER ||
  [path.join(ROOT, 'svn-credential-store'), path.join(ROOT, 'native', 'svn-credential-store')].find((p) =>
    fs.existsSync(p)
  ) || null;
function credentialAccount(url) {
  const normalized = String(url || '').trim().replace(/\/+$/, '');
  return createHash('sha256').update(normalized).digest('hex');
}

function keychainRequest(action, account, value) {
  if (!KEYCHAIN_HELPER) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(KEYCHAIN_HELPER, [action, account], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || size > 64 * 1024) return resolve(null);
      resolve(action === 'get' ? Buffer.concat(chunks).toString('utf8') : true);
    });
    if (action === 'set') child.stdin.end(JSON.stringify(value));
    else child.stdin.end();
  });
}

function repoUrlAncestors(url) {
  const normalized = String(url || '').trim().replace(/\/+$/, '');
  const candidates = [normalized];
  try {
    const parsed = new URL(normalized);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    while (parts.length > 0) {
      parts.pop();
      parsed.pathname = parts.length ? `/${parts.join('/')}` : '/';
      candidates.push(parsed.toString().replace(/\/+$/, ''));
    }
  } catch {
    // Invalid/non-URL values are rejected by the SVN operation itself.
  }
  return [...new Set(candidates)];
}

async function getRepoCreds(url, supplied) {
  if (supplied?.username) return supplied;
  if (!KEYCHAIN_HELPER) return null;
  for (const candidate of repoUrlAncestors(url)) {
    const raw = await keychainRequest('get', credentialAccount(candidate));
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (typeof value.username === 'string' && value.username) {
        return {
          username: value.username,
          password: typeof value.password === 'string' ? value.password : '',
        };
      }
    } catch {
      // Ignore malformed stale Keychain entries.
    }
  }
  return null;
}

async function rememberRepoCreds(url, creds) {
  if (!creds?.username || !creds.password || !KEYCHAIN_HELPER) return;
  const account = credentialAccount(url);
  await keychainRequest('set', account, { username: creds.username, password: creds.password });
}

// 工作副本对应的仓库 URL 在它生命周期内不会变，缓存起来，
// 免得每条要访问服务器的命令都多跑一次 svn info。
const wcUrlCache = new Map();
async function wcRepoUrl(wcPath) {
  const hit = wcUrlCache.get(wcPath);
  if (hit) return hit;
  const info = parseInfo(await svn(['info', '--xml', wcPath]));
  const url = info.url || info.root;
  if (url) wcUrlCache.set(wcPath, url);
  return url;
}

/**
 * 需要访问服务器的命令（commit / update / log / status -u 等）。
 * svn 自己不会去读 FastSVN 存进钥匙串的凭据，这里按工作副本 URL 取一份带上；
 * 不带账号的话，私有仓库会统一报 E170001，看起来像"没有权限"。
 */
async function svnRemote(args, wcPath, supplied) {
  const url = await wcRepoUrl(wcPath);
  const creds = await getRepoCreds(url, supplied);
  let out;
  try {
    out = await svn([...args, ...authArgs(creds)], wcPath);
  } catch (e) {
    throw authHint(e, creds);
  }
  // 用户在别处刚输入过账号：顺手记下来，下次不用再问
  if (supplied?.username) await rememberRepoCreds(url, supplied);
  return out;
}

/**
 * 本地删掉但还没 svn delete 的文件，不能直接 commit（svn 会报路径不存在）。
 * 这里先按状态把它们正式排进删除，用户勾选「本地已删除」就能正常提交。
 */
async function stageMissingDeletes(wc, files, supplied) {
  if (!files.length) return [];
  const xml = await svn(['status', '--xml', ...files], wc).catch(() => '');
  if (!xml) return [];
  const norm = (e) => (path.isAbsolute(e.rel) ? path.relative(wc, e.rel) : e.rel);
  const entries = parseStatus(xml);
  const missingRels = entries.filter((e) => e.wcItem === 'missing').map(norm);
  // 上一次提交失败时可能已经把删除排进去了（状态变成 deleted），
  // 这种同样要更新，否则重试永远卡在 E155011。
  const deletedRels = entries.filter((e) => e.wcItem === 'deleted').map(norm);

  const topLevel = (arr) => {
    const unique = [...new Set(arr)].sort((a, b) => a.length - b.length);
    return unique.filter((rel) => !unique.some((other) => other !== rel && rel.startsWith(other + path.sep)));
  };
  const topMissing = topLevel(missingRels);
  const topDeleted = topLevel(deletedRels).filter(
    (rel) => !topMissing.some((m) => rel === m || rel.startsWith(m + path.sep))
  );
  const updateTargets = topLevel([...topMissing, ...topDeleted]);

  // 改名留下的旧路径（moved-to）不能做 depth-empty 更新：
  // 更新会把已删除的目录重新拉回来，和本地删除冲突，提交直接报 E155015。
  // 它的删除必须和复制出来的新路径作为一个整体提交。
  const movedSources = new Set(
    entries.filter((e) => e.movedTo).map((e) => (path.isAbsolute(e.rel) ? path.relative(wc, e.rel) : e.rel))
  );

  // 目录节点过期时 commit 会报 E155011。只把目录本身更新到 HEAD
  // （--depth empty，不下载里面的文件），这样删除才提交得上去。
  // info -r BASE 在 https 仓库上也要问服务器，必须带凭据，
  // 否则会静默失败（拿不到 kind），更新被跳过，重试永远卡在 E155011。
  for (const rel of updateTargets) {
    if (movedSources.has(rel)) continue;
    const kind = await svnRemote(['info', '-r', 'BASE', '--show-item', 'kind', rel], wc, supplied)
      .then((s) => s.trim())
      .catch(() => '');
    if (kind !== 'dir') continue;
    await svnRemote(['update', '--depth', 'empty', '--accept', 'postpone', rel], wc, supplied).catch(() => {});
  }

  if (topMissing.length) await svn(['delete', '--force', ...topMissing], wc);
  return topMissing;
}

/**
 * `svn delete` 一个目录后，status 里只剩目录一条，子项不再逐条出现；
 * 而提交用的是 `--depth empty`，只提交列出的节点 —— 只给目录时
 * svn 会返回成功但什么都没提交（删除被静默忽略）。
 * 提交前把已排删除目录的 BASE 子项展开进来，保证删除真的落库。
 * 只对用户明确选中的目录展开，不影响其他勾选。
 */
async function expandDeletedDirTargets(wc, files, supplied) {
  const norm = (p) => (path.isAbsolute(p) ? path.relative(wc, p) : p);
  const xml = await svn(['status', '--xml', ...files], wc).catch(() => '');
  if (!xml) return files;
  const deleted = parseStatus(xml)
    .filter((e) => e.wcItem === 'deleted')
    .map((e) => norm(e.rel))
    .filter(Boolean);
  if (!deleted.length) return files;

  const out = [...files];
  const have = new Set(files.map(norm));
  for (const rel of deleted) {
    // 只有目录需要展开。`svn list` 对文件会失败，但对"已排删除的文件"
    // 可能退回上一级并把它自己列出来（会拼出 a.txt/a.txt 这种非法路径），
    // 所以先本地问一次节点类型，不靠 list 的返回值猜测。
    const kind = await svn(['info', '--show-item', 'kind', rel], wc)
      .then((s) => s.trim())
      .catch(() => '');
    if (kind !== 'dir') continue;
    let list;
    try {
      list = await svnRemote(['list', '-R', '-r', 'BASE', rel], wc, supplied);
    } catch {
      continue;
    }
    for (const line of list.split('\n')) {
      const child = line.trim().replace(/\/+$/, '');
      if (!child) continue;
      const relPath = `${rel}/${child}`;
      if (!have.has(relPath)) {
        have.add(relPath);
        out.push(relPath);
      }
    }
  }
  return out;
}

/**
 * 从 E155011 的报错里取出"过期的目录"，做一次 depth-empty 更新。
 * 返回是否真的更新过（用于决定要不要重试提交）。
 */
async function repairOutdatedDirs(wc, text, supplied) {
  const dirs = [...String(text).matchAll(/Directory '([^']+)' is out of date/g)]
    .map((m) => m[1])
    .filter((abs) => abs.startsWith(wc + path.sep));
  for (const abs of [...new Set(dirs)]) {
    const rel = path.relative(wc, abs);
    if (!rel || rel.startsWith('..')) continue;
    try {
      await svnRemote(['update', '--depth', 'empty', '--accept', 'postpone', rel], wc, supplied);
      return true;
    } catch {
      /* 试下一个 */
    }
  }
  return false;
}

/**
 * 提交并把进度实时推给界面（SSE）。
 * svn 先逐条打印 Sending/Adding/Deleting（排队阶段），
 * 真正传输时再按文件打点（上传阶段）；两种信号都转成事件，
 * 大仓库提交时用户能看见它到底走到哪一步，而不是干等一个转圈。
 */
async function streamCommit(req, res, wc, files, message) {
  const url = await wcRepoUrl(wc);
  const supplied = svnCreds(req);
  const creds = await getRepoCreds(url, supplied);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sseSend(res, 'start', { total: files.length, files });

  let queued = 0;
  let uploaded = 0;
  let finished = false;

  const finish = (event, payload) => {
    if (finished) return;
    finished = true;
    sseSend(res, event, payload);
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  // 先补 svn delete，再真正提交；否则「本地已删除」的文件提交不了
  try {
    const staged = await stageMissingDeletes(wc, files, supplied);
    if (staged.length) {
      sseSend(res, 'phase', { phase: 'stage', message: `已把 ${staged.length} 个本地删除排进这次提交…` });
    }
  } catch (e) {
    return finish('error', { message: decodeUrlText(commitErrorHint(e).message) });
  }

  // 已排删除的目录要展开成具体的子项：`--depth empty` 只提交列出的节点，
  // 只给目录会让 svn 报成功、实际什么都没删。展开放在 stage 之后，
  // 因为「本地已删除」的目录正是在 stage 阶段才变成已排删除。
  const targets = await expandDeletedDirTargets(wc, files, supplied);

  const args = ['--non-interactive', 'commit', '-m', message, '--depth', 'empty', ...targets, ...authArgs(creds)];

  // 一次提交尝试：进度事件直接写进 SSE，结果通过 Promise 返回
  const runAttempt = () =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let lineBuf = '';
      let uploading = false;

      const child = spawn(SVN, args, { cwd: wc, env: svnEnv() });

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (stdout.length > 400_000) stdout = stdout.slice(-200_000);

        if (!uploading && text.includes('Transmitting file data')) {
          uploading = true;
          sseSend(res, 'phase', { phase: 'upload', message: '正在上传文件内容…' });
        }
        if (uploading) {
          // 传输进度是没换行的点：一个点大约代表一个文件
          const dots = (text.match(/\./g) || []).length;
          if (dots > 0) {
            uploaded = Math.min(files.length, uploaded + dots);
            sseSend(res, 'progress', { phase: 'upload', done: uploaded, total: files.length });
          }
        }

        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          const m = /^(Sending|Adding|Deleting|Replacing)\s+(.+)$/.exec(line.trimEnd());
          if (!m) continue;
          queued++;
          // 目录展开后实际提交的节点数可能多于界面上的「项」，进度按界面的项数收口
          const shown = Math.min(queued, files.length);
          sseSend(res, 'queued', { done: shown, total: files.length, path: m[2].trim(), action: m[1] });
        }
      });

      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 16_000) stderr = stderr.slice(0, 16_000);
      });

      child.on('error', () => resolve({ code: -1, stdout, stderr: 'svn: 找不到 svn 命令行工具' }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  let result = await runAttempt();

  // 目录不是最新（E155011）：错误里带着本地绝对路径，
  // 更新这个目录后再自动重试一次，用户不用自己先去「更新」。
  if (result.code !== 0 && /E155011/.test(result.stderr)) {
    const repaired = await repairOutdatedDirs(wc, result.stderr, supplied);
    if (repaired) {
      sseSend(res, 'phase', { phase: 'stage', message: '目录不是最新，已自动更新，正在重试提交…' });
      result = await runAttempt();
    }
  }

  if (result.code !== 0) {
    // humanize 先翻成中文，再按"有没有账号"补一句下一步该做什么
    const hint = wcAuthHint(commitErrorHint(new Error(humanize(result.stderr, result.code))), '提交');
    return finish('error', { message: decodeUrlText(hint.message) });
  }

  statusCache.delete(wc);
  remoteCache.delete(wc);
  if (supplied?.username) {
    await rememberRepoCreds(url, supplied).catch(() => {});
  }
  const m = /Committed revision (\d+)/.exec(result.stdout);
  finish('done', { revision: m ? Number(m[1]) : 0, raw: result.stdout.trim().slice(-4000) });
}

// SVN 原始报错翻译成人话
function humanize(stderr, code) {
  const s = String(stderr || '');
  if (s.includes('E155004')) return '上次操作被中断，文件夹被锁住了。可以点「修复」自动清理。';
  if (s.includes('E155007') || s.includes('E155016') || /is not a working copy|working copy database .* is missing/i.test(s)) {
    return '这个目录不是可用的 SVN 工作副本（.svn 可能被清理或损坏）。可以从项目列表移除后重新检出。';
  }
  // 401/403 在 svn 里可能是这几种错误码：都需要用户补账号，不是"仓库坏了"
  if (
    s.includes('E170001') ||
    s.includes('E215004') ||
    s.includes('E175002') && /authorization failed/i.test(s) ||
    /authentication failed|authorization failed/i.test(s)
  ) {
    return '这个仓库需要账号密码，或者当前账号没有这个目录的权限';
  }
  if (s.includes('E175002') || /could not resolve/i.test(s)) return '连不上服务器，检查一下网络或仓库地址。';
  if (s.includes('E155037')) return '工作副本需要先执行一次清理（cleanup）。';
  if (s.includes('E195020')) return '本地文件和服务器记录对不上，可能需要重新下载这个目录。';
  // 连不上（DNS/端口/网络）单独说，别把它当成"仓库坏了"
  if (s.includes('E170013') && !/E170001|authorization failed/i.test(s)) {
    return '连不上这个仓库，检查一下地址和网络';
  }
  // 多行报错时第一行往往只是 "Commit failed (details follow):"，
  // 真正有用的是后面带错误码的那一行
  const lines = s.split('\n').filter((l) => l.startsWith('svn:'));
  const detail =
    lines.find((l) => /^svn:\s*E\d+/.test(l) && !/details follow|E200009/.test(l)) || lines[lines.length - 1];
  const line = detail || s.split('\n').find((l) => l.startsWith('svn:'));
  return line ? line.replace(/^svn:\s*/, '') : `操作失败（退出码 ${code}）`;
}

// ---------- XML 轻量解析（只取需要的字段） ----------

function unescapeXML(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** svn 报错里的仓库地址是百分号编码的，回给前端前还原成中文 */
function decodeUrlText(text) {
  return String(text == null ? '' : text).replace(/https?:\/\/[^\s'"，。；、)）\]]+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

function parseStatus(xml) {
  const out = [];
  const entryRe = /<entry\s+([^>]*)>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const attrs = m[1];
    const body = m[2];
    const pathMatch = /path="([^"]*)"/.exec(attrs);
    if (!pathMatch) continue;
    const rel = unescapeXML(pathMatch[1]);
    if (!rel || rel === '.') continue;

    const wc = /<wc-status\s+([^>]*?)\/?>/.exec(body);
    const repos = /<repos-status\s+([^>]*?)\/?>/.exec(body);
    const wcItem = wc ? (/item="([^"]*)"/.exec(wc[1]) || [])[1] : null;
    const reposItem = repos ? (/item="([^"]*)"/.exec(repos[1]) || [])[1] : null;
    const copied = wc ? /copied="true"/.test(wc[1]) : false;
    const movedFrom = wc ? unescapeXML((/moved-from="([^"]*)"/.exec(wc[1]) || [])[1] || '') : '';
    const movedTo = wc ? unescapeXML((/moved-to="([^"]*)"/.exec(wc[1]) || [])[1] || '') : '';
    out.push({ rel, wcItem, reposItem, copied, movedFrom, movedTo });
  }
  return out;
}

function parseInfo(xml) {
  const url = (/<url>([\s\S]*?)<\/url>/.exec(xml) || [])[1] || '';
  const root = (/<root>([\s\S]*?)<\/root>/.exec(xml) || [])[1] || '';
  const rev = (/<entry[^>]*revision="(\d+)"/.exec(xml) || [])[1] || '0';
  let branch = 'trunk';
  if (root && url.startsWith(root)) {
    const rest = url.slice(root.length).replace(/^\/+/, '');
    branch = rest.split('/')[0] || 'trunk';
  }
  return { url: unescapeXML(url), root: unescapeXML(root), revision: Number(rev), branch: unescapeXML(branch) };
}

// ---------- diff 解析 ----------

function parseUnifiedDiff(text) {
  const lines = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let deleted = 0;
  let inHunk = false;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const raw of text.split('\n')) {
    if (/^Index: |^====|^--- |^\+\+\+ |^Property changes on:/.test(raw)) continue;
    if (raw.startsWith('@@')) {
      const m = hunkRe.exec(raw);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      inHunk = true;
      lines.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', oldNo: null, newNo, text: raw.slice(1) });
      newNo++; added++;
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', oldNo, newNo: null, text: raw.slice(1) });
      oldNo++; deleted++;
    } else if (raw.startsWith(' ') || raw === '') {
      const body = raw.startsWith(' ') ? raw.slice(1) : raw;
      lines.push({ kind: 'ctx', oldNo, newNo, text: body });
      oldNo++; newNo++;
    }
    if (lines.length > 40000) break;
  }
  return { lines, added, deleted, binary: false };
}

// 把一次 svn diff 的输出按 Index 切成每个文件一段
function parseMultiFileDiff(text) {
  const files = new Map();
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) files.set(current, parseUnifiedDiff(buf.join('\n')));
  };
  for (const line of text.split('\n')) {
    const m = /^Index: (.+)$/.exec(line);
    if (m) {
      flush();
      current = m[1];
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return files;
}

async function readLineCount(abs) {
  try {
    const content = await fsp.readFile(abs, 'utf8');
    const rows = content.split('\n');
    return { rows, count: rows.length };
  } catch {
    return null;
  }
}

// ---------- 工作副本存储 ----------

/**
 * 项目列表 + 别名。
 * aliases 单独存成 { 路径: 别名 }，而不是把 paths 改成对象数组 ——
 * 老版本的 working-copies.json 只有 paths，这样读进来照样能用。
 */
async function readStoreMeta() {
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const json = JSON.parse(raw);
    const paths = Array.isArray(json.paths) ? json.paths : [];
    const aliases =
      json && typeof json.aliases === 'object' && json.aliases && !Array.isArray(json.aliases)
        ? json.aliases
        : {};
    return { paths, aliases };
  } catch {
    return { paths: [], aliases: {} };
  }
}

async function readStore() {
  return (await readStoreMeta()).paths;
}

async function writeStore(paths, aliases) {
  // 不传 aliases 时保留磁盘上已有的；顺手清掉已经不在列表里的项目的别名
  const nextAliases = { ...((aliases ?? (await readStoreMeta()).aliases) || {}) };
  for (const key of Object.keys(nextAliases)) {
    if (!paths.includes(key)) delete nextAliases[key];
  }
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(STORE_FILE, JSON.stringify({ paths, aliases: nextAliases }, null, 2), 'utf8');
  return paths;
}

/** 项目列表 + 每个目录还是不是工作副本（界面用来决定灰不灰）+ 别名 */
function withWcFlags(paths, aliases = {}) {
  return paths.map((x) => ({
    path: x,
    alias: aliases[x] || null,
    isWc: isWorkingCopyDir(x),
    exists: fs.existsSync(x),
  }));
}

// ---------- 设置 ----------
// 只放"影响扫描结果"的开关。默认值写在代码里，settings.json 只做覆盖，
// 这样以后加新开关时老文件也能正常读。
const DEFAULT_SETTINGS = { ignoreDsStore: true };
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const raw = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  const next = { ...settings };
  if (patch && typeof patch === 'object') {
    if (typeof patch.ignoreDsStore === 'boolean') next.ignoreDsStore = patch.ignoreDsStore;
  }
  settings = next;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  // 过滤规则变了，旧缓存里可能还留着 .DS_Store，直接作废
  statusCache.clear();
  remoteCache.clear();
  return settings;
}

/** macOS 的系统垃圾文件：包一层，方便以后扩充（.localized、Thumbs.db …） */
function isNoiseFile(name) {
  if (name === '.svn') return true;
  if (settings.ignoreDsStore && (name === '.DS_Store' || name === '.ds_store')) return true;
  return false;
}

// ---------- 目录变更摘要 ----------
// 目录移动/删除在 svn status 里只有一条记录，子文件不再逐条出现。
// 界面要能说清「里面有几个文件」，并允许展开确认文件还在。
const DIR_CHILD_LIST_LIMIT = 200;
const DIR_SCAN_LIMIT = 500;

/** 已从磁盘消失的目录：从 status 里缺失的子项还原文件列表 */
function collectGoneDescendants(dirPath, files) {
  const prefix = dirPath + '/';
  const gone = files.filter(
    (f) => f.path.startsWith(prefix) && (f.kind === 'missing' || f.kind === 'deleted')
  );
  // 子目录会连同自己的子项一起出现，只取叶子，避免把子目录本身也当成文件
  const top = gone.filter((f) => !gone.some((g) => g !== f && g.path.startsWith(f.path + '/')));
  const children = top.map((f) => f.path.slice(prefix.length));
  return {
    count: children.length,
    children: children.slice(0, DIR_CHILD_LIST_LIMIT),
    truncated: children.length > DIR_CHILD_LIST_LIMIT,
  };
}

/** 还在磁盘上的目录：递归数文件，限制上限避免大目录拖慢状态接口 */
async function scanDirChildren(abs) {
  const out = { count: 0, children: [], truncated: false };
  const walk = async (dirAbs, prefix) => {
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const d of entries) {
      if (out.count >= DIR_SCAN_LIMIT) {
        out.truncated = true;
        return;
      }
      if (isNoiseFile(d.name)) continue;
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        await walk(path.join(dirAbs, d.name), rel);
      } else {
        out.count++;
        if (out.children.length < DIR_CHILD_LIST_LIMIT) out.children.push(rel);
      }
    }
  };
  await walk(abs, '');
  if (out.count > out.children.length) out.truncated = true;
  return out;
}

// ---------- 检出任务 ----------

const checkouts = createCheckoutManager({
  svnBin: SVN,
  onComplete: async ({ path: newPath, mode }) => {
    // 下载（export）得到的是纯文件目录，没有 .svn，不该进项目列表
    if (mode === 'export') return;
    // 检出成功后自动挂到项目列表，用户不用再手动添加一次
    const paths = await readStore();
    if (!paths.includes(newPath)) {
      paths.push(newPath);
      await writeStore(paths);
    }
    statusCache.delete(newPath);
    wcUrlCache.delete(newPath);
  },
});

// 定期清理已结束的任务，避免内存里堆积
setInterval(() => checkouts.sweep(), 5 * 60 * 1000).unref?.();


// ---------- 业务 ----------

// 常见的非文本扩展名。命中就完全不读内容：不数行、不比差异。
const BINARY_EXT = new Set([
  // 图片 / 设计稿
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif', 'ico', 'icns',
  'psd', 'ai', 'sketch', 'fig', 'xd',
  // 压缩包 / 安装包 / 磁盘镜像
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'dmg', 'pkg', 'iso', 'jar', 'war',
  // 可执行 / 库
  'exe', 'dll', 'so', 'dylib', 'a', 'o', 'class', 'bin', 'dat',
  // 音视频 / 字体
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'ttf', 'otf', 'woff', 'woff2',
  // 文档 / 数据库
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages', 'sqlite', 'db',
]);

/**
 * 超过这个体积的文件不做内联差异。
 *
 * 为什么必须拦：svn diff 的输出是整段读进内存再按行解析的，
 * 一个几百 MB 的 zip 既会让 svn 卡住，也会把主进程内存打满、
 * 界面一直停在"正在读取差异…"。看大文件用外部工具更合适。
 */
const BIG_FILE_LIMIT = 10 * 1024 * 1024;

/** 只读前 8KB 判断是不是二进制（扩展名不认识的大文件才用得上） */
async function sniffBinary(abs) {
  try {
    const fh = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

// 状态缓存：短时间内重复刷新直接复用，避免连续全量扫描
const statusCache = new Map();
const CACHE_TTL = 2000;
const CACHE_FILE = path.join(DATA_DIR, 'status-cache.json');
let diskCache = {};
let diskCacheTimer = null;

async function loadDiskCache() {
  try {
    diskCache = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8'));
  } catch {
    diskCache = {};
  }
}

function saveDiskCacheSoon() {
  clearTimeout(diskCacheTimer);
  diskCacheTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(CACHE_FILE, JSON.stringify(diskCache), 'utf8');
    } catch { /* 缓存写失败不影响主流程 */ }
  }, 300);
}

function riskOf(rel, size, isBinary) {
  const lower = rel.toLowerCase();
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (lower.endsWith('.env') || lower.endsWith('.env.local') || lower.includes('id_rsa')
      || ext === 'pem' || lower.includes('secret') || lower.includes('credential')) {
    return { code: 'secret', text: '疑似密钥' };
  }
  if (size > 50 * 1024 * 1024) return { code: 'largeFile', text: '文件超过 50 MB' };
  if (isBinary) return { code: 'binaryGrowth', text: '二进制文件，看不到文本差异' };
  return null;
}

function humanSize(n) {
  if (!n) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ---------- 本地目录浏览 ----------

/**
 * 列出工作副本里某个目录的真实内容（不只是有改动的）。
 * 状态来自 buildStatus 的结果，未改动的文件 status 为 null。
 */
async function listLocalDir(wcPath, relDir) {
  const rel = (relDir || '').replace(/^\/+|\/+$/g, '');
  const abs = rel ? path.join(wcPath, rel) : wcPath;

  // 目录穿越防护
  const normalized = path.resolve(abs);
  if (normalized !== wcPath && !normalized.startsWith(wcPath + path.sep)) {
    throw new Error('路径超出了工作副本范围');
  }

  let dirents;
  try {
    dirents = await fsp.readdir(normalized, { withFileTypes: true });
  } catch {
    throw new Error('这个目录读不了，可能已被删除或没有权限');
  }

  // 复用状态结果做标记（不强制刷新，走 2 秒缓存）
  const payload = await buildStatus(wcPath, { remote: false, force: false });
  const statusMap = new Map();
  for (const f of payload.local) statusMap.set(f.path, f);

  const entries = [];
  for (const d of dirents) {
    // 设置了忽略 .DS_Store 时，本地目录树里也不出现它
    if (isNoiseFile(d.name)) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const isDir = d.isDirectory();
    let size = 0;
    let mtime = null;
    if (!isDir) {
      try {
        const st = await fsp.stat(path.join(normalized, d.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        /* 符号链接或权限问题 */
      }
    }
    const hit = statusMap.get(childRel);
    entries.push({
      name: d.name,
      path: childRel,
      kind: isDir ? 'dir' : 'file',
      size,
      sizeText: isDir ? null : humanSize(size),
      mtime,
      status: hit ? { kind: hit.kind, letter: hit.letter, label: hit.label } : null,
      added: hit ? hit.added : 0,
      deleted: hit ? hit.deleted : 0,
      binary: hit ? hit.binary : false,
    });
  }

  // 目录在前，各自按名称排（和文件管理器一致）
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });

  const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : rel ? '' : null;
  return { dir: rel, parent: parentRel, entries, revision: payload.info.revision };
}

// ---------- 远程仓库浏览 ----------

/** 拿仓库根与当前版本，供浏览器把左侧树从仓库根展开 */
async function repoInfo(url, creds) {
  if (typeof url !== 'string' || !/^(https?|svn|svn\+ssh|file):\/\//i.test(url.trim())) {
    throw new Error('仓库地址要以 http:// 、https:// 、svn:// 或 svn+ssh:// 开头');
  }
  const clean = url.trim().replace(/\/+$/, '');
  const effectiveCreds = await getRepoCreds(clean, creds);
  let xml;
  try {
    xml = await svn(['info', '--xml', ...authArgs(effectiveCreds), clean]);
  } catch (e) {
    throw authHint(e, effectiveCreds);
  }
  const info = parseInfo(xml);
  if (creds?.username) {
    await rememberRepoCreds(clean, creds);
    if (info.root && info.root !== clean) await rememberRepoCreds(info.root, creds);
  }
  return { url: clean, root: info.root || clean, revision: info.revision };
}

/**
 * 列出仓库里某个 URL 下的条目，并补上每个文件的最后提交说明。
 *
 * svn list --xml 已经带 commit(revision/author/date/size)，但没有 message；
 * message 只能从 svn log 拿。这里按需查一次范围内的 log 建映射，
 * 跨度太大时只覆盖最近的一段（未覆盖的 message 留空，不编造）。
 */
async function listRepo(url, opts = {}) {
  if (typeof url !== 'string' || !/^(https?|svn|svn\+ssh|file):\/\//i.test(url.trim())) {
    throw new Error('仓库地址要以 http:// 、https:// 、svn:// 或 svn+ssh:// 开头');
  }
  const clean = url.trim().replace(/\/+$/, '');
  const started = Date.now();
  const effectiveCreds = await getRepoCreds(clean, opts.creds);

  let listXml;
  try {
    listXml = await svn(['list', '--xml', ...authArgs(effectiveCreds), clean]);
  } catch (e) {
    throw authHint(e, effectiveCreds);
  }
  if (opts.creds?.username) await rememberRepoCreds(clean, opts.creds);
  const entries = [];
  const re = /<entry\s+kind="(\w+)">([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(listXml))) {
    const kind = m[1];
    const body = m[2];
    const name = unescapeXML(((/<name>([\s\S]*?)<\/name>/.exec(body) || [])[1] || '').trim());
    if (!name) continue;
    const sizeRaw = (/<size>(\d+)<\/size>/.exec(body) || [])[1];
    const commitBlock = /<commit[\s\S]*?<\/commit>/.exec(body);
    let revision = null;
    let author = '';
    let date = '';
    if (commitBlock) {
      revision = Number((/revision="(\d+)"/.exec(commitBlock[0]) || [])[1] || 0) || null;
      author = unescapeXML(((/<author>([\s\S]*?)<\/author>/.exec(commitBlock[0]) || [])[1] || '').trim());
      date = ((/<date>([\s\S]*?)<\/date>/.exec(commitBlock[0]) || [])[1] || '').trim();
    }
    const size = sizeRaw ? Number(sizeRaw) : 0;
    entries.push({
      name,
      path: name,
      kind: kind === 'dir' ? 'dir' : 'file',
      size,
      sizeText: kind === 'dir' ? null : humanSize(size),
      revision,
      author,
      date,
      message: '',
    });
  }

  // 目录树只需要目录，跳过 log 查询
  if (opts.dirsOnly) {
    return {
      url: clean,
      entries: entries.filter((e) => e.kind === 'dir'),
      tookMs: Date.now() - started,
    };
  }

  // 补齐每个条目最后修改时的 commit message
  const revs = [...new Set(entries.map((e) => e.revision).filter(Boolean))];
  if (revs.length > 0) {
    const max = Math.max(...revs);
    const min = Math.min(...revs);
    // 跨度太大时不要一次拉几千条日志：只覆盖最近的一段
    const span = max - min + 1;
    const LIMIT = 600;
    const from = span <= LIMIT ? min : Math.max(min, max - LIMIT + 1);
    try {
      const logXml = await svn(['log', '--xml', '-r', `${max}:${from}`, '--limit', String(LIMIT), clean]);
      const msgMap = new Map();
      const logRe = /<logentry\s+revision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/g;
      let lm;
      while ((lm = logRe.exec(logXml))) {
        const rev = Number(lm[1]);
        const body = lm[2];
        msgMap.set(rev, unescapeXML(((/<msg>([\s\S]*?)<\/msg>/.exec(body) || [])[1] || '').trim()));
      }
      for (const e of entries) {
        if (e.revision && msgMap.has(e.revision)) e.message = msgMap.get(e.revision);
      }
    } catch {
      /* 拿不到说明不影响列目录 */
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });

  return { url: clean, entries, tookMs: Date.now() - started };
}

// ---------- 文件内容预览 ----------

const PREVIEW_LIMIT = 512 * 1024; // 只读前 512KB，避免超大文件把内存打满

/**
 * 读工作副本里某个文件的内容用于预览。
 * 与 diff 不同：这里读的是磁盘上的真实文件，未改动的文件也能看。
 */
async function readLocalFile(wcPath, relFile) {
  if (typeof relFile !== 'string' || !relFile) throw new Error('缺少文件路径');
  const abs = path.resolve(path.join(wcPath, relFile));
  if (!abs.startsWith(wcPath + path.sep)) throw new Error('文件不在工作副本里');

  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw new Error('这个文件已经不存在了');
  if (st.isDirectory()) throw new Error('这是个目录');

  const fh = await fsp.open(abs, 'r');
  try {
    const readLen = Math.min(st.size, PREVIEW_LIMIT);
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, 0);
    // 前 8KB 出现 NUL 就当二进制
    const probe = buf.subarray(0, Math.min(buf.length, 8192));
    const isBinary = probe.includes(0);
    return {
      path: relFile,
      size: st.size,
      sizeText: humanSize(st.size),
      mtime: st.mtimeMs,
      binary: isBinary,
      truncated: st.size > PREVIEW_LIMIT,
      content: isBinary ? '' : buf.toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}

/**
 * 读仓库里某个文件的真实内容（不用检出）。
 *
 * 用流式 spawn 而不是 execFile：execFile 会先把整个文件收进内存，
 * 遇到几百 MB 的二进制会直接把进程撑爆。这里读满 PREVIEW_LIMIT 就杀掉子进程。
 */
async function readRepoFile(url, creds, limit = PREVIEW_LIMIT) {
  if (typeof url !== 'string' || !/^(https?|svn|svn\+ssh|file):\/\//i.test(url.trim())) {
    throw new Error('文件地址要以 http:// 、https:// 、svn:// 或 svn+ssh:// 开头');
  }
  const clean = url.trim().replace(/\/+$/, '');
  const effectiveCreds = await getRepoCreds(clean, creds);

  return new Promise((resolve, reject) => {
    const child = spawn(SVN, ['--non-interactive', 'cat', ...authArgs(effectiveCreds), clean], {
      env: svnEnv(),
    });
    const chunks = [];
    let total = 0;
    let truncated = false;
    let stderr = '';

    child.stdout.on('data', (d) => {
      const remain = limit - total;
      if (remain <= 0) {
        truncated = true;
        return;
      }
      if (d.length > remain) {
        chunks.push(d.subarray(0, remain));
        total += remain;
        truncated = true;
      } else {
        chunks.push(d);
        total += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(0, 8000);
    });
    child.on('error', () => reject(new Error('找不到 svn 命令行工具')));

    // 读够了就提前收工，别让大文件继续下载
    child.on('close', async (code) => {
      if (code !== 0) {
        const first = stderr.split('\n').find((l) => /^svn: /.test(l)) || stderr.trim().split('\n')[0];
        return reject(authHint(new Error(decodeUrlText(first || '读取失败，仓库可能不可达')), effectiveCreds));
      }
      if (creds?.username) await rememberRepoCreds(clean, creds);
      const buf = Buffer.concat(chunks);
      const probe = buf.subarray(0, Math.min(buf.length, 8192));
      const isBinary = probe.includes(0);
      resolve({
        url: clean,
        size: buf.length,
        sizeText: truncated ? `≥ ${humanSize(buf.length)}` : humanSize(buf.length),
        binary: isBinary,
        truncated,
        content: isBinary ? '' : buf.toString('utf8'),
      });
    });

    // 超限时主动结束：cat 不支持 range，只能杀进程
    const timer = setInterval(() => {
      if (truncated && child.exitCode === null) child.kill('SIGTERM');
    }, 200);
    child.on('close', () => clearInterval(timer));
  });
}

// 远端状态单独缓存。
// 为什么：`svn status -u` 要遍历服务器目录。本地 file:// 仓库只多 20ms，
// 但真实远程仓库是几秒到几十秒量级 —— 它不该跟着每次本地刷新一起跑。
const remoteCache = new Map();
const REMOTE_TTL = 30_000;

async function buildStatus(wcPath, opts = {}) {
  const wantRemote = opts.remote === true;
  const force = opts.force === true;
  const forceRemote = opts.forceRemote === true;

  const now = Date.now();
  const lHit = statusCache.get(wcPath);
  const rHit = remoteCache.get(wcPath);
  const localUsable = Boolean(lHit) && !force && now - lHit.at < CACHE_TTL;
  const remoteUsable = Boolean(rHit) && !forceRemote && now - rHit.at < REMOTE_TTL;

  // 本地缓存够用，且远端要么不需要、要么也有缓存 → 直接返回
  if (localUsable && (!wantRemote || remoteUsable)) {
    const payload = { ...lHit.payload };
    if (wantRemote) {
      payload.remote = rHit.files;
      payload.remoteCached = true;
      payload.remoteFetchedAt = rHit.at;
    }
    return { ...payload, cached: true, tookMs: 0 };
  }

  const started = Date.now();

  const infoXml = await svn(['info', '--xml', wcPath]);
  const info = parseInfo(infoXml);
  if (info.url) wcUrlCache.set(wcPath, info.url);
  const queryServer = wantRemote && !remoteUsable;

  // 只有需要"新查"远端时才带 -u：这一条命令同时给出本地与远端状态
  if (TRACE) {
    process.stderr.write(
      `[cache] wc=${path.basename(wcPath)} wantRemote=${wantRemote} force=${force} ` +
        `forceRemote=${forceRemote} lHit=${Boolean(lHit)} rHit=${Boolean(rHit)} ` +
        `age=${rHit ? now - rHit.at : -1} remoteUsable=${remoteUsable} queryServer=${queryServer}\n`
    );
  }
  const args = ['status', '--xml'];
  if (queryServer) args.push('-u');
  args.push(wcPath);
  const statusXml = queryServer ? await svnRemote(args, wcPath, opts.creds) : await svn(args);
  const entries = parseStatus(statusXml);

  const local = [];
  const remote = [];
  const toStat = [];

  for (const e of entries) {
    // svn status 的 entry path 可能是绝对路径，统一转成相对工作副本的路径
    let rel = e.rel;
    if (path.isAbsolute(rel)) rel = path.relative(wcPath, rel);
    if (!rel || rel === '.' || rel.startsWith('..')) continue;
    // .DS_Store 这类系统垃圾文件：默认不算改动，也不在列表里出现
    if (isNoiseFile(path.basename(rel))) continue;

    const wcKind = mapKind(e.wcItem);
    const reposKind = mapKind(e.reposItem);

    // svn move 留下的配对信息，界面据此把「旧路径 → 新路径」说清楚。
    // 路径统一转成相对工作副本，绝对路径出不了工作副本。
    const moveRel = (p) => {
      if (!p) return null;
      let out = p;
      if (path.isAbsolute(out)) out = path.relative(wcPath, out);
      if (!out || out === '.' || out.startsWith('..')) return null;
      return out;
    };
    const movedFrom = moveRel(e.movedFrom);
    const movedTo = moveRel(e.movedTo);

    if (wcKind && wcKind !== 'ignored' && wcKind !== 'normal') {
      // 冲突期间 svn 会生成 xxx.mine / xxx.rN 辅助文件，不该让用户去处理
      if (wcKind === 'unversioned' && /\.(mine|r\d+)$/i.test(rel)) continue;
      const ext = path.extname(rel).slice(1).toLowerCase();
      const isBinary = BINARY_EXT.has(ext);
      const file = {
        path: rel,
        name: path.basename(rel),
        dir: path.dirname(rel) === '.' ? '工作副本根目录' : path.dirname(rel),
        kind: wcKind,
        letter: LETTER[wcKind],
        label: (wcKind === 'added' && e.copied) ? '已移动（保留历史）' : LABEL[wcKind],
        copied: !!e.copied,
        movedFrom,
        movedTo,
        isDir: false,
        added: 0,
        deleted: 0,
        binary: isBinary,
        size: 0,
        sizeText: null,
        big: false,
        // 大文件不读差异，界面据此显示"文件较大，不做逐行对比"
        diffSkipped: false,
        risk: riskOf(rel, 0, isBinary),
        mtime: null,
      };
      local.push(file);
      toStat.push(file);
    }

    // 远端更新独立判断，不能挂在 local 的 else 分支上。
    // 一个文件完全可能"本地改了、远端也改了"——这种恰恰最该出现在待同步里，
    // 因为直接更新它会冲突。原来的 else if 会让这类文件一个都进不了待同步。
    if (reposKind && reposKind !== 'normal') {
      remote.push({
        path: rel,
        name: path.basename(rel),
        dir: path.dirname(rel) === '.' ? '工作副本根目录' : path.dirname(rel),
        kind: reposKind,
        letter: LETTER[reposKind],
        label: '同事已更新',
        added: 0,
        deleted: 0,
        binary: false,
        size: 0,
        risk: null,
        mtime: null,
        remote: true,
      });
    }
  }

  // 标出"远端改了、本地也改了"的文件：更新它会冲突，界面要提醒
  const localPathSet = new Set(local.map((f) => f.path));
  for (const r of remote) {
    if (localPathSet.has(r.path)) r.localChanged = true;
  }

  // 并行 stat。
  // 原来是在上面的循环里 await，N 个改动文件就是 N 次串行 IO；
  // 上千文件各改一处时，串行 stat 会比并行慢一个数量级。
  // 目录删除的子项不用逐个问 kind：它们在界面上收进目录行，结果用不到。
  const gonePathSet = new Set(
    local.filter((f) => f.kind === 'missing' || f.kind === 'deleted').map((f) => f.path)
  );
  const goneAncestors = new Set();
  for (const p of gonePathSet) {
    let i = p.lastIndexOf('/');
    while (i > 0) {
      goneAncestors.add(p.slice(0, i));
      i = p.lastIndexOf('/', i - 1);
    }
  }
  await runLimited(toStat, 32, async (f) => {
    try {
      const abs = path.join(wcPath, f.path);
      const st = await fsp.stat(abs);
      f.isDir = st.isDirectory();
      f.size = st.size;
      f.mtime = st.mtimeMs;
      f.sizeText = humanSize(st.size);
      f.big = st.size > BIG_FILE_LIMIT;
      // 扩展名不认识的大文件再嗅探一次（只读 8KB）：
      // 没后缀的 zip / 数据库 dump 不会被当成文本塞进 diff
      if (f.big && !f.binary) f.binary = await sniffBinary(abs);
      f.diffSkipped = f.big;
      const risk = riskOf(f.path, st.size, f.binary);
      if (risk) f.risk = risk;
    } catch {
      /* 已删除的文件 */
      // 目录被整个删掉时，status 只会给顶层目录；界面要说清"整个目录都会被删除"。
      // 用不带 -r BASE 的 info：它只读工作副本元数据，不会连仓库。
      // 带 -r BASE 会把不存在的路径解析成仓库 URL，远程仓库没凭据时必然失败。
      if (f.kind === 'missing' || f.kind === 'deleted') {
        if (!goneAncestors.has(f.path)) {
          const kind = await svn(['info', '--show-item', 'kind', f.path], wcPath)
            .then((s) => s.trim())
            .catch(() => '');
          if (kind === 'dir') f.isDir = true;
        }
        // 节点信息取不到时，moved 过的还能从新路径判断
        if (!f.isDir && f.movedTo) {
          try {
            const st = await fsp.stat(path.join(wcPath, f.movedTo));
            if (st.isDirectory()) f.isDir = true;
          } catch { /* 新路径也不在了 */ }
        }
      }
    }
  });

  // 旧目录在磁盘上已经不存在时，从 status 里的缺失子项反推它是目录
  for (const f of local) {
    if (f.isDir || !gonePathSet.has(f.path)) continue;
    const prefix = f.path + '/';
    if (local.some((g) => g !== f && g.path.startsWith(prefix))) f.isDir = true;
  }

  const modified = local.filter((f) => f.kind === 'modified');
  const diffable = modified.filter((f) => !f.binary && !f.big);
  const risky = modified.filter((f) => f.binary || f.big);

  let multi = new Map();
  if (diffable.length && risky.length === 0) {
    // 快路径：全是小文本文件时一次取整个工作副本的 diff。
    // 实测 60 个改动文件：161ms（60 次进程）→ 19ms（1 次进程）。
    const diffOut = await svn(['diff', wcPath]);
    multi = parseMultiFileDiff(diffOut);
  } else if (diffable.length) {
    // 有二进制 / 大文件时不能再用整仓 diff —— svn 会把它们也读一遍。
    // 改成只对"能安全比较"的文件逐个 diff，大文件完全不碰。
    await runLimited(diffable, 4, async (f) => {
      const out = await svn(['diff', path.join(wcPath, f.path)]).catch(() => '');
      if (!out) return;
      const d = parseUnifiedDiff(out);
      if (d.binary) {
        f.binary = true;
        f.diffSkipped = true;
        f.risk = f.risk || { code: 'binaryGrowth', text: '二进制变更' };
        return;
      }
      f.added = d.added;
      f.deleted = d.deleted;
    });
  }

  // 新增/未纳入的文件不在 svn diff 输出里，直接读文件统计行数。
  // 大文件与非文本一律不读 —— 这就是"拖进一个大 zip 界面就卡住"的根源。
  const addedOnes = local.filter(
    (f) => (f.kind === 'added' || f.kind === 'unversioned') && !f.binary && !f.big
  );
  await runLimited(addedOnes, 8, async (f) => {
    const r = await readLineCount(path.join(wcPath, f.path));
    if (r) { f.added = r.count; f.deleted = 0; }
  });

  for (const f of local) {
    if (f.kind !== 'modified' || f.binary) continue;
    const abs = path.join(wcPath, f.path);
    const d = multi.get(abs) || multi.get(f.path);
    if (!d) continue;
    f.added = d.added;
    f.deleted = d.deleted;
    if (d.binary) {
      f.binary = true;
      f.diffSkipped = true;
      f.risk = f.risk || { code: 'binaryGrowth', text: '二进制变更' };
    }
  }

  // 目录条目的文件数：目录行只占一条状态，用户看不到里面的文件。
  // 界面需要在目录行上说明"含 N 个文件"并允许展开确认，避免以为文件丢了。
  // 旧路径不在磁盘上时：moved 过的看新路径，没 moved 的看 status 里的缺失子项。
  const dirEntries = local.filter(
    (f) => f.isDir && ['added', 'deleted', 'missing', 'unversioned', 'replaced'].includes(f.kind)
  );
  await runLimited(dirEntries, 8, async (f) => {
    const onDisk = f.movedTo || f.path;
    let summary = null;
    try {
      const st = await fsp.stat(path.join(wcPath, onDisk));
      if (st.isDirectory()) summary = await scanDirChildren(path.join(wcPath, onDisk));
    } catch { /* 磁盘上没有 */ }
    if (!summary) summary = collectGoneDescendants(f.path, local);
    f.childCount = summary.count;
    f.children = summary.children;
    f.childrenTruncated = summary.truncated;
  });

  local.sort((a, b) => a.path.localeCompare(b.path, 'zh'));

  // 自动检测「访达里改名」造成的 missing + 未纳入配对。只读，不改磁盘；
  // 修复要等用户在界面上确认，走 /api/rename-repair。
  let renameCandidates = [];
  if (local.some((f) => f.kind === 'missing') && local.some((f) => f.kind === 'unversioned')) {
    renameCandidates = await detectRenameCandidates({ wcPath, local, fs, svn });
  }

  // 远端数据来源：这次新查的 / 复用的旧缓存 / 没有
  let remoteFiles = remote;
  let remoteCached = false;
  let remoteFetchedAt = null;
  if (wantRemote) {
    if (queryServer) {
      remoteCache.set(wcPath, { at: Date.now(), files: remote });
      remoteFetchedAt = Date.now();
    } else if (remoteUsable) {
      remoteFiles = rHit.files;
      remoteCached = true;
      remoteFetchedAt = rHit.at;
    }
  }

  const payload = {
    info,
    local,
    remote: remoteFiles,
    renameCandidates,
    remoteCached,
    remoteFetchedAt,
    cached: false,
    tookMs: Date.now() - started,
  };
  statusCache.set(wcPath, { at: Date.now(), payload });
  // 持久化一份，供下次启动先渲染（PRD FR-16）
  if (local.length <= 3000) {
    diskCache[wcPath] = { ...payload, savedAt: Date.now() };
    saveDiskCacheSoon();
  }
  return payload;
}

function mapKind(item) {
  switch (item) {
    case 'modified': case 'replaced': return 'modified';
    case 'added': return 'added';
    case 'deleted': return 'deleted';
    case 'missing': return 'missing';
    case 'conflicted': return 'conflicted';
    case 'unversioned': return 'unversioned';
    case 'ignored': return 'ignored';
    case 'normal': return 'normal';
    default: return null;
  }
}

const LETTER = { modified: 'M', added: 'A', deleted: 'D', missing: 'D', conflicted: 'C', unversioned: 'U', ignored: 'I', normal: '' };
const LABEL = { modified: '已修改', added: '新增', deleted: '已删除', missing: '本地已删除', conflicted: '有冲突', unversioned: '未纳入', ignored: '已忽略', normal: '正常' };

async function computeDiff(wcPath, rel, kind, context = '', supplied = null) {
  const abs = path.join(wcPath, rel);
  if (kind === 'missing') {
    // 文件被从磁盘删掉、但还没 svn delete。BASE 版本还在本地 pristine 里，
    // 先把上次提交的内容当成「删除」展示，用户才看得见到底删了什么。
    const base = await svn(['cat', '-r', 'BASE', abs]).catch(() => null);
    if (base !== null) {
      if (base.length > BIG_FILE_LIMIT) {
        return {
          lines: [],
          added: 0,
          deleted: 0,
          binary: true,
          skipped: true,
          sizeText: humanSize(base.length),
          message: `这个文件上次提交时有 ${humanSize(base.length)}，不做逐行对比。`,
        };
      }
      if (base.includes('\u0000')) return { lines: [], added: 0, deleted: 0, binary: true };
      const rows = base.split('\n');
      if (rows[rows.length - 1] === '') rows.pop();
      const lines = [
        { kind: 'hunk', oldNo: null, newNo: null, text: `@@ 本地已删除，下面是上次提交的内容（共 ${rows.length} 行）@@` },
      ];
      rows.forEach((text, i) => lines.push({ kind: 'del', oldNo: i + 1, newNo: null, text }));
      return { lines, added: 0, deleted: rows.length, binary: false };
    }

    // 目录读不出内容，就列出原本里面有什么（递归，含子目录）。
    // cat 能读本地 pristine，目录列表不行，需要带凭据问服务器。
    const listed = await svnRemote(['list', '-R', '-r', 'BASE', abs], wcPath, supplied).catch(() => null);
    if (listed !== null) {
      const names = listed.split('\n').filter(Boolean);
      if (!names.length) {
        return { lines: [], added: 0, deleted: 0, binary: false, message: '这个空目录已从本地删除。' };
      }
      const lines = [
        { kind: 'hunk', oldNo: null, newNo: null, text: `@@ 目录已从本地删除，原本有 ${names.length} 项（含子目录）@@` },
      ];
      names.forEach((name) => lines.push({ kind: 'del', oldNo: null, newNo: null, text: name }));
      return { lines, added: 0, deleted: names.length, binary: false };
    }

    return { lines: [], added: 0, deleted: 0, binary: false, message: '这个路径已从本地删除，也读不到上次提交的内容。' };
  }
  const ext = path.extname(rel).slice(1).toLowerCase();
  const st = await fsp.stat(abs).catch(() => null);
  const size = st ? st.size : 0;
  let isBinary = BINARY_EXT.has(ext);
  if (st && !isBinary && size > BIG_FILE_LIMIT) isBinary = await sniffBinary(abs);

  // 大文件压根不读：不 readFile、不 svn diff。
  // 之前这里对"新增/未纳入"的文件直接 readFile + split('\n')，
  // 拖进来一个几百 MB 的 zip 就足够把进程和界面一起卡死。
  if (st && size > BIG_FILE_LIMIT) {
    const sizeText = humanSize(size);
    return {
      lines: [],
      added: 0,
      deleted: 0,
      binary: isBinary,
      skipped: true,
      size,
      sizeText,
      message: isBinary
        ? `这个文件 ${sizeText}，不是文本，不做逐行对比。需要看内容请用外部工具打开。`
        : `这个文件 ${sizeText}，超过 10 MB，不做逐行对比。需要看全量内容请用外部工具打开。`,
    };
  }

  if (isBinary) return { lines: [], added: 0, deleted: 0, binary: true };

  if (kind === 'added' || kind === 'unversioned') {
    const content = await fsp.readFile(abs, 'utf8');
    const rows = content.split('\n');
    const lines = [{ kind: 'hunk', oldNo: null, newNo: null, text: `@@ 新文件，共 ${rows.length} 行 @@` }];
    rows.forEach((text, i) => lines.push({ kind: 'add', oldNo: null, newNo: i + 1, text }));
    return { lines, added: rows.length, deleted: 0, binary: false };
  }
  // -U 决定每段改动上下各带几行未变更内容。展开时给一个足够大的值，
  // 相当于把整个文件的上下文都带出来（svn 会自动截到文件边界）。
  const ctxArgs = context === 'full' ? ['-x', '-U100000'] : [];
  const out = await svn(['diff', ...ctxArgs, abs]);
  if (out.includes('Cannot display: file marked as a binary type')) {
    return { lines: [], added: 0, deleted: 0, binary: true };
  }
  return parseUnifiedDiff(out);
}

async function runLimited(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function snapshot(wcPath, rels) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(SNAPSHOT_DIR, stamp);
  let copied = 0;
  for (const rel of rels) {
    const src = path.join(wcPath, rel);
    const dst = path.join(base, rel);
    try {
      const st = await fsp.stat(src);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      // 目录也要能备份：删目录时用 copyFile 会直接失败，等于没有备份
      if (st.isDirectory()) await fsp.cp(src, dst, { recursive: true, force: true });
      else await fsp.copyFile(src, dst);
      copied++;
    } catch { /* 已删除的文件跳过 */ }
  }
  return copied > 0 ? base : null;
}

// ---------- HTTP ----------

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** SSE 一帧：event 名在前，data 是一行 JSON（前端按 \n\n 切帧） */
function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** 允许用户按习惯填 ~/Documents/project；决策前统一展开成绝对路径 */
function expandHome(p) {
  const s = String(p).trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * 只看 .svn 目录存在不够：/tmp 清理、误删都可能留下一个空的 .svn，
 * 这时 svn 会报 E155007。必须看到 wc.db（1.7+）或 entries（老格式）才算工作副本。
 */
function isWorkingCopyDir(p) {
  const dotSvn = path.join(p, '.svn');
  if (!fs.existsSync(dotSvn)) return false;
  if (fs.existsSync(path.join(dotSvn, 'wc.db'))) return true;
  // 1.7+ 也会留一个 3 字节的 entries 占位文件，不能只凭它判断。
  // 老格式（1.6 及以前）的 entries 是完整的 XML。
  const entries = path.join(dotSvn, 'entries');
  try {
    return fs.existsSync(entries) && fs.statSync(entries).size > 64;
  } catch {
    return false;
  }
}

function assertWC(p) {
  if (typeof p !== 'string' || !p) throw new Error('缺少工作副本路径');
  const abs = expandHome(p);
  if (!path.isAbsolute(abs)) throw new Error('路径必须是绝对路径');
  if (!fs.existsSync(path.join(abs, '.svn'))) throw new Error('这个目录不是 SVN 工作副本（找不到 .svn）');
  if (!isWorkingCopyDir(abs)) {
    throw new Error('这个目录的 .svn 不完整（可能被清理或损坏），不是可用的工作副本。可以从项目列表移除后重新检出。');
  }
  return abs;
}

/** 写接口统一的相对路径归一：去掉 ./ 和结尾斜杠，拒绝绝对路径与 .. */
function relNormPath(p) {
  const s = relNorm(p);
  if (!s || s.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(s)) return '';
  return s;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

async function readFromRoot(root, relPath) {
  const clean = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(root, clean);
  // 目录穿越防护：解析后的路径必须仍在根目录内
  if (!file.startsWith(root)) return null;
  try {
    return { file, data: await fsp.readFile(file) };
  } catch {
    return null;
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;

  // 新前端优先，旧版 public/ 作回退（两者都存在时以构建产物为准）
  for (const root of [WEB_DIST, PUBLIC_DIR]) {
    const hit = await readFromRoot(root, rel);
    if (!hit) continue;
    const isHtml = path.extname(hit.file) === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(hit.file)] || 'application/octet-stream',
      // 带 hash 的静态资源可长缓存；html 不缓存，保证更新后立刻生效
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    return res.end(hit.data);
  }

  // 单页应用回退：非 API 的未知路径交给前端处理，而不是 404
  for (const root of [WEB_DIST, PUBLIC_DIR]) {
    const hit = await readFromRoot(root, '/index.html');
    if (!hit) continue;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(hit.data);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('前端资源不存在，先在 web/ 目录执行 npm run build');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (p === '/api/health' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          svn: SVN,
          svnEmbedded: SVN_EMBEDDED,
          svnVersion: SVN ? svnVersion() : '',
          credentialStore: Boolean(KEYCHAIN_HELPER),
          bundled: process.env.FASTSVN_BUNDLED === '1',
          version: APP_VERSION,
        });
      }

      if (p === '/api/working-copies' && req.method === 'GET') {
        const { paths, aliases } = await readStoreMeta();
        // 逐个确认还是不是工作副本：目录可能被删了，或者 .svn 被清掉了。
        // 界面据此把"不是 SVN 工作副本"的项目灰掉，而不是点进去才报错。
        return json(res, 200, { paths, items: withWcFlags(paths, aliases) });
      }

      if (p === '/api/working-copies' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const { paths, aliases } = await readStoreMeta();
        if (!paths.includes(wc)) paths.push(wc);
        wcUrlCache.delete(wc);
        await writeStore(paths, aliases);
        return json(res, 200, { paths, items: withWcFlags(paths, aliases) });
      }

      if (p === '/api/working-copies' && req.method === 'DELETE') {
        const body = await readBody(req);
        const { paths: all, aliases } = await readStoreMeta();
        const paths = all.filter((x) => x !== body.path);
        delete aliases[body.path];
        wcUrlCache.delete(body.path);
        await writeStore(paths, aliases);
        return json(res, 200, { paths, items: withWcFlags(paths, aliases) });
      }

      // 给项目起个显示用的别名：只影响界面显示，不动磁盘、不动 svn
      if (p === '/api/working-copies/alias' && req.method === 'POST') {
        const body = await readBody(req);
        const { paths, aliases } = await readStoreMeta();
        const target = String(body.path || '');
        if (!paths.includes(target)) throw new Error('这个项目不在列表里');
        const alias = String(body.alias ?? '').trim();
        if (alias) {
          if (alias.length > 60) throw new Error('别名太长了（最多 60 个字）');
          aliases[target] = alias;
        } else {
          // 传空字符串 = 恢复成目录名
          delete aliases[target];
        }
        await writeStore(paths, aliases);
        return json(res, 200, { paths, items: withWcFlags(paths, aliases) });
      }

      // ---- 设置 ----
      if (p === '/api/settings' && req.method === 'GET') {
        return json(res, 200, settings);
      }

      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, await saveSettings(body));
      }

      // 检出：POST /api/checkout 起任务 → GET /api/checkout?id= 轮询进度
      if (p === '/api/checkout' && req.method === 'POST') {
        const body = await readBody(req);
        const creds = await getRepoCreds(body.url, svnCreds(req));
        const job = checkouts.start({
          url: body.url,
          target: body.path,
          mode: body.mode === 'export' ? 'export' : 'checkout',
          creds,
        });
        return json(res, 200, checkouts.status(job.id));
      }

      if (p === '/api/checkout' && req.method === 'GET') {
        return json(res, 200, checkouts.status(url.searchParams.get('id')));
      }

      if (p === '/api/checkout/cancel' && req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, checkouts.cancel(body.id));
      }

      if (p === '/api/status' && req.method === 'GET') {
        if (TRACE) process.stderr.write(`[req] status ${url.search}\n`);
        const wc = assertWC(url.searchParams.get('path'));
        // stale=1：只返回上次存下的状态，用于打开应用时先渲染，再后台校验
        if (url.searchParams.get('stale') === '1') {
          const saved = diskCache[wc];
          if (saved) return json(res, 200, { ...saved, cached: true, stale: true, tookMs: 0 });
        }
        const data = await buildStatus(wc, {
          remote: url.searchParams.get('remote') === '1',
          force: url.searchParams.get('force') === '1',
          // forceRemote：明确要求重新问服务器（默认复用 30 秒内的远端缓存）
          forceRemote: url.searchParams.get('forceRemote') === '1',
          creds: svnCreds(req),
        });
        return json(res, 200, data);
      }

      // 本地目录浏览：列出工作副本里某个目录的真实内容
      if (p === '/api/ls' && req.method === 'GET') {
        const wc = assertWC(url.searchParams.get('path'));
        const dir = url.searchParams.get('dir') || '';
        return json(res, 200, await listLocalDir(wc, dir));
      }

      // 读工作副本里的真实文件内容（未改动的文件也能看）
      if (p === '/api/file' && req.method === 'GET') {
        const wc = assertWC(url.searchParams.get('path'));
        const file = url.searchParams.get('file');
        return json(res, 200, await readLocalFile(wc, file));
      }

      // 在访达里打开/定位本地路径（下载完成后用）
      if (p === '/api/reveal' && req.method === 'POST') {
        const body = await readBody(req);
        const target = String(body.path || '').trim();
        if (!target || !path.isAbsolute(target)) throw new Error('需要一个绝对路径');
        const st = await fsp.stat(target).catch(() => null);
        if (!st) throw new Error('这个位置已经不存在了');
        // 目录直接进去；文件在访达里选中，省得用户自己再找
        const args = st.isDirectory() ? [target] : ['-R', target];
        await new Promise((resolve, reject) => {
          execFile('open', args, (err) => {
            if (err) reject(new Error('无法打开访达，可能是路径权限受限'));
            else resolve();
          });
        });
        return json(res, 200, { ok: true, kind: st.isDirectory() ? 'dir' : 'file' });
      }

      // 仓库根信息（左侧树从根展开）
      if (p === '/api/repo/info' && req.method === 'GET') {
        return json(res, 200, await repoInfo(url.searchParams.get('url'), svnCreds(req)));
      }

      // 读仓库里的文件内容（不用检出）
      if (p === '/api/repo/cat' && req.method === 'GET') {
        return json(res, 200, await readRepoFile(url.searchParams.get('url'), svnCreds(req)));
      }

      // 远程仓库浏览
      if (p === '/api/repo/list' && req.method === 'GET') {
        const target = url.searchParams.get('url');
        const dirsOnly = url.searchParams.get('dirsOnly') === '1';
        return json(res, 200, await listRepo(target, { dirsOnly, creds: svnCreds(req) }));
      }

      if (p === '/api/diff' && req.method === 'GET') {
        const wc = assertWC(url.searchParams.get('path'));
        const rel = url.searchParams.get('file');
        const kind = url.searchParams.get('kind') || 'modified';
        // context=full：把未变更的行也带出来，供「展开查看」用
        const context = url.searchParams.get('context') || '';
        if (!rel) throw new Error('缺少文件路径');
        const abs = path.join(wc, rel);
        if (!abs.startsWith(wc + path.sep)) throw new Error('非法文件路径');
        const data = await computeDiff(wc, rel, kind, context, svnCreds(req));
        return json(res, 200, data);
      }

      // 提交（流式）：进度、错误、成功都在同一响应里推给界面
      if (p === '/api/commit/stream' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const files = Array.isArray(body.files) ? body.files : [];
        const message = String(body.message || '').trim();
        if (!files.length) throw new Error('没有选择任何文件');
        if (!message) throw new Error('请填一句说明，方便同事看懂这次改了什么');
        await streamCommit(req, res, wc, files, message);
        return;
      }

      if (p === '/api/commit' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const files = Array.isArray(body.files) ? body.files : [];
        const message = String(body.message || '').trim();
        if (!files.length) throw new Error('没有选择任何文件');
        if (!message) throw new Error('请填一句说明，方便同事看懂这次改了什么');
        await stageMissingDeletes(wc, files, svnCreds(req));
        const targets = await expandDeletedDirTargets(wc, files, svnCreds(req));
        let out;
        try {
          out = await svnRemote(['commit', '-m', message, '--depth', 'empty', ...targets], wc, svnCreds(req));
        } catch (e) {
          // 目录不是最新：更新后重试一次
          if (/E155011/.test(e.message) && (await repairOutdatedDirs(wc, e.message, svnCreds(req)))) {
            try {
              out = await svnRemote(['commit', '-m', message, '--depth', 'empty', ...targets], wc, svnCreds(req));
            } catch (retryError) {
              throw wcAuthHint(commitErrorHint(retryError), '提交');
            }
          } else {
            throw wcAuthHint(commitErrorHint(e), '提交');
          }
        }
        statusCache.delete(wc);
        remoteCache.delete(wc);
        const m = /Committed revision (\d+)/.exec(out);
        return json(res, 200, { revision: m ? Number(m[1]) : 0, raw: out.trim() });
      }

      if (p === '/api/update' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        // 可选 file：本地目录树里对单个文件/子目录右键「更新」时只更新它
        let target = wc;
        if (body.file) {
          target = path.join(wc, String(body.file));
          if (!target.startsWith(wc + path.sep)) throw new Error('非法文件路径');
          if (!fs.existsSync(target)) throw new Error('这个路径已经不在磁盘上了');
        }
        let out;
        try {
          out = await svnRemote(['update', target], wc, svnCreds(req));
        } catch (e) {
          throw wcAuthHint(e, '更新');
        }
        statusCache.delete(wc);
        remoteCache.delete(wc);
        const conflicts = out.split('\n').filter((l) => /^C\s/.test(l) || /^C {4}/.test(l)).length;
        const m = /(Updated to|At) revision (\d+)/.exec(out);
        // svn update 会逐行打印动作：A 新增 / U 更新 / G 合并 / C 冲突 / D 删除 / E 已存在
        // 把它们收成明细，界面才能告诉用户"这次到底更新了什么"
        const updated = [];
        for (const line of out.split('\n')) {
          const hit = /^([ADUCGER])\s{2,}(.+)$/.exec(line.replace(/\r$/, ''));
          if (!hit) continue;
          // 带空格的路径会被 svn 加引号
          let rel = hit[2].trim().replace(/^"(.*)"$/, '$1');
          rel = path.relative(wc, path.join(wc, rel));
          updated.push({ action: hit[1], path: rel, name: path.basename(rel) });
        }
        return json(res, 200, { revision: m ? Number(m[2]) : 0, conflicts, updated, raw: out.trim() });
      }

      // 本地目录树里「新建子目录」：先建目录，父目录在版本控制下就顺手 add
      if (p === '/api/mkdir' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const dirRel = String(body.dir || '');
        const name = String(body.name || '').trim();
        if (!name) throw new Error('目录名不能为空');
        if (name.includes('/') || name === '.' || name === '..') throw new Error('目录名里不能带 /');
        const parentAbs = dirRel ? path.join(wc, dirRel) : wc;
        if (!parentAbs.startsWith(wc)) throw new Error('非法文件路径');
        if (!fs.existsSync(parentAbs)) throw new Error('父目录不存在了，刷新一下再试');

        const abs = path.join(parentAbs, name);
        if (fs.existsSync(abs)) throw new Error('这个名字已经存在了');
        await fsp.mkdir(abs);
        // 父目录已在版本控制下时，新目录也排进版本库，免得用户还要手动 add
        let added = false;
        try {
          await svn(['add', '--depth', 'empty', abs], wc);
          added = true;
        } catch {
          /* 父目录未纳入版本管理：只建本地目录 */
        }
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { ok: true, added, rel: path.relative(wc, abs) });
      }

      if (p === '/api/revert' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) throw new Error('没有选择任何文件');
        const snap = await snapshot(wc, files);
        await svn(['revert', '--depth', 'infinity', ...files], wc);
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { snapshot: snap });
      }

      if (p === '/api/log' && req.method === 'GET') {
        const wc = assertWC(url.searchParams.get('path'));
        const limit = Number(url.searchParams.get('limit') || 50);
        // file：只看某个文件/子目录的历史（本地目录里右键「查看历史」）
        const relFile = url.searchParams.get('file');
        let logTarget = wc;
        if (relFile) {
          logTarget = path.join(wc, relFile);
          if (!logTarget.startsWith(wc + path.sep)) throw new Error('非法文件路径');
          if (!fs.existsSync(logTarget)) throw new Error('这个路径已经不在磁盘上了');
        }
        // 按文件查时也要 -v：不然这条记录里"改了哪些文件"是空的
        const verbose = url.searchParams.get('verbose') === '1' || Boolean(relFile);
        const args = ['log', '-r', 'HEAD:1', '--xml', '-l', String(limit)];
        if (verbose) args.push('-v');
        args.push(logTarget);
        let xml;
        try {
          xml = await svnRemote(args, wc, svnCreds(req));
        } catch (e) {
          throw wcAuthHint(e, '查看历史');
        }
        const entries = [];
        const re = /<logentry\s+revision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/g;
        let m;
        while ((m = re.exec(xml))) {
          const body = m[2];
          const changes = [];
          if (verbose) {
            const pathRe = /<path\s+([^>]*)>([\s\S]*?)<\/path>/g;
            let pm;
            while ((pm = pathRe.exec(body))) {
              const action = (/action="([^"]*)"/.exec(pm[1]) || [])[1] || 'M';
              const kind = (/kind="([^"]*)"/.exec(pm[1]) || [])[1] || 'file';
              if (kind !== 'file') continue;
              const full = unescapeXML(pm[2]).trim();
              const rel = full.replace(/^\/[^/]+\//, ''); // 去掉 /trunk/ 前缀
              // repoPath 是仓库绝对路径，按版本取 diff 时要用它拼 URL
              changes.push({ path: rel, repoPath: full, name: path.basename(rel), action });
            }
          }
          entries.push({
            revision: Number(m[1]),
            author: unescapeXML(((/<author>([\s\S]*?)<\/author>/.exec(body) || [])[1] || '未知').trim()),
            date: ((/<date>([\s\S]*?)<\/date>/.exec(body) || [])[1] || '').trim(),
            message: unescapeXML(((/<msg>([\s\S]*?)<\/msg>/.exec(body) || [])[1] || '').trim()),
            files: changes,
          });
        }
        return json(res, 200, { entries });
      }

      // 看某个历史版本里某个文件改了什么：按仓库 URL 取，文件被删/改名也能看
      if (p === '/api/log/diff' && req.method === 'GET') {
        const wc = assertWC(url.searchParams.get('path'));
        const rev = Number(url.searchParams.get('rev'));
        const repoPath = url.searchParams.get('target') || '';
        if (!rev) throw new Error('缺少版本号');
        if (!repoPath.startsWith('/')) throw new Error('缺少文件路径');
        const rootUrl = (await svn(['info', '--show-item', 'repos-root-url', wc])).trim();
        const fileUrl = `${rootUrl.replace(/\/+$/, '')}${repoPath}`;
        let out;
        try {
          out = await svnRemote(['diff', '-c', String(rev), fileUrl], wc, svnCreds(req));
        } catch (e) {
          throw wcAuthHint(e, '查看历史差异');
        }
        if (out.includes('Cannot display: file marked as a binary type') || out.includes('Cannot display: file marked as a binary')) {
          return json(res, 200, { lines: [], added: 0, deleted: 0, binary: true });
        }
        if (!out.trim()) {
          return json(res, 200, {
            lines: [],
            added: 0,
            deleted: 0,
            binary: false,
            message: `r${rev} 里这个文件没有文本改动（可能是属性变更或只有路径操作）`,
          });
        }
        return json(res, 200, parseUnifiedDiff(out));
      }

      // 用系统默认程序打开工作副本里的文件
      if (p === '/api/open' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const rel = String(body.file || '');
        const abs = rel ? path.join(wc, rel) : wc;
        if (!abs.startsWith(wc + path.sep) && abs !== wc) throw new Error('非法文件路径');
        if (!fs.existsSync(abs)) throw new Error('这个文件已经不在磁盘上了');
        await new Promise((resolve, reject) => {
          execFile('open', [abs], (err) => {
            if (err) reject(new Error('打不开这个文件，可能没有关联的应用'));
            else resolve();
          });
        });
        return json(res, 200, { ok: true });
      }

      if (p === '/api/conflict' && req.method === 'GET') {
        const wc = assertWC(url.searchParams.get('path'));
        const rel = url.searchParams.get('file');
        if (!rel) throw new Error('缺少文件路径');
        const abs = path.join(wc, rel);
        if (!abs.startsWith(wc + path.sep)) throw new Error('非法文件路径');
        const text = await fsp.readFile(abs, 'utf8');
        const blocks = [];
        const re = /<{7}[^\n]*\n([\s\S]*?)={7}\n([\s\S]*?)>{7}[^\n]*\n/g;
        let m;
        while ((m = re.exec(text))) {
          // svn 默认 diff3 格式会在 "我的" 段后插入 "||||||| .rN" 基础版本段，需要截断
          let mine = m[1];
          const baseIdx = mine.indexOf('|||||||');
          if (baseIdx >= 0) mine = mine.slice(0, baseIdx);
          blocks.push({ mine, theirs: m[2] });
        }
        return json(res, 200, { blocks, count: blocks.length });
      }

      if (p === '/api/resolve' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const rel = String(body.file || '');
        const accept = String(body.accept || 'working');
        if (!rel) throw new Error('缺少文件路径');
        if (!['mine-full', 'theirs-full', 'working'].includes(accept)) {
          throw new Error('不支持的解决方式');
        }
        const abs = path.join(wc, rel);
        if (!abs.startsWith(wc + path.sep)) throw new Error('非法文件路径');
        await svn(['resolve', '--accept', accept, abs], wc);
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { ok: true, accept });
      }

      if (p === '/api/add' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const rel = String(body.file || '');
        if (!rel) throw new Error('缺少文件路径');
        const abs = path.join(wc, rel);
        if (!abs.startsWith(wc + path.sep)) throw new Error('非法文件路径');
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) throw new Error('这个文件已经不存在了');

        // 目录要递归加入，文件只需自身
        const depth = st.isDirectory() ? 'infinity' : 'empty';
        // --force：用户主动点了「加入」，就尊重这个意图，不受忽略规则阻挡
        await svn(['add', '--force', '--depth', depth, abs], wc);

        // 递归加入目录时，svn 可能把 .DS_Store 一起排进版本库
        // （取决于用户自己的 global-ignores 配置）。这里按设置把它们退回来：
        // revert 只取消"待提交"标记，磁盘上的文件不动。
        let skippedNoise = 0;
        if (settings.ignoreDsStore && st.isDirectory()) {
          const after = await svn(['status', '--xml', abs], wc).catch(() => '');
          const noise = parseStatus(after)
            .filter((e) => e.wcItem === 'added' && isNoiseFile(path.basename(e.rel)))
            .map((e) => (path.isAbsolute(e.rel) ? e.rel : path.join(wc, e.rel)));
          skippedNoise = noise.length;
          if (noise.length) await svn(['revert', ...noise], wc).catch(() => '');
        }
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { ok: true, skippedNoise });
      }

      if (p === '/api/ignore' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const rel = String(body.file || '');
        if (!rel) throw new Error('缺少文件路径');
        const abs = path.join(wc, rel);
        if (!abs.startsWith(wc + path.sep)) throw new Error('非法文件路径');

        const parent = path.dirname(abs);
        const name = path.basename(abs);
        const current = await svn(['propget', 'svn:ignore', parent], wc).catch(() => '');
        const lines = current.split('\n').map((s) => s.trim()).filter(Boolean);
        if (lines.includes(name)) {
          return json(res, 200, { ok: true, already: true });
        }
        lines.push(name);
        await svn(['propset', 'svn:ignore', lines.join('\n'), parent], wc);
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { ok: true, patterns: lines });
      }

      if (p === '/api/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const rel = String(body.file || '');
        if (!rel) throw new Error('缺少文件路径');
        const abs = path.join(wc, rel);
        if (!abs.startsWith(wc + path.sep)) throw new Error('非法文件路径');

        // 删除是破坏性操作，先快照（可恢复）
        const snap = await snapshot(wc, [rel]);

        // 未纳入版本控制的文件没有 svn 记录，直接删本地
        const xml = await svn(['status', '--xml', abs]).catch(() => '');
        const isUnversioned = /item="unversioned"/.test(xml);
        if (isUnversioned) {
          await fsp.rm(abs, { recursive: true, force: true });
        } else {
          await svn(['delete', '--force', abs], wc);
        }
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { ok: true, snapshot: snap, unversioned: isUnversioned });
      }

      if (p === '/api/rename' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const rel = String(body.file || '');
        const rawNew = String(body.newName || '').trim();
        if (!rel) throw new Error('缺少文件路径');
        if (!rawNew) throw new Error('新名字不能为空');
        if (rawNew.includes('/') || rawNew.includes('\\')) throw new Error('新名字里不能带路径分隔符');

        const abs = path.join(wc, rel);
        if (!abs.startsWith(wc + path.sep)) throw new Error('非法文件路径');
        const dstAbs = path.join(path.dirname(abs), rawNew);
        if (dstAbs === abs) return json(res, 200, { ok: true, same: true });
        if (fs.existsSync(dstAbs)) throw new Error('同一目录下已经有叫这个名字的文件了');

        const xml = await svn(['status', '--xml', abs]).catch(() => '');
        const isUnversioned = /item="unversioned"/.test(xml);

        if (isUnversioned) {
          await fsp.rename(abs, dstAbs);
        } else {
          // svn move 保留历史（状态会显示为 A(copied) + D）
          await svn(['move', abs, dstAbs], wc);
        }
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { ok: true, newPath: path.relative(wc, dstAbs), unversioned: isUnversioned });
      }

      // 检测并修复「访达里改名」：missing + 未纳入 → svn move（保留历史）。
      // 服务端重新验一次配对，绝不信任前端传来的 confidence，防止把无关文件硬凑成改名。
      if (p === '/api/rename-repair' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        const from = relNormPath(String(body.from || ''));
        const to = relNormPath(String(body.to || ''));
        if (!from || !to) throw new Error('缺少旧路径或新路径');
        if (from === to) throw new Error('旧路径和新路径不能相同');
        const fromAbs = path.join(wc, from);
        const toAbs = path.join(wc, to);
        if (!fromAbs.startsWith(wc + path.sep) || !toAbs.startsWith(wc + path.sep)) {
          throw new Error('非法文件路径');
        }
        if (fs.existsSync(fromAbs)) throw new Error('旧路径还在磁盘上，不是「本地已删除」状态');
        if (!fs.existsSync(toAbs)) throw new Error('新路径不存在');

        // 重新读一次本地状态并重新检测：配对必须由服务端判定
        const fresh = await buildStatus(wc, { force: true });
        const candidates = fresh.renameCandidates || [];
        const pair = candidates.find((c) => c.from === from && c.to === to);
        if (!pair || pair.confidence < MIN_RENAME_CONFIDENCE) {
          throw new Error('这两个路径看起来不是同一次改名，已取消修复');
        }

        // 破坏性元数据操作前留快照；快照失败不影响修复本身
        await snapshot(wc, [to]).catch(() => null);

        // 把新树移回旧路径，再用 svn move 挪回新路径。
        // 直接 svn move 会因目标未纳入而报 E155010；这样一步既保留历史，
        // 又完整保留用户在改名后做的内容修改。
        await fsp.mkdir(path.dirname(fromAbs), { recursive: true });
        await fsp.rename(toAbs, fromAbs);
        try {
          await svn(['move', fromAbs, toAbs], wc);
        } catch (e) {
          // 回滚：尽量把文件放回新路径，别让用户丢内容
          if (!fs.existsSync(toAbs) && fs.existsSync(fromAbs)) {
            await fsp.rename(fromAbs, toAbs).catch(() => {});
          }
          throw e;
        }
        statusCache.delete(wc);
        remoteCache.delete(wc);
        return json(res, 200, { ok: true, from, to, confidence: pair.confidence });
      }

      if (p === '/api/cleanup' && req.method === 'POST') {
        const body = await readBody(req);
        const wc = assertWC(body.path);
        await svn(['cleanup', wc]);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: '未知接口' });
    }

    return serveStatic(req, res, p);
  } catch (err) {
    return json(res, 500, { error: err.message || '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  // 启动器靠这一行拿到真实端口（PORT=0 时由系统分配）
  console.log(`LISTENING ${actualPort}`);
  Promise.all([loadDiskCache(), loadSettings()]).then(() => {
    console.log(`FastSVN 已启动：http://${HOST}:${actualPort}`);
    console.log(`svn 引擎：${SVN ? `${SVN}${SVN_EMBEDDED ? '（内嵌）' : ''}` : '未找到'}`);
    console.log(`状态缓存：${Object.keys(diskCache).length} 个工作副本`);
    console.log(`设置：ignoreDsStore=${settings.ignoreDsStore}`);
  });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
