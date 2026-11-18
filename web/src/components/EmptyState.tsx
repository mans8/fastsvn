import { RiFolderDownloadLine, RiFolderOpenLine, RiFolder3Line } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';

interface Props {
  onAddExisting: () => void;
  onCheckout: () => void;
}

export function EmptyState({ onAddExisting, onCheckout }: Props) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-[440px] flex-col items-center rounded-3xl border border-border-button-default bg-background-primary-default px-8 py-9 text-center shadow-sm">
        <div className="mb-3 grid size-14 place-items-center rounded-2xl bg-accent-50 text-accent-600 dark:bg-accent-500/15 dark:text-accent-400">
          <RiFolder3Line className="size-7" />
        </div>
        <h2 className="text-title-3-semibold text-text-primary">开始用 FastSVN</h2>
        <p className="mt-1.5 text-body-2-regular leading-relaxed text-text-secondary">
          已有的 SVN 文件夹可以直接打开，或者从服务器检出新的。
        </p>

        <div className="mt-5 flex w-full flex-col gap-2">
          <Button
            variant="primary"
            size="medium"
            leadingIcon={RiFolderDownloadLine}
            className="w-full justify-center"
            onClick={onCheckout}
          >
            从服务器检出
          </Button>
          <Button
            variant="secondary"
            size="medium"
            leadingIcon={RiFolderOpenLine}
            className="w-full justify-center"
            onClick={onAddExisting}
          >
            打开已有的 SVN 文件夹
          </Button>
        </div>

        <p className="mt-4 text-caption-1-regular text-text-tertiary">
          打开已有文件夹时，目录里需要有 <code className="rounded bg-background-tertiary-default px-1 font-mono">.svn</code>
        </p>
      </div>
    </div>
  );
}
