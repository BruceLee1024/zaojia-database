export const CURRENCY_OPTIONS = [
  { code: 'CNY', label: '人民币', symbol: '¥', fractionDigits: 2 },
  { code: 'USD', label: '美元', symbol: '$', fractionDigits: 2 },
  { code: 'AED', label: '阿联酋迪拉姆', symbol: 'AED', fractionDigits: 2 },
  { code: 'IQD', label: '伊拉克第纳尔', symbol: 'IQD', fractionDigits: 0 },
  { code: 'EGP', label: '埃及镑', symbol: 'EGP', fractionDigits: 2 },
];

const CURRENCY_MAP = new Map(CURRENCY_OPTIONS.map(item => [item.code, item]));

export function normalizeCurrency(value, fallback = 'CNY') {
  const code = String(value || '').trim().toUpperCase();
  return CURRENCY_MAP.has(code) ? code : fallback;
}

export function currencyMeta(value) {
  return CURRENCY_MAP.get(normalizeCurrency(value)) || CURRENCY_MAP.get('CNY');
}

export function currencyLabel(value, { includeCode = true } = {}) {
  const currency = currencyMeta(value);
  return includeCode ? `${currency.label} (${currency.code})` : currency.label;
}

export function formatCurrency(value, currency = 'CNY') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '-';
  const meta = currencyMeta(currency);
  const formatted = amount.toLocaleString('zh-CN', {
    minimumFractionDigits: meta.fractionDigits,
    maximumFractionDigits: meta.fractionDigits,
  });
  return meta.code === 'CNY' ? `${meta.symbol}${formatted}` : `${meta.symbol} ${formatted}`;
}

export function sumByCurrency(items = [], amountOf = item => item?.amount || 0, currencyOf = item => item?.currency || 'CNY') {
  const sums = new Map();
  items.forEach(item => {
    const currency = normalizeCurrency(currencyOf(item));
    sums.set(currency, (sums.get(currency) || 0) + Number(amountOf(item) || 0));
  });
  return [...sums.entries()].map(([currency, amount]) => ({ currency, amount }));
}

export function formatCurrencySummary(items = [], amountOf, currencyOf) {
  return sumByCurrency(items, amountOf, currencyOf).map(item => formatCurrency(item.amount, item.currency)).join(' · ') || '¥0.00';
}
