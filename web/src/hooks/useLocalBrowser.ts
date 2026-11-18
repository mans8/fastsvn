import { useCallback, useEffect, useRef, useState } from 'react';
import { api, decodePercent } from '@/src/lib/api';
import type { FilePreview, LocalDirPayload, LocalEntry } from '@/src/lib/types';

/**
 * 「本地目录」页签的状态：以树的形式浏览工作副本里的真实文件树。
 *
 * 和「待提交 / 待更新」的区别：那两个是变更列表，这里列的是磁盘上的全部内容，
 * 未改动的文件也在，只是没有状态标记。
 *
 * 树是懒加载的：根目录先读，展开某个目录时才去读它的子项。
 */
export function useLocalBrowser(wcPath: string | null, active: boolean) {
  const [root, setRoot] = useState<LocalDirPayload | null>(null);
  /** 相对路径 → 该目录下的条目；'' 是工作副本根 */
  const [children, setChildren] = useState<Map<string, LocalEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [loading, setLoading] = useState(false);
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<LocalEntry | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const seq = useRef(0);
  const initedFor = useRef<string | null>(null);
  // setState 是异步的，回调里要读到最新的树，用 ref 同步一份
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const fetchDir = useCallback(
    async (rel: string, opts: { force?: boolean } = {}) => {
      if (!wcPath) return;
      if (!opts.force && rel !== '' && childrenRef.current.has(rel)) return;
      const mySeq = seq.current;
      if (rel === '') setLoading(true);
      else setLoadingDirs((prev) => new Set(prev).add(rel));
      setError(null);
      try {
        const payload = await api.ls(wcPath, rel);
        if (mySeq !== seq.current) return;
        if (rel === '') setRoot(payload);
        setChildren((prev) => new Map(prev).set(rel, payload.entries));
      } catch (e) {
        if (mySeq !== seq.current) return;
        if (rel === '') setError(decodePercent((e as Error).message));
        // 失败的目录标成空，避免每次展开都重试打满 svn
        setChildren((prev) => new Map(prev).set(rel, []));
      } finally {
        if (rel === '') {
          if (mySeq === seq.current) setLoading(false);
        } else {
          setLoadingDirs((prev) => {
            const next = new Set(prev);
            next.delete(rel);
            return next;
          });
        }
      }
    },
    [wcPath]
  );

  /** 展开 / 收起某个目录（首次展开时读子项） */
  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else {
          next.add(rel);
          if (!childrenRef.current.has(rel)) void fetchDir(rel);
        }
        return next;
      });
    },
    [fetchDir]
  );

  /** 重新读盘：根目录 + 所有展开着的目录（串行，别把 svn 打满） */
  const refresh = useCallback(async () => {
    if (!wcPath) return;
    const dirs = [...expandedRef.current].filter((d) => d !== '');
    const mySeq = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const payload = await api.ls(wcPath, '');
      if (mySeq !== seq.current) return;
      setRoot(payload);
      const next = new Map<string, LocalEntry[]>();
      next.set('', payload.entries);
      for (const d of dirs) {
        try {
          const p = await api.ls(wcPath, d);
          if (mySeq !== seq.current) return;
          next.set(d, p.entries);
        } catch {
          next.set(d, []);
        }
      }
      setChildren(next);
    } catch (e) {
      if (mySeq !== seq.current) return;
      setError(decodePercent((e as Error).message));
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }, [wcPath]);

  /** 重读某个目录并确保它是展开的（新建子目录、单目录更新之后用） */
  const refreshDir = useCallback(
    async (rel: string) => {
      setExpanded((prev) => (prev.has(rel) ? prev : new Set(prev).add(rel)));
      await fetchDir(rel, { force: true });
    },
    [fetchDir]
  );

  const openFile = useCallback(
    async (entry: LocalEntry) => {
      if (!wcPath) return;
      setSelected(entry);
      if (entry.kind === 'dir') return;
      setPreviewLoading(true);
      setPreview(null);
      try {
        const payload = await api.readFile(wcPath, entry.path);
        setPreview(payload);
      } catch (e) {
        setPreview(null);
        setError(decodePercent((e as Error).message));
      } finally {
        setPreviewLoading(false);
      }
    },
    [wcPath]
  );

  const reset = useCallback(() => {
    seq.current++;
    initedFor.current = null;
    setRoot(null);
    setChildren(new Map());
    setExpanded(new Set(['']));
    setSelected(null);
    setPreview(null);
    setError(null);
    setLoading(false);
    setLoadingDirs(new Set());
  }, []);

  // 换项目时回到根目录
  useEffect(() => {
    reset();
  }, [wcPath, reset]);

  // 只有切到这个页签时才真正读目录，避免每次刷新都多一次 IO
  useEffect(() => {
    if (!active || !wcPath) return;
    if (initedFor.current === wcPath) return;
    initedFor.current = wcPath;
    void fetchDir('');
  }, [active, wcPath, fetchDir]);

  return {
    wcPath,
    root,
    children,
    expanded,
    loading,
    loadingDirs,
    error,
    selected,
    preview,
    previewLoading,
    revision: root?.revision ?? null,
    toggleDir,
    openFile,
    fetchDir,
    refreshDir,
    refresh,
    reset,
  };
}

export type LocalBrowser = ReturnType<typeof useLocalBrowser>;
