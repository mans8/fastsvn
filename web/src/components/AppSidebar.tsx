import {
  RiAddLine,
  RiDeleteBin6Line,
  RiFileCopyLine,
  RiFolder3Line,
  RiFolderOpenLine,
  RiPriceTag3Line,
  RiRouteLine,
  RiSettings3Line,
} from '@remixicon/react';
import { IconButton } from '@/components/base/buttons/icon-button';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/base/context-menu/context-menu';
import { api } from '@/src/lib/api';
import { basename, tildify } from '@/src/lib/format';
import type { WcItem } from '@/src/lib/types';

interface Props {
  items: WcItem[];
  current: string | null;
  /** 版本号：显示在品牌块下方，和标题一样一眼能看到 */
  version: string;
  onSelect: (path: string) => void;
  onAdd: () => void;
  onSettings: () => void;
  /** 只从列表移除，磁盘上的文件夹不动 */
  onRemove: (path: string) => void;
  /** 设置显示别名（不影响磁盘目录名） */
  onAlias: (path: string) => void;
  /** 修改仓库地址（svn relocate） */
  onRelocate: (path: string) => void;
  onCopyPath: (path: string) => void;
}

export function AppSidebar({
  items,
  current,
  version,
  onSelect,
  onAdd,
  onSettings,
  onRemove,
  onAlias,
  onRelocate,
  onCopyPath,
}: Props) {
  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-border-button-default bg-background-secondary-default">
      {/* 品牌区：名字居左，版本号当小字跟在右边（桌面应用内左侧留出交通灯空间） */}
      <div data-brand-row className="flex items-baseline gap-2 px-4 pt-4 pb-3">
        <span className="truncate text-title-3-semibold leading-tight text-text-primary">FastSVN</span>
        <span className="shrink-0 text-caption-1-regular tabular-nums text-text-tertiary">
          V{version}
        </span>
      </div>

      {/* 项目区标题：+ 跟在这行，才看得出它是"往这个列表里加" */}
      <div className="flex items-center gap-1 px-3 pb-1.5">
        <span className="px-1 text-caption-2-semibold tracking-wide text-text-tertiary uppercase">
          我的项目
        </span>
        <IconButton
          className="ml-auto"
          size="small"
          icon={RiAddLine}
          aria-label="添加已有项目"
          title="添加已有项目"
          onClick={onAdd}
        />
      </div>

      <nav className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {items.length === 0 && (
          <p className="px-2 py-3 text-caption-1-regular leading-relaxed text-text-tertiary">
            还没有项目。点「我的项目」右侧的 + 添加，或从服务器检出。
          </p>
        )}
        {items.map((item) => {
          const path = item.path;
          const active = path === current;
          // 找不到 .svn 的目录不是工作副本，整行灰掉，别让人以为只是"加载慢"
          const broken = !item.isWc;
          const name = basename(path);
          return (
            <ContextMenuTrigger key={path}>
              <button
                type="button"
                onClick={() => onSelect(path)}
                aria-current={active ? 'true' : undefined}
                data-project-path={path}
                data-project-broken={broken ? 'true' : undefined}
                title={
                  broken
                    ? item.exists
                      ? '这个目录里找不到 .svn，不是 SVN 工作副本'
                      : '这个目录已经不存在了'
                    : item.alias
                      ? `别名：${item.alias}\n${tildify(path)}`
                      : tildify(path)
                }
                className={[
                  'group mb-0.5 flex w-full items-center gap-2.5 overflow-hidden rounded-xl px-2.5 py-2 text-left transition-colors',
                  active
                    ? broken
                      ? 'bg-background-primary-hover'
                      : 'bg-accent-50 dark:bg-accent-500/15'
                    : 'bg-transparent hover:bg-background-primary-hover',
                ].join(' ')}
              >
                <RiFolder3Line
                  className={[
                    'size-4 shrink-0',
                    broken
                      ? 'text-foreground-icon-quaternary'
                      : active
                        ? 'text-accent-600 dark:text-accent-400'
                        : 'text-accent-600/70 dark:text-accent-400/80',
                  ].join(' ')}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={[
                        'truncate text-body-2-medium',
                        // 项目名统一用主题色；当前打开的这个加粗
                        broken
                          ? 'text-text-tertiary'
                          : 'text-accent-700 dark:text-accent-300',
                        active ? 'font-semibold' : '',
                      ].join(' ')}
                    >
                      {name}
                    </span>
                    {broken && (
                      <span className="shrink-0 rounded bg-background-tertiary-default px-1 text-[10px] leading-[15px] text-text-tertiary">
                        {item.exists ? '无 .svn' : '已丢失'}
                      </span>
                    )}
                    {/* 别名不替代名字：小标签跟在名字后面 */}
                    {item.alias && !broken && (
                      <span
                        data-project-alias
                        title={`别名：${item.alias}`}
                        className="shrink-0 whitespace-nowrap rounded bg-accent-50 px-1 text-[10px] leading-[15px] text-accent-700 dark:bg-accent-500/20 dark:text-accent-300"
                      >
                        {item.alias}
                      </span>
                    )}
                  </span>
                  <span
                    className={[
                      'block truncate text-caption-2-regular',
                      broken ? 'text-text-disabled' : 'text-text-tertiary',
                    ].join(' ')}
                  >
                    {tildify(path)}
                  </span>
                </span>
              </button>

              <ContextMenu
                aria-label={`项目操作：${name}`}
                onAction={(key) => {
                  if (key === 'alias') onAlias(path);
                  if (key === 'relocate') onRelocate(path);
                  if (key === 'copy-path') onCopyPath(path);
                  if (key === 'reveal') void api.reveal(path).catch(() => {});
                  if (key === 'remove') onRemove(path);
                }}
              >
                <ContextMenuItem id="alias" icon={RiPriceTag3Line}>
                  设置别名…
                </ContextMenuItem>
                <ContextMenuItem id="copy-path" icon={RiFileCopyLine}>
                  复制路径
                </ContextMenuItem>
                <ContextMenuItem id="reveal" icon={RiFolderOpenLine}>
                  在访达中显示
                </ContextMenuItem>
                {/* 没有 .svn 就没有可 relocate 的工作副本 */}
                <ContextMenuItem id="relocate" icon={RiRouteLine} isDisabled={broken}>
                  修改仓库地址…
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem id="remove" icon={RiDeleteBin6Line} variant="danger">
                  移除项目
                </ContextMenuItem>
              </ContextMenu>
            </ContextMenuTrigger>
          );
        })}
      </nav>

      <div className="border-t border-border-button-default p-2">
        <button
          type="button"
          onClick={onSettings}
          className="flex w-full items-center gap-2.5 rounded-xl bg-transparent px-2.5 py-2 text-left text-body-2-medium text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
        >
          <RiSettings3Line className="size-4 shrink-0 text-foreground-icon-tertiary" />
          设置
        </button>
      </div>
    </aside>
  );
}
