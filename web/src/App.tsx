import { useCallback, useEffect, useState } from 'react';
import { toast, Toaster } from '@/components/base/toast/toast';
import { AppSidebar } from '@/src/components/AppSidebar';
import { Toolbar } from '@/src/components/Toolbar';
import { FileList, type FileAction } from '@/src/components/FileList';
import { RenameHintBar } from '@/src/components/RenameHintBar';
import { DiffPane } from '@/src/components/DiffPane';
import { EmptyState } from '@/src/components/EmptyState';
import { StatusBar } from '@/src/components/StatusBar';
import { CheckoutDialog } from '@/src/components/dialogs/CheckoutDialog';
import { AddProjectDialog } from '@/src/components/dialogs/AddProjectDialog';
import { SettingsDialog } from '@/src/components/dialogs/SettingsDialog';
import { CommitDialog } from '@/src/components/dialogs/CommitDialog';
import { ConflictDialog } from '@/src/components/dialogs/ConflictDialog';
import { LogDialog } from '@/src/components/dialogs/LogDialog';
import { ConfirmDialog } from '@/src/components/dialogs/ConfirmDialog';
import { RenameDialog } from '@/src/components/dialogs/RenameDialog';
import { RepoBrowserDialog } from '@/src/components/dialogs/RepoBrowserDialog';
import { PromptDialog, type PromptConfig } from '@/src/components/dialogs/PromptDialog';
import { PreviewPane } from '@/src/components/PreviewPane';
import type { LocalAction, LocalTarget } from '@/src/components/LocalDirPane';
import { useTheme } from '@/src/hooks/useTheme';
import { useWorkspace } from '@/src/hooks/useWorkspace';
import { useLocalBrowser } from '@/src/hooks/useLocalBrowser';
import { useSettings } from '@/src/hooks/useSettings';
import { api, decodePercent, type CommitStreamEvent } from '@/src/lib/api';
import { basename } from '@/src/lib/format';
import type { FileChange, RenameCandidate } from '@/src/lib/types';

/** 把 svn update 的结果说成人话：更新了什么 / 什么都没更新 */
function updateSummary(updated: { name: string }[] | undefined) {
  const list = updated ?? [];
  if (!list.length) return '已经是最新的，没有需要更新的内容';
  const names = list.slice(0, 3).map((u) => u.name);
  const more = list.length > 3 ? ` 等 ${list.length} 个文件` : '';
  return `更新了 ${list.length} 个文件：${names.join('、')}${more}`;
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // WKWebView / permission fallback
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('剪贴板不可用');
}

type DialogId =
  | 'checkout'
  | 'addProject'
  | 'settings'
  | 'commit'
  | 'conflict'
  | 'log'
  | 'rename'
  | 'confirm'
  | 'repo'
  | 'prompt'
  | null;

export default function App() {
  const { theme, patch } = useTheme();
  const appSettings = useSettings();
  const ws = useWorkspace();
  const browse = useLocalBrowser(ws.current, ws.tab === 'files');

  const [dialog, setDialog] = useState<DialogId>(null);
  // 左侧项目栏是否展开：记在本地，下次打开还是上次的样子
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('fastsvn.sidebar') !== 'closed';
    } catch {
      return true;
    }
  });

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem('fastsvn.sidebar', next ? 'open' : 'closed');
      } catch {
        /* 隐私模式下写不了，忽略 */
      }
      return next;
    });
  }, []);
  const [renameTarget, setRenameTarget] = useState<FileChange | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    description?: string;
    confirmLabel: string;
    action: () => Promise<void>;
  } | null>(null);
  // 通用"问一个名字"弹窗：本地目录里新建子目录用
  const [promptState, setPromptState] = useState<PromptConfig | null>(null);
  // 提交历史的查看目标：null = 整个工作副本
  const [logTarget, setLogTarget] = useState<{ path: string; name: string } | null>(null);
  // 调试/自测：?dialog=checkout&cu=<url>&cp=<path> 自动开始一次检出
  // 从仓库浏览里「检出目录 / 下载」带过来的地址；普通检出为 null
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [checkoutMode, setCheckoutMode] = useState<'checkout' | 'export'>('checkout');
  // 从仓库浏览里打开时，检出弹窗叠在它上面，关掉后仓库浏览还在
  const [checkoutOverlay, setCheckoutOverlay] = useState(false);

  const [autoCheckout] = useState(() => {
    const qs = new URLSearchParams(location.search);
    const url = qs.get('cu');
    const path = qs.get('cp');
    return url && path ? { url, path } : null;
  });

  // 检出成功后刷新项目列表并选中新项目
  const handleCheckoutDone = useCallback(
    (job: { phase: string; path: string; mode?: string }) => {
      if (job.phase !== 'done') return;
      if (job.mode === 'export') {
        // 下载得到的是纯文件，没有 .svn，不能当项目打开
        toast('下载完成', { description: `已保存到 ${job.path}`, status: 'success' });
        return;
      }
      void (async () => {
        const items = await ws.loadWcs();
        if (items.some((i) => i.path === job.path)) {
          ws.selectWc(job.path);
        }
        toast('检出完成', { description: `已把 ${job.path} 加到项目列表`, status: 'success' });
      })();
    },
    [ws]
  );

  /** 打开检出/下载弹窗；fromRepo=true 时保持仓库浏览窗口开着 */
  const openTransfer = useCallback((url: string, mode: 'checkout' | 'export', fromRepo: boolean) => {
    setCheckoutUrl(url);
    setCheckoutMode(mode);
    if (fromRepo) {
      setCheckoutOverlay(true);
    } else {
      setDialog('checkout');
    }
  }, []);

  // ---- 操作 ----
  const doSync = useCallback(async () => {
    if (!ws.current) return;
    try {
      const r = await api.update(ws.current);
      // 同步之后服务器视图变了，远端列表必须重查
      await ws.refresh({ force: true, withRemote: true, forceRemote: true });
      toast('已更新到最新', {
        description: r.conflicts
          ? `有 ${r.conflicts} 个文件需要处理冲突`
          : updateSummary(r.updated),
        status: r.conflicts ? 'information' : 'success',
      });
    } catch (e) {
      toast('更新失败', { description: decodePercent((e as Error).message), status: 'error' });
    }
  }, [ws]);

  const doCommit = useCallback(
    async (message: string, onEvent: (event: CommitStreamEvent) => void) => {
      const wc = ws.current;
      if (!wc) throw new Error('没有选中项目');
      // 弹窗自己保留进度/成功/失败状态；这里只负责发请求和提交成功后刷新列表
      const result = await api.commitStream(
        wc,
        ws.activeChecked.map((f) => f.path),
        message,
        onEvent
      );
      await ws.refresh({ force: true });
      return result;
    },
    [ws]
  );

  /** 自动检测到的改名：弹确认框，确认后才把 missing + 未纳入还原成 svn move */
  const handleRenameRepair = useCallback(
    (candidate: RenameCandidate) => {
      const wc = ws.current;
      if (!wc) return;
      setConfirmState({
        title: '确认这是一次改名？',
        description:
          `把「${candidate.from}」还原为「${candidate.to}」的改名，并保留 SVN 历史。\n\n` +
          '只有确认文件确实是从旧路径改过来的才继续；否则请取消，分别处理删除和新增。',
        confirmLabel: '确认修复改名',
        action: async () => {
          await api.renameRepair(wc, candidate.from, candidate.to);
          await ws.refresh({ force: true });
          toast('已修复改名', {
            description: `${candidate.from.split('/').pop()} → ${candidate.to.split('/').pop()}（历史已保留）`,
            status: 'success',
          });
        },
      });
      setDialog('confirm');
    },
    [ws]
  );

  const handleFileAction = useCallback(
    async (action: FileAction, file: FileChange) => {
      const wc = ws.current;
      if (!wc) return;
      try {
        if (action === 'open') {
          await api.openFile(wc, file.path);
          return;
        }
        if (action === 'resolve') {
          setDialog('conflict');
          return;
        }
        if (action === 'rename') {
          setRenameTarget(file);
          return;
        }
        if (action === 'add') {
          const r = await api.add(wc, file.path);
          await ws.refresh({ force: true });
          toast('已加入版本管理', {
            description: r.skippedNoise
              ? `${file.name}（顺带跳过 ${r.skippedNoise} 个 .DS_Store）`
              : file.name,
            status: 'success',
          });
          return;
        }
        if (action === 'ignore') {
          await api.ignore(wc, file.path);
          await ws.refresh({ force: true });
          toast('已忽略', { description: `${file.name} 不会再出现在列表里`, status: 'success' });
          return;
        }
        if (action === 'delete') {
          setConfirmState({
            title: `删除「${file.name}」？`,
            description: '会先备份到本地快照目录，之后可以从那里取回。上传后同事那边也会消失。',
            confirmLabel: '删除',
            action: async () => {
              await api.remove(wc, file.path);
              await ws.refresh({ force: true });
              toast('已删除', { description: '原文件已备份到快照目录', status: 'success' });
            },
          });
          setDialog('confirm');
          return;
        }
        if (action === 'revert') {
          setConfirmState({
            title: `撤销「${file.name}」的修改？`,
            description: '这些改动会消失，但原文件会先备份到本地快照目录，之后可以恢复。',
            confirmLabel: '撤销修改',
            action: async () => {
              await api.revert(wc, [file.path]);
              await ws.refresh({ force: true });
              toast('已撤销', { description: '原内容已备份，可恢复', status: 'success' });
            },
          });
          setDialog('confirm');
        }
      } catch (e) {
        toast('操作失败', { description: decodePercent((e as Error).message), status: 'error' });
      }
    },
    [ws]
  );

  /** 本地目录树的右键操作：更新 / 删除 / 新建子目录 */
  const handleLocalAction = useCallback(
    async (action: LocalAction, target: LocalTarget) => {
      const wc = ws.current;
      if (!wc) return;
      try {
        if (action === 'update') {
          const r = await api.update(wc, target.path || undefined);
          await Promise.all([ws.refresh({ force: true }), browse.refresh()]);
          toast('已更新到最新', {
            description: updateSummary(r.updated),
            status: r.conflicts ? 'information' : 'success',
          });
          return;
        }

        if (action === 'history') {
          setLogTarget(target.path ? { path: target.path, name: target.name } : null);
          setDialog('log');
          return;
        }

        if (action === 'mkdir') {
          setPromptState({
            title: '新建子目录',
            description: `会在「${target.name || '工作副本'}」里创建一个新文件夹，已纳入版本控制的目录会自动排进待提交。`,
            label: '目录名',
            placeholder: '比如 assets',
            confirmLabel: '创建',
            onSubmit: async (name) => {
              await api.mkdir(wc, target.path, name);
              // 新建完展开父目录，让用户直接看到结果
              if (target.path) await browse.refreshDir(target.path);
              else await browse.refresh();
              await ws.refresh({ force: true });
              toast('已创建目录', { description: name, status: 'success' });
            },
          });
          setDialog('prompt');
          return;
        }

        if (action === 'delete') {
          setConfirmState({
            title: `删除「${target.name}」？`,
            description:
              '会先备份到本地快照目录，之后可以从那里取回。已纳入版本管理的文件，提交后同事那边也会消失。',
            confirmLabel: '删除',
            action: async () => {
              await api.remove(wc, target.path);
              await Promise.all([browse.refresh(), ws.refresh({ force: true })]);
              toast('已删除', { description: '原文件已备份到快照目录', status: 'success' });
            },
          });
          setDialog('confirm');
        }
      } catch (e) {
        toast('操作失败', { description: decodePercent((e as Error).message), status: 'error' });
      }
    },
    [ws, browse]
  );

  const conflictFile =
    ws.visibleFiles.find((f) => f.kind === 'conflicted') ??
    ws.localFiles.find((f) => f.kind === 'conflicted') ??
    null;
  const conflictFiles = ws.localFiles.filter((f) => f.kind === 'conflicted');

  // 调试/截图用：?dialog=checkout|settings|add|commit|log|conflict
  useEffect(() => {
    const want = new URLSearchParams(location.search).get('dialog');
    if (!want) return;
    const map: Record<string, DialogId> = {
      checkout: 'checkout',
      settings: 'settings',
      add: 'addProject',
      commit: 'commit',
      log: 'log',
      conflict: 'conflict',
      repo: 'repo',
    };
    if (map[want]) setDialog(map[want]);
  }, []);

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'r' && e.shiftKey) {
        e.preventDefault();
        void ws.refresh({ force: true });
      } else if (k === 'r') {
        e.preventDefault();
        void doSync();
      } else if (k === 'k') {
        e.preventDefault();
        if (ws.activeChecked.length) setDialog('commit');
      } else if (k === ',') {
        e.preventDefault();
        setDialog('settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ws, doSync]);

  const currentItem = ws.wcItems.find((i) => i.path === ws.current) ?? null;
  // 别名只做标签，不替代标题里的真实目录名
  const projectAlias = currentItem?.alias ?? null;

  const statusText = ws.busy ? '正在读取状态…' : ws.error ? '出错了' : '已是最新';

  return (
    <div className="flex h-full flex-col bg-background-full">
      <div className="flex min-h-0 flex-1" data-app-shell data-sidebar={sidebarOpen ? 'open' : 'closed'}>
        {sidebarOpen && (
        <AppSidebar
          items={ws.wcItems}
          current={ws.current}
          version={ws.version}
          onSelect={(path) => {
            const item = ws.wcItems.find((i) => i.path === path);
            // 打不开的目录不必切过去看一屏报错，直接说清楚原因
            if (item && !item.isWc) {
              toast('打不开这个项目', {
                description: item.exists
                  ? '这个目录里找不到 .svn，可能不是 SVN 工作副本'
                  : '这个目录已经不存在了，可以右键从列表里移除',
                status: 'error',
              });
              return;
            }
            ws.selectWc(path);
          }}
          onAdd={() => setDialog('addProject')}
          onSettings={() => setDialog('settings')}
          onAlias={(path) => {
            const item = ws.wcItems.find((i) => i.path === path);
            setPromptState({
              title: '设置别名',
              description: '别名只影响这里的显示，磁盘上的文件夹名和 svn 都不会变。留空等于恢复成目录名。',
              label: '显示名',
              placeholder: basename(path),
              defaultValue: item?.alias ?? '',
              allowEmpty: true,
              confirmLabel: '保存',
              onSubmit: async (name) => {
                await ws.setWcAlias(path, name);
                toast(name ? '已设置别名' : '已恢复成目录名', {
                  description: name ? `${basename(path)} → ${name}` : basename(path),
                  status: 'success',
                });
              },
            });
            setDialog('prompt');
          }}
          onCopyPath={(path) => {
            void copyTextToClipboard(path)
              .then(() => toast('路径已复制', { description: path, status: 'success' }))
              .catch((e) => toast('复制失败', { description: (e as Error).message, status: 'error' }));
          }}
          onRemove={(path) => {
            void (async () => {
              try {
                await ws.removeWc(path);
                toast('已从列表移除', {
                  description: `${basename(path)} 的本地文件没有被删除，随时可以再加回来`,
                  status: 'success',
                });
              } catch (e) {
                toast('移除失败', { description: decodePercent((e as Error).message), status: 'error' });
              }
            })();
          }}
        />
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <Toolbar
            projectPath={ws.current}
            projectAlias={projectAlias}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={toggleSidebar}
            branch={ws.status?.info?.branch}
            revision={ws.status?.info?.revision}
            conflictCount={conflictFiles.length}
            busy={ws.busy}
            onCheckout={() => {
              setCheckoutUrl(null);
              setCheckoutMode('checkout');
              setDialog('checkout');
            }}
            onBrowseRepo={() => setDialog('repo')}
            onLog={() => {
              setLogTarget(null);
              setDialog('log');
            }}
            onRefresh={() => void ws.refresh({ force: true, forceRemote: ws.tab === 'remote' })}
            onSync={() => void doSync()}
            onConflict={() => setDialog('conflict')}
            onSettings={() => setDialog('settings')}
          />

          {ws.current ? (
            <div className="flex min-h-0 flex-1 gap-3 px-4 pb-1">
              <div className="flex min-h-0 flex-col gap-2 [&>section]:min-h-0 [&>section]:flex-1">
              <RenameHintBar
                candidates={ws.status?.renameCandidates ?? []}
                busy={ws.busy}
                onRepair={handleRenameRepair}
              />
              <FileList
                tab={ws.tab}
                onTabChange={ws.setTab}
                localFiles={ws.localFiles}
                remoteFiles={ws.remoteFiles}
                visibleFiles={ws.visibleFiles}
                selected={ws.selected}
                checked={ws.checked}
                onlyRisk={ws.onlyRisk}
                onOnlyRiskChange={ws.setOnlyRisk}
                onSelect={ws.selectFile}
                onToggleChecked={ws.toggleChecked}
                onToggleAll={ws.toggleAll}
                onAction={(a, f) => void handleFileAction(a, f)}
                loading={ws.busy}
                remoteLoading={ws.remoteLoading}
                error={ws.error}
                onRetry={() => void ws.refresh({ force: true })}
                browse={browse}
                commitCount={ws.activeChecked.length}
                onCommit={() => setDialog('commit')}
                onLocalAction={(action, target) => void handleLocalAction(action, target)}
                onOpenExternal={(entry) => {
                  if (!ws.current) return;
                  void api
                    .openFile(ws.current, entry.path)
                    .catch((e) =>
                      toast('打不开这个文件', {
                        description: decodePercent((e as Error).message),
                        status: 'error',
                      })
                    );
                }}
              />
              </div>
              {ws.tab === 'files' ? (
                <PreviewPane
                  entry={browse.selected}
                  preview={browse.preview}
                  loading={browse.previewLoading}
                />
              ) : (
                <DiffPane
                  file={ws.selectedFile}
                  diff={ws.diff}
                  loading={ws.diffLoading}
                  expanded={ws.diffExpanded}
                  onToggleExpand={ws.toggleDiffExpanded}
                />
              )}
            </div>
          ) : (
            <EmptyState
              onAddExisting={() => setDialog('addProject')}
              onCheckout={() => {
              setCheckoutUrl(null);
              setCheckoutMode('checkout');
              setDialog('checkout');
            }}
            />
          )}

          <StatusBar
            text={statusText}
            error={ws.error}
            busy={ws.busy}
            tookMs={ws.tookMs}
            fromCache={ws.fromCache}
            engineReady={ws.engineReady}
          />
        </main>
      </div>

      {/* ---- 对话框 ---- */}
      <AddProjectDialog
        isOpen={dialog === 'addProject'}
        onOpenChange={(open) => setDialog(open ? 'addProject' : null)}
        onAdded={(path) => {
          void (async () => {
            const items = await ws.loadWcs();
            if (items.some((i) => i.path === path)) ws.selectWc(path);
          })();
        }}
      />

      <SettingsDialog
        isOpen={dialog === 'settings'}
        onOpenChange={(open) => setDialog(open ? 'settings' : null)}
        theme={theme}
        patchTheme={patch}
        settings={appSettings.settings}
        patchSettings={(next) => {
          void (async () => {
            try {
              await appSettings.patch(next);
              // 过滤规则在后端，改完必须重扫一次，列表才会立刻变
              await ws.refresh({ force: true, withRemote: ws.tab === 'remote', forceRemote: true });
              // 本地目录树也有 .DS_Store，重读一次
              if (ws.tab === 'files') browse.refresh();
            } catch (e) {
              toast('设置没保存成功', {
                description: decodePercent((e as Error).message),
                status: 'error',
              });
            }
          })();
        }}
        version={ws.version}
        engineReady={ws.engineReady}
        svnEmbedded={ws.svnEmbedded}
        svnVersion={ws.svnVersion}
        bundled={ws.bundled}
      />

      <CommitDialog
        isOpen={dialog === 'commit'}
        onOpenChange={(open) => setDialog(open ? 'commit' : null)}
        files={ws.activeChecked}
        onSubmit={doCommit}
      />

      <ConflictDialog
        isOpen={dialog === 'conflict'}
        onOpenChange={(open) => setDialog(open ? 'conflict' : null)}
        wcPath={ws.current}
        file={conflictFile}
        conflictFiles={conflictFiles}
        onResolved={() => {
          void ws.refresh({ force: true });
          toast('冲突已解决', { status: 'success' });
        }}
      />

      <LogDialog
        isOpen={dialog === 'log'}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setLogTarget(null);
          }
        }}
        wcPath={ws.current}
        target={logTarget}
      />

      <RenameDialog
        file={dialog === 'rename' ? renameTarget : null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setRenameTarget(null);
          }
        }}
        onSubmit={async (newName) => {
          if (!ws.current || !renameTarget) return;
          await api.rename(ws.current, renameTarget.path, newName);
          await ws.refresh({ force: true });
          toast('已重命名', { description: `${renameTarget.name} → ${newName}`, status: 'success' });
        }}
      />

      <PromptDialog
        isOpen={dialog === 'prompt'}
        config={promptState}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setPromptState(null);
          }
        }}
      />

      <ConfirmDialog
        isOpen={dialog === 'confirm'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={confirmState?.title ?? ''}
        description={confirmState?.description}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={async () => {
          try {
            await confirmState?.action();
            setDialog(null);
          } catch (e) {
            toast('操作失败', { description: decodePercent((e as Error).message), status: 'error' });
          }
        }}
      />

      <RepoBrowserDialog
        isOpen={dialog === 'repo'}
        onOpenChange={(open) => setDialog(open ? 'repo' : null)}
        defaultUrl={ws.status?.info?.url}
        onCheckout={(url) => openTransfer(url, 'checkout', true)}
        onDownload={(url) => openTransfer(url, 'export', true)}
      />

      {/* 放在仓库浏览之后：两者同为 z-100，DOM 顺序决定谁在上层。
          从仓库浏览打开时不关闭它，关掉检出后还能接着浏览。 */}
      <CheckoutDialog
        isOpen={dialog === 'checkout' || checkoutOverlay}
        onOpenChange={(open) => {
          if (open) return;
          setCheckoutOverlay(false);
          setCheckoutUrl(null);
          setDialog((d) => (d === 'checkout' ? null : d));
        }}
        onFinished={handleCheckoutDone}
        autoStart={autoCheckout}
        initialUrl={checkoutUrl}
        mode={checkoutMode}
      />

      <Toaster />
    </div>
  );
}
