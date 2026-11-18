import type {
  AppSettings,
  CheckoutJob,
  ConflictPayload,
  DiffPayload,
  FilePreview,
  LocalDirPayload,
  LogEntry,
  RepoFilePreview,
  RepoInfoPayload,
  RepoListPayload,
  StatusPayload,
  UpdateResult,
  WcItem,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text.slice(0, 200) || `请求失败（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const errField =
      data && typeof data === 'object' && 'error' in data ? (data as { error: unknown }).error : null;
    const message = errField ? String(errField) : `请求失败（HTTP ${res.status}）`;
    throw new Error(decodePercent(message));
  }
  return data as T;
}

const get = <T,>(url: string, headers?: Record<string, string>) =>
  request<T>(url, headers ? { headers } : undefined);

/** 需要登录的仓库：账号走请求头，不放进 URL */
export interface SvnCreds {
  username: string;
  password: string;
}

function credHeaders(creds?: SvnCreds | null): Record<string, string> | undefined {
  if (!creds || !creds.username) return undefined;
  // Fetch header values are ByteString-only; Unicode credentials throw TypeError.
  // Base64 the UTF-8 JSON so the custom header is ASCII-safe and never enters the URL.
  const bytes = new TextEncoder().encode(JSON.stringify({
    username: creds.username,
    password: creds.password ?? '',
  }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { 'x-svn-auth': btoa(binary) };
}
const post = <T,>(url: string, body?: unknown) =>
  request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/** svn 报错里的仓库地址是百分号编码的，展示前还原成中文 */
export function decodePercent(text: string | null | undefined): string {
  if (text == null) return '';
  return String(text).replace(/https?:\/\/[^\s'"，。；、)）\]]+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

/** svn commit 的实时事件：排队 → 上传 → 完成 / 失败 */
export type CommitStreamEvent =
  | { type: 'start'; total: number; files: string[] }
  | { type: 'queued'; done: number; total: number; path: string; action: string }
  | { type: 'phase'; phase: 'upload'; message: string }
  | { type: 'progress'; phase: 'upload'; done: number; total: number }
  | { type: 'done'; revision: number };

export const api = {
  health: () =>
    get<{
      ok: boolean;
      svn: string | null;
      /** svn 是不是 app 自带的 */
      svnEmbedded?: boolean;
      svnVersion?: string;
      bundled?: boolean;
      version?: string;
    }>('/api/health'),

  listWorkingCopies: () => get<{ paths: string[]; items: WcItem[] }>('/api/working-copies'),
  addWorkingCopy: (path: string) =>
    post<{ paths: string[]; items: WcItem[] }>('/api/working-copies', { path }),
  removeWorkingCopy: (path: string) =>
    request<{ paths: string[]; items: WcItem[] }>('/api/working-copies', {
      method: 'DELETE',
      body: JSON.stringify({ path }),
      headers: { 'Content-Type': 'application/json' },
    }),
  /** 设置显示别名；传空字符串表示恢复成目录名 */
  setWorkingCopyAlias: (path: string, alias: string) =>
    post<{ paths: string[]; items: WcItem[] }>('/api/working-copies/alias', { path, alias }),

  // ---- 设置 ----
  settings: () => get<AppSettings>('/api/settings'),
  saveSettings: (patch: Partial<AppSettings>) => post<AppSettings>('/api/settings', patch),

  status: (
    path: string,
    opts: { force?: boolean; remote?: boolean; forceRemote?: boolean } = {}
  ) => {
    // 默认不查远端：svn status -u 要遍历服务器目录，在远程仓库上是秒级开销。
    // 只有明确要看「待更新」时才传 remote: true。
    const qs = new URLSearchParams({ path, remote: opts.remote ? '1' : '0' });
    if (opts.force) qs.set('force', '1');
    if (opts.forceRemote) qs.set('forceRemote', '1');
    return get<StatusPayload>(`/api/status?${qs.toString()}`);
  },

  /** context='full'：连未变更的行一起返回（差异窗口「展开」用） */
  diff: (path: string, file: string, kind: string, context?: 'full') =>
    get<DiffPayload>(
      `/api/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}&kind=${encodeURIComponent(kind)}${
        context ? `&context=${context}` : ''
      }`
    ),

  commit: (path: string, files: string[], message: string) =>
    post<{ revision?: number; output?: string }>('/api/commit', { path, files, message }),

  /**
   * 提交并接收实时进度（SSE）。
   * 不能用 post()：那个会先把整个响应读完，进度就没了。
   */
  commitStream: async (
    path: string,
    files: string[],
    message: string,
    onEvent: (event: CommitStreamEvent) => void
  ): Promise<{ revision: number }> => {
    const res = await fetch('/api/commit/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, files, message }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const data = (await res.json()) as { error?: string };
        detail = data?.error ? String(data.error) : '';
      } catch {
        /* 非 JSON 错误体：交给下面的兜底文案 */
      }
      throw new Error(decodePercent(detail || `提交请求失败（HTTP ${res.status}）`));
    }
    if (!res.body) throw new Error('当前环境不支持流式提交');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let revision: number | null = null;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === 'error') {
            const err = new Error(decodePercent(String(payload.message ?? '提交失败')));
            // 服务器/钩子的原始报错单独带上：结论可能被归纳过，排查时要看原文
            if (typeof payload.detail === 'string' && payload.detail) {
              (err as Error & { detail?: string }).detail = decodePercent(payload.detail);
            }
            throw err;
          }
          if (event === 'done') {
            revision = Number(payload.revision ?? 0) || 0;
            onEvent({ type: 'done', revision });
            continue;
          }
          onEvent({ ...(payload as Omit<CommitStreamEvent, 'type'>), type: event } as CommitStreamEvent);
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (revision === null) {
      throw new Error('提交连接中断了，请刷新后确认服务器上是否已经有这次提交');
    }
    return { revision };
  },

  /** 不带 file：更新整个工作副本；带 file：只更新这个文件/子目录 */
  update: (path: string, file?: string) => post<UpdateResult>('/api/update', { path, file }),
  revert: (path: string, files: string[]) => post<{ snapshot?: string }>('/api/revert', { path, files }),
  cleanup: (path: string) => post<unknown>('/api/cleanup', { path }),

  /** file：只看某个文件/子目录的历史。verbose=1 才会带上"这条改了哪些文件" */
  log: (path: string, limit = 50, file?: string) =>
    get<{ entries: LogEntry[] }>(
      `/api/log?path=${encodeURIComponent(path)}&limit=${limit}&verbose=1${
        file ? `&file=${encodeURIComponent(file)}` : ''
      }`
    ),

  /** 某个历史版本里某个文件改了什么 */
  logDiff: (path: string, rev: number, target: string) =>
    get<DiffPayload>(
      `/api/log/diff?path=${encodeURIComponent(path)}&rev=${rev}&target=${encodeURIComponent(target)}`
    ),

  conflict: (path: string, file: string) =>
    get<ConflictPayload>(`/api/conflict?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`),

  resolve: (path: string, file: string, accept: 'mine-full' | 'theirs-full' | 'working') =>
    post<unknown>('/api/resolve', { path, file, accept }),

  add: (path: string, file: string) =>
    post<{ skippedNoise?: number }>('/api/add', { path, file }),
  ignore: (path: string, file: string) => post<unknown>('/api/ignore', { path, file }),
  remove: (path: string, file: string) => post<unknown>('/api/delete', { path, file }),
  rename: (path: string, file: string, newName: string) =>
    post<{ unversioned?: boolean }>('/api/rename', { path, file, newName }),
  /** 确认修复检测到的改名：missing + 未纳入 → svn move（保留历史） */
  renameRepair: (path: string, from: string, to: string) =>
    post<{ ok: boolean; from: string; to: string; confidence: number }>('/api/rename-repair', { path, from, to }),

  /** 本地目录树里新建子目录（父目录在版本控制下会自动 svn add） */
  mkdir: (path: string, dir: string, name: string) =>
    post<{ ok: boolean; added: boolean; rel: string }>('/api/mkdir', { path, dir, name }),

  // ---- 本地目录浏览 ----
  ls: (path: string, dir = '') =>
    get<LocalDirPayload>(`/api/ls?path=${encodeURIComponent(path)}&dir=${encodeURIComponent(dir)}`),

  readFile: (path: string, file: string) =>
    get<FilePreview>(`/api/file?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`),

  // ---- 远程仓库浏览 ----
  repoInfo: (url: string, creds?: SvnCreds | null) =>
    get<RepoInfoPayload>(`/api/repo/info?url=${encodeURIComponent(url)}`, credHeaders(creds)),

  /** 用系统默认程序打开文件 */
  openFile: (path: string, file: string) => post<{ ok: boolean }>('/api/open', { path, file }),

  /** 在访达里打开目录 / 定位文件 */
  reveal: (path: string) => post<{ ok: boolean; kind: 'dir' | 'file' }>('/api/reveal', { path }),

  /** 读仓库里的文件内容，不需要先检出 */
  repoCat: (url: string, creds?: SvnCreds | null) =>
    get<RepoFilePreview>(`/api/repo/cat?url=${encodeURIComponent(url)}`, credHeaders(creds)),

  repoList: (url: string, dirsOnly = false, creds?: SvnCreds | null) =>
    get<RepoListPayload>(
      `/api/repo/list?url=${encodeURIComponent(url)}${dirsOnly ? '&dirsOnly=1' : ''}`,
      credHeaders(creds)
    ),

  // ---- 检出 ----
  startCheckout: (
    url: string,
    path: string,
    mode: 'checkout' | 'export' = 'checkout',
    creds?: SvnCreds | null
  ) =>
    request<CheckoutJob>('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({ url, path, mode }),
      headers: credHeaders(creds) ?? {},
    }),
  checkoutStatus: (id: string) => get<CheckoutJob>(`/api/checkout?id=${encodeURIComponent(id)}`),
  cancelCheckout: (id: string) => post<CheckoutJob>('/api/checkout/cancel', { id }),
};
