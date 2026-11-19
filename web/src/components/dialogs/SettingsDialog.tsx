import type { ReactNode } from 'react';
import { RiCheckLine } from '@remixicon/react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { Button } from '@/components/base/buttons/button';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import { Switch } from '@/components/base/switch/switch';
import { ACCENTS, type Accent, type Appearance, type Contrast, type ThemeState } from '@/src/hooks/useTheme';
import type { AppSettings } from '@/src/lib/types';
import { cx } from '@/utils/cx';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  theme: ThemeState;
  patchTheme: (next: Partial<ThemeState>) => void;
  settings: AppSettings;
  patchSettings: (next: Partial<AppSettings>) => void;
  version: string;
  engineReady: boolean;
  /** svn 引擎来自 app 内置还是用户机器 */
  svnEmbedded: boolean;
  svnVersion: string;
  bundled: boolean;
}

/**
 * 设置：一行一项，名称在左、控件在右；组有标题，组间留白大于组内。
 * 不套卡片——整块内容直接落在弹窗面上。
 */
export function SettingsDialog({
  isOpen,
  onOpenChange,
  theme,
  patchTheme,
  settings,
  patchSettings,
  version,
  engineReady,
  svnEmbedded,
  svnVersion,
  bundled,
}: Props) {
  const accentName = ACCENTS.find((a) => a.id === theme.accent)?.name;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md" className="min-w-[520px] border-0">
      <ModalHeader title="设置" />

      <ModalBody>
        <div className="flex flex-col gap-8 pb-2">
          <Group title="外观">
            <Row label="主题">
              <SegmentedControl
                aria-label="主题"
                selectedKeys={[theme.appearance]}
                onSelectionChange={(keys) => {
                  const first = Array.from(keys)[0];
                  if (first) patchTheme({ appearance: String(first) as Appearance });
                }}
                className="w-[152px]"
              >
                <SegmentedControlItem id="light" className="flex-1">
                  明亮
                </SegmentedControlItem>
                <SegmentedControlItem id="dark" className="flex-1">
                  深色
                </SegmentedControlItem>
              </SegmentedControl>
            </Row>

            <Row label="高对比" hint="加深次要文字与边框，适合强光环境">
              <Switch
                isSelected={theme.contrast === 'high'}
                onChange={(v) => patchTheme({ contrast: (v ? 'high' : 'normal') as Contrast })}
                aria-label="高对比"
              />
            </Row>

            <Row label="强调色" hint={accentName}>
              <div className="flex items-center gap-1.5" role="group" aria-label="强调色">
                {ACCENTS.map((a) => {
                  const active = theme.accent === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => patchTheme({ accent: a.id as Accent })}
                      aria-pressed={active}
                      aria-label={a.name}
                      title={a.name}
                      className={cx(
                        'grid size-8 place-items-center rounded-full border transition-colors',
                        'outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
                        active
                          ? 'border-accent-500'
                          : 'border-transparent hover:border-border-button-default',
                      )}
                    >
                      <span
                        className="grid size-5 place-items-center rounded-full"
                        style={{ background: a.swatch }}
                      >
                        {active && <RiCheckLine className="size-3 text-white" aria-hidden />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Row>
          </Group>

          <Group title="文件">
            <Row label="忽略 .DS_Store" hint="macOS 自动生成的隐藏文件。开启后不在列表里显示，也不会被提交。">
              <Switch
                isSelected={settings.ignoreDsStore}
                onChange={(v) => patchSettings({ ignoreDsStore: v })}
                aria-label="忽略 .DS_Store"
              />
            </Row>
          </Group>

          <Group title="运行信息">
            <dl>
              <InfoRow label="版本" value={`FastSVN ${version}`} />
              <InfoRow
                label="svn 引擎"
                value={
                  engineReady
                    ? `已就绪 · ${svnEmbedded ? '内嵌' : '系统'}${svnVersion ? ` ${svnVersion}` : ''}`
                    : '未找到'
                }
                tone={engineReady ? 'ok' : 'error'}
              />
              <InfoRow label="运行方式" value={bundled ? '桌面应用' : '本地服务（浏览器）'} />
              <InfoRow label="数据目录" value="~/Library/Application Support/FastSVN" mono />
            </dl>
          </Group>
        </div>
      </ModalBody>

      <ModalFooter>
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          完成
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** 组：标题 + 若干行；组内不留额外缺口，组与组之间靠父级 gap 拉开。 */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="mb-1.5 text-caption-1-semibold text-text-secondary">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 一项设置占一行：左边名称（可带一行说明），右边控件。
 * 不带背景、不带分隔线——从外观上就是纯文本行。
 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-6 py-1.5">
      <div className="min-w-0">
        <div className="text-body-2-medium text-text-primary">{label}</div>
        {hint ? <div className="mt-0.5 text-caption-2-regular text-text-tertiary">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 items-center justify-end">{children}</div>
    </div>
  );
}

/** 运行信息的只读行：左边名称，右边取值。 */
function InfoRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'error';
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-6 py-1.5">
      <dt className="min-w-0 text-body-2-medium text-text-primary">{label}</dt>
      <dd
        className={cx(
          'text-end text-body-2-medium',
          mono && 'font-mono text-caption-1-medium',
          tone === 'error' ? 'text-text-error-primary' : 'text-text-primary',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
