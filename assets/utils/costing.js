// 造价计算纯函数：便于服务层和测试共用
export function calculateAmount(qty = 0, unitPrice = 0, factor = 1) {
  return (Number(qty) || 0) * (Number(unitPrice) || 0) * (Number(factor) || 1);
}

export function hasMissingPrice(value) {
  return !(Number(value) > 0);
}
