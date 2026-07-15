export const QUOTA_BREAKDOWN_KEYS = ['人工', '材料', '设备', '机械', '管理费', '利润', '风险'];

export function normalizeQuotaBreakdown(breakdown = {}) {
  return Object.fromEntries(QUOTA_BREAKDOWN_KEYS.map(key => [key, finiteNumber(breakdown?.[key])]));
}

function finiteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
