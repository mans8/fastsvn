import { RiFile3Line } from '@remixicon/react';
import { Spinner } from '@/components/base/spinner/spinner';
import { relativeTime } from '@/src/lib/format';
import type { FilePreview, LocalEntry } from '@/src/lib/types';

interface Props {
  entry: LocalEntry | null;
  preview: FilePreview | null;
  loading: boolean;
}

/**
 * 只读预览磁盘上的真实文件。
 * 与 DiffPane 的区别：这里不比较版本，只把文件内容摊开看。
 */
export function PreviewPane({ entry, preview, loading }: Props) {
  if (!entry || entry.kind === 'dir') {
    return (
      <section className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-3xl border border-border-button-default bg-background-primary-default shadow-sm">
        <RiFile3Line className="size-8 text-foreground-icon-quaternary" />
        <p className="mt-2 text-body-2-medium text-text-secondary">选一个文件看内容</p>
        <p className="mt-0.5 text-caption-1-regular text-text-tertiary">
          在左边展开目录，点文件就能预览 —— 没改过的文件也能看
        </p>
      </section>
    );
  }

  const lineCount = preview && !preview.binary ? preview.content.split('\n').length : 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border-button-default bg-background-primary-default shadow-sm">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-button-default px-3 py-2">
        <span className="truncate text-body-2-semibold text-text-primary">{entry.name}</span>
        <span className="truncate text-caption-1-regular text-text-tertiary">{entry.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-caption-2-medium text-text-tertiary">
          {entry.sizeText && <span>{entry.sizeText}</span>}
          {lineCount > 0 && <span>{lineCount} 行</span>}
          {preview?.mtime && <span>{relativeTime(preview.mtime)}</span>}
        </span>
      </header>

      <div className="thin-scroll min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center gap-2 px-4 py-6 text-caption-1-regular text-text-tertiary">
            <Spinner size="sm" /> 正在读取文件…
          </div>
        )}

        {!loading && preview?.binary && (
          <div className="px-4 py-6 text-caption-1-regular leading-relaxed text-text-secondary">
            <p className="text-body-2-medium text-text-primary">这是个二进制文件</p>
            <p className="mt-1">
              {preview.sizeText}
              {entry.status ? ` · ${entry.status.label}` : ''}
            </p>
            <p className="mt-1 text-text-tertiary">文本预览对它没有意义，用外部工具打开更合适。</p>
          </div>
        )}

        {!loading && preview && !preview.binary && (
          <>
            {preview.truncated && (
              <p className="border-b border-border-separator-border bg-amber-50 px-4 py-1.5 text-caption-1-regular text-amber-900 dark:bg-amber-500/10 dark:text-amber-300">
                文件较大，只显示前 512 KB
              </p>
            )}
            <pre className="min-w-max px-4 py-3 font-mono text-caption-1-regular leading-[1.65] text-text-primary">
              {preview.content}
            </pre>
          </>
        )}

        {!loading && !preview && (
          <p className="px-4 py-6 text-caption-1-regular text-text-tertiary">读不到这个文件</p>
        )}
      </div>
    </section>
  );
}
