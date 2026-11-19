import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RiArrowRightSLine,
  RiDeleteBin6Line,
  RiFile3Line,
  RiFileCopy2Line,
  RiFileCopyLine,
  RiFolder3Line,
  RiFolderAddLine,
  RiFolderOpenLine,
  RiHistoryLine,
  RiRefreshLine,
} from '@remixicon/react';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/base/context-menu/context-menu';
import { Spinner } from '@/components/base/spinner/spinner';
import { kindMeta } from '@/src/lib/status-meta';
import type { LocalDirPayload, LocalEntry } from '@/src/lib/types';
import { basename, relativeTime } from '@/src/lib/format';

/** 本地目录里可以右键做的事 */
export type LocalAction =
  | 'update'
  | 'delete'
  | 'mkdir'
  | 'history'
  | 'copy-path'
  | 'copy-relative'
  | 'reveal';

export interface LocalTarget {
  /** 相对工作副本的路径；根目录是 '' */
  path: string;
  name: string;
  kind: 'dir' | 'file';
}

interface Props {
  wcPath: string | null;
  root: LocalDirPayload | null;
  children: Map<string, LocalEntry[]>;
  expanded: Set<string>;
  loading: boolean;
  loadingDirs: Set<string>;
  error: string | null;
  selected: LocalEntry | null;
  revision: number | null;
  onToggleDir: (rel: string) => void;
  onOpenFile: (entry: LocalEntry) => void;
  /** 双击文件：用系统默认应用打开 */
  onOpenExternal: (entry: LocalEntry) => void;
  onRefresh: () => void;
  onAction: (action: LocalAction, target: LocalTarget) => void;
}

/** 树拍平后的一行 */
interface Row {
  key: string;
  name: string;
  rel: string;
  depth: number;
  kind: 'root' | 'dir' | 'file' | 'empty';
  entry: LocalEntry | null;
  expanded: boolean;
  hasChildren: boolean;
}

/**
 * 本地目录：树形查看工作副本里的真实文件。
 *
 * 与左侧变更列表共用一套视觉语言，但语义不同：这里列的是磁盘上的全部内容，
 * 未改动的文件没有状态标记（而不是显示成"正常"）。
 *
 * 键盘：↑↓ 移动、→ 展开/进子项、← 收起/回父级、Enter 打开或展开。
 */
export function LocalDirPane({
  wcPath,
  root,
  children,
  expanded,
  loading,
  loadingDirs,
  error,
  selected,
  revision,
  onToggleDir,
  onOpenFile,
  onOpenExternal,
  onRefresh,
  onAction,
}: Props) {
  const rows = useMemo<Row[]>(() => {
    if (!root) return [];
    const out: Row[] = [
      {
        key: '__root__',
        name: basename(wcPath ?? '') || '工作副本',
        rel: '',
        depth: 0,
        kind: 'root',
        entry: null,
        expanded: expanded.has(''),
        hasChildren: (children.get('') ?? []).length > 0,
      },
    ];
    if (!expanded.has('')) return out;

    const walk = (rel: string, depth: number) => {
      const list = children.get(rel) ?? [];
      if (list.length === 0) {
        out.push({
          key: `${rel}/__empty__`,
          name: '空目录',
          rel,
          depth,
          kind: 'empty',
          entry: null,
          expanded: false,
          hasChildren: false,
        });
        return;
      }
      for (const e of list) {
        const isDir = e.kind === 'dir';
        const open = isDir && expanded.has(e.path);
        const kids = children.get(e.path);
        out.push({
          key: e.path,
          name: e.name,
          rel: e.path,
          depth,
          kind: isDir ? 'dir' : 'file',
          entry: e,
          expanded: open,
          hasChildren: isDir && (kids === undefined || kids.length > 0),
        });
        if (open) walk(e.path, depth + 1);
      }
    };
    walk('', 1);
    return out;
  }, [root, children, expanded, wcPath]);

  // 键盘光标：和"预览选中的文件"分开，光标可以停在目录上
  const [cursor, setCursor] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // 鼠标选中文件时，光标跟着走
  useEffect(() => {
    if (selected) setCursor(selected.path);
  }, [selected]);

  // 目录收起后光标所在行可能消失，回落到根
  useEffect(() => {
    if (cursor && !rows.some((r) => r.key === cursor)) setCursor(rows.length ? rows[0].key : null);
  }, [rows, cursor]);

  // 光标移动后滚进可视区
  useEffect(() => {
    if (!cursor) return;
    rowRefs.current.get(cursor)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows]);

  const moveCursorTo = useCallback(
    (index: number) => {
      if (!rows.length) return;
      const i = Math.max(0, Math.min(rows.length - 1, index));
      setCursor(rows[i].key);
    },
    [rows]
  );

  /** 找光标行的父级（同一条路径上最近的上层目录） */
  const parentIndexOf = useCallback(
    (index: number) => {
      const depth = rows[index]?.depth ?? 0;
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth === depth - 1) return i;
      }
      return -1;
    },
    [rows]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const idx = rows.findIndex((r) => r.key === cursor);
    const cur = idx >= 0 ? rows[idx] : null;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveCursorTo(idx < 0 ? 0 : idx + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveCursorTo(idx < 0 ? rows.length - 1 : idx - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveCursorTo(0);
        break;
      case 'End':
        e.preventDefault();
        moveCursorTo(rows.length - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!cur) return moveCursorTo(0);
        if (cur.kind === 'root' || cur.kind === 'dir') {
          // 收起状态下先展开；已展开则进入第一个子项
          if (!cur.expanded) onToggleDir(cur.rel);
          else moveCursorTo(idx + 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (!cur) return;
        if ((cur.kind === 'root' || cur.kind === 'dir') && cur.expanded) {
          onToggleDir(cur.rel);
          break;
        }
        moveCursorTo(parentIndexOf(idx));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!cur) return moveCursorTo(0);
        if (cur.kind === 'file' && cur.entry) onOpenFile(cur.entry);
        else if (cur.kind !== 'empty') onToggleDir(cur.rel);
        break;
      default:
        break;
    }
  };

  return (
    <>
      {/* 标题栏：说明这里是磁盘上的真实目录，不是变更列表 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-separator-border px-3 py-1.5">
        <span className="text-caption-1-medium text-text-secondary">文件树</span>
        {revision != null && (
          <span className="rounded bg-background-tertiary-default px-1.5 py-0.5 font-mono text-caption-2-medium text-text-secondary">
            r{revision}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          aria-label="重新读取目录"
          title="重新读取磁盘上的内容"
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-regular text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
        >
          <RiRefreshLine className={['size-3.5', loading ? 'animate-spin' : ''].join(' ')} />
          刷新
        </button>
      </div>

      <div
        ref={boxRef}
        tabIndex={0}
        role="tree"
        aria-label="本地文件树"
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (!cursor && rows.length) setCursor(rows[0].key);
        }}
        className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1.5 outline-none"
      >
        {loading && !root && (
          <div className="flex items-center gap-2 px-3 py-6 text-caption-1-regular text-text-tertiary">
            <Spinner size="sm" /> 正在读取目录…
          </div>
        )}

        {error && !loading && (
          <p className="px-3 py-6 text-caption-1-regular text-text-error-primary">{error}</p>
        )}

        {rows.map((row) => {
          const isSelected = row.entry ? selected?.path === row.entry.path : false;
          const isCursor = row.key === cursor;
          const meta = row.entry?.status ? kindMeta(row.entry.status.kind) : null;
          const spinning = row.kind === 'dir' && loadingDirs.has(row.rel);

          if (row.kind === 'empty') {
            return (
              <div
                key={row.key}
                role="treeitem"
                aria-disabled
                style={{ paddingLeft: 8 + row.depth * 14 }}
                className="py-[5px] text-caption-2-regular text-text-tertiary"
              >
                空目录
              </div>
            );
          }

          const target: LocalTarget = {
            path: row.rel,
            name: row.name,
            kind: row.kind === 'file' ? 'file' : 'dir',
          };

          return (
            <ContextMenuTrigger key={row.key}>
              <button
                ref={(el) => {
                  if (el) rowRefs.current.set(row.key, el);
                  else rowRefs.current.delete(row.key);
                }}
                type="button"
                role="treeitem"
                aria-expanded={row.kind === 'file' ? undefined : row.expanded}
                aria-selected={isSelected}
                data-local-tree-row={row.rel}
                data-cursor={isCursor ? 'true' : undefined}
                onClick={() => {
                  setCursor(row.key);
                  if (row.kind === 'file' && row.entry) onOpenFile(row.entry);
                  else onToggleDir(row.rel);
                }}
                onDoubleClick={() => {
                  // 双击文件：交给系统默认应用（预览只在单击时进右侧面板）
                  if (row.kind === 'file' && row.entry) onOpenExternal(row.entry);
                }}
                style={{ paddingLeft: 4 + row.depth * 14 }}
                className={[
                  'flex w-full items-center gap-1.5 rounded-lg py-[5px] pr-2 text-left transition-colors',
                  isSelected ? 'bg-accent-50 dark:bg-accent-500/15' : 'hover:bg-background-primary-hover',
                  isCursor ? 'ring-2 ring-inset ring-accent-400/60' : '',
                ].join(' ')}
              >
                {row.kind === 'file' ? (
                  <span className="size-3.5 shrink-0" />
                ) : (
                  <RiArrowRightSLine
                    className={[
                      'size-3.5 shrink-0 text-foreground-icon-tertiary transition-transform',
                      row.expanded ? 'rotate-90' : '',
                      row.hasChildren ? '' : 'opacity-0',
                    ].join(' ')}
                  />
                )}

                {row.kind === 'file' ? (
                  <RiFile3Line className="size-4 shrink-0 text-foreground-icon-tertiary" />
                ) : row.expanded ? (
                  <RiFolderOpenLine className="size-4 shrink-0 text-accent-600 dark:text-accent-400" />
                ) : (
                  <RiFolder3Line className="size-4 shrink-0 text-accent-600 dark:text-accent-400" />
                )}

                <span
                  className={[
                    'min-w-0 flex-1 truncate',
                    row.kind === 'root'
                      ? 'text-body-2-semibold text-text-primary'
                      : 'text-body-2-regular text-text-primary',
                  ].join(' ')}
                  title={row.rel || wcPath || ''}
                >
                  {row.name}
                </span>

                {meta && (
                  <span className={['status-letter shrink-0', meta.blockClass].join(' ')} title={meta.label}>
                    {meta.letter}
                  </span>
                )}

                {row.kind === 'file' && row.entry?.mtime ? (
                  <span className="shrink-0 text-caption-2-regular text-text-tertiary">
                    {relativeTime(row.entry.mtime)}
                  </span>
                ) : null}

                <span className="w-14 shrink-0 text-right font-mono text-caption-2-medium text-text-tertiary">
                  {row.kind === 'file' ? row.entry?.sizeText : ''}
                </span>

                {spinning && <Spinner size="xs" className="shrink-0" />}
              </button>

              <ContextMenu
                aria-label={`操作：${row.name}`}
                onAction={(key) => {
                  if (key === 'update') onAction('update', target);
                  if (key === 'delete') onAction('delete', target);
                  if (key === 'mkdir') onAction('mkdir', target);
                  if (key === 'history') onAction('history', target);
                  if (key === 'copy-path') onAction('copy-path', target);
                  if (key === 'copy-relative') onAction('copy-relative', target);
                  if (key === 'reveal') onAction('reveal', target);
                }}
              >
                {row.kind !== 'file' && (
                  <ContextMenuItem id="mkdir" icon={RiFolderAddLine}>
                    新建子目录…
                  </ContextMenuItem>
                )}
                <ContextMenuItem id="history" icon={RiHistoryLine}>
                  查看历史
                </ContextMenuItem>
                <ContextMenuItem id="update" icon={RiRefreshLine}>
                  更新
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem id="copy-path" icon={RiFileCopyLine}>
                  复制路径
                </ContextMenuItem>
                {/* 根节点的相对路径是空串，复制出去没有意义 */}
                {row.kind !== 'root' && (
                  <ContextMenuItem id="copy-relative" icon={RiFileCopy2Line}>
                    复制相对路径
                  </ContextMenuItem>
                )}
                <ContextMenuItem id="reveal" icon={RiFolderOpenLine}>
                  在访达中显示
                </ContextMenuItem>
                {row.kind !== 'root' && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem id="delete" icon={RiDeleteBin6Line} variant="danger">
                      删除…
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenu>
            </ContextMenuTrigger>
          );
        })}
      </div>
    </>
  );
}
