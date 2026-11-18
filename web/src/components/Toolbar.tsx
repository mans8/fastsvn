import {
  RiFolderDownloadLine,
  RiGitMergeLine,
  RiGitRepositoryLine,
  RiHistoryLine,
  RiRefreshLine,
  RiSettings3Line,
} from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { SidebarToggleIcon } from '@/src/components/SidebarToggleIcon';
import { postWindowAction } from '@/src/lib/bridge';
import { basename } from '@/src/lib/format';

interface Props {
  projectPath: string | null;
  /** 项目别名：不替代项目名，只在旁边挂一个小标签 */
  projectAlias?: string | null;
  /** 左侧项目栏是否展开 */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  branch?: string;
  revision?: number;
  conflictCount: number;
  busy: boolean;
  onCheckout: () => void;
  onBrowseRepo: () => void;
  onLog: () => void;
  onRefresh: () => void;
  onSync: () => void;
  onConflict: () => void;
  onSettings: () => void;
}

export function Toolbar({
  projectPath,
  projectAlias,
  sidebarOpen,
  onToggleSidebar,
  branch,
  revision,
  conflictCount,
  busy,
  onCheckout,
  onBrowseRepo,
  onLog,
  onRefresh,
  onSync,
  onConflict,
  onSettings,
}: Props) {
  const handleDoubleClick = (e: React.MouseEvent) => {
    // 双击工具栏空白处切换窗口最大化；点按钮不触发
    if ((e.target as HTMLElement).closest('button,a,input,[role="button"]')) return;
    postWindowAction('zoom');
  };

  return (
    <header
      data-toolbar
      onDoubleClick={handleDoubleClick}
      className="flex h-14 shrink-0 items-center gap-3 px-4"
      style={{ WebkitUserSelect: 'none', userSelect: 'none' }}
    >
      {/* 收起/展开左侧项目栏：位置紧贴标题左边，收起后仍然留在这里能点回来 */}
      <IconButton
        size="small"
        data-sidebar-toggle
        icon={(props) => <SidebarToggleIcon {...props} collapsed={!sidebarOpen} />}
        aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
        title={sidebarOpen ? '收起左侧项目栏' : '展开左侧项目栏'}
        onClick={onToggleSidebar}
      />

      <div className="min-w-0 flex-1">
        {projectPath ? (
          <div className="flex items-baseline gap-1.5">
            <span data-project-title className="truncate text-headline-semibold text-text-primary">
              {basename(projectPath)}
            </span>
            {projectAlias && (
              <span
                data-project-alias
                title={`别名：${projectAlias}`}
                className="shrink-0 whitespace-nowrap rounded-md bg-accent-50 px-1.5 py-0.5 text-caption-2-medium text-accent-700 dark:bg-accent-500/20 dark:text-accent-300"
              >
                {projectAlias}
              </span>
            )}
            {branch && (
              <span className="text-body-2-regular text-text-tertiary">· {branch}</span>
            )}
            {revision != null && (
              <span className="rounded-md bg-background-tertiary-default px-1.5 py-0.5 font-mono text-caption-2-medium text-text-secondary">
                r{revision}
              </span>
            )}
          </div>
        ) : (
          <span className="text-headline-semibold text-text-primary">FastSVN</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="small" leadingIcon={RiGitRepositoryLine} onClick={onBrowseRepo}>
          浏览仓库
        </Button>

        <Button variant="ghost" size="small" leadingIcon={RiFolderDownloadLine} onClick={onCheckout}>
          从服务器检出
        </Button>

        <IconButton
          size="small"
          icon={RiHistoryLine}
          aria-label="提交历史"
          title="提交历史"
          disabled={!projectPath}
          onClick={onLog}
        />

        <IconButton
          size="small"
          icon={RiRefreshLine}
          aria-label="重新扫描"
          title="重新扫描（⌘⇧R）"
          disabled={!projectPath || busy}
          onClick={onRefresh}
        />

        {conflictCount > 0 && (
          <Button variant="secondary" size="small" leadingIcon={RiGitMergeLine} onClick={onConflict}>
            有 {conflictCount} 个冲突
          </Button>
        )}

        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiGitMergeLine}
          disabled={!projectPath || busy}
          title="把同事已经提交的改动拉到本地（svn update）"
          onClick={onSync}
        >
          更新到最新
        </Button>

        {/* 侧栏收起后「设置」入口跟着没了，这里补一个，别让用户只能靠 ⌘, */}
        {!sidebarOpen && (
          <IconButton
            size="small"
            icon={RiSettings3Line}
            aria-label="设置"
            title="设置（⌘,）"
            onClick={onSettings}
          />
        )}
      </div>
    </header>
  );
}
