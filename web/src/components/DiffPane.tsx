import { useMemo } from 'react';
import { RiArrowUpDownLine, RiFileTextLine } from '@remixicon/react';
import { Spinner } from '@/components/base/spinner/spinner';
import type { DiffLine, DiffPayload, FileChange } from '@/src/lib/types';
import { kindMeta } from '@/src/lib/status-meta';

/* diff 不做语法着色。
 *
 * 原因：这个界面要回答的问题只有一个 ——「改了哪几行」。增删底色已经承担了
 * 这个信号，任何额外的着色都在与它竞争；而且在深色主题下，注释/关键字的
 * 语义色容易压到背景里，反而让内容读不清。
 * 需要看语法结构时，用外部编辑器打开更合适。
 */

interface Props {
  file: FileChange | null;
  diff: DiffPayload | null;
  loading: boolean;
  /** 是否已展开未变更的内容（整份文件可见） */
  expanded: boolean;
  onToggleExpand: () => void;
}

export function DiffPane({ file, diff, loading, expanded, onToggleExpand }: Props) {
  const marks = useMemo(() => {
    if (!diff || diff.binary || !diff.lines.length) return [];
    const total = diff.lines.length;
    return diff.lines
      .map((l, i) => ({ kind: l.kind, ratio: total > 1 ? i / (total - 1) : 0 }))
      .filter((x) => x.kind === 'add' || x.kind === 'del');
  }, [diff]);

  if (!file) {
    return (
      <section className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-3xl border border-border-button-default bg-background-primary-default shadow-sm">
        <RiFileTextLine className="size-8 text-foreground-icon-quaternary" />
        <p className="mt-2 text-body-2-medium text-text-secondary">选一个文件看改动</p>
        <p className="mt-0.5 text-caption-1-regular text-text-tertiary">左边点任意一行</p>
      </section>
    );
  }

  const meta = kindMeta(file.kind);
  // 删除的文件没有本地内容，「删了多少行」只能从差异里取
  const deletedCount = file.kind === 'missing' ? (diff?.deleted ?? 0) : file.deleted;
  // 新增/未纳入的文件本来就是整份内容；删除的文件没有上下文可展开
  const canExpand =
    file.kind !== 'added' &&
    file.kind !== 'unversioned' &&
    file.kind !== 'missing' &&
    Boolean(diff) &&
    !diff?.binary &&
    !diff?.skipped &&
    !diff?.message &&
    (diff?.lines.length ?? 0) > 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border-button-default bg-background-primary-default shadow-sm">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-button-default px-3 py-2">
        <span className="truncate text-body-2-semibold text-text-primary">{file.name}</span>
        <span className="truncate text-caption-1-regular text-text-tertiary">{file.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-caption-2-medium">
          {canExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              data-diff-expand={expanded ? '1' : '0'}
              title={expanded ? '只显示改动附近的行' : '把未变更的行也显示出来，方便看上下文'}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-2-medium text-text-secondary transition-colors hover:bg-background-secondary-default hover:text-text-primary"
            >
              <RiArrowUpDownLine className="size-3.5" />
              {expanded ? '收起未变更内容' : '展开未变更内容'}
            </button>
          )}
          <span className={['status-letter', meta.blockClass, '!size-[16px] !text-[10px]'].join(' ')}>
            {meta.letter}
          </span>
          {!file.binary && (file.added > 0 || deletedCount > 0) && (
            <span className="font-mono">
              <span className="text-green-700 dark:text-green-400">+{file.added}</span>{' '}
              <span className="text-red-700 dark:text-red-400">−{deletedCount}</span>
            </span>
          )}
          {file.binary && <span className="text-text-tertiary">二进制 {file.sizeText}</span>}
        </span>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="thin-scroll min-w-0 flex-1 overflow-auto">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-6 text-caption-1-regular text-text-tertiary">
              <Spinner size="sm" /> 正在读取差异…
            </div>
          )}

          {/* 大文件：后端根本没读内容，所以这里只能给结论 + 出路 */}
          {!loading && diff?.skipped && (
            <div className="px-4 py-6 text-caption-1-regular leading-relaxed text-text-secondary">
              <p className="text-body-2-medium text-text-primary">
                {diff.binary ? '大文件不做逐行对比' : '文件较大，不做逐行对比'}
              </p>
              <p className="mt-1">
                {diff.sizeText ?? file.sizeText ?? ''}
                {diff.binary ? ' · 不是文本' : ' · 超过 10 MB'}
              </p>
              <p className="mt-1 text-text-tertiary">
                逐行比较会把整个文件读进内存，界面会卡住，所以这类文件直接跳过。
                需要核对内容时，提交前后用外部工具打开即可。
              </p>
            </div>
          )}

          {!loading && !diff?.skipped && diff?.binary && (
            <div className="px-4 py-6 text-caption-1-regular leading-relaxed text-text-secondary">
              <p className="text-body-2-medium text-text-primary">二进制文件不做逐行对比</p>
              <p className="mt-1">
                当前大小 {file.sizeText}
                {file.risk?.text ? ` · ${file.risk.text}` : ''}
              </p>
              <p className="mt-1 text-text-tertiary">确认无误再提交；需要看内容请用外部工具打开。</p>
            </div>
          )}

          {!loading && !diff?.skipped && !diff?.binary && diff?.message && (
            <p className="px-4 py-6 text-caption-1-regular text-text-tertiary">{diff.message}</p>
          )}

          {!loading &&
            !diff?.skipped &&
            !diff?.binary &&
            !diff?.message &&
            diff?.lines.length === 0 && (
              <p className="px-4 py-6 text-caption-1-regular text-text-tertiary">
                这个文件还没有可预览的改动内容
              </p>
            )}

          {!loading &&
            !diff?.skipped &&
            !diff?.binary &&
            diff?.lines.map((line, i) => <DiffRow key={i} line={line} />)}
        </div>

        {/* 变更地图：长文件不用滚动就能看出改动集中在哪 */}
        {marks.length > 0 && (
          <div className="changemap my-2 mr-1 shrink-0" aria-hidden>
            {marks.map((m, i) => (
              <i
                key={i}
                className={m.kind === 'add' ? 'bg-green-500' : 'bg-red-500'}
                style={{ top: `${m.ratio * 100}%` }}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === 'hunk') {
    return (
      <div className="diff-line is-hunk">
        <span className="diff-text">{line.text}</span>
      </div>
    );
  }
  const cls = line.kind === 'add' ? 'is-add' : line.kind === 'del' ? 'is-del' : '';
  return (
    <div className={`diff-line ${cls}`}>
      <span className="diff-gutter">
        <span className="o">{line.oldNo ?? ''}</span>
        <span className="n">{line.newNo ?? ''}</span>
      </span>
      <span className="diff-mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
      <span className="diff-text">{line.text || ' '}</span>
    </div>
  );
}
