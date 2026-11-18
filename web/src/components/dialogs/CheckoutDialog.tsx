import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RiAlertLine, RiCheckLine, RiFolderDownloadLine, RiFolderOpenLine, RiLinkM } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { Input } from '@/components/base/input/input';
import { ProgressTrack } from '@/components/base/progress/progress';
import { useCheckout } from '@/src/hooks/useCheckout';
import { api, decodePercent } from '@/src/lib/api';
import { canPickFolder, pickFolder } from '@/src/lib/bridge';
import { formatDuration, formatSize, prettyUrl } from '@/src/lib/format';
import type { CheckoutJob } from '@/src/lib/types';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished: (job: CheckoutJob) => void;
  /** 调试/自测用：给定地址与路径时自动开始，便于无人工介入地验证进度界面 */
  autoStart?: { url: string; path: string } | null;
  /** 从仓库浏览带过来的地址（只预填，不自动开始） */
  initialUrl?: string | null;
  /** checkout=检出（生成工作副本）；export=下载（纯文件，不带 .svn） */
  mode?: 'checkout' | 'export';
}

/** 从仓库地址猜一个仓库名，用来建议本地文件夹 */
function repoNameFrom(url: string): string {
  const clean = url.trim().replace(/\/+$/, '');
  if (!clean) return '';
  const last = clean.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/, '') || '';
}

function suggestPath(url: string): string {
  const name = repoNameFrom(url);
  if (!name) return '';
  // 默认落到「下载」目录：这是用户对"下载"的直觉位置。
  // 用 ~ 是给用户看的习惯写法；后端要求绝对路径，提交前会展开。
  return `~/Downloads/${name}`;
}

export function CheckoutDialog({
  isOpen,
  onOpenChange,
  onFinished,
  autoStart,
  initialUrl,
  mode = 'checkout',
}: Props) {
  const isExport = mode === 'export';
  const { job, starting, formError, start, cancel, reset } = useCheckout(onFinished);
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [touchedPath, setTouchedPath] = useState(false);
  const [picking, setPicking] = useState(false);
  const canPick = useMemo(() => canPickFolder(), []);

  /** 访达选目录：选中后拼上名字，用户可以再改 */
  const chooseFolder = useCallback(async () => {
    const name = repoNameFrom(url) || 'download';
    setPicking(true);
    try {
      // ~ 由原生侧展开，这里原样传过去当面板的初始位置
      const dir = await pickFolder(target);
      if (!dir) return;
      setTouchedPath(true);
      setTarget(`${dir.replace(/\/+$/, '')}/${name}`);
    } finally {
      setPicking(false);
    }
  }, [target, url]);

  /** 在访达里打开刚下载的位置 */
  const openInFinder = useCallback(async () => {
    const targetPath = job?.path;
    if (!targetPath) return;
    try {
      await api.reveal(targetPath);
    } catch (e) {
      // 失败不阻塞收尾，用标题栏下方的错误行提示即可
      console.warn('打开访达失败', decodePercent((e as Error).message));
    }
  }, [job?.path]);

  // 地址变化时，若用户没手动改过本地位置，自动跟着更新建议路径
  useEffect(() => {
    if (!touchedPath) setTarget(suggestPath(url));
  }, [url, touchedPath]);

  // 调试自动开始（只在带参数时生效）
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    setUrl(autoStart.url);
    setTarget(autoStart.path);
    setTouchedPath(true);
    void start(autoStart.url, autoStart.path, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // 从仓库浏览「检出这个目录」进来时预填地址。
  // 只填地址不自动开始：本地文件夹要用户自己确认。
  useEffect(() => {
    if (!isOpen || !initialUrl) return;
    // 仅供展示：svn 给的是百分号编码，中文仓库地址直接显示会是一串 %E4%B8%AD
    setUrl(prettyUrl(initialUrl));
    setTouchedPath(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialUrl]);

  // 关闭时清空，避免下次打开留着上次的任务
  useEffect(() => {
    if (!isOpen) {
      reset();
      setUrl('');
      setTarget('');
      setTouchedPath(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const running = job && !['done', 'failed', 'cancelled'].includes(job.phase);
  const done = job?.phase === 'done';
  const failed = job?.phase === 'failed';

  const canStart = url.trim().length > 0 && target.trim().length > 0 && !starting && !running;

  const percent = job?.percent != null ? Math.round(job.percent * 100) : null;
  const indeterminate = Boolean(job && job.percent == null && running);

  const statusLine = useMemo(() => {
    if (!job) return '';
    if (job.phase === 'preparing') return '正在读取仓库文件清单…';
    if (job.phase === 'downloading') {
      return job.bytesTotal > 0 ? `正在下载 · 共 ${job.bytesTotalText}` : '正在下载文件…';
    }
    return job.message;
  }, [job]);

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" className="min-h-[300px]">
      <ModalHeader
        title={
          done
            ? isExport
              ? '下载完成'
              : '检出完成'
            : failed
              ? isExport
                ? '下载失败'
                : '检出失败'
              : running
                ? isExport
                  ? '正在下载'
                  : '正在检出'
                : isExport
                  ? '下载到本地'
                  : initialUrl
                    ? '检出这个目录'
                    : '从服务器检出'
        }
        description={
          done
            ? isExport
              ? '文件已经保存到你指定的位置。'
              : '已经加到左侧项目列表，可以直接开始用。'
            : running
              ? '文件正在下载到本地，可以随时停止。'
              : isExport
                ? '把仓库里的文件复制到本地，不带版本控制信息。'
                : '填服务器地址和本地文件夹，把仓库下载到这台电脑。'
        }
        showCloseButton={!running}
      />

      <ModalBody>
        {!job && (
          <div className="flex flex-col gap-4">
            <Input
              label="服务器地址"
              placeholder="https://svn.example.com/repo/trunk"
              value={url}
              onChange={(value) => setUrl(value)}
              leadingIcon={RiLinkM}
              // 仓库地址往往很长：字号小一点 + 等宽，才能一屏看全
              inputClassName="font-mono text-[12px]"
              autoFocus
            />
            <Input
              label="保存到"
              placeholder="~/Downloads/项目名"
              inputClassName="font-mono text-[12px]"
              trailingAddon={
                <Button
                  variant="ghost"
                  size="small"
                  className="me-1 shrink-0"
                  disabled={picking}
                  aria-label={canPick ? '在访达中选择目录' : '仅桌面应用支持访达选择'}
                  onClick={() => void chooseFolder()}
                >
                  {picking ? '选择中…' : '选择…'}
                </Button>
              }
              value={target}
              onChange={(value) => {
                setTouchedPath(true);
                setTarget(value);
              }}
              hint={
                isExport
                  ? '下载目录时这里是文件夹（需空目录）；下载单个文件时请写到文件名。'
                  : '会在这个位置新建文件夹；如果已存在，需要是空文件夹。'
              }
            />
            {formError && (
              <p className="flex items-start gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-caption-1-regular text-text-error-primary dark:bg-red-500/10">
                <RiAlertLine className="mt-px size-3.5 shrink-0" />
                {formError}
              </p>
            )}
          </div>
        )}

        {job && (
          <div className="flex flex-col gap-4">
            {/* 进度主区 */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-end justify-between">
                <span className="font-mono text-title-2-semibold tabular-nums text-text-primary">
                  {percent != null ? `${percent}%` : '—'}
                </span>
                <span className="text-caption-1-regular text-text-secondary">{statusLine}</span>
              </div>

              <ProgressTrack
                percentage={percent ?? 0}
                size="lg"
                isIndeterminate={Boolean(indeterminate)}
              />

              {/* 关键指标：文件数 / 体积 / 速度 —— 一行三项，等宽对齐 */}
              <div className="grid grid-cols-3 gap-2 pt-0.5">
                <Metric
                  label="条目"
                  value={
                    // 导出目录时 svn 会为目标目录本身也打一行 A，分母里没有它，
                    // 不夹一下就会出现 "2 / 1" 这种超过总量的读数
                    job.filesTotal > 0
                      ? `${Math.min(job.filesDone, job.filesTotal)} / ${job.filesTotal}`
                      : `${job.filesDone}`
                  }
                />
                <Metric label="已接收" value={formatSize(job.bytesDone)} />
                <Metric
                  label="速度"
                  value={
                    running
                      ? job.speedText || '—'
                      : done
                        ? job.avgSpeedText || '—'
                        : '—'
                  }
                  highlight={Boolean(running)}
                />
              </div>
            </div>

            {job.warn ? (
              <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-caption-1-regular leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-300">
                <RiAlertLine className="mt-px size-3.5 shrink-0" />
                {job.warn}
              </p>
            ) : null}

            {failed && job.error && (
              <p className="flex items-start gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-caption-1-regular text-text-error-primary dark:bg-red-500/10">
                <RiAlertLine className="mt-px size-3.5 shrink-0" />
                {job.error}
              </p>
            )}

            {done && (
              <div className="flex items-center gap-2 rounded-xl bg-green-50 px-3 py-2 text-caption-1-regular text-green-800 dark:bg-green-500/10 dark:text-green-300">
                <RiCheckLine className="size-4 shrink-0" />
                {isExport ? '已下载' : '已检出'} 用时 {formatDuration(job.elapsedMs)}，共{' '}
                {job.fileCount || job.filesDone} 个文件
                {job.avgSpeedText ? `，平均 ${job.avgSpeedText}` : ''}
              </div>
            )}

            {/* 目标信息：地址与本地目录各占一行、各自带标签。
                截断改成换行（break-all）——地址里的中文段落在末尾，
                截断后最关键的部分反而看不见。 */}
            <div className="rounded-xl bg-background-secondary-default px-3 py-2.5">
              <div className="flex items-start gap-3">
                <span className="w-14 shrink-0 text-caption-1-regular leading-[18px] text-text-tertiary">
                  SVN 地址
                </span>
                <span
                  className="min-w-0 flex-1 break-all font-mono text-caption-1-regular leading-[18px] text-text-secondary"
                  title={prettyUrl(job.url)}
                >
                  {prettyUrl(job.url)}
                </span>
              </div>
              <div className="mt-1.5 flex items-start gap-3">
                <span className="w-14 shrink-0 text-caption-1-regular leading-[18px] text-text-tertiary">
                  本地目录
                </span>
                <span
                  className="min-w-0 flex-1 break-all font-mono text-caption-1-regular leading-[18px] text-text-secondary"
                  title={job.path}
                >
                  {job.path}
                </span>
                {done && (
                  <button
                    type="button"
                    onClick={() => void openInFinder()}
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-medium text-accent-700 transition-colors hover:bg-accent-50 dark:text-accent-300 dark:hover:bg-accent-500/15"
                  >
                    <RiFolderOpenLine className="size-3.5" />
                    打开目录
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        {running && (
          <Button variant="secondary" onClick={cancel}>
            停止
          </Button>
        )}
        {!job && (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              leadingIcon={RiFolderDownloadLine}
              disabled={!canStart}
              onClick={() => void start(url, target, mode)}
            >
              {starting ? '正在开始…' : isExport ? '开始下载' : '开始检出'}
            </Button>
          </>
        )}
        {/* 失败态不再放「关闭」：右上角就有 ×，底部只留真正要做的事 */}
        {job && !running && !done && (
          <Button variant="primary" onClick={reset}>
            重新填地址
          </Button>
        )}
        {done && (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

function Metric({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl bg-background-secondary-default px-2.5 py-2">
      <div className="text-caption-2-regular text-text-tertiary">{label}</div>
      <div
        className={[
          'truncate font-mono text-body-2-semibold whitespace-nowrap tabular-nums',
          highlight ? 'text-accent-700 dark:text-accent-300' : 'text-text-primary',
        ].join(' ')}
      >
        {value}
        {sub && <span className="ml-1 text-caption-2-regular text-text-tertiary">{sub}</span>}
      </div>
    </div>
  );
}
