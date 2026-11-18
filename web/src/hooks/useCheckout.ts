import { useCallback, useEffect, useRef, useState } from 'react';
import { api, decodePercent } from '@/src/lib/api';
import { canonicalUrl } from '@/src/lib/format';
import type { CheckoutJob } from '@/src/lib/types';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * 检出任务的客户端侧：起任务 + 轮询进度。
 *
 * 为什么用轮询而不是 SSE：一次检出几十秒到几分钟，500ms 一次的本地请求
 * 开销可以忽略，但换来的是断线重连、页面刷新后恢复进度都天然可用。
 */
export function useCheckout(onFinished?: (job: CheckoutJob) => void) {
  const [job, setJob] = useState<CheckoutJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const notified = useRef<string | null>(null);

  const start = useCallback(
    async (url: string, path: string, mode: 'checkout' | 'export' = 'checkout') => {
    setFormError(null);
    setStarting(true);
    try {
      // 用户可能直接把中文路径贴进地址栏，交给 svn 前统一编码
      const created = await api.startCheckout(canonicalUrl(url.trim()), path.trim(), mode);
      notified.current = null;
      setJob(created);
      return true;
    } catch (e) {
      setFormError(decodePercent((e as Error).message));
      return false;
    } finally {
      setStarting(false);
    }
    },
    []
  );

  const cancel = useCallback(async () => {
    if (!job) return;
    try {
      const next = await api.cancelCheckout(job.id);
      setJob(next);
    } catch (e) {
      setFormError(decodePercent((e as Error).message));
    }
  }, [job]);

  const reset = useCallback(() => {
    setJob(null);
    setFormError(null);
    notified.current = null;
  }, []);

  // 轮询：只在任务未结束时跑
  useEffect(() => {
    if (!job || TERMINAL.has(job.phase)) return;
    let alive = true;
    const id = window.setInterval(async () => {
      try {
        const next = await api.checkoutStatus(job.id);
        if (alive) setJob(next);
      } catch {
        /* 单次失败不打断轮询，下一轮继续 */
      }
    }, 500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [job?.id, job?.phase]);

  // 完成回调只触发一次
  useEffect(() => {
    if (!job || !TERMINAL.has(job.phase)) return;
    if (notified.current === job.id) return;
    notified.current = job.id;
    onFinished?.(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.phase]);

  return { job, starting, formError, setFormError, start, cancel, reset };
}
