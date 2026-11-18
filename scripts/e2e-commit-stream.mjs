#!/usr/bin/env node
// 流式提交回归：start → queued/progress → done；失败时给 error 事件。
// 用法：node scripts/e2e-commit-stream.mjs（自建私有仓库 + 冒充钥匙串助手，不需要外部服务）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const SERVER = new URL('../server.js', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsvn-commit-stream-'));
const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
let app;

async function startServer(helper, tag = 'a') {
  const home = path.join(tmp, `home-${tag}`);
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOME: home, PORT: '0', FASTSVN_HOME: path.join(home, 'app'), FASTSVN_KEYCHAIN_HELPER: helper },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`启动超时 ${out}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /LISTENING (\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (d) => (out += d));
  });
  return { child, port };
}

async function readStream(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        if (line.startsWith('data: ')) data += line.slice(6);
      }
      let payload = null;
      try {
        payload = JSON.parse(data);
      } catch {}
      return { event, payload };
    });
}

try {
  const repo = path.join(tmp, 'repo');
  const seed = path.join(tmp, 'seed');
  const wc = path.join(tmp, 'wc');
  const cfg = path.join(tmp, 'config');
  const pidFile = path.join(tmp, 'svnserve.pid');
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  execFileSync('svnadmin', ['create', repo]);
  fs.writeFileSync(path.join(repo, 'conf', 'svnserve.conf'), '[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = fastsvn-stream\n');
  fs.writeFileSync(path.join(repo, 'conf', 'passwd'), '[users]\nalice = secret密码\n');
  fs.writeFileSync(path.join(seed, 'readme.txt'), 'v1\n');
  execFileSync('svn', ['--non-interactive', 'import', seed, `file://${repo}`, '-m', 'seed']);
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  spawn('svnserve', ['-d', '--listen-host', '127.0.0.1', '--listen-port', String(port), '-r', tmp, '--pid-file', pidFile], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  const url = `svn://127.0.0.1:${port}/repo`;
  execFileSync('svn', ['--non-interactive', '--no-auth-cache', '--config-dir', cfg, '--username', 'alice', '--password', 'secret密码', 'checkout', url, wc], { stdio: 'ignore' });

  const wcUrl = execFileSync('svn', ['info', '--show-item', 'url', wc], { encoding: 'utf8' }).trim();
  const account = crypto.createHash('sha256').update(wcUrl.replace(/\/+$/, '')).digest('hex');
  const helper = path.join(tmp, 'helper');
  fs.writeFileSync(
    helper,
    `#!/usr/bin/env node\nif(process.argv[2]==="get"&&process.argv[3]===${JSON.stringify(account)}){process.stdout.write(JSON.stringify({username:"alice",password:"secret密码"}));}else{process.exit(1);}\n`
  );
  fs.chmodSync(helper, 0o755);

  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(wc, `f${i}.txt`), `change ${i}\n`);
  execFileSync('svn', ['add', ...Array.from({ length: 3 }, (_, i) => path.join(wc, `f${i + 1}.txt`))], { stdio: 'ignore' });

  const good = await startServer(helper, 'good');
  app = good.child;
  const res = await fetch(`http://127.0.0.1:${good.port}/api/commit/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wc, files: ['f1.txt', 'f2.txt', 'f3.txt'], message: '流式提交回归' }),
  });
  check('流式接口返回 SSE', (res.headers.get('content-type') || '').includes('text/event-stream'), res.headers.get('content-type'));
  const events = await readStream(res);
  const names = events.map((e) => e.event);
  check('先发 start（总数 3）', names[0] === 'start' && events[0].payload.total === 3, JSON.stringify(events[0]?.payload));
  check('有逐文件的排队事件', names.filter((n) => n === 'queued').length === 3, names.join(','));
  check('有上传进度事件', names.includes('progress'), names.join(','));
  const done = events.find((e) => e.event === 'done');
  check('结束事件带 revision', Boolean(done && done.payload.revision > 0), JSON.stringify(done?.payload));

  const remoteLog = execFileSync('svn', ['log', '-l', '1', '-q', '--non-interactive', '--config-dir', cfg, '--username', 'alice', '--password', 'secret密码', url], { encoding: 'utf8' }).trim();
  check('提交真的写进仓库', /r2/.test(remoteLog), 'r2');
  app.kill('SIGTERM');
  app = null;

  // 失败路径：没有凭据
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(wc, `f${i}.txt`), `again ${i}\n`);
  const bad = await startServer('/nonexistent-helper', 'bad');
  app = bad.child;
  const badRes = await fetch(`http://127.0.0.1:${bad.port}/api/commit/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: wc, files: ['f1.txt'], message: 'x' }),
  });
  const badEvents = await readStream(badRes);
  const err = badEvents.find((e) => e.event === 'error');
  check('失败时推 error 事件（含登录指引）', Boolean(err && /提交需要仓库账号/.test(err.payload?.message ?? '')), JSON.stringify(err?.payload));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  try {
    const pid = Number(fs.readFileSync(path.join(tmp, 'svnserve.pid'), 'utf8').trim());
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed} / ${results.length} 通过`);
if (failed) process.exitCode = 1;
