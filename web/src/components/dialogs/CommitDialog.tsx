import { useEffect, useMemo, useState } from 'react';
import { RiAlertLine, RiCheckLine, RiUpload2Line } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { SpinnerGlyph } from '@/components/base/spinner/spinner';
import { Textarea } from '@/components/base/textarea/textarea';
import type { CommitStreamEvent } from '@/src/lib/api';
import type { FileChange } from '@/src/lib/types';
import { kindMeta } from '@/src/lib/status-meta';
import { riskLabel } from '@/src/lib/risk';

type Phase = 'idle' | 'running' | 'done' | 'error';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  files: FileChange[];
  /** 真正执行提交；进度通过 onEvent 实时回传，弹窗不关 */
  onSubmit: (message: string, onEvent: (event: CommitStreamEvent) => void) => Promise<{ revision: number }>;
}

export function CommitDialog({ isOpen, onOpenChange, files, onSubmit }: Props) {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [queued, setQueued] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [phaseText, setPhaseText] = useState('');
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // 提交成功后工作区会被刷新（待提交清空），弹窗里要留住"这次提交了哪些文件"
  const [snapshot, setSnapshot] = useState<FileChange[] | null>(null);

  // 关掉弹窗就回到初始状态：下次打开不该看到上次的进度或成功提示
  useEffect(() => {
    if (!isOpen) {
      setMessage('');
      setPhase('idle');
      setQueued(0);
      setUploaded(0);
      setCurrentFile(null);
      setPhaseText('');
      setSent(new Set());
      setRevision(null);
      setError(null);
      setErrorDetail(null);
      setSnapshot(null);
    }
  }, [isOpen]);

  // 一旦开始提交就用快照渲染，避免刷新后列表变空、数字变 0
  const viewFiles = snapshot ?? files;

  const stats = useMemo(() => {
    const added = viewFiles.reduce((s, f) => s + (f.binary ? 0 : f.added), 0);
    const deleted = viewFiles.reduce((s, f) => s + (f.binary ? 0 : f.deleted), 0);
    const risky = viewFiles.filter((f) => f.risk);
    const binaries = viewFiles.filter((f) => f.binary);
    return { added, deleted, risky, binaries };
  }, [viewFiles]);

  const total = stats.added + stats.deleted;
  const addRatio = total > 0 ? (stats.added / total) * 100 : 0;
  const fileTotal = viewFiles.length;
  const percent = fileTotal > 0 ? Math.round((Math.min(uploaded, fileTotal) / fileTotal) * 100) : 0;
  const running = phase === 'running';

  // 说清楚"要留意什么"，而不是干巴巴一句"需要确认"
  const riskSummary = useMemo(() => {
    const counts = { binary: 0, large: 0, secret: 0 };
    for (const f of stats.risky) {
      const code = f.risk?.code;
      if (code === 'binaryGrowth') counts.binary++;
      else if (code === 'largeFile') counts.large++;
      else if (code === 'secret') counts.secret++;
    }
    const parts: string[] = [];
    if (counts.binary) parts.push(`${counts.binary} 个是二进制文件，看不到文本差异`);
    if (counts.large) parts.push(`${counts.large} 个是大文件，不做逐行对比`);
    if (counts.secret) parts.push(`${counts.secret} 个像密钥或凭据，不该进版本库`);
    return `${parts.length ? parts.join('；') : '这些文件有需要留意的地方'}；确认它们确实该进版本库。`;
  }, [stats.risky]);

  const start = async () => {
    if (running) return;
    setPhase('running');
    setSnapshot(files);
    setQueued(0);
    setUploaded(0);
    setCurrentFile(null);
    setPhaseText('正在准备要提交的改动…');
    setSent(new Set());
    setRevision(null);
    setError(null);
    setErrorDetail(null);
    try {
      const result = await onSubmit(message.trim(), (event) => {
        if (event.type === 'queued') {
          setQueued(event.done);
          setCurrentFile(event.path);
          setSent((prev) => new Set(prev).add(event.path));
        } else if (event.type === 'progress') {
          setUploaded(event.done);
        } else if (event.type === 'phase') {
          setPhaseText(event.message);
        } else if (event.type === 'done') {
          setUploaded(fileTotal);
        }
      });
      setRevision(result.revision);
      setPhase('done');
    } catch (e) {
      setError((e as Error).message);
      setErrorDetail((e as Error & { detail?: string }).detail ?? null);
      setPhase('error');
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="xl"
      className="h-[min(760px,calc(100dvh-48px))] min-w-[720px]"
      // 提交过程中不允许背景关闭：关掉看不到进度，也容易让人以为提交被取消了
      isDismissable={!running}
      isKeyboardDismissDisabled={running}
    >
      <ModalHeader
        title="提交我的改动"
        description={
          phase === 'done'
            ? `已提交到服务器，同事更新后就能看到。`
            : `这次会把 ${viewFiles.length} 项改动提交到服务器，其他人同步后就能看到。`
        }
        showCloseButton={!running}
      />

      <ModalBody className="flex flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {/* 进度 / 结果：提交后原地显示，不弹 toast、不关窗 */}
          {phase !== 'idle' && (
            <div
              className={[
                'rounded-xl px-3 py-2.5',
                phase === 'error'
                  ? 'bg-red-50 dark:bg-red-500/10'
                  : phase === 'done'
                    ? 'bg-green-50 dark:bg-green-500/10'
                    : 'bg-background-secondary-default',
              ].join(' ')}
              data-commit-status={phase}
            >
              {phase === 'running' && (
                <>
                  <div className="flex items-center gap-2 text-caption-1-regular text-text-secondary">
                    {uploaded === 0 && queued > 0 ? (
                      <RiUpload2Line className="size-4 shrink-0 text-foreground-icon-secondary" />
                    ) : (
                      <SpinnerGlyph size="sm" className="shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {phaseText || '正在提交…'}
                    </span>
                    <span className="shrink-0 font-mono text-caption-2-medium text-text-tertiary tabular-nums">
                      {uploaded > 0 ? `${uploaded} / ${fileTotal}` : `${queued} / ${fileTotal}`}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background-tertiary-default">
                    <span
                      className="block h-full rounded-full bg-background-primary-default transition-[width] duration-300"
                      style={{ width: `${uploaded > 0 ? Math.max(percent, 4) : queued > 0 ? 2 : 1}%` }}
                    />
                  </div>
                  {currentFile && (
                    <p className="mt-1.5 truncate font-mono text-caption-2-regular text-text-tertiary">
                      {currentFile}
                    </p>
                  )}
                </>
              )}

              {phase === 'done' && (
                <div className="flex items-start gap-2">
                  <RiCheckLine className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400" />
                  <div className="min-w-0">
                    <p className="text-caption-1-semibold text-green-800 dark:text-green-300">
                      提交成功{revision ? ` · r${revision}` : ''}
                    </p>
                    <p className="mt-0.5 text-caption-2-regular text-green-700/80 dark:text-green-400/80">
                      {fileTotal} 项改动已进入版本库，其他人更新后就能看到。
                    </p>
                  </div>
                </div>
              )}

              {phase === 'error' && (
                <div className="flex items-start gap-2">
                  <RiAlertLine className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
                  <div className="min-w-0">
                    <p className="text-caption-1-semibold text-red-800 dark:text-red-300">提交失败</p>
                    <p className="mt-0.5 break-words text-caption-2-regular leading-relaxed text-red-700 dark:text-red-300">
                      {error}
                    </p>
                    {/* 结论是归纳过的；服务器/钩子的原文默认折叠，排查时能直接看到并复制 */}
                    {errorDetail && (
                      <details className="mt-1.5" data-commit-error-detail>
                        <summary className="cursor-pointer select-none text-caption-2-medium text-red-700/80 dark:text-red-300/80">
                          查看原始报错
                        </summary>
                        <pre className="thin-scroll mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-red-100/70 p-2 font-mono text-caption-2-regular leading-relaxed text-red-800 dark:bg-red-500/10 dark:text-red-300">
                          {errorDetail}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 总量四宫格 */}
          <div className="grid grid-cols-4 gap-2">
            <Stat label="文件" value={String(viewFiles.length)} />
            <Stat label="新增行" value={`+${stats.added}`} tone="add" />
            <Stat label="删除行" value={`−${stats.deleted}`} tone="del" />
            <Stat label="需留意" value={String(stats.risky.length)} tone={stats.risky.length ? 'warn' : undefined} />
          </div>

          {/* 增删平衡条：一眼看出这次是加功能还是删代码 */}
          {total > 0 && (
            <div>
              <div className="mb-1 flex justify-between text-caption-2-regular text-text-tertiary">
                <span>改动构成</span>
                <span>
                  {Math.round(addRatio)}% 新增 / {Math.round(100 - addRatio)}% 删除
                </span>
              </div>
              <div className="flex h-1.5 overflow-hidden rounded-full bg-background-tertiary-default">
                <span className="bg-green-500" style={{ width: `${addRatio}%` }} />
                <span className="bg-red-500" style={{ width: `${100 - addRatio}%` }} />
              </div>
            </div>
          )}

          {/* 风险项：全部列出，超出高度就在自己的框里滚，不挤占下方文件清单 */}
          {stats.risky.length > 0 && (
            <div className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 dark:bg-amber-500/10">
              <RiAlertLine className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1 text-caption-1-regular leading-relaxed text-amber-900 dark:text-amber-300">
                <p>
                  <span className="font-medium">提交前留意这些文件</span>
                  <span className="text-amber-800/80 dark:text-amber-300/80">：{riskSummary}</span>
                </p>
                <ul
                  className="thin-scroll mt-1.5 flex max-h-[112px] flex-col gap-0.5 overflow-y-auto pr-1"
                  data-risk-list
                >
                  {stats.risky.map((f) => (
                    <li key={f.path} className="flex items-baseline gap-2">
                      <code
                        title={f.path}
                        className="min-w-0 flex-1 truncate rounded bg-amber-100 px-1 font-mono text-caption-2-medium dark:bg-amber-500/20"
                      >
                        {f.path}
                      </code>
                      <span className="shrink-0 text-caption-2-regular">{riskLabel(f.risk?.code)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* 文件清单：占满面板剩下的高度，列表长了在自己的框里滚 */}
          <div className="flex min-h-[138px] flex-1 flex-col">
            <div className="mb-1.5 text-caption-1-semibold text-text-tertiary">将提交的文件</div>
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto rounded-xl bg-background-secondary-default p-1">
              {viewFiles.map((f) => {
                const meta = kindMeta(f.kind);
                const isSent = sent.has(f.path);
                return (
                  <div
                    key={f.path}
                    className="flex items-center gap-2 rounded-lg px-2 py-1"
                    data-commit-file={f.path}
                    data-commit-sent={isSent ? '1' : '0'}
                  >
                    <span className={['status-letter', meta.blockClass].join(' ')}>{meta.letter}</span>
                    <span className="min-w-0 flex-1 truncate text-body-2-regular text-text-primary">
                      {f.path}
                    </span>
                    {isSent ? (
                      <RiCheckLine className="size-3.5 shrink-0 text-green-600 dark:text-green-400" aria-label="已提交" />
                    ) : (
                      <span className="shrink-0 font-mono text-caption-2-medium text-text-tertiary">
                        {f.kind === 'missing' || f.kind === 'deleted'
                          ? f.isDir
                            ? '整个目录'
                            : '已删除'
                          : f.binary
                            ? (f.sizeText ?? '二进制')
                            : `+${f.added} −${f.deleted}`}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 说明放最后：用户不会在没看内容前先写说明 */}
          <Textarea
            label="提交说明"
            isRequired
            placeholder="优化了主流程性能"
            value={message}
            onChange={(value) => setMessage(value)}
            rows={2}
            autoFocus
            fieldClassName="commit-message-field"
            isDisabled={running || phase === 'done'}
          />
        </div>
      </ModalBody>

      <ModalFooter>
        {phase === 'idle' && (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!message.trim() || viewFiles.length === 0}
              onClick={() => void start()}
            >
              提交 {viewFiles.length} 项
            </Button>
          </>
        )}

        {phase === 'running' && (
          <>
            <Button variant="secondary" disabled>
              关闭
            </Button>
            <Button variant="primary" disabled aria-busy="true" leadingIcon={SpinnerGlyph}>
              提交中…
            </Button>
          </>
        )}

        {phase === 'done' && (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        )}

        {phase === 'error' && (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button variant="primary" disabled={!message.trim()} onClick={() => void start()}>
              重试提交
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'add' | 'del' | 'warn';
}) {
  const color =
    tone === 'add'
      ? 'text-green-700 dark:text-green-400'
      : tone === 'del'
        ? 'text-red-700 dark:text-red-400'
        : tone === 'warn'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-text-primary';
  return (
    <div className="rounded-xl bg-background-secondary-default px-2.5 py-2">
      <div className="text-caption-2-regular text-text-tertiary">{label}</div>
      <div className={`font-mono text-headline-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
