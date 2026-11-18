#!/usr/bin/env node
/**
 * 关掉 CDP 里所有测试标签页。
 *
 * 自测脚本每次跑都会新开一个标签（为了不复用上一个页面的状态），但只有
 * 少数几个会自己关。连着跑十几套就会堆到七八十个页面，headless Chrome
 * 开始卡、CDP 命令超时，看起来像"测试挂了"。跑批之前/之后跑一下这个即可。
 *
 * 用法：node scripts/close-tabs.mjs [CDP_PORT]
 */

const PORT = Number(process.argv[2] || process.env.CDP_PORT || 9222);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let closed = 0;
for (const t of list) {
  if (t.type !== 'page') continue;
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
    closed++;
  } catch {
    /* 已经关掉了 */
  }
}
console.log(`已关闭 ${closed} 个测试标签页（剩余 ${
  (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).length
} 个目标）`);
