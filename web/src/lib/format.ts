/** 相对时间：刚刚 / 3 分钟前 / 昨天 14:20 / 2026-03-04 */
export function relativeTime(input: string | number | null | undefined): string {
  if (!input) return '';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';

  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clockTime(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 1) return `${Math.round(ms)} 毫秒`;
  if (sec < 60) return `${sec.toFixed(1)} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${Math.round(sec % 60)} 秒`;
}

/** 取路径最后一段作为项目名 */
export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** 把 /Users/you 缩成 ~ */
export function tildify(p: string, home?: string): string {
  const h = home || '/Users/';
  if (p.startsWith('/Users/')) {
    const rest = p.slice(6);
    const idx = rest.indexOf('/');
    return idx === -1 ? '~' : `~${rest.slice(idx)}`;
  }
  return h ? p.replace(h, '~') : p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}

export function pluralFiles(n: number): string {
  return `${n} 个文件`;
}

/** 字节数格式化，和看板/仪表盘的写法一致 */
export function formatSize(n: number): string {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 仓库浏览用的紧凑时间：11-10 19:39（跨年才带年份） */
export function shortDateTime(input: string | number | null | undefined): string {
  if (!input) return '—';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  // 始终带年份：仓库里的提交可能跨年，省掉年份会让人把 2025 的提交读成今年
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 具体到秒的完整时间：2026-11-11 14:23:05（提交历史用，避免"昨天"这种模糊说法） */
export function fullDateTime(input: string | number | null | undefined): string {
  if (!input) return '—';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

/**
 * svn 输出的 URL 是百分号编码的（`svn info` 给的是 %E4%B8%AD%E6%96%87…），
 * 直接显示给用户就是一串乱码。展示前解码，请求前再规范化回去。
 */
export function prettyUrl(u: string): string {
  try {
    // 用 decodeURI 而不是 decodeURIComponent：后者会把 %2F 解成 /，改变路径含义
    return decodeURI(u);
  } catch {
    return u;
  }
}

/** 把用户输入/接口返回的地址统一成 svn 能认、且能和仓库根做前缀比较的形式 */
export function canonicalUrl(u: string): string {
  try {
    return encodeURI(decodeURI(u));
  } catch {
    return u;
  }
}
