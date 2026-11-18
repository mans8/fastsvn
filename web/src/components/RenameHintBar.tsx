import { RiArrowRightLine, RiLoopLeftLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import type { RenameCandidate } from '@/src/lib/types';

interface Props {
  candidates: RenameCandidate[];
  busy: boolean;
  onRepair: (candidate: RenameCandidate) => void;
}

/**
 * 检测到「访达里改名」时出现的提示条。
 * 检测是自动的，修复必须用户确认 —— 与主流 SVN 客户端（TortoiseSVN Repair move）一致：
 * 客户端无法可靠区分「改名」与「删了一个又建了一个」。
 */
export function RenameHintBar({ candidates, busy, onRepair }: Props) {
  if (!candidates.length) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-primary"
    >
      <span className="flex items-center gap-1.5 text-text-primary">
        <RiLoopLeftLine aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
        检测到 {candidates.length} 处疑似改名
      </span>
      <span className="text-text-secondary">
         SVN 只看到删除和新增；确认后会还原成改名并保留历史。
      </span>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        {candidates.map((c) => (
          <span key={`${c.from}→${c.to}`} className="flex items-center gap-1.5">
            <span className="max-w-48 truncate rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-text-primary" title={c.from}>
              {c.from.split('/').pop()}
            </span>
            <RiArrowRightLine aria-hidden className="size-3 shrink-0 text-foreground-icon-tertiary" />
            <span className="max-w-48 truncate rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-text-primary" title={c.to}>
              {c.to.split('/').pop()}
            </span>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => onRepair(c)}
            >
              修复
            </Button>
          </span>
        ))}
      </div>
    </div>
  );
}
