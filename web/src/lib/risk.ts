/** 风险类型 → 短标签。列表、提交弹窗共用，避免同一种风险两种说法。 */
export function riskLabel(code?: string | null): string {
  if (code === 'secret') return '疑似密钥';
  if (code === 'binaryGrowth') return '二进制';
  if (code === 'largeFile') return '大文件';
  return '注意';
}
