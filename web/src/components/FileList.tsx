import { useMemo, useState } from 'react';
import {
  RiAddLine,
  RiArrowRightSLine,
  RiDeleteBin6Line,
  RiEditLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiEyeOffLine,
  RiFileList3Line,
  RiFolder3Line,
  RiFolderOpenLine,
  RiGitMergeLine,
  RiListUnordered,
  RiNodeTree,
  RiRestartLine,
  RiUpload2Line,
} from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/base/context-menu/context-menu';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import { Switch } from '@/components/base/switch/switch';
import { LocalDirPane, type LocalAction, type LocalTarget } from '@/src/components/LocalDirPane';
import type { FileTab } from '@/src/hooks/useWorkspace';
import type { LocalBrowser } from '@/src/hooks/useLocalBrowser';
import type { FileChange } from '@/src/lib/types';
import { kindMeta } from '@/src/lib/status-meta';
import { riskLabel } from '@/src/lib/risk';

export type FileAction =
  | 'open'
  | 'add'
  | 'ignore'
  | 'rename'
  | 'delete'
  | 'revert'
  | 'resolve';

interface Props {
  tab: FileTab;
  onTabChange: (tab: FileTab) => void;
  localFiles: FileChange[];
  remoteFiles: FileChange[];
  visibleFiles: FileChange[];
  selected: string | null;
  checked: Set<string>;
  onlyRisk: boolean;
  onOnlyRiskChange: (v: boolean) => void;
  onSelect: (path: string) => void;
  onToggleChecked: (path: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  onAction: (action: FileAction, file: FileChange) => void;
  loading: boolean;
  /** 「待更新」正在向服务器查询 */
  remoteLoading: boolean;
  /** 当前工作副本的状态查询错误，失败时不要显示“服务器上没有新内容” */
  error: string | null;
  /** 出错后重新读取状态 */
  onRetry: () => void;
  /** 本地目录浏览（第三个页签） */
  browse: LocalBrowser;
  /** 已勾选、真正会被提交的文件数 */
  commitCount: number;
  onCommit: () => void;
  /** 本地目录里的右键操作：更新 / 删除 / 新建子目录 */
  onLocalAction: (action: LocalAction, target: LocalTarget) => void;
  /** 本地目录里双击文件：用默认应用打开 */
  onOpenExternal: (entry: { path: string; name: string }) => void;
}

/** 风险小标签：说清楚是什么风险，别用一个「体积」让人猜 */

/** 待提交列表的两种视图：平铺（默认）与按目录层级 */
type ViewMode = 'flat' | 'tree';

interface TreeDirRow {
  type: 'dir';
  path: string;
  name: string;
  depth: number;
  fileCount: number;
  added: number;
  deleted: number;
  collapsed: boolean;
}

interface TreeFileRow {
  type: 'file';
  file: FileChange;
  depth: number;
}

type TreeRow = TreeDirRow | TreeFileRow;

/** 把变更列表按路径层级摊平成带缩进的行（目录默认展开） */
function buildTreeRows(files: FileChange[], collapsed: Set<string>): TreeRow[] {
  interface Node {
    dirs: Map<string, Node>;
    files: FileChange[];
  }
  const empty = (): Node => ({ dirs: new Map(), files: [] });
  const root = empty();

  for (const f of files) {
    const segs = f.path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], empty());
      node = node.dirs.get(segs[i])!;
    }
    node.files.push(f);
  }

  const count = (n: Node): { fileCount: number; added: number; deleted: number } => {
    let fileCount = n.files.length;
    let added = n.files.reduce((s, f) => s + (f.added || 0), 0);
    let deleted = n.files.reduce((s, f) => s + (f.deleted || 0), 0);
    for (const child of n.dirs.values()) {
      const c = count(child);
      fileCount += c.fileCount;
      added += c.added;
      deleted += c.deleted;
    }
    return { fileCount, added, deleted };
  };

  const rows: TreeRow[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    const names = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    for (const name of names) {
      const child = node.dirs.get(name)!;
      const path = prefix ? `${prefix}/${name}` : name;
      const stats = count(child);
      const isCollapsed = collapsed.has(path);
      rows.push({ type: 'dir', path, name, depth, collapsed: isCollapsed, ...stats });
      if (!isCollapsed) walk(child, path, depth + 1);
    }
    const sorted = [...node.files].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const f of sorted) rows.push({ type: 'file', file: f, depth });
  };
  walk(root, '', 0);
  return rows;
}

export function FileList({
  tab,
  onTabChange,
  localFiles,
  remoteFiles,
  visibleFiles,
  selected,
  checked,
  onlyRisk,
  onOnlyRiskChange,
  onSelect,
  onToggleChecked,
  onToggleAll,
  onAction,
  loading,
  remoteLoading,
  error,
  browse,
  commitCount,
  onCommit,
  onLocalAction,
  onOpenExternal,
  onRetry,
}: Props) {
  const committable = useMemo(
    () => visibleFiles.filter((f) => f.kind !== 'ignored'),
    [visibleFiles]
  );
  const allChecked = committable.length > 0 && committable.every((f) => checked.has(f.path));
  // 只统计"当前这个列表里"被勾选的数量。
  // 原来用的是全局 checked.size，切到「待更新」或「只看有风险」时数字不会跟着变。
  const selectedInView = committable.filter((f) => checked.has(f.path)).length;

  // 树形视图：默认平铺。记录的是"被折叠的"目录，这样后来新出现的目录会自动展开
  const [view, setView] = useState<ViewMode>('flat');
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const treeRows = useMemo(
    () => (tab === 'local' && view === 'tree' ? buildTreeRows(visibleFiles, collapsedDirs) : []),
    [tab, view, visibleFiles, collapsedDirs]
  );

  const toggleDirRow = (path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** 一行变更（平铺与树形共用）。compact=树形：单行、无路径副标题 */
  const fileRow = (file: FileChange, depth: number, compact = false) => {
    const meta = kindMeta(file.kind);
    const isSelected = file.path === selected;
    const canCheck = file.kind !== 'ignored' && !file.remote;
    // 冲突是红色语义：这一行整体偏红，名字标红，再挂一个「冲突」标签，
    // 别让人以为它和普通修改一样可以直接提交
    const isConflict = file.kind === 'conflicted';
    return (
      <ContextMenuTrigger key={file.path}>
        <button
          type="button"
          onClick={() => onSelect(file.path)}
          data-file-row={file.path}
          data-conflict={isConflict ? 'true' : undefined}
          style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}
          className={[
            'flex w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors',
            compact ? 'py-[3px]' : 'py-[7px]',
            isSelected
              ? 'bg-accent-50 dark:bg-accent-500/15'
              : isConflict
                ? 'bg-red-50/70 hover:bg-red-50 dark:bg-red-500/10 dark:hover:bg-red-500/15'
                : 'hover:bg-background-primary-hover',
          ].join(' ')}
        >
          {/* 待更新的文件不能被选择性提交，所以不放勾选框，
              否则会让人以为"勾上就能单独更新" */}
          <span onClick={(e) => e.stopPropagation()} className="flex w-4 shrink-0 justify-center">
            {tab === 'local' ? (
              <Checkbox
                size="sm"
                isSelected={checked.has(file.path)}
                isDisabled={!canCheck}
                onChange={(v) => onToggleChecked(file.path, v)}
                aria-label={`选择 ${file.name}`}
              />
            ) : null}
          </span>

          <span className={['status-letter', meta.blockClass].join(' ')} title={meta.label}>
            {meta.letter}
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                className={[
                  'truncate text-body-2-medium',
                  isConflict ? 'text-red-700 dark:text-red-400' : 'text-text-primary',
                ].join(' ')}
              >
                {file.name}
              </span>
              {isConflict && (
                <span
                  title="这个文件有冲突，先解决冲突才能提交"
                  className="shrink-0 rounded bg-red-600 px-1 text-caption-2-semibold text-white dark:bg-red-500"
                >
                  冲突
                </span>
              )}
              {file.remote && file.localChanged && (
                <span
                  title="这个文件你本地也改过，直接更新会产生冲突"
                  className="shrink-0 rounded bg-amber-100 px-1 text-caption-2-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                >
                  会冲突
                </span>
              )}
              {file.risk && (
                <span
                  title={file.risk.text}
                  className="shrink-0 rounded bg-amber-100 px-1 text-caption-2-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                >
                  {riskLabel(file.risk.code)}
                </span>
              )}
            </span>
            {!compact && (
              <span
                className={[
                  'block truncate text-caption-2-regular',
                  isConflict ? 'text-red-600 dark:text-red-400' : 'text-text-secondary',
                ].join(' ')}
              >
                {isConflict
                  ? '先解决冲突，才能提交'
                  : (file.kind === 'missing' || file.kind === 'deleted') && file.isDir
                    ? '整个目录已删除，含里面的内容'
                    : file.kind === 'missing'
                      ? '文件已从本地删除'
                      : file.remote && file.localChanged
                        ? '你和同事都改了这个文件'
                        : file.path.includes('/')
                          ? file.path.slice(0, file.path.lastIndexOf('/'))
                          : '根目录'}
              </span>
            )}
          </span>

          <span className="flex shrink-0 items-center gap-1.5 font-mono text-caption-2-medium">
            {file.binary ? (
              <span
                className="text-text-tertiary"
                title={file.diffSkipped ? '体积超过 10 MB，不做差异比较' : undefined}
              >
                {file.sizeText ?? '二进制'}
              </span>
            ) : file.diffSkipped ? (
              <span className="text-text-tertiary" title="体积超过 10 MB，不做差异比较">
                大文件
              </span>
            ) : file.added === 0 && file.deleted === 0 ? (
              <span className="text-text-tertiary">—</span>
            ) : (
              <>
                {file.added > 0 && <span className="text-green-700 dark:text-green-400">+{file.added}</span>}
                {file.deleted > 0 && <span className="text-red-700 dark:text-red-400">−{file.deleted}</span>}
              </>
            )}
          </span>
        </button>

        <ContextMenu onAction={((key: string) => onAction(key as FileAction, file)) as never}>
          <ContextMenuItem id="open" icon={RiExternalLinkLine}>
            打开
          </ContextMenuItem>
          <ContextMenuSeparator />
          {(file.kind === 'unversioned' || file.kind === 'ignored') && (
            <ContextMenuItem id="add" icon={RiAddLine}>
              加入版本管理
            </ContextMenuItem>
          )}
          {(file.kind === 'unversioned' || file.kind === 'ignored') && (
            <ContextMenuItem id="ignore" icon={RiEyeOffLine}>
              {file.kind === 'ignored' ? '取消忽略' : '忽略这个文件'}
            </ContextMenuItem>
          )}
          {file.kind === 'conflicted' && (
            <ContextMenuItem id="resolve" icon={RiGitMergeLine}>
              解决冲突…
            </ContextMenuItem>
          )}
          {file.kind !== 'unversioned' && file.kind !== 'ignored' && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem id="rename" icon={RiEditLine}>
                重命名…
              </ContextMenuItem>
              {file.kind === 'deleted' || file.kind === 'missing' ? (
                <ContextMenuItem id="revert" icon={RiRestartLine}>
                  {file.kind === 'missing' ? '恢复本地文件' : '撤销删除'}
                </ContextMenuItem>
              ) : (
                <ContextMenuItem id="revert" icon={RiRestartLine}>
                  撤销我的修改
                </ContextMenuItem>
              )}
              <ContextMenuItem id="delete" icon={RiDeleteBin6Line} variant="danger">
                删除…
              </ContextMenuItem>
            </>
          )}
        </ContextMenu>
      </ContextMenuTrigger>
    );
  };

  return (
    <section className="flex w-[400px] shrink-0 flex-col overflow-hidden rounded-3xl border border-border-button-default bg-background-primary-default shadow-sm">
      {/* 页签与筛选 */}
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border-button-default px-3 py-2.5">
        <SegmentedControl
          selectedKeys={[tab]}
          onSelectionChange={(keys) => {
            const first = Array.from(keys)[0];
            if (first) onTabChange(String(first) as FileTab);
          }}
          className="w-full"
        >
          <SegmentedControlItem id="local" className="flex-1">
            待提交{localFiles.length > 0 ? ` · ${localFiles.length}` : ''}
          </SegmentedControlItem>
          <SegmentedControlItem id="remote" className="flex-1">
            待更新{remoteFiles.length > 0 ? ` · ${remoteFiles.length}` : ''}
          </SegmentedControlItem>
          <SegmentedControlItem id="files" className="flex-1">
            本地目录
          </SegmentedControlItem>
        </SegmentedControl>

        {tab !== 'files' && (
          <div className="flex items-center gap-2">
            {tab === 'local' && (
              <Checkbox
                size="sm"
                isSelected={allChecked}
                isIndeterminate={!allChecked && selectedInView > 0}
                onChange={(v) => onToggleAll(v)}
                isDisabled={committable.length === 0}
                aria-label="全选"
              />
            )}
            <span className="shrink-0 text-caption-1-regular text-text-tertiary">
              {tab === 'remote'
                ? remoteLoading
                  ? '正在检查服务器…'
                  : remoteFiles.length > 0
                    ? `${remoteFiles.length} 个文件待更新`
                    : '服务器上没有新内容'
                : selectedInView > 0
                  ? `已选 ${selectedInView} 个`
                  : '未选择'}
            </span>

            {/* 视图切换：默认平铺，可切成按目录层级 */}
            {tab === 'local' && (
              <IconButton
                size="small"
                icon={view === 'tree' ? RiListUnordered : RiNodeTree}
                aria-label={view === 'tree' ? '切换为列表视图' : '切换为树形视图'}
                title={view === 'tree' ? '当前：树形。点击切回列表' : '当前：列表。点击按目录层级展示'}
                onClick={() => setView((v) => (v === 'tree' ? 'flat' : 'tree'))}
              />
            )}

            {/* 提交按钮只对左侧勾选生效，所以跟着「待提交」走 */}
            {tab === 'local' && (
              <Button
                variant="primary"
                size="small"
                className="shrink-0"
                leadingIcon={RiUpload2Line}
                disabled={commitCount === 0}
                onClick={onCommit}
                title={commitCount > 0 ? '把勾选的改动提交到服务器（⌘K）' : '先勾选要提交的文件'}
              >
                提交{commitCount > 0 ? ` ${commitCount}` : ''}
              </Button>
            )}

            <label className="ml-auto flex shrink-0 items-center gap-1.5 text-caption-1-regular text-text-secondary">
              只看有风险
              <Switch size="sm" isSelected={onlyRisk} onChange={onOnlyRiskChange} aria-label="只看有风险" />
            </label>
          </div>
        )}
      </div>

      {tab === 'files' ? (
        <LocalDirPane
          wcPath={browse.wcPath}
          root={browse.root}
          children={browse.children}
          expanded={browse.expanded}
          loading={browse.loading}
          loadingDirs={browse.loadingDirs}
          error={browse.error}
          selected={browse.selected}
          revision={browse.revision}
          onToggleDir={browse.toggleDir}
          onOpenFile={browse.openFile}
          onOpenExternal={onOpenExternal}
          onRefresh={browse.refresh}
          onAction={onLocalAction}
        />
      ) : (
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
        {error && (
          <div className="mx-1 mt-1 flex gap-2 rounded-xl bg-red-50 px-3 py-2.5 dark:bg-red-500/10">
            <RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
            <div className="min-w-0 flex-1 text-caption-1-regular leading-relaxed text-red-900 dark:text-red-300">
              <p className="font-medium">读不到这个工作副本</p>
              <p className="mt-0.5 break-words text-caption-2-regular text-red-800/80 dark:text-red-300/80">
                {error}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-1.5 rounded-md bg-red-100 px-2 py-0.5 text-caption-2-medium text-red-800 transition-colors hover:bg-red-200 dark:bg-red-500/20 dark:text-red-300 dark:hover:bg-red-500/30"
              >
                重新扫描
              </button>
            </div>
          </div>
        )}
        {((loading && tab === 'local') || (remoteLoading && tab === 'remote')) &&
          visibleFiles.length === 0 && (
            <p className="px-3 py-6 text-center text-caption-1-regular text-text-tertiary">
              {tab === 'remote' ? '正在问服务器有哪些新内容…' : '正在读取状态…'}
            </p>
          )}
        {!loading && !error && !(tab === 'remote' && (remoteLoading || error)) && visibleFiles.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
            <RiFileList3Line className="size-7 text-foreground-icon-quaternary" />
            <p className="text-body-2-medium text-text-secondary">
              {tab === 'local' ? '没有待提交的改动' : '服务器上没有新内容'}
            </p>
            <p className="text-caption-1-regular text-text-tertiary">
              {onlyRisk
                ? '关掉「只看有风险」看看全部'
                : tab === 'local'
                  ? '改完文件后点右上角重新扫描'
                  : '点「更新到最新」向服务器确认一次'}
            </p>
          </div>
        )}

        {view === 'tree' && tab === 'local'
          ? treeRows.map((row) =>
              row.type === 'file' ? (
                fileRow(row.file, row.depth, true)
              ) : (
                <button
                  key={`dir:${row.path}`}
                  type="button"
                  data-tree-dir={row.path}
                  onClick={() => toggleDirRow(row.path)}
                  style={{ paddingLeft: 8 + row.depth * 14 }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[3px] text-left transition-colors hover:bg-background-primary-hover"
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    <RiArrowRightSLine
                      className={[
                        'size-3.5 text-foreground-icon-tertiary transition-transform',
                        row.collapsed ? '' : 'rotate-90',
                      ].join(' ')}
                    />
                  </span>
                  {row.collapsed ? (
                    <RiFolder3Line className="size-4 shrink-0 text-accent-600 dark:text-accent-400" />
                  ) : (
                    <RiFolderOpenLine className="size-4 shrink-0 text-accent-600 dark:text-accent-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">
                    {row.name}
                  </span>
                  <span className="shrink-0 font-mono text-caption-2-medium">
                    {row.added > 0 && <span className="text-green-700 dark:text-green-400">+{row.added}</span>}
                    {row.deleted > 0 && <span className="text-red-700 dark:text-red-400"> −{row.deleted}</span>}
                  </span>
                  <span className="shrink-0 text-caption-2-regular text-text-tertiary">
                    {row.fileCount} 个文件
                  </span>
                </button>
              )
            )
          : visibleFiles.map((file) => fileRow(file, 0))}
      </div>
      )}
    </section>
  );
}
