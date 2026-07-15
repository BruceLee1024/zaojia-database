import { quotaResourceService } from '../services/quotaResourceService.js?v=6.0';
import { resourcePriceService } from '../services/resourcePriceService.js?v=6.0';
import { resourceService } from '../services/resourceService.js?v=4.1';
import { esc, fmtMoney, toast } from '../utils/dom.js';
import { buildCompositionPreview, buildUsageComparisonViewModel, renderCompositionPreview } from './quotaResourceComposition.js?v=4.2';
import { createBusyActionRunner, createLatestRequestGuard } from '../utils/asyncInteraction.js?v=4.2';

export async function applyCompositionFromPanel({ quota, getBaseBreakdown, service = quotaResourceService }) {
  const baseBreakdown = getBaseBreakdown?.();
  const updated = await service.applyComposition(quota.id, { baseBreakdown });
  Object.assign(quota, updated);
  return updated;
}

export function isCurrentQuotaResourcePanel({
  container,
  currentContainer,
  expectedGeneration,
  currentGeneration,
  expectedResourceId = '',
  currentResourceId = '',
}) {
  return Boolean(container?.isConnected
    && currentContainer === container
    && expectedGeneration === currentGeneration
    && expectedResourceId === currentResourceId);
}

export async function mountQuotaResourceComposition(quota, { onApplied, getBaseBreakdown } = {}) {
  const container = document.getElementById('quotaResourceComposition');
  if (!container || !quota?.id) return;
  const state = { keyword: '', selectedResourceId: '', renderGeneration: 0 };
  const renderGuard = createLatestRequestGuard();
  let activeAction = null;
  const isCurrentContext = context => isCurrentQuotaResourcePanel({
    container,
    currentContainer: document.getElementById('quotaResourceComposition'),
    expectedGeneration: context.generation,
    currentGeneration: state.renderGeneration,
    expectedResourceId: context.resourceId,
    currentResourceId: state.selectedResourceId,
  });
  const actionRunner = createBusyActionRunner({
    onBusy: busy => setPanelBusy(container, busy),
    onError: error => {
      if (activeAction && isCurrentContext(activeAction)) toast(error.message || '资源组成操作失败', 'error');
    },
  });
  const runAction = async action => {
    if (actionRunner.busy) return actionRunner.run(action);
    activeAction = { generation: state.renderGeneration, resourceId: state.selectedResourceId };
    try {
      return await actionRunner.run(action);
    } finally {
      activeAction = null;
    }
  };

  const render = async () => {
    const request = { keyword: state.keyword, selectedResourceId: state.selectedResourceId, generation: ++state.renderGeneration };
    try {
      return await renderGuard.run(async () => {
        const [comparisons, resources] = await Promise.all([
          quotaResourceService.compareUsages(quota.id),
          resourceService.list({ keyword: request.keyword, status: 'active' }),
        ]);
        const selected = resources.find(item => item.id === request.selectedResourceId)
          || (request.selectedResourceId ? await resourceService.get(request.selectedResourceId) : null);
        const prices = selected ? await resourcePriceService.listByResource(selected.id) : [];
        const previewQuota = { ...quota, breakdown: getBaseBreakdown?.() || quota.breakdown };
        return { comparisons, resources: resources.slice(0, 8), selected, prices, preview: buildCompositionPreview(previewQuota, comparisons.map(item => item.usage)), keyword: request.keyword };
      }, model => {
        if (!container.isConnected || document.getElementById('quotaResourceComposition') !== container) return;
        container.innerHTML = panelHtml(model);
        bindPanel(container, { quota, state, render, preview: model.preview, usages: model.comparisons.map(item => item.usage), onApplied, getBaseBreakdown, actionRunner, runAction });
        setPanelBusy(container, actionRunner.busy);
      });
    } catch (error) {
      const current = isCurrentContext({ generation: request.generation, resourceId: request.selectedResourceId });
      if (current) {
        container.innerHTML = `<div class="rounded border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">资源组成读取失败：${esc(error.message)}</div>`;
        toast(error.message || '资源组成读取失败', 'error');
      }
      return { stale: false, error };
    }
  };

  await render();
}

function panelHtml({ comparisons, resources, selected, prices, preview, keyword }) {
  return `<div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
    <div class="space-y-3">
      <div class="flex gap-2">
        <label class="sr-only" for="quotaResourceSearch">搜索材料或设备</label>
        <input id="quotaResourceSearch" type="search" value="${esc(keyword)}" placeholder="输入名称、编码、规格或品牌" class="h-9 min-w-0 flex-1 rounded border border-slate-300 px-3 text-sm" />
        <button id="quotaResourceSearchBtn" type="button" class="h-9 rounded border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50">搜索</button>
      </div>
      <div class="flex flex-wrap gap-2">${resources.length ? resources.map(item => `
        <button type="button" data-select-resource="${item.id}" class="rounded border px-3 py-2 text-left text-xs ${selected?.id === item.id ? 'border-teal-400 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'}">
          <span class="font-medium text-slate-800">${esc(item.name)}</span><span class="ml-1 text-slate-500">${esc(item.specModel || item.code || '')}</span>
          <span class="ml-2 text-slate-400">${item.resourceType === 'equipment' ? '设备' : '材料'}</span>
        </button>`).join('') : '<div class="w-full rounded border border-dashed border-slate-200 py-4 text-center text-sm text-slate-400">未找到可关联资源</div>'}</div>
      ${selected ? linkForm(selected, prices) : ''}
      <div class="space-y-2">${comparisons.length ? comparisons.map(comparisonRow).join('') : '<div class="rounded border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">尚未关联材料或设备</div>'}</div>
    </div>
    <aside><div class="mb-2 flex items-center justify-between"><div class="text-sm font-semibold text-slate-800">组成应用预览</div><button id="quotaCompositionApply" data-panel-mutation type="button" class="rounded bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-wait disabled:bg-slate-400">确认应用</button></div>${renderCompositionPreview(preview)}</aside>
  </div>`;
}

function linkForm(resource, prices) {
  return `<div class="rounded border border-teal-200 bg-teal-50 p-3">
    <div class="mb-2 text-sm font-medium text-teal-950">关联 ${esc(resource.name)}</div>
    <div class="grid grid-cols-2 gap-2 xl:grid-cols-[1fr_110px_90px_auto]">
      <label class="col-span-2 text-xs text-slate-600 xl:col-span-1">价格快照<select id="quotaResourcePrice" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm">${prices.map(price => `<option value="${price.id}">${fmtMoney(price.unitPrice)} · ${basisLabel(price.priceBasis)} · ${esc(price.priceDate || '')}</option>`).join('')}</select></label>
      <label class="text-xs text-slate-600">单位用量<input id="quotaResourceQty" type="number" min="0" step="0.0001" value="1" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-right text-sm" /></label>
      <label class="text-xs text-slate-600">损耗率 %<input id="quotaResourceLoss" type="number" min="0" step="0.01" value="0" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-right text-sm" /></label>
      <button id="quotaResourceLink" data-panel-mutation data-no-price="${prices.length ? 'false' : 'true'}" type="button" ${prices.length ? '' : 'disabled'} class="mt-5 h-9 rounded bg-teal-700 px-3 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-300">关联</button>
    </div>${prices.length ? '' : '<div class="mt-2 text-xs text-amber-700">该资源尚无可用价格，请先在材料/设备库建立价格记录。</div>'}
  </div>`;
}

function comparisonRow(comparison) {
  const vm = buildUsageComparisonViewModel(comparison);
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="flex items-start justify-between gap-3"><div><span class="font-medium text-slate-800">${esc(vm.name)}</span><span class="ml-2 text-xs text-slate-500">${esc(vm.specification)}</span></div><span class="badge ${comparison.stale ? 'badge-yellow' : 'badge-green'}">${vm.statusLabel}</span></div>
    <div class="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-600"><span>快照 ${fmtMoney(vm.snapshotPrice)}</span><span>当前 ${comparison.currentPrice ? fmtMoney(vm.currentPrice) : '无可用价'}</span><span>单价差 ${vm.deltaLabel}</span><span>用量 ${comparison.usage.quantityPerUnit}</span><span>损耗 ${comparison.usage.lossRate}%</span><span>成本差 ${vm.costDeltaLabel}</span></div>
    ${vm.changeDetails.length ? `<div class="mt-2 rounded border border-amber-100 bg-amber-50/60 px-2 py-1.5 text-xs leading-5 text-amber-900">${vm.changeDetails.map(detail => `<div>${esc(detail)}</div>`).join('')}</div>` : ''}
    <div class="mt-2 flex justify-end gap-2">${comparison.stale ? `<button type="button" data-panel-mutation data-refresh-usage="${vm.id}" class="rounded border border-amber-300 px-2 py-1 text-xs text-amber-800 hover:bg-amber-50 disabled:cursor-wait disabled:opacity-50">刷新快照</button>` : ''}<button type="button" data-panel-mutation data-remove-usage="${vm.id}" class="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-wait disabled:opacity-50">移除</button></div>
  </div>`;
}

function bindPanel(container, context) {
  const search = () => { context.state.keyword = container.querySelector('#quotaResourceSearch')?.value.trim() || ''; context.state.selectedResourceId = ''; context.render(); };
  container.querySelector('#quotaResourceSearchBtn')?.addEventListener('click', search);
  container.querySelector('#quotaResourceSearch')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
  container.querySelectorAll('[data-select-resource]').forEach(button => button.addEventListener('click', () => { context.state.selectedResourceId = button.dataset.selectResource; context.render(); }));
  container.querySelector('#quotaResourceLink')?.addEventListener('click', () => context.runAction(() => linkUsage(container, context)));
  container.querySelectorAll('[data-remove-usage]').forEach(button => button.addEventListener('click', () => context.runAction(async () => {
    if (!confirm('确定从当前定额组成中移除该资源？')) return;
    await quotaResourceService.removeUsage(button.dataset.removeUsage); await context.render();
  })));
  container.querySelectorAll('[data-refresh-usage]').forEach(button => button.addEventListener('click', () => context.runAction(async () => {
    if (!confirm('刷新会用当前价格替换原价格快照，不可自动撤销。确定继续？')) return;
    await quotaResourceService.refreshUsageSnapshot(button.dataset.refreshUsage); await context.render();
  })));
  container.querySelector('#quotaCompositionApply')?.addEventListener('click', () => context.runAction(async () => {
    const livePreview = buildCompositionPreview({ ...context.quota, breakdown: context.getBaseBreakdown?.() || context.quota.breakdown }, context.usages);
    if (!confirm(`应用后仅更新材料费和设备费，其他分项保持不变。总价变化 ${signedMoney(livePreview.delta.total)}，确定应用？`)) return;
    const updated = await applyCompositionFromPanel(context); await context.onApplied?.(updated); toast('资源组成已应用', 'success'); await context.render();
  }));
}

async function linkUsage(container, context) {
  await quotaResourceService.saveUsage({ quotaItemId: context.quota.id, resourceId: context.state.selectedResourceId, selectedPriceId: container.querySelector('#quotaResourcePrice').value, quantityPerUnit: container.querySelector('#quotaResourceQty').value, lossRate: container.querySelector('#quotaResourceLoss').value });
  context.state.selectedResourceId = ''; toast('已关联资源价格快照', 'success'); await context.render();
}

function basisLabel(value) { return { ex_factory: '出厂价', delivered: '到场价', installed_composite: '安装综合价' }[value] || '未标注口径'; }
function signedMoney(value) { const number = Number(value || 0); return `${number > 0 ? '+' : ''}${fmtMoney(number)}`; }

function setPanelBusy(container, busy) {
  container.setAttribute('aria-busy', String(busy));
  container.querySelectorAll('[data-panel-mutation]').forEach(button => { button.disabled = busy || button.dataset.noPrice === 'true'; });
}
