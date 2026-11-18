import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 主题由三个正交维度组成（对齐 BoardUI 的 token 体系）：
 *   appearance  明亮 / 深色        → 切换 <html class="dark">
 *   contrast    标准 / 高对比      → data-contrast="high"，重映射次级文字与边框
 *   accent      强调色             → data-accent，覆盖 accent-50…950 十一个变量
 *
 * 这样"主题"不再是四份写死的色板，而是可组合的维度；新增一套配色只需加一个
 * data-accent 分支，不必复制整份样式。
 */

export type Appearance = 'light' | 'dark';
export type Contrast = 'normal' | 'high';
export type Accent = 'blue' | 'violet' | 'teal' | 'amber' | 'rose';

export interface ThemeState {
  appearance: Appearance;
  contrast: Contrast;
  accent: Accent;
}

const KEY = 'fastsvn.theme.v2';
const DEFAULT: ThemeState = { appearance: 'light', contrast: 'normal', accent: 'blue' };

/** URL 参数优先（便于截图与自测）：?theme=dark&contrast=high&accent=violet */
function fromUrl(): Partial<ThemeState> | null {
  if (typeof location === 'undefined') return null;
  const qs = new URLSearchParams(location.search);
  const appearance = qs.get('theme');
  const contrast = qs.get('contrast');
  const accent = qs.get('accent');
  if (!appearance && !contrast && !accent) return null;
  const out: Partial<ThemeState> = {};
  if (appearance === 'dark' || appearance === 'light') out.appearance = appearance;
  if (contrast === 'high' || contrast === 'normal') out.contrast = contrast;
  if (accent && ['blue', 'violet', 'teal', 'amber', 'rose'].includes(accent)) {
    out.accent = accent as Accent;
  }
  return out;
}

function read(): ThemeState {
  const urlTheme = fromUrl();
  if (urlTheme) return { ...DEFAULT, ...urlTheme };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    return {
      appearance: parsed.appearance === 'dark' ? 'dark' : 'light',
      contrast: parsed.contrast === 'high' ? 'high' : 'normal',
      accent: (['blue', 'violet', 'teal', 'amber', 'rose'] as const).includes(parsed.accent as Accent)
        ? (parsed.accent as Accent)
        : 'blue',
    };
  } catch {
    return DEFAULT;
  }
}

function apply(theme: ThemeState) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme.appearance === 'dark');
  root.dataset.contrast = theme.contrast;
  if (theme.accent === 'blue') delete root.dataset.accent;
  else root.dataset.accent = theme.accent;
  // 让系统控件（滚动条、表单）跟随明暗
  root.style.colorScheme = theme.appearance === 'dark' ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeState>(() => {
    const initial = read();
    if (typeof document !== 'undefined') apply(initial);
    return initial;
  });

  // 来自 URL 的参数属于"临时预览"，不落盘
  const fromUrlOnly = useRef(Boolean(fromUrl()));

  useEffect(() => {
    apply(theme);
    if (fromUrlOnly.current) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(theme));
    } catch {
      /* 隐私模式下写不进去，忽略 */
    }
  }, [theme]);

  const patch = useCallback((next: Partial<ThemeState>) => {
    setTheme((prev) => ({ ...prev, ...next }));
  }, []);

  return { theme, patch, setTheme };
}

export const ACCENTS: { id: Accent; name: string; swatch: string }[] = [
  { id: 'blue', name: '经典蓝', swatch: 'oklch(0.623 0.214 259.8)' },
  { id: 'violet', name: '紫罗兰', swatch: 'oklch(0.606 0.25 292.7)' },
  { id: 'teal', name: '青碧', swatch: 'oklch(0.704 0.14 182.5)' },
  { id: 'amber', name: '琥珀', swatch: 'oklch(0.769 0.188 70.08)' },
  { id: 'rose', name: '玫瑰', swatch: 'oklch(0.645 0.246 16.44)' },
];
