import { AlertDialog } from '@/components/base/modal/modal';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => void | Promise<void>;
}

/**
 * 二次确认。用 BoardUI 的 AlertDialog 而不是 window.confirm：
 * WKWebView 默认不实现 window.confirm，会静默返回 false —— 表现就是"点了没反应"。
 */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  description,
  confirmLabel = '确定',
  variant = 'danger',
  onConfirm,
}: Props) {
  // icon={false}：标题与红色确认按钮已经说明了危险性，不再放圆形警示图标
  return (
    <AlertDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      icon={false}
      title={title}
      description={description}
      variant={variant}
      confirmLabel={confirmLabel}
      cancelLabel="取消"
      onConfirm={async () => {
        await onConfirm();
      }}
    />
  );
}
