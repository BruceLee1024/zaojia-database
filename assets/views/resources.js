import { boqService } from '../services/boqService.js?v=6.2';
import { resourcePriceService } from '../services/resourcePriceService.js?v=6.2';
import { resourceService } from '../services/resourceService.js?v=6.2';
import { projectRepo, quotaRepo } from '../data/repository.js?v=6.2';
import { exportResourceTemplate } from '../data/excel.js?v=6.2';
import { closeModal, esc, fmtMoney, openModal, toast } from '../utils/dom.js?v=6.2';
import { attachmentPanelShell, loadAttachmentPanel } from './resourceAttachments.js?v=6.2';

const state = { resourceType: 'material', keyword: '', category: '', status: '', selectedId: '', resourceIds: [], healthLabel: '', rows: [], prices: new Map(), usage: null };
let attachmentRenderGeneration = 0;
const LABELS = {
  material: { singular: '材料', plural: '材料库', icon: 'category', route: 'materials' },
  equipment: { singular: '设备', plural: '设备库', icon: 'precision_manufacturing', route: 'equipment' },
};

export async function render() {
  const route = window.__app?.state?.currentView;
  const params = window.__app?.state?.routeParams || {};
  Object.assign(state, nextResourceViewState(state, route, params));
  exposeActions();
  await refresh();
}

export function nextResourceViewState(current = {}, route = 'materials', params = {}) {
  const resourceType = route === 'equipment' ? 'equipment' : 'material';
  const changedType = current.resourceType !== resourceType;
  const next = {
    resourceType,
    keyword: changedType ? '' : String(current.keyword || ''),
    category: changedType ? '' : String(current.category || ''),
    status: changedType ? '' : String(current.status || ''),
    selectedId: changedType ? '' : String(current.selectedId || ''),
  };
  for (const key of ['keyword', 'category', 'status', 'selectedId']) {
    if (Object.prototype.hasOwnProperty.call(params, key)) next[key] = String(params[key] || '');
  }
  if (Object.prototype.hasOwnProperty.call(current, 'resourceIds') || Object.prototype.hasOwnProperty.call(params, 'resourceIds')) {
    next.resourceIds = [];
  }
  if (Object.prototype.hasOwnProperty.call(current, 'healthLabel') || Object.prototype.hasOwnProperty.call(params, 'healthLabel')) {
    next.healthLabel = '';
  }
  if (Object.prototype.hasOwnProperty.call(params, 'resourceIds')) next.resourceIds = normalizeResourceIds(params.resourceIds);
  if (Object.prototype.hasOwnProperty.call(params, 'healthLabel')) next.healthLabel = String(params.healthLabel || '');
  return next;
}

function normalizeResourceIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))];
}

export function createLatestResourceSelection({ setSelectedId, getSelectedId, loadUsage, commit }) {
  let requestGeneration = 0;
  return async id => {
    const resourceId = String(id || '');
    const request = ++requestGeneration;
    setSelectedId(resourceId);
    const usage = await loadUsage(resourceId);
    if (request !== requestGeneration || getSelectedId() !== resourceId) return false;
    await commit({ id: resourceId, usage, request });
    return true;
  };
}

const selectResource = createLatestResourceSelection({
  setSelectedId: id => { state.selectedId = id; },
  getSelectedId: () => state.selectedId,
  loadUsage: id => resourceService.usage(id),
  commit: async ({ id, usage }) => {
    state.usage = usage;
    const generation = paint();
    await Promise.all([loadPriceHistory(id), loadAttachmentPanel(id, generation)]);
  },
});

async function refresh() {
  state.rows = await resourceService.list({ resourceType: state.resourceType, keyword: state.keyword, category: state.category, status: state.status });
  if (state.resourceIds.length) state.rows = state.rows.filter(item => state.resourceIds.includes(item.id));
  if (state.selectedId && !state.rows.some(item => item.id === state.selectedId)) state.selectedId = '';
  if (!state.selectedId && state.rows.length) state.selectedId = state.rows[0].id;
  state.prices = new Map(await Promise.all(state.rows.map(async item => [item.id, await resourcePriceService.getCurrentPrice(item.id)])));
  state.usage = state.selectedId ? await resourceService.usage(state.selectedId) : null;
  const generation = paint();
  if (state.selectedId) await Promise.all([loadPriceHistory(state.selectedId), loadAttachmentPanel(state.selectedId, generation)]);
}

function paint() {
  const generation = String(++attachmentRenderGeneration);
  const meta = LABELS[state.resourceType];
  const selected = state.rows.find(item => item.id === state.selectedId);
  const categories = [...new Set(state.rows.map(item => item.category).filter(Boolean))];
  document.getElementById('workspace').innerHTML = `
    <div class="page-frame min-h-full flex flex-col gap-4">
      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div class="flex items-center gap-3">
            <span class="material-symbols-outlined h-10 w-10 border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center">${meta.icon}</span>
            <div><h1 class="text-xl font-semibold text-slate-950">${meta.plural}</h1><p class="mt-1 text-xs text-slate-500">维护主数据、价格快照与使用位置</p></div>
          </div>
          <div class="flex-1"></div>
          <button onclick="window.__resources.downloadTemplate()" class="h-9 px-3 border border-slate-300 bg-white text-sm text-slate-700">下载模板</button>
          <button onclick="window.__resources.importExcel()" class="h-9 px-3 border border-teal-300 bg-white text-sm text-teal-700">导入 Excel</button>
          <button onclick="window.__resources.edit()" class="h-9 px-4 brand-bg text-white text-sm">新增${meta.singular}</button>
        </div>
        ${state.resourceIds.length ? `<div role="status" class="mt-3 flex flex-wrap items-center justify-between gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><span>已按仪表盘“${esc(state.healthLabel || '资源健康')}”筛选，共 ${state.resourceIds.length} 条。</span><button onclick="window.__resources.clearHealthFilter()" class="font-medium underline">查看全部${meta.singular}</button></div>` : ''}
        <div class="mt-4 grid grid-cols-1 md:grid-cols-[minmax(240px,1fr)_180px_150px_auto] gap-2">
          <label class="relative"><span class="sr-only">搜索${meta.singular}</span><input value="${esc(state.keyword)}" oninput="window.__resources.filter('keyword',this.value)" type="search" placeholder="搜索编码、名称、规格、品牌…" class="h-9 w-full border border-slate-300 bg-white pl-9 pr-3 text-sm"><span class="material-symbols-outlined absolute left-3 top-2.5 text-[17px] text-slate-400">search</span></label>
          <select onchange="window.__resources.filter('category',this.value)" class="h-9 border border-slate-300 bg-white px-2 text-sm"><option value="">全部分类</option>${categories.map(value => `<option ${value === state.category ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>
          <select onchange="window.__resources.filter('status',this.value)" class="h-9 border border-slate-300 bg-white px-2 text-sm"><option value="">全部状态</option><option value="active" ${state.status === 'active' ? 'selected' : ''}>启用</option><option value="inactive" ${state.status === 'inactive' ? 'selected' : ''}>停用</option></select>
          <button onclick="window.__resources.clearFilters()" class="h-9 px-3 border border-slate-300 bg-white text-sm text-slate-600">清除筛选</button>
        </div>
      </section>
      <div class="grid flex-1 min-h-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
        ${resourceTable(meta)}
        ${selected ? detailPanel(selected, meta, generation) : emptyDetail(meta)}
      </div>
      </div>`;
  bindResourceIdActions(document.getElementById('workspace'));
  return generation;
}

function resourceTable(meta) {
  return `<section class="rounded-lg border border-slate-200 bg-white overflow-hidden min-h-[420px]">
    <div class="border-b border-slate-200 px-4 py-3 flex items-center"><h2 class="font-semibold text-slate-900">${meta.plural}清单</h2><span class="ml-2 text-xs text-slate-500">${state.rows.length} 条</span></div>
    <div class="overflow-auto"><table class="w-full text-sm"><thead class="bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-2 text-left">编码 / 名称</th><th class="px-3 text-left">规格型号</th><th class="px-3 text-left">分类</th><th class="px-3 text-right">当前价</th><th class="px-3 text-left">状态</th><th class="px-3 w-28"></th></tr></thead>
    <tbody class="divide-y divide-slate-100">${state.rows.length ? state.rows.map(item => resourceRowHtml(item, state.prices.get(item.id), item.id === state.selectedId)).join('') : `<tr><td colspan="6" class="py-16 text-center text-slate-400">暂无符合条件的${meta.singular}。</td></tr>`}</tbody></table></div></section>`;
}

export function resourceRowHtml(item, price, active) {
  return `<tr class="${active ? 'bg-teal-50/70' : 'hover:bg-slate-50'}"><td class="px-3 py-3"><button data-resource-action="select" data-resource-id="${esc(item.id)}" class="block text-left"><span class="block font-medium text-slate-900">${esc(item.name)}</span><span class="mt-0.5 block text-xs font-data text-slate-500">${esc(item.code || '未编码')} · ${esc(item.unit)}</span></button></td><td class="px-3 text-slate-600">${esc(item.specModel || '-')}</td><td class="px-3 text-slate-600">${esc(item.category || '未分类')}</td><td class="px-3 text-right tabular-nums">${price ? fmtMoney(price.unitPrice) : '<span class="text-amber-600">待询价</span>'}</td><td class="px-3"><span class="badge ${item.status === 'inactive' ? 'badge-gray' : 'badge-green'}">${item.status === 'inactive' ? '停用' : '启用'}</span></td><td class="px-3"><div class="flex justify-end gap-1"><button aria-label="编辑" title="编辑" data-resource-action="edit" data-resource-id="${esc(item.id)}" class="h-8 w-8 text-slate-500 hover:bg-slate-100"><span class="material-symbols-outlined text-[17px]">edit</span></button><button aria-label="复制" title="复制" data-resource-action="copy" data-resource-id="${esc(item.id)}" class="h-8 w-8 text-slate-500 hover:bg-slate-100"><span class="material-symbols-outlined text-[17px]">content_copy</span></button></div></td></tr>`;
}

function detailPanel(item, meta, generation) {
  const current = state.prices.get(item.id);
  const usage = state.usage || {};
  return `<aside class="rounded-lg border border-slate-200 bg-white overflow-auto">
    <div class="p-4 border-b border-slate-200"><div class="flex items-start gap-3"><div class="min-w-0 flex-1"><div class="text-xs text-slate-500">${esc(item.code || '未编码')}</div><h2 class="mt-1 text-lg font-semibold text-slate-900">${esc(item.name)}</h2><p class="mt-1 text-sm text-slate-500">${esc(item.specModel || '未填规格')} · ${esc(item.unit)}</p></div><button data-resource-action="toggleStatus" data-resource-id="${esc(item.id)}" class="h-8 px-2 border border-slate-300 bg-white text-xs">${item.status === 'inactive' ? '恢复启用' : '停用'}</button></div>
      <div class="mt-4 grid grid-cols-2 gap-2 text-xs">${field('分类', item.category)}${field('品牌 / 厂家', item.brand || item.manufacturer)}${field('执行标准', item.standard)}${field('工艺段', item.processStage)}</div>
      ${item.tags?.length ? `<div class="mt-3 flex flex-wrap gap-1">${item.tags.map(tag => `<span class="badge badge-blue">${esc(tag)}</span>`).join('')}</div>` : ''}
      ${item.note ? `<p class="mt-3 text-xs leading-5 text-slate-500">${esc(item.note)}</p>` : ''}
    </div>
    <section class="p-4 border-b border-slate-200"><div class="flex items-center"><div><h3 class="font-semibold text-slate-900">价格历史</h3><p class="mt-1 text-xs text-slate-500">${current ? `当前价 ${fmtMoney(current.unitPrice)} · ${esc(current.priceDate)}` : '还没有价格快照'}</p></div><div class="flex-1"></div><button data-resource-action="addPrice" data-resource-id="${esc(item.id)}" class="h-8 px-3 border border-teal-300 bg-white text-xs text-teal-700">新增价格</button></div><div id="resourcePriceHistory" class="mt-3 text-xs text-slate-400">正在读取价格历史…</div></section>
    <section class="p-4 border-b border-slate-200"><h3 class="font-semibold text-slate-900">使用位置</h3><div class="mt-3 grid grid-cols-2 gap-2">${metric('定额引用', usage.quotaUsageCount || 0)}${metric('项目清单', usage.projectLineCount || 0)}</div>${usage.total ? `<p class="mt-3 text-xs leading-5 text-slate-500">定额 ID：${esc((usage.quotaItemIds || []).join('、') || '-')}<br>项目 ID：${esc((usage.projectIds || []).join('、') || '-')}</p>` : '<p class="mt-3 text-xs text-slate-400">尚未被定额或项目清单引用。</p>'}</section>
    ${attachmentPanelShell(item.id, generation)}
    <div class="p-4 flex flex-wrap gap-2">${state.resourceType === 'equipment' ? `<button data-resource-action="addToProject" data-resource-id="${esc(item.id)}" ${current ? '' : 'disabled'} class="h-9 flex-1 brand-bg px-3 text-sm text-white disabled:opacity-40">加入项目</button>` : ''}<button data-resource-action="edit" data-resource-id="${esc(item.id)}" class="h-9 px-3 border border-slate-300 bg-white text-sm">编辑</button><button data-resource-action="remove" data-resource-id="${esc(item.id)}" class="h-9 px-3 border border-red-200 bg-white text-sm text-red-600">停用 / 移除</button></div>
  </aside>`;
}

function emptyDetail(meta) { return `<aside class="rounded-lg border border-slate-200 bg-white min-h-[420px] flex items-center justify-center p-8 text-center"><div><span class="material-symbols-outlined text-4xl text-slate-300">${meta.icon}</span><h2 class="mt-3 font-semibold text-slate-800">选择一条${meta.singular}</h2><p class="mt-1 text-sm text-slate-400">详情、价格和引用位置会显示在这里。</p></div></aside>`; }
function field(label, value) { return `<div class="border border-slate-100 bg-slate-50 px-2 py-2"><div class="text-slate-400">${label}</div><div class="mt-1 text-slate-700">${esc(value || '-')}</div></div>`; }
function metric(label, value) { return `<div class="border border-slate-200 bg-slate-50 px-3 py-2"><div class="text-xs text-slate-500">${label}</div><div class="mt-1 text-lg font-semibold tabular-nums text-slate-900">${value}</div></div>`; }

function exposeActions() {
  window.__resources = {
    select: selectResource,
    filter: (key, value) => { state[key] = value; clearTimeout(window.__resourceFilterTimer); window.__resourceFilterTimer = setTimeout(refresh, 150); },
    clearFilters: () => { state.keyword = ''; state.category = ''; state.status = ''; refresh(); },
    clearHealthFilter: () => { state.resourceIds = []; state.healthLabel = ''; refresh(); },
    edit: showResourceEditor,
    copy: async id => { const copy = await resourceService.copy(id); state.selectedId = copy.id; toast('已创建副本', 'success'); await refresh(); },
    toggleStatus: async id => { const item = await resourceService.get(id); await resourceService.setStatus(id, item.status === 'inactive' ? 'active' : 'inactive'); toast('状态已更新', 'success'); await refresh(); },
    remove: removeResource,
    addPrice: showPriceEditor,
    preferPrice: async (resourceId, priceId) => { await resourceService.setPreferredPrice(resourceId, priceId); toast('已设为首选价格', 'success'); await refresh(); await loadPriceHistory(resourceId); },
    withdrawPrice: async (resourceId, priceId) => { if (!confirm('撤回这条价格快照？历史记录和附件仍保留。')) return; await resourcePriceService.withdraw(priceId); await refresh(); await loadPriceHistory(resourceId); },
    addToProject: showAddToProject,
    importExcel: () => window.__app.go('resource-import', { resourceType: state.resourceType }),
    downloadTemplate: () => exportResourceTemplate(state.resourceType),
  };
}

async function loadPriceHistory(resourceId) {
  const host = document.getElementById('resourcePriceHistory');
  if (!host || state.selectedId !== resourceId) return;
  const [resource, prices] = await Promise.all([resourceService.get(resourceId), resourcePriceService.listByResource(resourceId)]);
  host.innerHTML = prices.length ? `<div class="space-y-2">${prices.map(price => `<div class="border ${price.id === resource.preferredPriceId ? 'border-teal-300 bg-teal-50/50' : 'border-slate-200'} p-2"><div class="flex items-center gap-2"><span class="font-semibold text-slate-900">${fmtMoney(price.unitPrice)}</span>${price.id === resource.preferredPriceId ? '<span class="badge badge-green">首选</span>' : ''}${price.status === 'withdrawn' ? '<span class="badge badge-gray">已撤回</span>' : ''}<span class="ml-auto text-slate-500">${esc(price.priceDate)}</span></div><div class="mt-1 text-slate-500">${esc(price.region?.province || '')}${esc(price.region?.city || '')} · ${sourceLabel(price.sourceType)} · ${basisLabel(price.priceBasis)}${price.supplier ? ` · ${esc(price.supplier)}` : ''}</div><div class="mt-2 flex gap-3">${price.status === 'withdrawn' ? '' : `<button data-price-action="prefer" data-resource-id="${esc(resourceId)}" data-price-id="${esc(price.id)}" class="text-teal-700">设为首选</button><button data-price-action="withdraw" data-resource-id="${esc(resourceId)}" data-price-id="${esc(price.id)}" class="text-red-600">撤回</button>`}</div></div>`).join('')}</div>` : '<div class="border border-dashed border-slate-200 p-4 text-center">暂无价格历史。</div>';
  host.querySelectorAll('[data-price-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.priceAction === 'prefer' ? 'preferPrice' : 'withdrawPrice';
    window.__resources[action](button.dataset.resourceId, button.dataset.priceId);
  }));
}

function bindResourceIdActions(root) {
  root?.querySelectorAll('[data-resource-action]').forEach(button => button.addEventListener('click', () => {
    window.__resources[button.dataset.resourceAction]?.(button.dataset.resourceId);
  }));
}

async function showResourceEditor(id = '') {
  const item = id ? await resourceService.get(id) : { resourceType: state.resourceType, status: 'active', tags: [] };
  const meta = LABELS[state.resourceType];
  openModal(`${id ? '编辑' : '新增'}${meta.singular}`, `<form id="resourceEditForm" class="grid grid-cols-2 gap-3 text-sm">
    ${input('编码', 'code', item.code)}${input('分类', 'category', item.category)}${input('名称 *', 'name', item.name, 'col-span-2', true)}${input('规格型号', 'specModel', item.specModel)}${input('单位 *', 'unit', item.unit, '', true)}${input('品牌', 'brand', item.brand)}${input('生产厂家', 'manufacturer', item.manufacturer)}${input('执行标准', 'standard', item.standard)}${input('工艺段', 'processStage', item.processStage)}${input('标签（逗号分隔）', 'tags', (item.tags || []).join(','), 'col-span-2')}${input('备注', 'note', item.note, 'col-span-2')}
  </form>`, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="saveResourceButton" class="h-9 px-4 brand-bg text-white text-sm">保存</button>`);
  document.getElementById('saveResourceButton').onclick = async () => {
    const data = Object.fromEntries(new FormData(document.getElementById('resourceEditForm')));
    await resourceService.save({ ...item, ...data, id: id || undefined, resourceType: state.resourceType, tags: String(data.tags || '').split(/[,，]/).map(value => value.trim()).filter(Boolean) });
    closeModal(); toast(`${meta.singular}已保存`, 'success'); await refresh();
  };
}

async function showPriceEditor(resourceId) {
  openModal('新增价格快照', `<form id="resourcePriceForm" class="grid grid-cols-2 gap-3 text-sm">
    <label>价格来源<select name="sourceType" class="mt-1 h-9 w-full border border-slate-300 bg-white px-2"><option value="official">官方信息价</option><option value="supplier_quote">供应商报价</option><option value="transaction">历史成交价</option></select></label>
    <label>价格口径<select name="priceBasis" class="mt-1 h-9 w-full border border-slate-300 bg-white px-2"><option value="delivered">到场价</option><option value="ex_factory">出厂价</option><option value="installed_composite">安装综合价</option></select></label>
    ${input('单价 *', 'unitPrice', '', '', true, 'number')}${input('价格日期 *', 'priceDate', new Date().toISOString().slice(0, 10), '', true, 'date')}${input('省', 'province')}${input('市', 'city')}${input('区县', 'district')}${input('供应商', 'supplier')}${input('税率 %', 'taxRate', '0', '', false, 'number')}${input('安装范围', 'installationScope')}
    <label class="col-span-2 flex items-center gap-2"><input name="taxIncluded" value="true" type="checkbox">含税价</label>
  </form>`, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="saveResourcePriceButton" class="h-9 px-4 brand-bg text-white text-sm">保存快照</button>`);
  document.getElementById('saveResourcePriceButton').onclick = async () => {
    const form = document.getElementById('resourcePriceForm'); const data = Object.fromEntries(new FormData(form));
    await resourcePriceService.save({ ...data, resourceId, region: { province: data.province, city: data.city, district: data.district }, taxIncluded: Boolean(data.taxIncluded) });
    closeModal(); toast('价格快照已保存', 'success'); await refresh(); await loadPriceHistory(resourceId);
  };
}

async function removeResource(id) {
  if (!confirm('停用或移除这条主数据？有历史记录时将保留为停用档案。')) return;
  try { await resourceService.remove(id); state.selectedId = ''; toast('已移除未使用资源', 'success'); await refresh(); }
  catch (error) { if (error.code !== 'RESOURCE_IN_USE' || !confirm(`该资源有 ${error.usage.total} 条历史或引用。继续将只停用主数据，不删除价格、附件和引用，是否继续？`)) throw error; await resourceService.remove(id, { force: true }); state.selectedId = ''; toast('已停用，历史与引用完整保留', 'success'); await refresh(); }
}

async function showAddToProject(resourceId) {
  const [projects, prices, quotas] = await Promise.all([projectRepo.all(), resourcePriceService.listByResource(resourceId), quotaRepo.all()]);
  if (!projects.length) return toast('请先建立项目');
  const dialog = buildEquipmentPackageDialog({ projects, prices, quotas });
  openModal('设备加入项目', dialog.body, dialog.footer);
  if (!dialog.hasActivePrices) return;
  document.getElementById('addEquipmentPackageButton').onclick = async () => { const data = Object.fromEntries(new FormData(document.getElementById('equipmentPackageForm'))); await boqService.addEquipmentPackage(data.projectId, resourceId, data.priceId, Number(data.qty), { installQuotaId: data.installQuotaId || undefined }); closeModal(); toast('设备已加入项目清单', 'success'); };
}

export function buildEquipmentPackageDialog({ projects = [], prices = [], quotas = [] } = {}) {
  const activePrices = prices.filter(price => price.status !== 'withdrawn');
  const hasActivePrices = activePrices.length > 0;
  const body = `<form id="equipmentPackageForm" class="space-y-3 text-sm">
    <label class="block">目标项目<select name="projectId" class="mt-1 h-9 w-full border border-slate-300 bg-white px-2">${projects.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>
    <label class="block">价格快照<select name="priceId" ${hasActivePrices ? '' : 'disabled'} class="mt-1 h-9 w-full border border-slate-300 bg-white px-2">${activePrices.map(price => `<option value="${esc(price.id)}">${fmtMoney(price.unitPrice)} · ${esc(price.priceDate)} · ${basisLabel(price.priceBasis)}</option>`).join('')}</select></label>
    ${hasActivePrices ? '' : '<div role="alert" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">没有可用的未撤回价格，请先新增价格快照。</div>'}
    ${input('数量', 'qty', '1', '', true, 'number')}
    <label class="block">安装定额（可选）<select name="installQuotaId" class="mt-1 h-9 w-full border border-slate-300 bg-white px-2"><option value="">不另加安装定额</option>${quotas.map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${fmtMoney(item.priceTotal)}</option>`).join('')}</select></label>
  </form>`;
  const footer = `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="addEquipmentPackageButton" ${hasActivePrices ? '' : 'disabled'} class="h-9 px-4 brand-bg text-white text-sm disabled:cursor-not-allowed disabled:opacity-40">加入项目清单</button>`;
  return { body, footer, hasActivePrices };
}

function input(label, name, value = '', wrapper = '', required = false, type = 'text') { return `<label class="${wrapper}">${label}<input name="${name}" value="${esc(value || '')}" type="${type}" ${required ? 'required' : ''} class="mt-1 h-9 w-full border border-slate-300 bg-white px-2"></label>`; }
function sourceLabel(value) { return ({ official: '官方信息价', supplier_quote: '供应商报价', transaction: '成交价' })[value] || value; }
function basisLabel(value) { return ({ ex_factory: '出厂价', delivered: '到场价', installed_composite: '安装综合价' })[value] || value; }
