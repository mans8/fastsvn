import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiDownloadCloud2Line,
  RiFile3Line,
  RiFileCopy2Line,
  RiFolder3Line,
  RiFolderOpenLine,
  RiGitRepositoryLine,
  RiLinkM,
  RiRefreshLine,
  RiTimeLine,
} from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/base/context-menu/context-menu';
import { Input } from '@/components/base/input/input';
import { Modal, ModalBody, ModalHeader } from '@/components/base/modal/modal';
import { Spinner } from '@/components/base/spinner/spinner';
import { api, decodePercent, type SvnCreds } from '@/src/lib/api';
import { copyWithToast } from '@/src/lib/clipboard';
import { canonicalUrl, prettyUrl, shortDateTime } from '@/src/lib/format';
import type { RepoEntry, RepoFilePreview, RepoListPayload } from '@/src/lib/types';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前项目的仓库地址，用来预填 */
  defaultUrl?: string;
  /** 把当前浏览的目录交给检出流程（本窗口保持打开） */
  onCheckout: (url: string) => void;
  /** 下载当前目录或某个文件（svn export，不带版本控制） */
  onDownload: (url: string) => void;
}

/** 树节点渲染用的扁平行 */
interface TreeRow {
  url: string;
  name: string;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  loading: boolean;
}

/** 文件预览最多渲染多少行：512KB 文本可能有上万行，全塞进 DOM 会卡 */
const MAX_PREVIEW_LINES = 3000;

type ColKey = 'name' | 'author' | 'date' | 'rev';

const COL_MIN: Record<ColKey, number> = { name: 140, author: 64, date: 104, rev: 52 };
const COL_MAX: Record<ColKey, number> = { name: 640, author: 220, date: 180, rev: 130 };

function joinUrl(base: string, name: string) {
  return `${base.replace(/\/+$/, '')}/${canonicalUrl(name)}`;
}

/** 仓库根以下的路径（以 / 开头，如 /trunk/docs/a.md）；仓库根自身返回空串 */
function repoRelative(url: string, root: string) {
  if (!root || !url.startsWith(root)) return '';
  return prettyUrl(url.slice(root.length));
}

function shortName(url: string) {
  const parts = url.replace(/\/+$/, '').split('/');
  return prettyUrl(parts[parts.length - 1] || url);
}

/**
 * 从仓库根到目标目录的父级链（含根、不含目标自身）。
 * 这串节点必须展开，目标行才会出现在树里。
 */
function ancestorChain(root: string, target: string): string[] {
  if (!root || !target || target === root || !target.startsWith(root)) return [];
  const rest = target.slice(root.length).replace(/^\/+/, '');
  const segs = rest.split('/').filter(Boolean);
  const out = [root];
  let cursor = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cursor = joinUrl(cursor, segs[i]);
    out.push(cursor);
  }
  return out;
}

export function RepoBrowserDialog({
  isOpen,
  onOpenChange,
  defaultUrl,
  onCheckout,
  onDownload,
}: Props) {
  const [input, setInput] = useState('');
  const [root, setRoot] = useState('');
  const [rootName, setRootName] = useState('');
  const [current, setCurrent] = useState('');
  const [payload, setPayload] = useState<RepoListPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 需要登录的仓库：凭据只放内存，随弹窗关闭清空；svn 自己会把它们记进
  // ~/.subversion/auth，所以后续检出/预览不用再输一次。
  const credsRef = useRef<SvnCreds | null>(null);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');

  // 树的展开状态：已展开的目录 url → 子目录列表
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childDirs, setChildDirs] = useState<Map<string, RepoEntry[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  // 文件内容查看：不落地，直接 svn cat
  const [fileView, setFileView] = useState<{ entry: RepoEntry; url: string } | null>(null);
  const [preview, setPreview] = useState<RepoFilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // 列宽可拖拽调整
  const [colW, setColW] = useState<Record<ColKey, number>>({
    name: 280,
    author: 92,
    date: 118,
    rev: 64,
  });
  const drag = useRef<{ key: ColKey; startX: number; startW: number } | null>(null);

  // 目录列表缓存：生命周期 = 这个弹窗打开期间（关闭时清空）。
  // 之前每次点左侧树都要重新请求，来回点几次就要等几次 svn。
  const listCache = useRef(new Map<string, RepoListPayload>());

  const listSeq = useRef(0);
  const treeSeq = useRef(0);

  // 左树自动定位：已加载过子目录的 url 集合 + 当前高亮行的 DOM
  const loadedDirs = useRef<Set<string>>(new Set());
  const revealSeq = useRef(0);
  const treeBoxRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  /** 切换右侧列表到某个 url；命中缓存直接用，force 才重新请求 */
  const goTo = useCallback(async (url: string, opts: { force?: boolean } = {}) => {
    const target = canonicalUrl(url);
    const mySeq = ++listSeq.current;
    setCurrent(target);
    setFileView(null);
    setError(null);

    if (!opts.force) {
      const hit = listCache.current.get(target);
      if (hit) {
        setPayload(hit);
        setLoading(false);
        return;
      }
    }

    setLoading(true);
    try {
      const data = await api.repoList(target, false, credsRef.current);
      if (mySeq !== listSeq.current) return;
      listCache.current.set(target, data);
      setPayload(data);
    } catch (e) {
      if (mySeq !== listSeq.current) return;
      setPayload(null);
      setError(decodePercent((e as Error).message));
    } finally {
      if (mySeq === listSeq.current) setLoading(false);
    }
  }, []);

  /** 刷新按钮：丢掉当前目录的缓存并重新请求，同时让左树重算子目录 */
  const refreshCurrent = useCallback(() => {
    if (!current) return;
    listCache.current.delete(current);
    setChildDirs((prev) => {
      const next = new Map(prev);
      next.delete(current);
      return next;
    });
    void goTo(current, { force: true });
  }, [current, goTo]);

  /** 点开一个文件：直接把仓库里的内容读出来看，不写本地 */
  const openFile = useCallback(
    async (entry: RepoEntry) => {
      const url = joinUrl(current, entry.name);
      setFileView({ entry, url });
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(true);
      try {
        const data = await api.repoCat(url, credsRef.current);
        setPreview(data);
      } catch (e) {
        setPreviewError(decodePercent((e as Error).message));
      } finally {
        setPreviewLoading(false);
      }
    },
    [current]
  );

  /** 加载某个目录的子目录（只查目录，跳过 log，快）；同一个目录只请求一次 */
  const loadChildDirs = useCallback(async (url: string) => {
    if (loadedDirs.current.has(url)) return;
    loadedDirs.current.add(url);
    setLoadingDirs((prev) => new Set(prev).add(url));
    try {
      const data = await api.repoList(url, true, credsRef.current);
      setChildDirs((prev) => new Map(prev).set(url, data.entries));
    } catch {
      // 失败不锁定：下次展开 / 刷新还能再试
      loadedDirs.current.delete(url);
      setChildDirs((prev) => new Map(prev).set(url, []));
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  }, []);

  /** 打开一个地址：定位仓库根 → 展开到目标路径 → 列内容 */
  const openUrl = useCallback(
    async (raw: string) => {
      const typed = raw.trim().replace(/\/+$/, '');
      if (!typed) return;
      const url = canonicalUrl(typed);
      const mySeq = ++treeSeq.current;
      setLoading(true);
      setError(null);
      try {
        const info = await api.repoInfo(url, credsRef.current);
        if (mySeq !== treeSeq.current) return;

        setRoot(info.root);
        setRootName(shortName(info.root));
        setExpanded(new Set());
        setChildDirs(new Map());
        loadedDirs.current.clear();

        // 从根到目标路径逐级展开，让左树直接定位到用户要看的位置
        const rest = url.startsWith(info.root) ? url.slice(info.root.length).replace(/^\/+/, '') : '';
        const segments = rest ? rest.split('/') : [];
        let cursor = info.root;
        const chain = [info.root];
        for (const seg of segments) {
          cursor = joinUrl(cursor, seg);
          chain.push(cursor);
        }

        // 逐级预加载子目录
        for (let i = 0; i < chain.length - 1; i++) {
          const parent = chain[i];
          await loadChildDirs(parent);
          setExpanded((prev) => new Set(prev).add(parent));
        }
        if (mySeq !== treeSeq.current) return;

        // 输入框展示解码后的地址，中文才看得懂
        setInput(prettyUrl(url));
        await goTo(url);
      } catch (e) {
        if (mySeq !== treeSeq.current) return;
        setError(decodePercent((e as Error).message));
        setPayload(null);
      } finally {
        if (mySeq === treeSeq.current) setLoading(false);
      }
    },
    [goTo, loadChildDirs]
  );

  // 需要账号密码时才算"要登录"：权限不足、证书问题不显示登录框
  // 服务端两种说法都要认：第一次是"需要账号密码"，密码错了是"账号或密码不对"
  const needsAuth = Boolean(error && /账号|密码|认证|authentication|authorization/i.test(error));

  /** 用刚填的账号重试当前地址；svn 成功后会把凭据记进 ~/.subversion */
  const retryWithCreds = useCallback(() => {
    const username = user.trim();
    if (!username) return;
    credsRef.current = { username, password: pass };
    setError(null);
    void openUrl(current || input);
  }, [user, pass, current, input, openUrl]);

  // 打开弹窗时重置并预填。
  // 注意：defaultUrl 来自当前项目的 status，可能比弹窗打开晚到，
  // 所以这里也跟着 defaultUrl 变化再试一次（用 ref 防重复加载）。
  const initializedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      initializedFor.current = null;
      // 缓存生命周期与窗口一致：关掉就丢，下次打开看到的是最新内容
      listCache.current.clear();
      setPayload(null);
      setError(null);
      credsRef.current = null;
      setUser('');
      setPass('');
      setExpanded(new Set());
      setChildDirs(new Map());
      loadedDirs.current.clear();
      setCurrent('');
      setRoot('');
      setInput('');
      setFileView(null);
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const initial = defaultUrl?.trim();
    if (!initial) return;
    if (initializedFor.current === initial) return;
    initializedFor.current = initial;
    setInput(prettyUrl(initial));
    void openUrl(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultUrl]);

  const toggleDir = useCallback(
    (url: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(url)) {
          next.delete(url);
        } else {
          next.add(url);
          if (!childDirs.has(url)) void loadChildDirs(url);
        }
        return next;
      });
    },
    [childDirs, loadChildDirs]
  );

  /** 把树拍平成带缩进的行，按当前展开状态计算 */
  const treeRows = useMemo<TreeRow[]>(() => {
    if (!root) return [];
    const rows: TreeRow[] = [];
    const walk = (url: string, name: string, depth: number) => {
      const kids = childDirs.get(url);
      const isExpanded = expanded.has(url);
      rows.push({
        url,
        name,
        depth,
        expanded: isExpanded,
        hasChildren: kids === undefined ? true : kids.length > 0,
        loading: loadingDirs.has(url),
      });
      if (isExpanded && kids) {
        for (const k of kids) walk(joinUrl(url, k.name), prettyUrl(k.name), depth + 1);
      }
    };
    walk(root, rootName, 0);
    return rows;
  }, [root, rootName, childDirs, expanded, loadingDirs]);

  // 右侧列表跳到某个目录后，把左树展开到它的父级。
  // 否则树停在原地，高亮行根本不在视野里，看着就像"树没跟着走"。
  useEffect(() => {
    if (!isOpen || !root || !current) return;
    const chain = ancestorChain(root, current);
    if (!chain.length) return;
    const mySeq = ++revealSeq.current;
    void (async () => {
      for (const url of chain) {
        if (mySeq !== revealSeq.current) return;
        await loadChildDirs(url);
        if (mySeq !== revealSeq.current) return;
        setExpanded((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
      }
    })();
  }, [isOpen, root, current, loadChildDirs]);

  // 树结构变化后把当前行滚进可视区；已经看得见时浏览器不会动
  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => {
      activeRowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [current, treeRows]);

  const breadcrumb = useMemo(() => {
    if (!root || !current) return [];
    const rest = current.startsWith(root) ? current.slice(root.length).replace(/^\/+/, '') : '';
    if (!rest) return [];
    const segs = rest.split('/').filter(Boolean);
    const out: { name: string; url: string }[] = [];
    let cursor = root;
    for (const s of segs) {
      cursor = joinUrl(cursor, s);
      out.push({ name: prettyUrl(s), url: cursor });
    }
    return out;
  }, [root, current]);

  const dirCount = payload?.entries.filter((e) => e.kind === 'dir').length ?? 0;
  const fileCount = payload?.entries.filter((e) => e.kind === 'file').length ?? 0;

  const previewLines = useMemo(() => {
    if (!preview || preview.binary) return [];
    return preview.content.split('\n').slice(0, MAX_PREVIEW_LINES);
  }, [preview]);

  // ---------- 列宽拖拽 ----------
  const startDrag = (key: ColKey) => (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { key, startX: e.clientX, startW: colW[key] };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件下不可用，退化为普通 mousemove */
    }
    document.body.style.userSelect = 'none';
  };

  const moveDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = d.startW + (e.clientX - d.startX);
    const clamped = Math.min(COL_MAX[d.key], Math.max(COL_MIN[d.key], next));
    setColW((prev) => ({ ...prev, [d.key]: clamped }));
  };

  const endDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.userSelect = '';
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* 同上 */
    }
  };

  const handleDivider = (key: ColKey) => (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整列宽"
      onPointerDown={startDrag(key)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(e) => e.stopPropagation()}
      className="absolute -right-[3px] top-0 z-20 h-full w-[7px] cursor-col-resize touch-none hover:bg-accent-200/70 dark:hover:bg-accent-400/25"
    />
  );

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="wide">
      <ModalHeader
        title={
          <span className="flex items-center gap-2">
            <RiGitRepositoryLine className="size-[18px] shrink-0 text-foreground-icon-secondary" />
            浏览仓库
          </span>
        }
      />

      <ModalBody className="!px-5 !py-2">
        {/* 地址栏：标签与输入框同一行，把纵向空间留给内容 */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-body-2-medium text-text-secondary">仓库地址</span>
          <div className="min-w-0 flex-1">
            <Input
              aria-label="仓库地址"
              placeholder="https://svn.example.com/repo/trunk"
              value={input}
              onChange={(value) => setInput(value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void openUrl(input);
              }}
              leadingIcon={RiLinkM}
            />
          </div>
          <Button variant="secondary" onClick={() => void openUrl(input)} disabled={!input.trim()}>
            打开
          </Button>
        </div>

        {/* 面包屑 + 刷新 */}
        {root && (
          <div className="mt-1.5 flex items-center gap-0.5 overflow-x-auto text-caption-1-regular">
            <button
              type="button"
              onClick={() => void goTo(root)}
              className="shrink-0 rounded px-1 py-0.5 font-mono text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary"
            >
              {rootName}
            </button>
            {breadcrumb.map((b) => (
              <span key={b.url} className="flex shrink-0 items-center gap-0.5">
                <RiArrowRightSLine className="size-3.5 text-foreground-icon-quaternary" />
                <button
                  type="button"
                  onClick={() => void goTo(b.url)}
                  className={[
                    'rounded px-1 py-0.5 font-mono',
                    b.url === current
                      ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
                      : 'text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary',
                  ].join(' ')}
                >
                  {b.name}
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={refreshCurrent}
              title="重新加载当前目录（忽略缓存）"
              aria-label="重新加载当前目录"
              className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary"
            >
              <RiRefreshLine className={['size-3.5', loading ? 'animate-spin' : ''].join(' ')} />
              刷新
            </button>
          </div>
        )}

        {error && (
          <div className="mt-2 flex flex-col gap-1.5">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-caption-1-regular text-text-error-primary dark:bg-red-500/10">
              {error}
            </p>
            {needsAuth && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-background-secondary-default px-3 py-2">
                <div className="w-[150px]">
                  <Input
                    aria-label="SVN 用户名"
                    placeholder="用户名"
                    value={user}
                    onChange={(value) => setUser(value)}
                  />
                </div>
                <div className="w-[150px]">
                  <Input
                    aria-label="SVN 密码"
                    type="password"
                    placeholder="密码"
                    value={pass}
                    onChange={(value) => setPass(value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') retryWithCreds();
                    }}
                  />
                </div>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={!user.trim() || loading}
                  onClick={retryWithCreds}
                >
                  连接
                </Button>
                <span className="text-caption-2-regular text-text-tertiary">
                  凭据会安全保存在 macOS 钥匙串，下次不用再输
                </span>
              </div>
            )}
          </div>
        )}

        {/* 树 + 内容：长方形弹窗，横向更宽、纵向更矮 */}
        <div className="mt-2 flex h-[min(46vh,380px)] gap-3">
          {/* 左侧目录树 */}
          <div
            ref={treeBoxRef}
            data-repo-tree
            className="thin-scroll w-[200px] shrink-0 overflow-y-auto rounded-xl border border-border-button-default bg-background-secondary-default p-1"
          >
            {!root && (
              <p className="px-2 py-3 text-caption-1-regular text-text-tertiary">
                填地址后这里显示目录结构
              </p>
            )}
            {treeRows.map((row) => {
              const isCurrent = row.url === current;
              const isOpen = row.expanded;
              // 当前目录的祖先：颜色略深，让人看出"现在在这条路上"
              const isAncestor = !isCurrent && current.startsWith(`${row.url}/`);
              const rel = repoRelative(row.url, root);
              return (
                <ContextMenuTrigger key={row.url}>
                  <button
                    type="button"
                    ref={(el) => {
                      if (isCurrent) activeRowRef.current = el;
                    }}
                    data-tree-url={row.url}
                    data-tree-active={isCurrent ? 'true' : undefined}
                    onClick={() => {
                      if (row.url !== current) void goTo(row.url);
                      if (row.hasChildren) toggleDir(row.url);
                    }}
                    style={{ paddingLeft: 6 + row.depth * 12 }}
                    className={[
                      // 行距比之前紧一档：目录多时一屏能多看几层
                      'relative flex w-full items-center gap-1 rounded-md py-[3px] pr-1.5 text-left transition-colors',
                      isCurrent
                        ? 'bg-accent-50 font-medium text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
                        : isAncestor
                          ? 'text-text-primary hover:bg-background-primary-hover'
                          : 'text-text-secondary hover:bg-background-primary-hover hover:text-text-primary',
                    ].join(' ')}
                  >
                    {isCurrent && (
                      <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent-500 dark:bg-accent-400" />
                    )}
                    {row.hasChildren ? (
                      <RiArrowRightSLine
                        className={[
                          'size-3 shrink-0 transition-transform',
                          isOpen ? 'rotate-90' : '',
                        ].join(' ')}
                      />
                    ) : (
                      <span className="size-3 shrink-0" />
                    )}
                    {isOpen ? (
                      <RiFolderOpenLine className="size-3.5 shrink-0 text-accent-600 dark:text-accent-400" />
                    ) : (
                      <RiFolder3Line className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
                    )}
                    <span className="truncate text-caption-1-regular leading-[18px]">{row.name}</span>
                    {row.loading && <Spinner size="xs" className="ml-auto shrink-0" />}
                  </button>
                  <ContextMenu
                    aria-label={`目录操作：${row.name}`}
                    onAction={(key) => {
                      if (key === 'copy-url') void copyWithToast(prettyUrl(row.url), '地址');
                      if (key === 'copy-repo-path') void copyWithToast(rel, '路径');
                    }}
                  >
                    <ContextMenuItem id="copy-url" icon={RiLinkM}>
                      复制地址
                    </ContextMenuItem>
                    {rel && (
                      <ContextMenuItem id="copy-repo-path" icon={RiFileCopy2Line}>
                        复制仓库路径
                      </ContextMenuItem>
                    )}
                  </ContextMenu>
                </ContextMenuTrigger>
              );
            })}
          </div>

          {/* 右侧内容 */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-button-default">
            {fileView ? (
              /* ---------- 文件内容 ---------- */
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-border-separator-border bg-background-secondary-default px-2 py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setFileView(null);
                      setPreview(null);
                      setPreviewError(null);
                    }}
                    className="flex items-center gap-0.5 rounded px-1 py-0.5 text-caption-1-regular text-text-secondary hover:bg-background-primary-hover hover:text-text-primary"
                  >
                    <RiArrowLeftSLine className="size-3.5" />
                    返回
                  </button>
                  <RiFile3Line className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
                  <span className="truncate font-mono text-caption-1-medium text-text-primary">
                    {fileView.entry.name}
                  </span>
                  {preview && (
                    <span className="shrink-0 text-caption-2-regular text-text-secondary">
                      {preview.sizeText}
                    </span>
                  )}
                  {preview?.truncated && (
                    <span className="shrink-0 rounded bg-amber-100 px-1 text-caption-2-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                      只显示前 512 KB
                    </span>
                  )}
                  <Button
                    variant="secondary"
                    size="small"
                    className="ml-auto shrink-0"
                    leadingIcon={RiDownloadCloud2Line}
                    onClick={() => onDownload(fileView.url)}
                  >
                    下载
                  </Button>
                </div>

                <div className="thin-scroll min-h-0 flex-1 overflow-auto bg-background-primary-default">
                  {previewError && (
                    <p className="px-4 py-4 text-caption-1-regular text-text-error-primary">
                      {previewError}
                    </p>
                  )}
                  {!previewError && preview?.binary && (
                    <p className="px-4 py-4 text-caption-1-regular text-text-secondary">
                      这是二进制文件，界面上不做文本预览（{preview.sizeText}）。
                      <br />
                      需要看内容的话，可以先下载这个文件再用外部工具打开。
                    </p>
                  )}
                  {!previewError && preview && !preview.binary && (
                    <div className="min-w-max py-1">
                      {previewLines.map((line, i) => (
                        <div key={i} className="flex hover:bg-background-primary-hover">
                          <span className="sticky left-0 w-[52px] shrink-0 select-none border-r border-border-separator-border bg-background-secondary-default pr-2 text-right font-mono text-[11px] leading-[19px] text-text-tertiary">
                            {i + 1}
                          </span>
                          <span className="whitespace-pre pr-4 pl-3 font-mono text-[12px] leading-[19px] text-text-primary">
                            {line || ' '}
                          </span>
                        </div>
                      ))}
                      {previewLines.length >= MAX_PREVIEW_LINES && (
                        <p className="px-3 py-2 text-caption-2-regular text-text-tertiary">
                          文件较长，只显示前 {MAX_PREVIEW_LINES} 行
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* ---------- 目录列表 ---------- */
              <div className="thin-scroll min-h-0 flex-1 overflow-auto">
                {loading && (
                  <div className="flex items-center gap-2 px-4 py-6 text-caption-1-regular text-text-tertiary">
                    <Spinner size="sm" /> 正在读取仓库…
                  </div>
                )}

                {!loading && payload && payload.entries.length === 0 && (
                  <p className="px-4 py-8 text-center text-caption-1-regular text-text-tertiary">
                    这个目录是空的
                  </p>
                )}

                {!loading && payload && payload.entries.length > 0 && (
                  <table className="w-full table-fixed border-collapse text-left">
                    {/* 列宽由用户拖拽决定，初始值见 colW */}
                    <colgroup>
                      <col style={{ width: colW.name }} />
                      <col style={{ width: colW.author }} />
                      <col style={{ width: colW.date }} />
                      <col style={{ width: colW.rev }} />
                      <col />
                      <col style={{ width: 62 }} />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-background-secondary-default">
                      <tr className="whitespace-nowrap text-caption-2-semibold text-text-secondary">
                        <th className="relative px-2.5 py-1 font-medium">
                          名称
                          {handleDivider('name')}
                        </th>
                        <th className="relative px-2 py-1 font-medium">
                          提交人
                          {handleDivider('author')}
                        </th>
                        <th className="relative px-2 py-1 font-medium">
                          提交时间
                          {handleDivider('date')}
                        </th>
                        <th className="relative px-2 py-1 font-medium">
                          版本号
                          {handleDivider('rev')}
                        </th>
                        <th className="px-2.5 py-1 font-medium">说明</th>
                        <th className="px-2 py-1.5 text-center font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payload.entries.map((e) => {
                        const fullUrl = joinUrl(current, e.name);
                        const rel = repoRelative(fullUrl, root);
                        return (
                          <ContextMenuTrigger key={e.path}>
                            <tr
                              data-kind={e.kind}
                              data-name={e.name}
                              onClick={() => {
                                if (e.kind === 'dir') void goTo(joinUrl(current, e.name));
                                else void openFile(e);
                              }}
                              className="group cursor-pointer hover:bg-background-primary-hover"
                            >
                              <td className="px-2.5 py-[3px]">
                                <span className="flex items-center gap-1.5">
                                  {e.kind === 'dir' ? (
                                    <RiFolder3Line className="size-3.5 shrink-0 text-accent-600 dark:text-accent-400" />
                                  ) : (
                                    <RiFile3Line className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
                                  )}
                                  <span className="truncate text-body-2-regular text-text-primary">
                                    {e.name}
                                  </span>
                                  {e.kind === 'file' && e.sizeText && (
                                    <span className="shrink-0 font-mono text-caption-2-regular text-text-secondary">
                                      {e.sizeText}
                                    </span>
                                  )}
                                  <span className="shrink-0 text-caption-2-regular text-text-tertiary opacity-0 group-hover:opacity-100">
                                    {e.kind === 'dir' ? '打开' : '查看'}
                                  </span>
                                </span>
                              </td>
                              <td className="truncate px-2 py-[3px] text-caption-2-regular text-text-secondary">
                                {e.author || <span className="text-text-tertiary">—</span>}
                              </td>
                              <td className="whitespace-nowrap px-2 py-[3px] text-caption-2-regular tabular-nums text-text-secondary">
                                {shortDateTime(e.date)}
                              </td>
                              <td className="whitespace-nowrap px-2 py-[3px] font-mono text-caption-1-medium tabular-nums text-text-secondary">
                                {e.revision ?? '—'}
                              </td>
                              <td className="px-2.5 py-[3px]">
                                <span className="block truncate text-caption-1-regular text-text-secondary">
                                  {e.message || <span className="text-text-tertiary">—</span>}
                                </span>
                              </td>
                              <td className="px-2 py-[3px]">
                                <button
                                  type="button"
                                  aria-label={`下载 ${e.name}`}
                                  title={e.kind === 'dir' ? '下载这个目录到本地' : '下载这个文件到本地'}
                                  onClick={(ev) => {
                                    // 别让点击冒泡成"打开目录 / 查看文件"
                                    ev.stopPropagation();
                                    onDownload(joinUrl(current, e.name));
                                  }}
                                  className="mx-auto flex size-6 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
                                >
                                  <RiDownloadCloud2Line className="size-3.5" />
                                </button>
                              </td>
                            </tr>
                            <ContextMenu
                              aria-label={`仓库操作：${e.name}`}
                              onAction={(key) => {
                                if (key === 'copy-url') void copyWithToast(prettyUrl(fullUrl), '地址');
                                if (key === 'copy-repo-path') void copyWithToast(rel, '路径');
                              }}
                            >
                              <ContextMenuItem id="copy-url" icon={RiLinkM}>
                                复制地址
                              </ContextMenuItem>
                              {rel && (
                                <ContextMenuItem id="copy-repo-path" icon={RiFileCopy2Line}>
                                  复制仓库路径
                                </ContextMenuItem>
                              )}
                            </ContextMenu>
                          </ContextMenuTrigger>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* 底部操作条：统计 + 下载 + 检出 */}
            <div className="flex shrink-0 items-center gap-2 border-t border-border-separator-border bg-background-secondary-default px-3 py-1 text-caption-2-regular text-text-tertiary">
              <span>
                {dirCount} 个目录 · {fileCount} 个文件
              </span>
              {payload?.tookMs != null && (
                <span className="flex items-center gap-1">
                  <RiTimeLine className="size-3" />
                  {payload.tookMs} ms
                </span>
              )}
              <Button
                variant="secondary"
                size="small"
                className="ml-auto"
                disabled={!current}
                onClick={() => onCheckout(current)}
              >
                检出目录
              </Button>
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
}
