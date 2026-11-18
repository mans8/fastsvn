'use strict';

// 性能基线对比：逐文件 svn diff  vs  一次性 svn diff
// 用法：node scripts/bench.js [文件数]

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SVN = '/opt/homebrew/bin/svn';
const SVNADMIN = '/opt/homebrew/bin/svnadmin';
const ENV = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
const N = Number(process.argv[2] || 800);

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, env: ENV, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function parseUnifiedDiff(text) {
  let added = 0, deleted = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  return { added, deleted };
}

function parseMultiFileDiff(text) {
  const files = new Map();
  let current = null, buf = [];
  const flush = () => {
    if (current) files.set(current, parseUnifiedDiff(buf.join('\n')));
  };
  for (const line of text.split('\n')) {
    const m = /^Index: (.+)$/.exec(line);
    if (m) { flush(); current = m[1]; buf = []; continue; }
    if (current) buf.push(line);
  }
  flush();
  return files;
}

async function runLimited(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

async function main() {
  const root = path.join(os.tmpdir(), 'fastsvn-bench');
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');

  console.log(`准备仓库：${N} 个文件…`);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  await run(SVNADMIN, ['create', repo]);
  await run(SVN, ['mkdir', '-m', 'init', `file://${repo}/trunk`]);

  // 先在仓库里建好目录结构（一次 mkdir 多个 URL），再检出，避免本地预建造成冲突
  const dirs = 20;
  const dirUrls = Array.from({ length: dirs }, (_, i) => `file://${repo}/trunk/pkg${i}`);
  await run(SVN, ['mkdir', '-m', 'dirs', ...dirUrls]);
  await run(SVN, ['checkout', '-q', `file://${repo}/trunk`, wc]);

  const per = Math.ceil(N / dirs);
  for (let d = 0; d < dirs; d++) {
    for (let i = 0; i < per; i++) {
      const body = Array.from({ length: 40 }, (_, k) => `// pkg${d} file${i} line${k}`).join('\n') + '\n';
      await fsp.writeFile(path.join(wc, `pkg${d}`, `f${i}.js`), body, 'utf8');
    }
  }
  await run(SVN, ['add', '-q', '--force', '.'], wc);
  await run(SVN, ['commit', '-q', '-m', 'bulk import'], wc);

  // 改动 60 个文件（每个目录均匀分布，索引不越界）
  const changed = [];
  for (let i = 0; i < 60; i++) {
    const d = i % dirs;
    const idx = Math.floor(i / dirs);
    const f = path.join(wc, `pkg${d}`, `f${idx}.js`);
    await fsp.appendFile(f, `// changed ${i}\nexport const v${i} = ${i};\n`, 'utf8');
    changed.push(f);
  }

  console.log(`仓库就绪：${N} 个文件，其中 ${changed.length} 个被改动\n`);

  // 基线 0：仅 svn status
  let t = Date.now();
  const statusXml = await run(SVN, ['status', '--xml', wc]);
  const statusMs = Date.now() - t;
  const entries = (statusXml.match(/<entry\s/g) || []).length;
  console.log(`svn status --xml            ${String(statusMs).padStart(6)} ms   (${entries} 条 entry)`);

  // 策略 A：逐文件 diff（并发 4）—— 旧实现
  t = Date.now();
  await runLimited(changed, 4, async (f) => {
    await run(SVN, ['diff', f]);
  });
  const perFileMs = Date.now() - t;
  console.log(`逐文件 svn diff（并发 4）   ${String(perFileMs).padStart(6)} ms   (${changed.length} 次进程)`);

  // 策略 B：一次性 diff —— 新实现
  t = Date.now();
  const allDiff = await run(SVN, ['diff', wc]);
  const multi = parseMultiFileDiff(allDiff);
  const onceMs = Date.now() - t;
  console.log(`一次性 svn diff + 解析      ${String(onceMs).padStart(6)} ms   (1 次进程，${multi.size} 个文件)`);

  const speedup = (perFileMs / Math.max(onceMs, 1)).toFixed(1);
  console.log(`\n提速：${speedup}×（${perFileMs} ms → ${onceMs} ms）`);
  console.log(`旧实现总耗时 ≈ ${statusMs + perFileMs} ms`);
  console.log(`新实现总耗时 ≈ ${statusMs + onceMs} ms`);

  if (process.env.KEEP === '1') {
    console.log(`\n仓库已保留：${wc}`);
    console.log(`可用于应用内测：添加工作副本 ${wc}`);
  } else {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('BENCH_FAILED:', e.message);
  process.exit(1);
});
