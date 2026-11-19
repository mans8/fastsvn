#!/usr/bin/env node
/**
 * 非法请求地址回归（v0.6.26）：
 *   `//?tab=files` 这种以双斜杠开头的请求，以前会让 `new URL()` 抛
 *   ERR_INVALID_URL 并直接退出后端进程。现在应按普通路径处理并正常返回页面；
 *   真正解析不了的请求回 400，进程继续活着。
 *
 * 用法：node scripts/e2e-invalid-url.mjs <baseUrl>
 * 前置：服务已在 baseUrl 上运行，且 web/dist 已构建。
 */

const [, , rawBase] = process.argv;
if (!rawBase) {
  console.error('用法: node scripts/e2e-invalid-url.mjs <baseUrl>');
  process.exit(1);
}
const base = rawBase.replace(/\/+$/, '');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

async function main() {
  const doubled = await fetch(`${base}//?tab=files`);
  const doubledBody = await doubled.text();
  check('双斜杠地址正常返回页面', doubled.status === 200 && doubledBody.includes('id="root"'), `HTTP ${doubled.status}`);

  const tripled = await fetch(`${base}///?tab=files`);
  check('三斜杠地址也不崩', tripled.status === 200, `HTTP ${tripled.status}`);

  const health = await fetch(`${base}/api/health`);
  const data = await health.json().catch(() => null);
  check(
    '坏请求之后服务仍然存活',
    health.status === 200 && data?.ok === true,
    `HTTP ${health.status} ${JSON.stringify(data)}`
  );

  console.log('');
  let failed = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed} / ${results.length} 通过`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('自测脚本出错：', e.message);
  process.exit(1);
});
