import { RiCheckLine } from '@remixicon/react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { Button } from '@/components/base/buttons/button';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import { Switch } from '@/components/base/switch/switch';
import { ACCENTS, type Accent, type Appearance, type Contrast, type ThemeState } from '@/src/hooks/useTheme';
import type { AppSettings } from '@/src/lib/types';

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
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md" className="min-w-[520px]">
      <ModalHeader title="设置" description="外观与运行信息" />

      <ModalBody>
        <div className="flex flex-col gap-6">
          {/* 外观 */}
          <section>
            <h3 className="mb-2 text-caption-1-semibold tracking-wide text-text-tertiary uppercase">外观</h3>
            <SegmentedControl
              selectedKeys={[theme.appearance]}
              onSelectionChange={(keys) => {
                const first = Array.from(keys)[0];
                if (first) patchTheme({ appearance: String(first) as Appearance });
              }}
              className="w-full"
            >
              <SegmentedControlItem id="light" className="flex-1">
                明亮
              </SegmentedControlItem>
              <SegmentedControlItem id="dark" className="flex-1">
                深色
              </SegmentedControlItem>
            </SegmentedControl>

            <label className="mt-3 flex items-center justify-between rounded-xl bg-background-secondary-default px-3 py-2.5">
              <span>
                <span className="block text-body-2-medium text-text-primary">高对比</span>
                <span className="block text-caption-2-regular text-text-tertiary">
                  加深次要文字与边框，适合强光环境
                </span>
              </span>
              <Switch
                isSelected={theme.contrast === 'high'}
                onChange={(v) => patchTheme({ contrast: (v ? 'high' : 'normal') as Contrast })}
                aria-label="高对比"
              />
            </label>
          </section>

          {/* 强调色 —— BoardUI 的换肤机制：覆盖 accent-50…950 */}
          <section>
            <h3 className="mb-2 text-caption-1-semibold tracking-wide text-text-tertiary uppercase">
              强调色
            </h3>
            <div className="grid grid-cols-5 gap-2">
              {ACCENTS.map((a) => {
                const active = theme.accent === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => patchTheme({ accent: a.id as Accent })}
                    aria-pressed={active}
                    className={[
                      'flex flex-col items-center gap-1.5 rounded-xl border px-1.5 py-2.5 transition-colors',
                      active
                        ? 'border-accent-400 bg-accent-50 dark:border-accent-500 dark:bg-accent-500/15'
                        : 'border-border-button-default hover:bg-background-secondary-hover',
                    ].join(' ')}
                  >
                    <span
                      className="grid size-6 place-items-center rounded-full"
                      style={{ background: a.swatch }}
                    >
                      {active && <RiCheckLine className="size-3.5 text-white" />}
                    </span>
                    <span className="text-caption-2-medium text-text-secondary">{a.name}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 文件与版本控制 */}
          <section>
            <h3 className="mb-2 text-caption-1-semibold tracking-wide text-text-tertiary uppercase">
              文件
            </h3>
            <label className="flex items-center justify-between gap-4 rounded-xl bg-background-secondary-default px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-body-2-medium text-text-primary">忽略 .DS_Store</span>
                <span className="block text-caption-2-regular text-text-tertiary">
                  macOS 自动生成的隐藏文件。开启后不在列表里显示，也不会被提交。
                </span>
              </span>
              <Switch
                isSelected={settings.ignoreDsStore}
                onChange={(v) => patchSettings({ ignoreDsStore: v })}
                aria-label="忽略 .DS_Store"
              />
            </label>
          </section>

          {/* 运行信息 */}
          <section>
            <h3 className="mb-1.5 text-caption-1-semibold tracking-wide text-text-tertiary uppercase">
              运行信息
            </h3>
            <dl>
              <Row label="版本" value={`FastSVN ${version}`} />
              <Row
                label="svn 引擎"
                value={
                  engineReady
                    ? `已就绪 · ${svnEmbedded ? '内嵌' : '系统'}${svnVersion ? ` ${svnVersion}` : ''}`
                    : '未找到'
                }
                tone={engineReady ? 'ok' : 'error'}
              />
              <Row label="运行方式" value={bundled ? '桌面应用' : '本地服务（浏览器）'} />
              <Row label="数据目录" value="~/Library/Application Support/FastSVN" mono />
            </dl>
          </section>
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

function Row({
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
    <div className="flex items-baseline justify-between gap-4 py-[7px]">
      <dt className="text-body-2-regular text-text-secondary">{label}</dt>
      <dd
        className={[
          'text-right text-body-2-medium',
          mono ? 'font-mono text-caption-1-medium' : '',
          tone === 'error' ? 'text-text-error-primary' : 'text-text-primary',
        ].join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}
