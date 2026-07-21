// 造价计算纯函数：便于服务层和测试共用
export function calculateAmount(qty = 0, unitPrice = 0, factor = 1) {
  return (Number(qty) || 0) * (Number(unitPrice) || 0) * (Number(factor) || 1);
}

export function hasMissingPrice(value) {
  return !(Number(value) > 0);
}

/** 定额允许负价调整；只有空值、非法值才算真正缺价。 */
export function quotaPriceStatus(value, provided = value !== '' && value !== null && value !== undefined) {
  if (!provided || !Number.isFinite(Number(value))) return 'missing';
  if (Number(value) < 0) return 'adjustment';
  if (Number(value) === 0) return 'zero';
  return 'available';
}

export function roundMoney(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
