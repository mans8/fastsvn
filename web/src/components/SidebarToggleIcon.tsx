interface Props {
  className?: string;
  /** 收起状态：把面板竖线画淡一点，暗示"这一栏已经收起来了" */
  collapsed?: boolean;
}

/**
 * 侧栏开关图标：圆角方框 + 左侧一条竖线。
 * 不用 Remixicon 的 sidebar-fold —— 那个里面带一个三角形箭头，和
 * 产品里其它图标不是一个语汇；这个更接近系统里常见的"侧栏"符号。
 */
export function SidebarToggleIcon({ className, collapsed }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3.6" y="4.6" width="16.8" height="14.8" rx="4" stroke="currentColor" strokeWidth="1.7" />
      <line
        x1="9"
        y1="6.8"
        x2="9"
        y2="17.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity={collapsed ? 0.32 : 1}
      />
    </svg>
  );
}
