import { useEffect, useState } from 'react';
import { RiAlertLine, RiFolderOpenLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { api, decodePercent } from '@/src/lib/api';
import { canPickFolder, pickFolder } from '@/src/lib/bridge';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (path: string) => void;
}

export function AddProjectDialog({ isOpen, onOpenChange, onAdded }: Props) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setPath('');
      setError(null);
      setPicking(false);
    }
  }, [isOpen]);

  /** 用访达的原生面板选目录，比手打路径可靠得多 */
  const chooseFolder = async () => {
    if (!canPickFolder()) {
      setError('浏览器预览里不能调起访达，请直接填路径；桌面应用里可以选。');
      return;
    }
    setPicking(true);
    try {
      const dir = await pickFolder(path);
      if (dir) {
        setPath(dir);
        setError(null);
      }
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    const value = path.trim();
    if (!value) {
      setError('填一个文件夹路径，或者点「选择…」在访达里挑一个。');
      return;
    }
    setPending(true);
    setError(null);
    try {
      // ~ 交给后端展开：前端不做路径改写，免得把 ~ 直接删掉
      await api.addWorkingCopy(value);
      onAdded(value);
      onOpenChange(false);
    } catch (e) {
      setError(decodePercent((e as Error).message));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md" className="min-w-[460px]">
      <ModalHeader
        title="打开已有的 SVN 文件夹"
        description="选一个已经从服务器检出过的文件夹，目录里要有 .svn。"
      />
      <ModalBody>
        <Input
          label="文件夹路径"
          placeholder="/Users/you/Documents/my-project"
          inputClassName="font-mono text-[12px]"
          value={path}
          onChange={(value) => setPath(value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          autoFocus
          isInvalid={Boolean(error)}
          trailingAddon={
            <Button
              variant="ghost"
              size="small"
              className="me-1 shrink-0"
              disabled={picking}
              leadingIcon={RiFolderOpenLine}
              aria-label="在访达中选择文件夹"
              onClick={() => void chooseFolder()}
            >
              {picking ? '选择中…' : '选择…'}
            </Button>
          }
          hint="点「选择…」可以直接在访达里挑，也可以把路径粘进来。"
        />
        {error && (
          <p className="mt-2 flex items-start gap-1.5 text-caption-1-regular text-text-error-primary">
            <RiAlertLine className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="primary" disabled={pending} onClick={() => void submit()}>
          {pending ? '正在打开…' : '打开'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
