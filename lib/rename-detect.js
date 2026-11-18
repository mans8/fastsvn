// 改名检测：把 svn 眼里的 missing + unversioned 配对成"疑似改名"。
// 只读，不改磁盘；置信度来自「名字相似度」和「BASE 内容比对」两条独立证据。
// 设计取舍：宁可漏报，也不能把两个无关文件硬凑成改名 —— 修复是不可逆的元数据写操作。

const MAX_NAME_SIGNALS = 400;
const MAX_CONTENT_FILES = 12;
const MAX_CONTENT_BYTES = 512 * 1024;

// 检测与修复必须共用同一条门槛，避免两端判定漂移
const MIN_RENAME_CONFIDENCE = 0.6;

function relNorm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isParentOf(parent, child) {
  return child.startsWith(parent + '/');
}

/** 编辑距离相似度 0..1。中文按字符算，无需分词。 */
function nameSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) / max < 0.45) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return Math.max(0, 1 - prev[b.length] / max);
}

/**
 * 复制副本的典型命名：xxx 2 / xxx (1) / xxx 副本 / xxx copy。
 * 这类"删了原件、留了副本"不是改名，README 里明确要求区分。
 */
function looksLikeCopyName(fromName, toName) {
  if (!toName.startsWith(fromName)) return false;
  const rest = toName.slice(fromName.length).trim();
  if (!rest) return false;
  return /^(\(\d+\)|#\d+|\d+|副本|备份|copy|Copy|COPY|-\s*副本|-\s*copy)/i.test(rest);
}

async function textOf(buf) {
  return buf.toString('utf8');
}

/**
 * 比对旧路径 BASE 内容与新路径当前内容。
 * 目录：比子项名字集合 + 共有文件内容；文件：直接比字节。
 * 返回 0..1。
 */
async function contentScore(wcPath, from, to, fromIsDir, toIsDir, fs, svn) {
  const absTo = wcPath + '/' + to;
  try {
    if (fromIsDir && toIsDir) {
      const base = await svn(['list', '-r', 'BASE', wcPath + '/' + from]);
      const baseNames = base.split('\n').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
      const newNames = (await fs.promises.readdir(absTo)).filter((n) => !n.startsWith('.DS_Store'));
      if (!baseNames.length || !newNames.length) return 0;
      const setA = new Set(baseNames);
      const setB = new Set(newNames);
      let inter = 0;
      for (const n of setA) if (setB.has(n)) inter++;
      // 用「旧子项是否都还在」而不是对称 Jaccard：改名后往新目录里加了文件是正常的
      const containment = inter / setA.size;

      const common = [...setA].filter((n) => setB.has(n)).slice(0, MAX_CONTENT_FILES);
      let equal = 0;
      let compared = 0;
      for (const name of common) {
        try {
          const st = await fs.promises.stat(absTo + '/' + name);
          if (!st.isFile() || st.size > MAX_CONTENT_BYTES) continue;
          const [oldText, newBuf] = await Promise.all([
            svn(['cat', '-r', 'BASE', wcPath + '/' + from + '/' + name]),
            fs.promises.readFile(absTo + '/' + name),
          ]);
          compared++;
          if ((await textOf(newBuf)) === oldText) equal++;
        } catch { /* 单个子项读不出来就跳过 */ }
      }
      const equalRatio = compared ? equal / compared : 0;
      return compared ? containment * 0.75 + equalRatio * 0.25 : containment;
    }
    if (!fromIsDir && !toIsDir) {
      const st = await fs.promises.stat(absTo);
      if (!st.isFile() || st.size > MAX_CONTENT_BYTES) return 0;
      const [oldText, newBuf] = await Promise.all([svn(['cat', '-r', 'BASE', wcPath + '/' + from]), fs.promises.readFile(absTo)]);
      const newText = await textOf(newBuf);
      if (newText === oldText) return 1;
      // 改名后又编辑过的文件：按行重合度给分，不能因为几行改动就漏掉
      const oldLines = new Set(oldText.split('\n'));
      const newLines = new Set(newText.split('\n'));
      let common = 0;
      for (const l of oldLines) if (newLines.has(l)) common++;
      const union = oldLines.size + newLines.size - common;
      return union ? common / union : 0;
    }
  } catch { /* 读 BASE 失败：不算内容证据 */ }
  return 0;
}

/**
 * 检测改名候选。
 * @param {{wcPath:string, local:Array, fs:object, svn:Function}} opts
 *   local 至少含 { path, kind }；kind 为 'missing' / 'unversioned'。
 * @returns {Promise<Array<{from:string,to:string,confidence:number,reason:string,fromIsDir:boolean,toIsDir:boolean}>>}
 */
async function detectRenameCandidates({ wcPath, local, fs, svn }) {
  const missing = (local || []).filter((f) => f?.kind === 'missing' && f.path);
  const unversioned = (local || []).filter((f) => f?.kind === 'unversioned' && f.path);
  if (!missing.length || !unversioned.length) return [];

  // 只看树根：A 及 A/x.sql 都 missing 时，只拿 A 去配对，避免父子重复候选
  const missingRoots = missing
    .map((f) => ({ ...f, path: relNorm(f.path) }))
    .filter((f, i, arr) => !arr.some((g) => g !== f && isParentOf(g.path, f.path)));
  const unversionedRoots = unversioned
    .map((f) => ({ ...f, path: relNorm(f.path) }))
    .filter((f, i, arr) => !arr.some((g) => g !== f && isParentOf(g.path, f.path)));

  const cands = [];
  let work = 0;
  for (const from of missingRoots) {
    for (const to of unversionedRoots) {
      if (work++ >= MAX_NAME_SIGNALS) break;
      const fromName = from.path.split('/').pop();
      const toName = to.path.split('/').pop();
      const nameScore = nameSimilarity(fromName, toName);
      // 副本形态（xxx 2 / xxx 副本）即使名字很像也不是改名
      if (looksLikeCopyName(fromName, toName)) continue;
      // 名字完全不像时只有内容证据能成立，先算内容，避免光靠名字误配
      let fromIsDir = Boolean(from.isDir);
      let toIsDir = false;
      try {
        fromIsDir = fromIsDir || (await fs.promises.stat(wcPath + '/' + from.path)).isDirectory();
      } catch { /* missing 本来就不在磁盘上 */ }
      try {
        toIsDir = (await fs.promises.stat(wcPath + '/' + to.path)).isDirectory();
      } catch { continue; }
      if (fromIsDir !== toIsDir) continue;

      // 名字像 + 内容一致才算高置信；只有名字像（比如两个不相干文件）不足以允许修复
      const content = await contentScore(wcPath, from.path, to.path, fromIsDir, toIsDir, fs, svn);
      const nameOK = nameScore >= 0.75;
      const contentOK = content >= 0.6;
      if (!contentOK) continue;
      const confidence = nameOK ? Math.min(1, nameScore * 0.6 + content * 0.4) : content;
      if (confidence < MIN_RENAME_CONFIDENCE) continue;
      cands.push({
        from: from.path,
        to: to.path,
        confidence: Math.round(confidence * 100) / 100,
        reason: nameOK ? '名称相似且内容一致' : '内容一致',
        fromIsDir,
        toIsDir,
      });
    }
  }
  cands.sort((a, b) => b.confidence - a.confidence);
  return cands.slice(0, 20);
}

module.exports = { detectRenameCandidates, MIN_RENAME_CONFIDENCE, relNorm };
