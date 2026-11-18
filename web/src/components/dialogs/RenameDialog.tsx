import { useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import type { FileChange } from '@/src/lib/types';

interface Props {
  file: FileChange | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (newName: string) => Promise<void>;
}

export function RenameDialog({ file, onOpenChange, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (file) {
      setName(file.name);
      setError(null);
    }
  }, [file]);

  const submit = async () => {
    if (!file) return;
    const next = name.trim();
    if (!next) return setError('名字不能为空');
    if (next.includes('/')) return setError('名字里不能带斜杠');
    if (next === file.name) {
      onOpenChange(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(next);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal isOpen={Boolean(file)} onOpenChange={onOpenChange} size="sm" className="min-w-[420px]">
      <ModalHeader
        title="重命名"
        description={file ? `把「${file.name}」改成新的名字，会保留版本历史。` : undefined}
      />
      <ModalBody>
        <Input
          label="新名字"
          value={name}
          onChange={(value) => setName(value)}
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
          {pending ? '正在重命名…' : '重命名'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
