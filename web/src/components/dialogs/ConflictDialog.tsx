import { useEffect, useState } from 'react';
import { RiAlertLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { Spinner } from '@/components/base/spinner/spinner';
import { api, decodePercent } from '@/src/lib/api';
import type { ConflictBlock, FileChange } from '@/src/lib/types';

type Accept = 'mine-full' | 'theirs-full' | 'working';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  wcPath: string | null;
  file: FileChange | null;
  conflictFiles: FileChange[];
  onResolved: () => void;
}

const CHOICES: { id: Accept; title: string; desc: string }[] = [
  { id: 'mine-full', title: '全部用我的', desc: '你的改动会覆盖同事的' },
  { id: 'theirs-full', title: '全部用同事的', desc: '放弃你在这几处的改动' },
  { id: 'working', title: '逐行挑选', desc: '保留我手工合并后的内容' },
];

export function ConflictDialog({ isOpen, onOpenChange, wcPath, file, conflictFiles, onResolved }: Props) {
  const [blocks, setBlocks] = useState<ConflictBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [choice, setChoice] = useState<Accept>('working');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!isOpen || !wcPath || !file) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .conflict(wcPath, file.path)
      .then((d) => {
        if (alive) setBlocks(d.blocks);
      })
      .catch((e) => {
        if (alive) setError(decodePercent((e as Error).message));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, wcPath, file]);

  const resolve = async () => {
    if (!wcPath || !file) return;
    setPending(true);
    setError(null);
    try {
      await api.resolve(wcPath, file.path, choice);
      onOpenChange(false);
      onResolved();
    } catch (e) {
      setError(decodePercent((e as Error).message));
    } finally {
      setPending(false);
    }
  };

  const others = conflictFiles.length - 1;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="xl"
      className="min-w-[720px]"
    >
      <ModalHeader
        title="这个文件你和同事都改了"
        description={
          file
            ? `${file.path} · 改动落在同一位置。选一个处理方式。`
            : '改动落在同一位置。选一个处理方式。'
        }
      />

      <ModalBody>
        <div className="grid grid-cols-3 gap-2">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setChoice(c.id)}
              aria-pressed={choice === c.id}
              className={[
                'rounded-xl border px-3 py-2.5 text-left transition-colors',
                choice === c.id
                  ? 'border-accent-400 bg-accent-50 dark:border-accent-500 dark:bg-accent-500/15'
                  : 'border-border-button-default hover:bg-background-secondary-hover',
              ].join(' ')}
            >
              <span className="block text-body-2-semibold text-text-primary">{c.title}</span>
              <span className="mt-0.5 block text-caption-2-regular leading-snug text-text-tertiary">
                {c.desc}
              </span>
            </button>
          ))}
        </div>

        {loading && (
          <div className="mt-4 flex items-center gap-2 text-caption-1-regular text-text-tertiary">
            <Spinner size="sm" /> 正在读取冲突内容…
          </div>
        )}

        {error && (
          <p className="mt-4 flex items-start gap-1.5 text-caption-1-regular text-text-error-primary">
            <RiAlertLine className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}

        {!loading && blocks.length > 0 && (
          <div className="mt-4 flex flex-col gap-3">
            {blocks.map((b, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-border-button-default">
                <div className="grid grid-cols-2 divide-x divide-border-separator-border">
                  <div>
                    <div className="bg-accent-50 px-2.5 py-1 text-caption-2-semibold text-accent-700 dark:bg-accent-500/15 dark:text-accent-300">
                      我的版本
                    </div>
                    <pre className="thin-scroll max-h-32 overflow-auto px-2.5 py-2 font-mono text-caption-1-regular leading-[1.55] text-text-primary">
                      {b.mine.trimEnd()}
                    </pre>
                  </div>
                  <div>
                    <div className="bg-background-secondary-default px-2.5 py-1 text-caption-2-semibold text-text-secondary">
                      同事的版本
                    </div>
                    <pre className="thin-scroll max-h-32 overflow-auto px-2.5 py-2 font-mono text-caption-1-regular leading-[1.55] text-text-primary">
                      {b.theirs.trimEnd()}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && blocks.length === 0 && !error && (
          <p className="mt-4 rounded-xl bg-background-secondary-default px-3 py-2.5 text-caption-1-regular text-text-secondary">
            没读到冲突块（可能是树冲突或属性冲突）。按上面的方式处理即可。
          </p>
        )}
      </ModalBody>

      <ModalFooter>
        <span className="mr-auto text-caption-2-regular text-text-tertiary">
          {others > 0 ? `还有 ${others} 个文件也有冲突` : ''}
        </span>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          稍后处理
        </Button>
        <Button variant="primary" disabled={pending} onClick={() => void resolve()}>
          {pending ? '正在处理…' : '完成并标记已解决'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
