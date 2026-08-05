import { esc, fmtMoney } from '../utils/dom.js?v=6.9';
import { normalizeQuotaBreakdown, QUOTA_BREAKDOWN_KEYS } from '../utils/quotaBreakdown.js?v=6.9';

export const BREAKDOWN_KEYS = QUOTA_BREAKDOWN_KEYS;

export function compositionPanelShell(quota = {}) {
  if (!quota.id) {
    return `<section class="rounded-lg border border-slate-200 bg-slate-50 p-4" aria-label="资源组成">
      <div class="font-semibold text-slate-900">材料 / 设备资源组成</div>
      <div class="mt-2 text-sm text-slate-500">请先保存定额后，再关联材料或设备的价格快照。</div>
    </section>`;
  }
  return `<section class="rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="quota-resource-title">
    <div class="flex items-start justify-between gap-4">
      <div><div id="quota-resource-title" class="font-semibold text-slate-900">材料 / 设备资源组成</div>
      <div class="mt-1 text-xs text-slate-500">搜索并关联材料或设备；快照只会在明确刷新后变更。</div></div>
    </div>
    <div id="quotaResourceComposition" class="mt-4" aria-live="polite"><div class="py-6 text-center text-sm text-slate-400">正在读取资源组成…</div></div>
  </section>`;
}

export function normalizeBreakdown(breakdown = {}) {
  return normalizeQuotaBreakdown(breakdown);
}

export function parseQuotaBreakdownInputValues(rawValues = {}) {
  const breakdown = {};
  BREAKDOWN_KEYS.forEach(key => {
    const rawValue = rawValues[key];
    const value = Number(rawValue == null || rawValue === '' ? 0 : rawValue);
    if (!Number.isFinite(value)) throw new Error(`${key}必须填写有效数字`);
    breakdown[key] = value;
  });
  return normalizeBreakdown(breakdown);
}

export function buildCompositionPreview(quota = {}, usages = []) {
  const oldBreakdown = normalizeBreakdown(quota.breakdown);
  const material = roundCost(usages
    .filter(usage => usage.resourceType === 'material')
    .reduce((sum, usage) => sum + finiteNumber(usage.calculatedCost), 0));
  const equipment = roundCost(usages
    .filter(usage => usage.resourceType === 'equipment')
    .reduce((sum, usage) => sum + finiteNumber(usage.calculatedCost), 0));
  const newBreakdown = { ...oldBreakdown, 材料: material, 设备: equipment };
  const oldTotal = sumBreakdown(oldBreakdown);
  const newTotal = sumBreakdown(newBreakdown);
  const hasInstalledComposite = usages.some(usage => usage.resourceType === 'equipment' && usage.priceSnapshot?.priceBasis === 'installed_composite');
  const warnings = [];
  if (hasInstalledComposite && (oldBreakdown.人工 > 0 || oldBreakdown.机械 > 0)) {
    warnings.push('设备采用安装综合价，但定额仍含非零人工或机械费，请核对是否重复计取安装费。');
  }
  return {
    oldBreakdown,
    newBreakdown,
    delta: {
      material: roundCost(material - oldBreakdown.材料),
      equipment: roundCost(equipment - oldBreakdown.设备),
      total: roundCost(newTotal - oldTotal),
    },
    oldTotal,
    newTotal,
    warnings,
  };
}

export function buildUsageComparisonViewModel(comparison = {}) {
  const { usage = {}, resource = {}, currentPrice = null } = comparison;
  const snapshot = usage.priceSnapshot || {};
  return {
    id: usage.id || '',
    name: resource.name || '已失效资源',
    specification: resource.specModel || '',
    statusLabel: comparison.stale ? '已过时' : '已同步',
    statusTone: comparison.stale ? 'warning' : 'success',
    snapshotPrice: finiteNumber(usage.priceSnapshot?.unitPrice),
    currentPrice: finiteNumber(currentPrice?.unitPrice),
    snapshotCost: finiteNumber(usage.calculatedCost),
    currentCost: finiteNumber(comparison.currentCost),
    priceBasis: usage.priceSnapshot?.priceBasis || '',
    sourceName: usage.priceSnapshot?.sourceName || '',
    deltaLabel: signedNumber(comparison.priceDelta),
    costDeltaLabel: signedNumber(comparison.costDelta),
    staleReasons: [...(comparison.staleReasons || [])],
    changeDetails: comparisonDetails(comparison.staleReasons, snapshot, currentPrice),
  };
}

function comparisonDetails(reasons = [], snapshot, currentPrice) {
  const details = [];
  if (reasons.includes('resourceInactive')) details.push('资源已停用，请替换或确认处理');
  if (!currentPrice) details.push('当前无可用价格');
  else details.push(...priceChangeDetails(snapshot, currentPrice));
  return details;
}

export function renderCompositionPreview(preview) {
  const rows = BREAKDOWN_KEYS.map(key => {
    const oldValue = preview.oldBreakdown[key];
    const newValue = preview.newBreakdown[key];
    return `<div class="grid grid-cols-[1fr_90px_20px_90px] items-center gap-2 py-1.5 text-xs">
      <span class="text-slate-600">${key}</span><span class="text-right tabular-nums">${fmtMoney(oldValue)}</span>
      <span class="text-center text-slate-400" aria-hidden="true">→</span><span class="text-right font-medium tabular-nums">${fmtMoney(newValue)}</span>
    </div>`;
  }).join('');
  return `<div class="rounded border border-slate-200 bg-slate-50 p-3">
    <div class="mb-2 grid grid-cols-[1fr_90px_20px_90px] gap-2 text-xs font-medium text-slate-500"><span>费用项</span><span class="text-right">当前</span><span></span><span class="text-right">应用后</span></div>
    ${rows}
    <div class="mt-2 border-t border-slate-200 pt-2 text-right text-sm font-semibold text-slate-900">总价变化 ${signedMoney(preview.delta.total)}</div>
    ${preview.warnings.map(message => `<div class="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">${esc(message)}</div>`).join('')}
  </div>`;
}

function sumBreakdown(breakdown) {
  return roundCost(BREAKDOWN_KEYS.reduce((sum, key) => sum + finiteNumber(breakdown[key]), 0));
}

function finiteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundCost(value) {
  return Math.round((finiteNumber(value) + Number.EPSILON) * 100) / 100;
}

function signedNumber(value) {
  const number = finiteNumber(value);
  return `${number > 0 ? '+' : ''}${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

function signedMoney(value) {
  const number = finiteNumber(value);
  return `${number > 0 ? '+' : ''}${fmtMoney(number)}`;
}

function priceChangeDetails(snapshot, current) {
  const details = [];
  addChange(details, '口径', basisLabel(snapshot.priceBasis), basisLabel(current.priceBasis));
  addChange(details, '来源', sourceLabel(snapshot.sourceType), sourceLabel(current.sourceType));
  addChange(details, '供应商', snapshot.supplier || snapshot.sourceName || '未记录', current.supplier || '未记录');
  addChange(details, '价格日期', snapshot.priceDate || '未记录', current.priceDate || '未记录');
  addChange(details, '有效期', validityText(snapshot), validityText(current));
  addChange(details, '含税状态', snapshot.taxIncluded ? '含税' : '不含税', current.taxIncluded ? '含税' : '不含税');
  addChange(details, '税率', `${finiteNumber(snapshot.taxRate)}%`, `${finiteNumber(current.taxRate)}%`);
  addChange(details, '地区', regionText(snapshot.region), regionText(current.region));
  addChange(details, '安装范围', snapshot.installationScope || '未记录', current.installationScope || '未记录');
  return details;
}

function addChange(details, label, before, after) {
  if (before !== after) details.push(`${label}：${before} → ${after}`);
}

function basisLabel(value) {
  return { ex_factory: '出厂价', delivered: '到场价', installed_composite: '安装综合价' }[value] || '未记录';
}

function sourceLabel(value) {
  return { official: '官方信息价', supplier_quote: '供应商报价', transaction: '历史成交价' }[value] || '未记录';
}

function validityText(price) {
  return `${price.validFrom || '未限定'} ~ ${price.validTo || '长期'}`;
}

function regionText(region = {}) {
  return [region?.province, region?.city, region?.district].filter(Boolean).join('/') || '未记录';
}
