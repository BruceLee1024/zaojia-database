const SOURCE_LABELS = { official: '官方信息价', supplier_quote: '供应商报价', transaction: '历史成交价' };
const BASIS_LABELS = { ex_factory: '出厂价', delivered: '到场价', installed_composite: '安装综合价' };

export function buildBoqResourceViewModel(line = {}, now = new Date()) {
  const resource = line.resourceSnapshot || line.linkedResourceSnapshot || {};
  const price = line.resourcePriceSnapshot || {};
  const badges = [];
  if (line.resourceReferenceStatus === 'missing' || line.linkedResourceReferenceStatus === 'missing') badges.push('引用失效');
  if (price.validTo && price.validTo < dateText(now)) badges.push('价格过期');
  if ((line.resourceItemId || line.resourcePriceSnapshot) && !price.priceBasis) badges.push('缺价格口径');
  return {
    hasResource: Boolean(line.resourceItemId || line.linkedResourceItemId || line.resourceSnapshot || line.linkedResourceSnapshot),
    name: resource.name || line.name || '',
    specification: resource.specModel || '',
    resourceType: resource.resourceType || (line.resourceItemId ? 'equipment' : ''),
    sourceLabel: SOURCE_LABELS[price.sourceType] || price.sourceName || '未记录',
    basisLabel: BASIS_LABELS[price.priceBasis] || '未记录',
    snapshotPrice: Number(price.unitPrice || line.unitPrice || 0),
    priceDate: price.priceDate || '',
    validTo: price.validTo || '',
    badges,
  };
}

export function renderBoqResourceReference(viewModel) {
  if (!viewModel?.hasResource) return '';
  return `<div class="col-span-2 rounded border border-slate-200 bg-slate-50 p-3">
    <div class="flex items-start justify-between gap-3">
      <div><div class="font-medium text-slate-800">资源价格快照</div><div class="mt-1 text-xs text-slate-500">${escapeHtml(viewModel.name)}${viewModel.specification ? ` · ${escapeHtml(viewModel.specification)}` : ''}</div></div>
      <div class="flex flex-wrap justify-end gap-1">${viewModel.badges.map(badge => `<span class="badge badge-yellow">${escapeHtml(badge)}</span>`).join('')}</div>
    </div>
    <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
      <div><dt class="text-slate-500">价格来源</dt><dd class="mt-0.5 font-medium text-slate-700">${escapeHtml(viewModel.sourceLabel)}</dd></div>
      <div><dt class="text-slate-500">快照口径</dt><dd class="mt-0.5 font-medium text-slate-700">${escapeHtml(viewModel.basisLabel)}</dd></div>
      <div><dt class="text-slate-500">快照单价</dt><dd class="mt-0.5 font-medium tabular-nums text-slate-700">¥${viewModel.snapshotPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</dd></div>
      <div><dt class="text-slate-500">价格日期 / 有效期</dt><dd class="mt-0.5 font-medium text-slate-700">${escapeHtml(viewModel.priceDate || '未记录')} / ${escapeHtml(viewModel.validTo || '长期')}</dd></div>
    </dl>
  </div>`;
}

function dateText(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}
