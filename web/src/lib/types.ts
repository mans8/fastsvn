/* FastSVN 前后端共享的数据形状（与 server.js 的返回字段一一对应） */

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'replaced'
  | 'conflicted'
  | 'unversioned'
  | 'missing'
  | 'ignored'
  | 'external'
  | 'normal';

export interface Risk {
  code: string;
  text: string;
}

export interface FileChange {
  path: string;
  name: string;
  dir: string;
  kind: ChangeKind;
  letter: string;
  label: string;
  added: number;
  deleted: number;
  binary: boolean;
  size: number;
  sizeText: string | null;
  risk: Risk | null;
  mtime: number | null;
  copied?: boolean;
  remote?: boolean;
  /** 远端有更新，同时本地也改过 —— 直接更新会冲突 */
  localChanged?: boolean;
  /** 超过 10 MB：不数行、不比差异 */
  big?: boolean;
  /** 后端跳过了差异读取（大文件 / 二进制），界面据此给出说明而不是空白 */
  diffSkipped?: boolean;
  /** 这个「本地已删除」的路径原本是目录（提交会连同里面的内容一起删） */
  isDir?: boolean;
  /** svn move 的配对信息：旧路径 → 新路径（界面用来交叉说明） */
  movedFrom?: string | null;
  movedTo?: string | null;
  /** 目录里的文件数：目录行只占一条 status，展开后能确认文件还在 */
  childCount?: number;
  /** 目录下文件的相对路径（相对这个目录，最多 200 条） */
  children?: string[];
  childrenTruncated?: boolean;
}

/** svn update 的一行结果：A 新增 / U 更新 / G 合并 / C 冲突 / D 删除 / E 已存在 */
export interface UpdatedEntry {
  action: string;
  path: string;
  name: string;
}

export interface UpdateResult {
  revision?: number;
  conflicts?: number;
  updated?: UpdatedEntry[];
}

export interface WcInfo {
  revision: number;
  branch?: string;
  url?: string;
}

/** 「我的项目」里的一项；isWc=false 表示找不到 .svn，界面把它灰掉 */
export interface WcItem {
  path: string;
  /** 用户起的显示名；为空时界面用目录名 */
  alias?: string | null;
  isWc: boolean;
  exists: boolean;
}

/** 工作副本当前指向的仓库（修改仓库地址对话框打开时预填用） */
export interface WcRepoInfo {
  path: string;
  url: string;
  root: string;
  uuid: string;
  revision: number;
  branch?: string;
}

/** relocate 的判定阶段：预检没通过时工作副本还没动过 */
export type RelocateStage = 'precheck' | 'relocate' | 'verify';

/**
 * 修改仓库地址的结果。
 * ok=false 且 currentUrl===newUrl 表示"地址已经改过去，但校验没通过"（半成功）。
 */
export interface RelocateResult {
  ok: boolean;
  stage: RelocateStage;
  oldUrl: string;
  newUrl: string;
  oldRoot?: string;
  root?: string;
  revision?: number;
  currentUrl?: string;
  error?: string;
  /** 预检失败是因为新地址要账号密码：界面就地展开登录 */
  needsAuth?: boolean;
}

export interface AppSettings {
  /** 忽略 macOS 生成的 .DS_Store：不显示、也不参与提交 */
  ignoreDsStore: boolean;
}

/** 后端检测出的「访达里改名」候选（missing + 未纳入配对），只读提示 */
export interface RenameCandidate {
  /** 旧路径（本地已删除，仍受版控） */
  from: string;
  /** 新路径（未纳入版本管理，磁盘上存在） */
  to: string;
  /** 0..1，越高越像同一次改名 */
  confidence: number;
  reason: string;
  fromIsDir: boolean;
  toIsDir: boolean;
}

export interface StatusPayload {
  info: WcInfo;
  local: FileChange[];
  remote: FileChange[];
  renameCandidates?: RenameCandidate[];
  tookMs: number;
  cached?: boolean;
  stale?: boolean;
  /** 远端列表来自缓存（未重新询问服务器） */
  remoteCached?: boolean;
  /** 远端列表的获取时间戳 */
  remoteFetchedAt?: number | null;
}

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'hunk';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffPayload {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  lines: DiffLine[];
  message?: string;
  /** 后端因为文件过大 / 非文本而没有读取差异 */
  skipped?: boolean;
  size?: number;
  sizeText?: string;
}

export interface LogFile {
  action: string;
  path: string;
  /** 仓库绝对路径（/trunk/...），按版本取 diff 时拼 URL 用 */
  repoPath?: string;
}

export interface LogEntry {
  revision: number;
  author: string;
  date: string;
  message: string;
  files: LogFile[];
}

export interface ConflictBlock {
  mine: string;
  theirs: string;
  base?: string;
}

export interface ConflictPayload {
  path: string;
  blocks: ConflictBlock[];
  count: number;
}

export type CheckoutPhase = 'preparing' | 'downloading' | 'done' | 'failed' | 'cancelled';

export interface CheckoutJob {
  id: string;
  /** checkout=检出（带 .svn）；export=下载（纯文件） */
  mode?: 'checkout' | 'export';
  url: string;
  path: string;
  phase: CheckoutPhase;
  filesTotal: number;
  filesDone: number;
  fileCount: number;
  dirCount: number;
  bytesTotal: number;
  bytesDone: number;
  bytesDoneText: string;
  bytesTotalText: string;
  speedBps: number;
  speedText: string;
  avgSpeedBps: number;
  avgSpeedText: string;
  percent: number | null;
  totalKnown: boolean;
  error: string | null;
  warn: string | null;
  message: string;
  startedAt: number;
  finishedAt: number | null;
  elapsedMs: number;
}

/* ---------- 本地目录浏览 ---------- */

export interface LocalEntry {
  name: string;
  /** 相对工作副本的路径 */
  path: string;
  kind: 'dir' | 'file';
  size: number;
  sizeText: string | null;
  mtime: number | null;
  /** 有改动时带状态，未改动为 null */
  status: { kind: ChangeKind; letter: string; label: string } | null;
  added: number;
  deleted: number;
  binary: boolean;
}

export interface LocalDirPayload {
  dir: string;
  /** null 表示已在工作副本根目录 */
  parent: string | null;
  entries: LocalEntry[];
  revision: number;
}

export interface FilePreview {
  path: string;
  size: number;
  sizeText: string;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

/* ---------- 远程仓库浏览 ---------- */

export interface RepoEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size: number;
  sizeText: string | null;
  revision: number | null;
  author: string;
  date: string;
  message: string;
}

export interface RepoListPayload {
  url: string;
  entries: RepoEntry[];
  tookMs: number;
}

export interface RepoInfoPayload {
  url: string;
  root: string;
  revision: number;
}

/** 仓库里某个文件的内容（svn cat），不落地 */
export interface RepoFilePreview {
  url: string;
  size: number;
  sizeText: string;
  binary: boolean;
  truncated: boolean;
  content: string;
}
