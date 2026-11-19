import { toast } from '@/components/base/toast/toast';

/**
 * 写剪贴板：优先 Clipboard API；WKWebView / 权限不给时回退到临时文本框。
 * 失败会抛错，交给调用方决定怎么提示。
 */
export async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // WKWebView / permission fallback
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('剪贴板不可用');
}

/**
 * 复制并提示结果。label 用来区分「路径已复制」「地址已复制」这类文案。
 * 提示里带上复制出去的原值，用户不用再粘到别处确认。
 */
export async function copyWithToast(text: string, label = '路径') {
  try {
    await copyTextToClipboard(text);
    toast(`${label}已复制`, { description: text, status: 'success' });
  } catch (e) {
    toast('复制失败', { description: (e as Error).message, status: 'error' });
  }
}
