import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/src/lib/api';
import type { AppSettings } from '@/src/lib/types';

/**
 * 应用设置。
 *
 * 这些开关影响的是「后端怎么扫描工作副本」（比如要不要显示 .DS_Store），
 * 所以真相存在后端 settings.json 里，前端只做乐观更新：
 * 先切 UI，保存失败再回滚。
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>({ ignoreDsStore: true });
  const [loaded, setLoaded] = useState(false);
  const ref = useRef(settings);
  ref.current = settings;

  const load = useCallback(async () => {
    try {
      const data = await api.settings();
      setSettings(data);
    } catch {
      /* 读不到就按默认值走，不打断使用 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(async (next: Partial<AppSettings>) => {
    const prev = ref.current;
    const merged = { ...prev, ...next };
    setSettings(merged);
    try {
      const saved = await api.saveSettings(merged);
      setSettings(saved);
      return saved;
    } catch (e) {
      setSettings(prev);
      throw e;
    }
  }, []);

  return { settings, loaded, load, patch };
}

export type SettingsApi = ReturnType<typeof useSettings>;
