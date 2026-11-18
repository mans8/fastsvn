import { RiCheckboxCircleFill, RiErrorWarningFill, RiLoader4Line } from '@remixicon/react';

interface Props {
  text: string;
  error: string | null;
  busy: boolean;
  tookMs: number | null;
  fromCache: boolean;
  engineReady: boolean;
}

export function StatusBar({ text, error, busy, tookMs, fromCache, engineReady }: Props) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 px-4 text-caption-2-regular text-text-tertiary">
      <span className="flex items-center gap-1.5">
        {busy ? (
          <RiLoader4Line className="size-3.5 animate-spin" />
        ) : error ? (
          <RiErrorWarningFill className="size-3.5 text-red-600 dark:text-red-400" />
        ) : (
          <RiCheckboxCircleFill className="size-3.5 text-green-600 dark:text-green-400" />
        )}
        <span className={error ? 'text-text-error-primary' : undefined}>{error || text}</span>
      </span>

      <span className="ml-auto flex items-center gap-2">
        {tookMs != null && !busy && (
          <span className="font-mono">{fromCache ? '缓存命中' : `${tookMs} ms`}</span>
        )}
        <span className={engineReady ? undefined : 'text-text-error-primary'}>
          {engineReady ? 'svn 引擎已就绪' : '未找到 svn'}
        </span>
        <span className="hidden md:inline">⌘R 更新 · ⌘K 提交</span>
      </span>
    </footer>
  );
}
