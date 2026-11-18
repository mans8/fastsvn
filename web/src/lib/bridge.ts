/** 桌面外壳（WKWebView）暴露的原生桥；浏览器里为空 */

interface WindowBridge {
  messageHandlers?: {
    windowAction?: { postMessage: (action: string) => void };
    /** 原生 NSOpenPanel，返回选中的绝对路径；取消返回 null */
    pickFolder?: { postMessage: (payload: { defaultPath?: string }) => Promise<string | null> };
  };
}

export function postWindowAction(action: 'zoom' | 'minimize' | 'close') {
  const w = window as unknown as { webkit?: WindowBridge };
  w.webkit?.messageHandlers?.windowAction?.postMessage(action);
}

export function hasBridge(): boolean {
  const w = window as unknown as { webkit?: WindowBridge };
  return Boolean(w.webkit?.messageHandlers?.windowAction);
}

/** 访达里选一个目录；浏览器环境或用户取消都返回 null */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const w = window as unknown as { webkit?: WindowBridge };
  const handler = w.webkit?.messageHandlers?.pickFolder;
  if (!handler) return null;
  try {
    return await handler.postMessage({ defaultPath: defaultPath ?? '' });
  } catch {
    return null;
  }
}

/** 是否具备原生选目录能力（浏览器预览时为 false） */
export function canPickFolder(): boolean {
  const w = window as unknown as { webkit?: WindowBridge };
  return Boolean(w.webkit?.messageHandlers?.pickFolder);
}
