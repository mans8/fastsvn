import { useEffect, useRef, useState } from 'react';
import { RiArrowRightSLine, RiFile3Line } from '@remixicon/react';
import { Modal, ModalBody, ModalHeader } from '@/components/base/modal/modal';
import { Spinner } from '@/components/base/spinner/spinner';
import { api, decodePercent } from '@/src/lib/api';
import { fullDateTime } from '@/src/lib/format';
import type { DiffPayload, LogEntry, LogFile } from '@/src/lib/types';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  wcPath: string | null;
  /** 只看某个文件/子目录的历史；空表示整个工作副本 */
  target?: { path: string; name: string } | null;
}

const ACTION_TONE: Record<string, string> = {
  A: 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400',
  M: 'bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-300',
  D: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400',
  R: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
};

const ACTION_LABEL: Record<string, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '替换',
};

/**
 * 提交历史：左边是记录列表，每条记录可以就地展开它改动的文件；
 * 点文件后，右边展示这一版里该文件的改动。
 *
 * 看过的文件改动会缓存在内存里（key = 版本 + 仓库路径），
 * 弹窗关掉就清空 —— 同一个文件来回点不再重复跑 svn。
 */
export function LogDialog({ isOpen, onOpenChange, wcPath, target }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 展开的记录（就地显示文件清单）
  const [expandedRev, setExpandedRev] = useState<number | null>(null);
  // 右边正在看的文件
  const [picked, setPicked] = useState<{ rev: number; file: LogFile } | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // 已看过的文件改动：弹窗生命周期内有效
  const diffCache = useRef(new Map<string, DiffPayload>());

  // 左栏宽度可拖：文件路径长的时候给右边留空间
  const [listW, setListW] = useState(420);
  const splitDrag = useRef<{ startX: number; startW: number } | null>(null);

  const onSplitterDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    splitDrag.current = { startX: e.clientX, startW: listW };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件下不可用，退化成普通 mousemove */
    }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onSplitterMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = splitDrag.current;
    if (!d) return;
    // 至少留 260px 给右边看 diff
    const next = Math.max(240, Math.min(d.startW + (e.clientX - d.startX), 760));
    setListW(next);
  };

  const onSplitterUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!splitDrag.current) return;
    splitDrag.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* 同上 */
    }
  };

  useEffect(() => {
    if (!isOpen || !wcPath) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setEntries([]);
    setExpandedRev(null);
    setPicked(null);
    setDiff(null);
    setDiffError(null);
    api
      .log(wcPath, 60, target?.path)
      .then((d) => {
        if (!alive) return;
        setEntries(d.entries);
        // 第一条默认展开，打开就能看到这一版改了哪些文件
        if (d.entries.length) setExpandedRev(d.entries[0].revision);
      })
      .catch((e) => {
        if (alive) setError(decodePercent((e as Error).message));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, wcPath, target?.path]);

  // 弹窗关掉：缓存作废（下次打开重新取，避免看到过期内容）
  useEffect(() => {
    if (!isOpen) {
      diffCache.current.clear();
      setPicked(null);
      setDiff(null);
      setDiffError(null);
      setExpandedRev(null);
    }
  }, [isOpen]);

  /** 点文件名：看这一版里它改了什么（命中缓存就直接用） */
  const openFileDiff = async (rev: number, file: LogFile) => {
    if (!wcPath) return;
    setPicked({ rev, file });
    setDiffError(null);

    const key = `${rev}::${file.repoPath || file.path}`;
    const hit = diffCache.current.get(key);
    if (hit) {
      setDiff(hit);
      setDiffLoading(false);
      return;
    }

    setDiff(null);
    setDiffLoading(true);
    try {
      const d = await api.logDiff(wcPath, rev, file.repoPath || `/${file.path}`);
      diffCache.current.set(key, d);
      setDiff(d);
    } catch (e) {
      setDiffError(decodePercent((e as Error).message));
    } finally {
      setDiffLoading(false);
    }
  };

  const pickedKey = picked ? `${picked.rev}::${picked.file.repoPath || picked.file.path}` : null;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="wide" className="!gap-2">
      <ModalHeader
        title={target ? `「${target.name}」的提交历史` : '提交历史'}
        description="点一条记录展开它改动的文件，再点文件在右边看具体改动。"
      />

      {/* 上下不额外留白：两个框直接顶到标题下方和面板底部 */}
      <ModalBody className="!px-4 !py-0">
        <div className="flex h-[min(62vh,540px)] items-stretch">
          {/* ---------- 左：记录列表（文件就地展开，路径长了可横向滚） ---------- */}
          <div
            style={{ width: listW }}
            className="flex min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default"
          >
            <div className="always-scroll min-h-0 flex-1 overflow-auto p-0.5">
              <div className="w-max min-w-full">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-6 text-caption-1-regular text-text-tertiary">
                <Spinner size="sm" /> 正在读取历史…
              </div>
            )}
            {error && <p className="px-3 py-6 text-caption-1-regular text-text-error-primary">{error}</p>}
            {!loading && !error && entries.length === 0 && (
              <p className="px-3 py-6 text-caption-1-regular text-text-tertiary">
                {target ? '这个文件还没有提交记录。' : '这个项目还没有提交记录。'}
              </p>
            )}

            {entries.map((e) => {
              const open = e.revision === expandedRev;
              return (
                <div key={e.revision}>
                  <button
                    type="button"
                    data-log-entry={e.revision}
                    aria-expanded={open}
                    onClick={() => setExpandedRev(open ? null : e.revision)}
                    className={[
                      'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
                      open ? 'bg-background-secondary-hover' : 'hover:bg-background-primary-hover',
                    ].join(' ')}
                  >
                    <RiArrowRightSLine
                      className={[
                        'size-3.5 shrink-0 text-foreground-icon-tertiary transition-transform',
                        open ? 'rotate-90' : '',
                      ].join(' ')}
                    />
                    <span className="shrink-0 rounded bg-background-tertiary-default px-1 font-mono text-caption-2-semibold text-text-secondary">
                      r{e.revision}
                    </span>
                    <span className="max-w-[64px] shrink-0 truncate text-caption-2-regular text-text-secondary">
                      {e.author}
                    </span>
                    <span className="shrink-0 text-caption-2-regular tabular-nums text-text-tertiary">
                      {fullDateTime(e.date)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-primary">
                      {e.message || '（无说明）'}
                    </span>
                    <span className="shrink-0 text-caption-2-regular text-text-tertiary">
                      {e.files.length}
                    </span>
                  </button>

                  {open && (
                    <ul className="mb-1 ml-7 flex flex-col gap-0.5 pb-1">
                      {e.files.length === 0 && (
                        <li className="px-2 py-1 text-caption-2-regular text-text-tertiary">
                          这一版没有文件级改动（可能只改了属性）
                        </li>
                      )}
                      {e.files.map((f, i) => {
                        const key = `${e.revision}::${f.repoPath || f.path}`;
                        const active = key === pickedKey;
                        return (
                          <li key={`${f.path}-${i}`}>
                            <button
                              type="button"
                              data-log-file={f.path}
                              onClick={() => void openFileDiff(e.revision, f)}
                              title="在右边看这个文件这一版的改动"
                              className={[
                                'flex w-full items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-[3px] text-left transition-colors',
                                active
                                  ? 'bg-accent-50 dark:bg-accent-500/15'
                                  : 'hover:bg-background-primary-hover',
                              ].join(' ')}
                            >
                              <span
                                className={[
                                  'status-letter shrink-0',
                                  ACTION_TONE[f.action] ?? 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700',
                                ].join(' ')}
                              >
                                {f.action}
                              </span>
                              <span
                                className={[
                                  'font-mono text-caption-1-regular',
                                  active ? 'text-accent-700 dark:text-accent-300' : 'text-text-secondary',
                                ].join(' ')}
                              >
                                {f.path}
                              </span>
                              <RiArrowRightSLine className="size-3.5 shrink-0 text-foreground-icon-quaternary" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
              </div>
            </div>
          </div>

          {/* 拖拽条：左右两栏宽度都能调 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整左右宽度"
            onPointerDown={onSplitterDown}
            onPointerMove={onSplitterMove}
            onPointerUp={onSplitterUp}
            onPointerCancel={onSplitterUp}
            className="mx-1 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center"
          >
            <span className="h-10 w-[2px] rounded-full bg-border-button-default transition-colors hover:bg-accent-400" />
          </div>

          {/* ---------- 右：文件改动 ---------- */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-separator-border bg-background-secondary-default px-2 py-1">
              {picked ? (
                <>
                  <span className="shrink-0 rounded bg-background-tertiary-default px-1.5 py-0.5 font-mono text-caption-2-semibold text-text-secondary">
                    r{picked.rev}
                  </span>
                  <RiFile3Line className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
                  <span className="truncate font-mono text-caption-1-medium text-text-primary">
                    {picked.file.path}
                  </span>
                  <span
                    className={[
                      'shrink-0 rounded px-1 text-caption-2-medium',
                      ACTION_TONE[picked.file.action] ?? 'bg-neutral-200 text-neutral-600',
                    ].join(' ')}
                  >
                    {ACTION_LABEL[picked.file.action] ?? picked.file.action}
                  </span>
                  {diff && !diff.binary && (diff.added > 0 || diff.deleted > 0) && (
                    <span className="ml-auto shrink-0 font-mono text-caption-2-medium">
                      <span className="text-green-700 dark:text-green-400">+{diff.added}</span>{' '}
                      <span className="text-red-700 dark:text-red-400">−{diff.deleted}</span>
                    </span>
                  )}
                </>
              ) : (
                <span className="text-caption-1-medium text-text-secondary">文件改动</span>
              )}
            </div>

            <div className="thin-scroll min-h-0 flex-1 overflow-auto">
              {!picked && (
                <p className="px-4 py-8 text-center text-caption-1-regular text-text-tertiary">
                  点左边的文件名，这里会显示它在这一版里的改动
                </p>
              )}
              {picked && diffLoading && (
                <div className="flex items-center gap-2 px-4 py-6 text-caption-1-regular text-text-tertiary">
                  <Spinner size="sm" /> 正在读取这一版的改动…
                </div>
              )}
              {picked && diffError && (
                <p className="px-4 py-6 text-caption-1-regular text-text-error-primary">{diffError}</p>
              )}
              {picked && !diffLoading && diff?.binary && (
                <p className="px-4 py-6 text-caption-1-regular text-text-secondary">
                  这是二进制文件，这一版没有可预览的文本改动。
                </p>
              )}
              {picked && !diffLoading && !diff?.binary && diff?.message && (
                <p className="px-4 py-6 text-caption-1-regular text-text-tertiary">{diff.message}</p>
              )}
              {picked && !diffLoading && !diff?.binary && diff && diff.lines.length > 0 && (
                <div className="min-w-max py-1">
                  {diff.lines.map((line, i) => (
                    <div
                      key={i}
                      className={[
                        'diff-line',
                        line.kind === 'hunk'
                          ? 'is-hunk'
                          : line.kind === 'add'
                            ? 'is-add'
                            : line.kind === 'del'
                              ? 'is-del'
                              : '',
                      ].join(' ')}
                    >
                      {line.kind === 'hunk' ? (
                        <span className="diff-text">{line.text}</span>
                      ) : (
                        <>
                          <span className="diff-gutter">
                            <span className="o">{line.oldNo ?? ''}</span>
                            <span className="n">{line.newNo ?? ''}</span>
                          </span>
                          <span className="diff-mark">
                            {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
                          </span>
                          <span className="diff-text">{line.text || ' '}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
}
