import { useCallback, useEffect, useRef, useState } from 'react';
import { api, decodePercent } from '@/src/lib/api';
import type { DiffPayload, FileChange, StatusPayload, WcItem } from '@/src/lib/types';

export type FileTab = 'local' | 'remote' | 'files';

export interface Workspace {
  wcs: string[];
  wcItems: WcItem[];
  current: string | null;
  status: StatusPayload | null;
  selected: string | null;
  diff: DiffPayload | null;
  diffLoading: boolean;
  busy: boolean;
  error: string | null;
  tab: FileTab;
  onlyRisk: boolean;
  checked: Set<string>;
  engineReady: boolean;
  /** svn 引擎是 app 自带的（不是用户机器上装的） */
  svnEmbedded: boolean;
  svnVersion: string;
  bundled: boolean;
  version: string;
  tookMs: number | null;
  fromCache: boolean;
  remoteLoaded: boolean;
  remoteLoading: boolean;
  remoteCachedAt: number | null;
}

export function useWorkspace() {
  const [wcs, setWcs] = useState<string[]>([]);
  const [wcItems, setWcItems] = useState<WcItem[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  // 差异窗口是否展开未变更内容（按文件重新取一次全上下文）
  const [diffExpanded, setDiffExpanded] = useState(false);
  const diffExpandedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 初始页签支持 ?tab=remote 直接打开（便于自测与截图）
  const [tab, setTab] = useState<FileTab>(() => {
    const t = new URLSearchParams(location.search).get('tab');
    return t === 'remote' || t === 'files' ? t : 'local';
  });
  const [onlyRisk, setOnlyRisk] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [engineReady, setEngineReady] = useState(false);
  const [svnEmbedded, setSvnEmbedded] = useState(false);
  const [svnVersion, setSvnVersion] = useState('');
  const [bundled, setBundled] = useState(false);
  const [version, setVersion] = useState('0.6.24');
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [fromCache, setFromCache] = useState(false);
  // 「待更新」是单独按需加载的：svn status -u 在远程仓库上要遍历服务器目录
  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteCachedAt, setRemoteCachedAt] = useState<number | null>(null);

  // 竞态防护：快速切换项目时，只认最后一次请求的结果
  const reqSeq = useRef(0);
  const diffSeq = useRef(0);
  // 上次出现在列表里的文件路径，用来区分"新出现的文件"和"用户主动取消勾选的"
  const knownPaths = useRef<Set<string>>(new Set());
  const remoteBusy = useRef(false);

  const localFiles = status?.local ?? [];
  const remoteFiles = status?.remote ?? [];

  const visibleFiles: FileChange[] = (() => {
    const base = tab === 'local' ? localFiles : remoteFiles;
    return onlyRisk ? base.filter((f) => f.risk) : base;
  })();

  const selectedFile = visibleFiles.find((f) => f.path === selected) ?? null;

  const loadEngineInfo = useCallback(async () => {
    try {
      const h = await api.health();
      setEngineReady(Boolean(h.svn));
      setSvnEmbedded(Boolean(h.svnEmbedded));
      setSvnVersion(h.svnVersion ?? '');
      setBundled(Boolean(h.bundled));
      if (h.version) setVersion(h.version);
      if (h.bundled) document.body.classList.add('in-app');
    } catch {
      setEngineReady(false);
    }
  }, []);

  const loadWcs = useCallback(async () => {
    try {
      const data = await api.listWorkingCopies();
      // 老版本后端没有 items，回退成"全都算工作副本"
      const items: WcItem[] =
        data.items ?? data.paths.map((p) => ({ path: p, isWc: true, exists: true }));
      setWcs(data.paths);
      setWcItems(items);
      return items;
    } catch (e) {
      setError(decodePercent((e as Error).message));
      return [] as WcItem[];
    }
  }, []);

  const loadDiff = useCallback(async (wc: string, file: FileChange) => {
    const seq = ++diffSeq.current;
    setDiffLoading(true);
    try {
      const data = await api.diff(wc, file.path, file.kind, diffExpandedRef.current ? 'full' : undefined);
      if (seq !== diffSeq.current) return;
      setDiff(data);
    } catch (e) {
      if (seq !== diffSeq.current) return;
      setDiff({
        path: file.path,
        added: 0,
        deleted: 0,
        binary: file.binary,
        lines: [],
        message: decodePercent((e as Error).message),
      });
    } finally {
      if (seq === diffSeq.current) setDiffLoading(false);
    }
  }, []);

  /** 差异窗口：在「只看改动」和「带完整未变更内容」之间切换 */
  const toggleDiffExpanded = useCallback(() => {
    diffExpandedRef.current = !diffExpandedRef.current;
    setDiffExpanded(diffExpandedRef.current);
    if (current && selectedFile) void loadDiff(current, selectedFile);
  }, [current, selectedFile, loadDiff]);

  const refresh = useCallback(
    async (
      opts: {
        force?: boolean;
        keepSelection?: boolean;
        /** 是否同时拉远端（默认跟随当前页签） */
        withRemote?: boolean;
        /** 忽略远端缓存，强制重新问服务器 */
        forceRemote?: boolean;
      } = {}
    ) => {
      const wc = current;
      if (!wc) return;
      const seq = ++reqSeq.current;
      const wantRemote = opts.withRemote ?? tab === 'remote';
      setBusy(true);
      setError(null);
      if (wantRemote) {
        setRemoteLoading(true);
        remoteBusy.current = true;
      }
      try {
        const data = await api.status(wc, {
          force: opts.force !== false,
          remote: wantRemote,
          forceRemote: Boolean(opts.forceRemote),
        });
        if (seq !== reqSeq.current) return;
        // 不带远端时，保留上一次拉到的待更新列表；
        // 否则每次本地刷新都会把「待更新」清空，切过去又白屏一次
        setStatus((prev) =>
          wantRemote || !prev
            ? data
            : {
                ...data,
                remote: prev.remote,
                remoteCached: prev.remoteCached,
                remoteFetchedAt: prev.remoteFetchedAt,
              }
        );
        setTookMs(data.tookMs ?? null);
        setFromCache(Boolean(data.cached));
        if (wantRemote) {
          setRemoteLoaded(true);
          setRemoteCachedAt(data.remoteFetchedAt ?? Date.now());
        }

        // 勾选状态：刷新后保留用户的手动选择。
        // 原来每次刷新都重置成"全选"，用户取消勾选后一刷新就自己跳回去，
        // 看起来就像"数量没更新"。
        const present = new Set(data.local.filter((f) => f.kind !== 'ignored').map((f) => f.path));
        // 必须在调用 setChecked 之前把"上一轮已知集合"取出来：
        // setChecked 的 updater 是延迟执行的，而下面那行是同步赋值。
        // 若在 updater 里读 knownPaths.current，读到的是已更新的新值，
        // 首次加载会误判成"全都不是新文件"，结果一个都不勾选。
        const prevKnown = knownPaths.current;
        setChecked((prev) => {
          const next = new Set<string>();
          const firstLoad = prev.size === 0 && prevKnown.size === 0;
          for (const p of present) {
            if (firstLoad) next.add(p); // 首次加载默认全选
            else if (prev.has(p)) next.add(p); // 保留用户选择
            else if (!prevKnown.has(p)) next.add(p); // 新出现的文件默认勾选
          }
          return next;
        });
        knownPaths.current = present;

        // 选中项失效时自动落到第一个可预览的文件
        const pool = [...data.local, ...data.remote];
        const stillValid = opts.keepSelection && selected && pool.some((f) => f.path === selected);
        if (!stillValid) {
          const preferred =
            data.local.find((f) => f.kind === 'modified' && !f.binary) ??
            data.local.find((f) => f.kind !== 'unversioned' && !f.binary) ??
            data.local[0] ??
            data.remote[0];
          if (preferred) {
            setSelected(preferred.path);
            void loadDiff(wc, preferred);
          } else {
            setSelected(null);
            setDiff(null);
          }
        }
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setError(decodePercent((e as Error).message));
      } finally {
        if (seq === reqSeq.current) setBusy(false);
        setRemoteLoading(false);
        remoteBusy.current = false;
      }
    },
    [current, selected, loadDiff, tab]
  );

  /** 单独按需加载「待更新」列表，不阻塞主界面其他部分 */
  const loadRemote = useCallback(
    async (forceRemote = false) => {
      const wc = current;
      if (!wc || remoteBusy.current) return;
      remoteBusy.current = true;
      setRemoteLoading(true);
      setError(null);
      try {
        const data = await api.status(wc, { remote: true, forceRemote });
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                remote: data.remote,
                remoteCached: data.remoteCached,
                remoteFetchedAt: data.remoteFetchedAt,
              }
            : data
        );
        setRemoteLoaded(true);
        setRemoteCachedAt(data.remoteFetchedAt ?? Date.now());
      } catch (e) {
        setError(decodePercent((e as Error).message));
      } finally {
        setRemoteLoading(false);
        remoteBusy.current = false;
      }
    },
    [current]
  );

  /** 切换页签：切到「待更新」且还没加载过时，才触发一次服务器查询 */
  const switchTab = useCallback(
    (next: FileTab) => {
      setTab(next);
      if (next === 'remote' && !remoteLoaded && !remoteBusy.current) {
        void loadRemote();
      }
    },
    [remoteLoaded, loadRemote]
  );

  const selectWc = useCallback(
    (path: string) => {
      if (path === current) return;
      reqSeq.current++;
      diffSeq.current++;
      setCurrent(path);
      setStatus(null);
      setSelected(null);
      setDiff(null);
      setTookMs(null);
      setError(null);
      setRemoteLoaded(false);
      setRemoteCachedAt(null);
      setTab('local');
      knownPaths.current = new Set();
    },
    [current]
  );

  const selectFile = useCallback(
    (path: string) => {
      setSelected(path);
      if (!current) return;
      const file = [...localFiles, ...remoteFiles].find((f) => f.path === path);
      if (!file) return;
      void loadDiff(current, file);
    },
    [current, localFiles, remoteFiles, loadDiff]
  );

  const toggleChecked = useCallback((path: string, next: boolean) => {
    setChecked((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(path);
      else copy.delete(path);
      return copy;
    });
  }, []);

  const toggleAll = useCallback(
    (next: boolean) => {
      setChecked(next ? new Set(visibleFiles.filter((f) => f.kind !== 'ignored').map((f) => f.path)) : new Set());
    },
    [visibleFiles]
  );

  const addWc = useCallback(async (path: string) => {
    const data = await api.addWorkingCopy(path);
    setWcs(data.paths);
    setWcItems(data.items ?? data.paths.map((p) => ({ path: p, isWc: true, exists: true })));
    setCurrent(null);
    return data.paths;
  }, []);

  /** 给项目设置显示别名（传空字符串 = 恢复成目录名）；只影响显示 */
  const setWcAlias = useCallback(async (path: string, alias: string) => {
    const data = await api.setWorkingCopyAlias(path, alias);
    const items: WcItem[] =
      data.items ?? data.paths.map((p) => ({ path: p, isWc: true, exists: true }));
    setWcs(data.paths);
    setWcItems(items);
    return data.paths;
  }, []);

  /** 从列表移除项目（不动磁盘上的文件） */
  const removeWc = useCallback(
    async (path: string) => {
      const data = await api.removeWorkingCopy(path);
      const items: WcItem[] =
        data.items ?? data.paths.map((p) => ({ path: p, isWc: true, exists: true }));
      setWcs(data.paths);
      setWcItems(items);
      if (path === current) {
        // 关掉当前这个时顺手切到下一个还能用的，别把用户丢在空白页
        const next = items.find((i) => i.isWc);
        setStatus(null);
        setSelected(null);
        setDiff(null);
        setTookMs(null);
        setError(null);
        knownPaths.current = new Set();
        setCurrent(next ? next.path : null);
      }
      return data.paths;
    },
    [current]
  );

  // 初始化：引擎信息 + 项目列表；有项目就自动选中第一个
  useEffect(() => {
    void (async () => {
      await loadEngineInfo();
      const items = await loadWcs();
      // 只自动打开真正的工作副本；找不到 .svn 的项目（灰的）不自动打开，
      // 否则一启动就停在一屏报错上
      const first = items.find((i) => i.isWc);
      if (first) setCurrent(first.path);
    })();
  }, [loadEngineInfo, loadWcs]);

  // current 变化时拉状态
  useEffect(() => {
    if (current) void refresh({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const value: Workspace & {
    localFiles: FileChange[];
    remoteFiles: FileChange[];
    visibleFiles: FileChange[];
    selectedFile: FileChange | null;
    diffExpanded: boolean;
    toggleDiffExpanded: typeof toggleDiffExpanded;
    activeChecked: FileChange[];
    selectWc: typeof selectWc;
    selectFile: typeof selectFile;
    refresh: typeof refresh;
    loadWcs: typeof loadWcs;
    addWc: typeof addWc;
    removeWc: typeof removeWc;
    setWcAlias: typeof setWcAlias;
    setTab: typeof switchTab;
    setOnlyRisk: typeof setOnlyRisk;
    toggleChecked: typeof toggleChecked;
    toggleAll: typeof toggleAll;
    setError: typeof setError;
    loadEngineInfo: typeof loadEngineInfo;
    loadRemote: typeof loadRemote;
  } = {
    wcs,
    wcItems,
    current,
    status,
    selected,
    diff,
    diffLoading,
    busy,
    error,
    tab,
    onlyRisk,
    checked,
    engineReady,
    svnEmbedded,
    svnVersion,
    bundled,
    version,
    tookMs,
    fromCache,
    remoteLoaded,
    remoteLoading,
    remoteCachedAt,
    localFiles,
    remoteFiles,
    visibleFiles,
    selectedFile,
    diffExpanded,
    toggleDiffExpanded,
    activeChecked: localFiles.filter((f) => checked.has(f.path)),
    selectWc,
    selectFile,
    refresh,
    loadWcs,
    addWc,
    removeWc,
    setWcAlias,
    setTab: switchTab,
    setOnlyRisk,
    toggleChecked,
    toggleAll,
    setError,
    loadEngineInfo,
    loadRemote,
  };

  return value;
}

export type WorkspaceApi = ReturnType<typeof useWorkspace>;
