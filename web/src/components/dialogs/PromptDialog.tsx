import { useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';

export interface PromptConfig {
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  /** 打开时预填的值（改别名这类"在原值上改"的场景） */
  defaultValue?: string;
  /** 允许提交空值（清空别名 = 恢复默认显示） */
  allowEmpty?: boolean;
  /** 抛错时错误显示在输入框下方，弹窗不关 */
  onSubmit: (value: string) => Promise<void>;
}

interface Props {
  isOpen: boolean;
  config: PromptConfig | null;
  onOpenChange: (open: boolean) => void;
}

/** 一个输入框的小弹窗：新建子目录这类"问一个名字"的场景共用 */
export function PromptDialog({ isOpen, config, onOpenChange }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setValue(config?.defaultValue ?? '');
      setError(null);
      setPending(false);
    }
  }, [isOpen, config]);

  if (!config) return null;

  const submit = async () => {
    const next = value.trim();
    if (!next && !config.allowEmpty) {
      setError('填一个名字');
      return;
    }
    if (next.includes('/')) {
      setError('名字里不能带斜杠');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await config.onSubmit(next);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm" className="min-w-[420px]">
      <ModalHeader title={config.title} description={config.description} />
      <ModalBody>
        <Input
          label={config.label}
          placeholder={config.placeholder}
          value={value}
          onChange={(v) => setValue(v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          isInvalid={Boolean(error)}
          errorMessage={error ?? undefined}
          autoFocus
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="primary" disabled={pending} onClick={() => void submit()}>
          {pending ? '正在处理…' : (config.confirmLabel ?? '确定')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
