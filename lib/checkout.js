'use strict';

/**
 * 检出（checkout）任务管理器
 *
 * 为什么不用一条命令直接给进度：
 *   svn 没有 --progress，且非 TTY 下不输出百分比。所以进度必须自己量：
 *   1) 先 `svn list -R --xml <url>` 拿条目数与总字节（一次轻量请求）
 *   2) checkout 时流式解析 stdout 的 `A    path` 行，得到已完成条目数
 *   3) 定时遍历目标目录（跳过 .svn）统计已落盘字节 → 进度与速率
 *
 * 这样得到的是"真实已接收量"，不是假动画。
 */

const { spawn, execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { svnEnv } = require('./svn-env');

// 云同步目录：同步进程会破坏 .svn/wc.db，是唯一能造成数据丢失的场景
const SYNC_DIR_PATTERNS = [
  /\/Library\/Mobile Documents\//i, // iCloud Drive
  /\/Library\/CloudStorage\//i, // iCloud 其他容器
  /\/Dropbox\//i,
  /\/Google Drive\//i,
  /\/OneDrive\//i,
  /\/坚果云\//,
  /\/Nutstore\//i,
  /\/百度网盘\//,
  /\/BaiduNetdisk\//i,
];

const URL_SCHEME = /^(https?|svn|svn\+ssh|file):\/\//i;

/** 用户习惯写 ~/Documents/x，展开成绝对路径再校验 */
function expandHome(input) {
  const p = String(input).trim();
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function humanSize(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 递归统计目录字节，跳过 .svn（元数据不是"下载内容"，算进去速率会虚高） */
async function dirBytes(root) {
  // 单个文件的下载（导出文件）直接把自身大小算进去，
  // 否则 readdir 一个文件路径会失败 → 速度恒为 0、完成提示变成「0 个文件、0 B」
  try {
    const st = await fsp.stat(root);
    if (st.isFile()) return st.size;
  } catch {
    return 0;
  }
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.svn') continue;
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(full);
          total += st.size;
        } catch {
          /* 正在写入或已删除，跳过 */
        }
      }
    }
  }
  return total;
}

function createCheckoutManager({ svnBin, onComplete }) {
  const jobs = new Map();

  /** 预统计：条目数 + 总字节。失败不阻塞检出，只是进度退化为"不确定" */
  function measureTotal(url, creds) {
    return new Promise((resolve) => {
      if (!svnBin) return resolve({ files: 0, bytes: 0, ok: false });
      const auth = creds && creds.username
        ? ['--username', creds.username, ...(creds.password ? ['--password', creds.password] : [])]
        : [];
      const child = spawn(svnBin, ['--non-interactive', 'list', '-R', '--xml', ...auth, url], {
        env: svnEnv(),
      });
      let out = '';
      let err = '';
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      // 大仓库列出全量可能很久；超过 20 秒就放弃预统计，检出照常进行
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({ files: 0, bytes: 0, ok: false });
      }, 20000);

      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        err += d;
      });
      child.on('error', () => finish({ files: 0, bytes: 0, ok: false }));
      child.on('close', (code) => {
        if (code !== 0) return finish({ files: 0, bytes: 0, ok: false, err });
        const entries = out.match(/<entry[\s\S]*?<\/entry>/g) || [];
        let files = 0;
        let dirs = 0;
        let bytes = 0;
        for (const e of entries) {
          const kind = /kind="(\w+)"/.exec(e);
          if (!kind) continue;
          if (kind[1] === 'dir') {
            dirs++;
            continue;
          }
          if (kind[1] !== 'file') continue;
          files++;
          const m = /<size>(\d+)<\/size>/.exec(e);
          if (m) bytes += Number(m[1]);
        }
        // checkout 输出的 `A` 行既含文件也含目录，所以进度分母要算上目录，
        // 否则会出现 "208/200" 这种超过 100% 的怪数
        finish({ files: files + dirs, fileCount: files, dirCount: dirs, bytes, ok: files > 0 });
      });
    });
  }

  /**
   * 启动一次传输。返回 job（不含内部字段）。
   * mode='checkout' 检出（生成工作副本）；mode='export' 下载（纯文件，不带 .svn）。
   */
  function start({ url, target, mode }) {
    const isExport = mode === 'export';
    if (typeof url !== 'string' || !URL_SCHEME.test(url.trim())) {
      throw new Error('仓库地址要以 http:// 、https:// 或 svn:// 开头');
    }
    const expanded = expandHome(target ?? '');
    if (!path.isAbsolute(expanded)) {
      throw new Error('本地文件夹要填绝对路径，比如 /Users/你/Documents/项目名');
    }
    const cleanUrl = url.trim();
    const cleanTarget = path.normalize(expanded);

    // 目标必须为空目录或不存在，否则 svn 会混入无关文件
    if (fs.existsSync(cleanTarget)) {
      let entries = [];
      try {
        entries = fs.readdirSync(cleanTarget);
      } catch {
        throw new Error('这个文件夹没有权限访问');
      }
      if (entries.length > 0) {
        throw new Error('这个文件夹里已经有内容了，换一个空文件夹');
      }
    }

    const warn = SYNC_DIR_PATTERNS.find((re) => re.test(cleanTarget))
      ? '这个位置在云同步文件夹里（iCloud / Dropbox 等）。同步进程可能破坏 SVN 的元数据，导致文件丢失。建议换到本地普通文件夹。'
      : null;

    const id = crypto.randomUUID();
    const job = {
      id,
      mode: isExport ? 'export' : 'checkout',
      url: cleanUrl,
      path: cleanTarget,
      phase: 'preparing', // preparing | downloading | done | failed | cancelled
      filesTotal: 0,
      filesDone: 0,
      fileCount: 0,
      dirCount: 0,
      avgSpeedBps: 0,
      bytesTotal: 0,
      bytesDone: 0,
      speedBps: 0,
      percent: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      warn,
      message: '正在读取仓库文件清单…',
      totalKnown: false,
      _child: null,
      _timer: null,
      _lastSample: null,
      _stderr: '',
    };
    jobs.set(id, job);
    void run(job);
    return job;
  }

  function publicView(job) {
    return {
      id: job.id,
      mode: job.mode,
      url: job.url,
      path: job.path,
      phase: job.phase,
      filesTotal: job.filesTotal,
      filesDone: job.filesDone,
      bytesTotal: job.bytesTotal,
      bytesDone: job.bytesDone,
      bytesDoneText: humanSize(job.bytesDone),
      bytesTotalText: humanSize(job.bytesTotal),
      speedBps: Math.round(job.speedBps),
      speedText: job.speedBps > 0 ? `${humanSize(job.speedBps)}/s` : '',
      avgSpeedBps: Math.round(job.avgSpeedBps || 0),
      avgSpeedText: job.avgSpeedBps > 0 ? `${humanSize(job.avgSpeedBps)}/s` : '',
      fileCount: job.fileCount || 0,
      dirCount: job.dirCount || 0,
      percent: job.percent,
      totalKnown: job.totalKnown,
      error: job.error,
      warn: job.warn,
      message: job.message,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    };
  }

  async function run(job) {
    try {
      const total = await measureTotal(job.url, job.creds);
      if (job.phase === 'cancelled') return;
      job.filesTotal = total.files;
      job.fileCount = total.fileCount || 0;
      job.dirCount = total.dirCount || 0;
      job.bytesTotal = total.bytes;
      job.totalKnown = total.ok;
      job.phase = 'downloading';
      job.message = total.ok
        ? `共 ${total.fileCount} 个文件、${humanSize(total.bytes)}`
        : '正在下载（仓库较大，进度按已接收量估算）';

      await new Promise((resolve) => {
        // export 加 --force：目标文件已存在时直接覆盖，否则用户选了个已有文件名会莫名失败
        const auth = job.creds && job.creds.username
          ? ['--username', job.creds.username, ...(job.creds.password ? ['--password', job.creds.password] : [])]
          : [];
        const args = job.mode === 'export'
          ? ['--non-interactive', 'export', '--force', ...auth, job.url, job.path]
          : ['--non-interactive', 'checkout', ...auth, job.url, job.path];
        const child = spawn(svnBin, args, {
          env: svnEnv(),
        });
        job._child = child;

        let lineBuf = '';
        child.stdout.on('data', (d) => {
          lineBuf += d.toString();
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() || '';
          for (const line of lines) {
            // 形如 "A    trunk/src/a.js"、"A  B  path"（带历史/外部）
            if (/^A/.test(line)) job.filesDone++;
          }
          recompute(job);
        });
        child.stderr.on('data', (d) => {
          job._stderr += d.toString();
          // svn 把传输进度写 stderr，做一次机会性解析（有就更好）
          const m = /Transmitting file data.*/i.test(job._stderr);
          if (m && job.phase === 'downloading') job.message = '正在传输文件内容…';
        });

        child.on('error', (err) => {
          job.error = err.message;
          resolve();
        });
        child.on('close', (code) => {
          job._exitCode = code;
          resolve();
        });

        // 采样循环：600ms 一次，算已落盘字节与速率
        job._timer = setInterval(async () => {
          const bytes = await dirBytes(job.path);
          const now = Date.now();
          const prev = job._lastSample;
          if (prev) {
            const dt = (now - prev.t) / 1000;
            if (dt > 0) {
              const inst = Math.max(0, (bytes - prev.bytes) / dt);
              // EMA 平滑，避免数字跳动
              job.speedBps = job.speedBps ? job.speedBps * 0.55 + inst * 0.45 : inst;
            }
          }
          job._lastSample = { t: now, bytes };
          job.bytesDone = bytes;
          recompute(job);
        }, 600);
      });

      clearInterval(job._timer);
      job._timer = null;
      job.bytesDone = await dirBytes(job.path);
      recompute(job);

      if (job.phase === 'cancelled') {
        job.message = job.mode === 'export'
          ? '已停止下载。已下载的部分保留在目标文件夹里。'
          : '已停止。文件夹保留，重新检出会接着下载。';
        return;
      }
      if (job._exitCode !== 0) {
        job.phase = 'failed';
        job.error =
          firstMeaningfulError(job._stderr) ||
          `${job.mode === 'export' ? '下载' : '检出'}失败（退出码 ${job._exitCode}）`;
        job.message = '';
        job.finishedAt = Date.now();
        return;
      }

      job.phase = 'done';
      job.percent = 1;
      job.finishedAt = Date.now();
      const secs = Math.max(0.001, (job.finishedAt - job.startedAt) / 1000);
      job.avgSpeedBps = job.bytesDone / secs;
      // 瞬时速率留最后有效值；没采到（本地仓库毫秒级完成）就用平均
      if (!job.speedBps) job.speedBps = 0;
      job.message = `${job.mode === 'export' ? '已下载' : '已检出'} ${job.fileCount || job.filesDone} 个文件、${humanSize(job.bytesDone)}，用时 ${formatDuration(secs)}`;
      if (typeof onComplete === 'function') {
        try {
          onComplete({ url: job.url, path: job.path, mode: job.mode, revision: parseRevision(job._stderr) });
        } catch {
          /* 加入项目列表失败不该影响检出结果 */
        }
      }
    } catch (e) {
      clearInterval(job._timer);
      job.phase = 'failed';
      job.error = e.message;
      job.finishedAt = Date.now();
    }
  }

  function recompute(job) {
    if (job.filesTotal > 0) {
      job.percent = Math.min(0.999, job.filesDone / job.filesTotal);
    } else if (job.bytesTotal > 0) {
      job.percent = Math.min(0.999, job.bytesDone / job.bytesTotal);
    } else {
      // 总量未知：用渐近曲线给个"还在动"的反馈，不谎报具体百分比
      job.percent = null;
    }
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) throw new Error('找不到这个检出任务');
    if (job.phase === 'done' || job.phase === 'failed') return publicView(job);
    job.phase = 'cancelled';
    job.message = '正在停止…';
    if (job._child) job._child.kill('SIGTERM');
    clearInterval(job._timer);
    job._timer = null;
    return publicView(job);
  }

  function status(id) {
    const job = jobs.get(id);
    if (!job) throw new Error('找不到这个检出任务');
    return publicView(job);
  }

  /** 清理已结束且超过 10 分钟的任务，避免 Map 无限增长 */
  function sweep() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > 10 * 60 * 1000) jobs.delete(id);
    }
  }

  return { start, status, cancel, sweep, _jobs: jobs };
}

function formatDuration(sec) {
  if (sec < 1) return `${Math.round(sec * 1000)} 毫秒`;
  if (sec < 60) return `${sec.toFixed(1)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m} 分 ${s} 秒`;
}

function parseRevision(stderr) {
  const m = /Checked out revision (\d+)/i.exec(stderr || '');
  return m ? Number(m[1]) : null;
}

/** 从 svn 的 stderr 里挑一行最有信息量的错误 */
function firstMeaningfulError(stderr) {
  const lines = String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const e = lines.filter((l) => /^svn: (E\d+)?/.test(l) || /^svn:/.test(l));
  return (e[e.length - 1] || lines[lines.length - 1]).replace(/^svn:\s*/, '');
}

module.exports = { createCheckoutManager, humanSize, dirBytes, SYNC_DIR_PATTERNS };
