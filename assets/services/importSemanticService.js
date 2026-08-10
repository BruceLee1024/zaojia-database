// 导入语义归一：保留原始业务词，同时给出可审计的本地推断。
// AI 建议会在这一层之上补充，而不是绕过数据校验直接改写业务数据。
const SOURCE_TYPE_ALIASES = new Map([
  ['official', 'official'], ['官方信息价', 'official'], ['信息价', 'official'], ['政府信息价', 'official'],
  ['supplier_quote', 'supplier_quote'], ['供应商报价', 'supplier_quote'], ['询价', 'supplier_quote'], ['询报价', 'supplier_quote'],
  ['transaction', 'transaction'], ['成交价', 'transaction'], ['历史成交', 'transaction'], ['实际采购', 'transaction'],
  ['实际采购价', 'transaction'], ['采购价', 'transaction'], ['历史采购', 'transaction'], ['合同价', 'transaction'], ['中标价', 'transaction'],
]);

const PRICE_BASIS_ALIASES = new Map([
  ['ex_factory', 'ex_factory'], ['出厂价', 'ex_factory'],
  ['delivered', 'delivered'], ['到场价', 'delivered'], ['落地价', 'delivered'], ['含运到场', 'delivered'],
  ['installed_composite', 'installed_composite'], ['安装综合价', 'installed_composite'], ['安装价', 'installed_composite'],
]);

export function normalizeResourcePriceSemantics({ sourceType = '', priceBasis = '', province = '', city = '', district = '', region = '' } = {}) {
  const rawSourceType = compact(sourceType);
  const rawPriceBasis = compact(priceBasis);
  const rawRegion = compact(region);
  const normalizedSourceType = SOURCE_TYPE_ALIASES.get(rawSourceType.toLowerCase()) || rawSourceType.toLowerCase() || 'official';
  const normalizedPriceBasis = PRICE_BASIS_ALIASES.get(rawPriceBasis.toLowerCase()) || rawPriceBasis.toLowerCase() || 'delivered';
  const normalizedProvince = compact(province) || (!compact(city) && !compact(district) ? rawRegion : '');
  const suggestions = [];
  if (rawSourceType && normalizedSourceType !== rawSourceType.toLowerCase()) suggestions.push(`价格来源“${rawSourceType}”已按成交/历史采购价处理`);
  if (!compact(province) && rawRegion) suggestions.push(`地区“${rawRegion}”已暂存为省份/区域`);
  if (!rawPriceBasis) suggestions.push('未提供价格口径，暂按到场价处理');
  return {
    sourceType: normalizedSourceType,
    priceBasis: normalizedPriceBasis,
    region: { province: normalizedProvince, city: compact(city), district: compact(district) },
    raw: { sourceType: rawSourceType, priceBasis: rawPriceBasis, region: rawRegion },
    suggestions,
  };
}

export function classifyResourcePriceReview(price) {
  if (!price) return [];
  const issues = [];
  if (!['official', 'supplier_quote', 'transaction'].includes(price.sourceType)) issues.push('价格来源无法识别，价格已转入待确认');
  if (!['ex_factory', 'delivered', 'installed_composite'].includes(price.priceBasis)) issues.push('价格口径无法识别，价格已转入待确认');
  if (!(price.unitPrice > 0)) issues.push(price.unitPrice < 0 ? '负数单价可能是调整或冲销，价格已转入待确认' : '单价必须大于 0，价格已转入待确认');
  if (!Number.isFinite(price.taxRate) || price.taxRate < 0 || price.taxRate > 100) issues.push('税率不在 0 到 100 之间，价格已转入待确认');
  if (!isDate(price.priceDate)) issues.push('价格日期缺失或无效，价格已转入待确认');
  if (!price.region?.province && !price.region?.city && !price.region?.district) issues.push('价格地区缺失，价格已转入待确认');
  if (price.validFrom && !isDate(price.validFrom)) issues.push('生效日期无效，价格已转入待确认');
  if (price.validTo && !isDate(price.validTo)) issues.push('失效日期无效，价格已转入待确认');
  if (price.validFrom && price.validTo && price.validFrom > price.validTo) issues.push('失效日期不能早于生效日期，价格已转入待确认');
  if (price.priceBasis === 'installed_composite' && !price.installationScope) issues.push('安装综合价缺少安装范围，价格已转入待确认');
  return issues;
}

function compact(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function isDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}
