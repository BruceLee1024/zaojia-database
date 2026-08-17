import { boqService } from '../services/boqService.js?v=6.15';
import { resourcePriceService } from '../services/resourcePriceService.js?v=6.15';
import { isPriceEffective } from '../services/resourcePriceService.js?v=6.15';
import { resourceService } from '../services/resourceService.js?v=6.15';
import { projectRepo, quotaRepo } from '../data/repository.js?v=6.15';
import { exportResourceTemplate } from '../data/excel.js?v=6.15';
import { closeModal, esc, fmtMoney, openModal, toast, scopedDom } from '../utils/dom.js?v=6.15';
import { attachmentPanelShell, loadAttachmentPanel } from './resourceAttachments.js?v=6.15';

const PAGE_SIZE = 50;
const state = { resourceType: 'material', keyword: '', category: '', status: '', selectedId: '', resourceIds: [], healthLabel: '', rows: [], prices: new Map(), usage: null, page: 1 };
let attachmentRenderGeneration = 0;
let resourceRenderGeneration = 0;
const LABELS = {
  material: { singular: '材料', plural: '材料库', icon: 'category', route: 'materials' },
  equipment: { singular: '设备', plural: '设备库', icon: 'precision_manufacturing', route: 'equipment' },
};

export async function render(workspace = document.getElementById('workspace')) {
  const generation = ++resourceRenderGeneration;
  const route = window.__app?.state?.currentView;
  const params = window.__app?.state?.routeParams || {};
  Object.assign(state, nextResourceViewState(state, route, params));
  exposeActions(workspace, generation);
  await refresh(workspace, generation);
}

export function nextResourceViewState(current = {}, route = 'materials', params = {}) {
  const resourceType = route === 'equipment' ? 'equipment' : 'material';
  const changedType = current.resourceType !== resourceType;
  const next = {
    resourceType,
    keyword: changedType ? '' : String(current.keyword || ''),
    category: changedType ? '' : String(current.category || ''),
    status: changedType ? '' : String(current.status || ''),
    // 默认停留在列表视图；只有路由明确传入 selectedId 时才打开详情。
    selectedId: '',
    page: changedType ? 1 : Math.max(1, Number(current.page) || 1),
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

export function createLatestResourceSelection({ setSelectedId, getSelectedId, loadUsage, commit, isCurrent = () => true }) {
  let requestGeneration = 0;
  const select = async (id, context) => {
    const resourceId = String(id || '');
    const request = ++requestGeneration;
    if (!isCurrent(context)) return false;
    setSelectedId(resourceId);
    const usage = await loadUsage(resourceId);
    if (request !== requestGeneration || getSelectedId() !== resourceId || !isCurrent(context)) return false;
    return await commit({ id: resourceId, usage, request, context }) !== false;
  };
  select.invalidate = () => { requestGeneration += 1; };
  return select;
}

export function createAtomicResourceRefresh({ list, currentPrices, currentPrice, usage, isCurrent = () => true, commit }) {
  let requestGeneration = 0;
  const refresh = async snapshot => {
    const request = ++requestGeneration;
    const valid = () => request === requestGeneration && isCurrent(snapshot);
    let rows = await list({ resourceType: snapshot.resourceType, keyword: snapshot.keyword, category: snapshot.category, status: snapshot.status });
    if (!valid()) return false;
    if (snapshot.resourceIds.length) rows = rows.filter(item => snapshot.resourceIds.includes(item.id));
    let selectedId = snapshot.selectedId;
    if (selectedId && !rows.some(item => item.id === selectedId)) selectedId = '';
    const prices = currentPrices
      ? await currentPrices(rows)
      : new Map(await Promise.all(rows.map(async item => [item.id, await currentPrice(item)])));
    if (!valid()) return false;
    const selectedUsage = selectedId ? await usage(selectedId) : null;
    if (!valid()) return false;
    const { context, ...viewState } = snapshot;
    await commit({ ...viewState, rows, selectedId, prices, usage: selectedUsage }, snapshot);
    return true;
  };
  refresh.invalidate = () => { requestGeneration += 1; };
  return refresh;
}

function isResourceContextCurrent(context) {
  return Boolean(context?.workspace && !context.workspace.isInvalidated && context.generation === resourceRenderGeneration);
}

const selectResource = createLatestResourceSelection({
  setSelectedId: id => { state.selectedId = id; },
  getSelectedId: () => state.selectedId,
  loadUsage: id => resourceService.usage(id),
  isCurrent: isResourceContextCurrent,
  commit: async ({ id, usage, context }) => {
    if (!isResourceContextCurrent(context)) return false;
    const { workspace, generation: renderGeneration } = context;
    state.usage = usage;
    const generation = paint(workspace);
    await Promise.all([loadPriceHistory(id, workspace, renderGeneration), loadAttachmentPanel(id, generation, { document: scopedDom(workspace) })]);
    return isResourceContextCurrent(context);
  },
});

const runAtomicResourceRefresh = createAtomicResourceRefresh({
  list: filters => resourceService.list(filters),
  currentPrices: rows => resourcePriceService.getCurrentPriceMap(rows),
  usage: id => resourceService.usage(id),
  isCurrent: snapshot => isResourceContextCurrent(snapshot.context),
  commit: async (result, snapshot) => {
    const context = snapshot.context;
    if (!isResourceContextCurrent(context)) return;
    Object.assign(state, result);
    const generation = paint(context.workspace);
    if (result.selectedId) await Promise.all([
      loadPriceHistory(result.selectedId, context.workspace, context.generation),
      loadAttachmentPanel(result.selectedId, generation, { document: scopedDom(context.workspace) }),
    ]);
  },
});

async function refresh(workspace = document.getElementById('workspace'), generation = resourceRenderGeneration) {
  selectResource.invalidate();
  const context = { workspace, generation };
  return runAtomicResourceRefresh({
    resourceType: state.resourceType,
    keyword: state.keyword,
    category: state.category,
    status: state.status,
    selectedId: state.selectedId,
    resourceIds: [...state.resourceIds],
    healthLabel: state.healthLabel,
    context,
  });
}

function paint(workspace = document.getElementById('workspace')) {
  const generation = String(++attachmentRenderGeneration);
  const meta = LABELS[state.resourceType];
  const selected = state.rows.find(item => item.id === state.selectedId);
  const categories = [...new Set(state.rows.map(item => item.category).filter(Boolean))];
  workspace.innerHTML = `
    <div class="page-frame library-workbench h-full flex flex-col">
      <section class="library-toolbar library-toolbar--compact">
        ${state.resourceIds.length ? `<div role="status" class="mt-3 flex flex-wrap items-center justify-between gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><span>已按仪表盘“${esc(state.healthLabel || '资源健康')}”筛选，共 ${state.resourceIds.length} 条。</span><button onclick="window.__resources.clearHealthFilter()" class="font-medium underline">查看全部${meta.singular}</button></div>` : ''}
        <div class="library-filter-row">
          <label class="relative"><span class="sr-only">搜索${meta.singular}</span><input value="${esc(state.keyword)}" oninput="window.__resources.filter('keyword',this.value)" type="search" placeholder="搜索编码、名称、规格、品牌…" class="h-9 w-full border border-slate-300 bg-white pl-9 pr-3 text-sm"><span class="material-symbols-outlined absolute left-3 top-2.5 text-[17px] text-slate-400">search</span></label>
          <div class="library-filter-controls"><select onchange="window.__resources.filter('category',this.value)" class="h-9 min-w-[150px] border border-slate-300 bg-white px-2 text-sm"><option value="">全部分类</option>${categories.map(value => `<option ${value === state.category ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select><select onchange="window.__resources.filter('status',this.value)" class="h-9 min-w-[120px] border border-slate-300 bg-white px-2 text-sm"><option value="">全部状态</option><option value="active" ${state.status === 'active' ? 'selected' : ''}>启用</option><option value="inactive" ${state.status === 'inactive' ? 'selected' : ''}>停用</option></select><button onclick="window.__resources.clearFilters()" class="h-9 px-3 border border-slate-300 bg-white text-sm text-slate-600">清除筛选</button><span class="library-toolbar-divider" aria-hidden="true"></span><button onclick="window.__resources.downloadTemplate()" class="h-9 px-3 border border-slate-300 bg-white text-sm text-slate-700">下载模板</button><button onclick="window.__resources.importExcel()" class="h-9 px-3 border border-teal-300 bg-white text-sm text-teal-700">导入 Excel</button><button onclick="window.__resources.edit()" class="h-9 px-4 brand-bg text-white text-sm">新增${meta.singular}</button></div>
        </div>
      </section>
      <section class="library-summary-grid" aria-label="${meta.plural}概览">
        ${resourceMetric('资源总数', state.rows.length, '条', meta.icon, 'icon-surface-teal')}
        ${resourceMetric('已有参考价', [...state.prices.values()].filter(Boolean).length, '条', 'paid', 'icon-surface-blue')}
        ${resourceMetric('启用中', state.rows.filter(item => item.status !== 'inactive').length, '条', 'check_circle', 'icon-surface-slate')}
      </section>
      <div class="library-split ${selected ? 'library-split--detail' : 'library-split--list-only'}">
        ${resourceTable(meta)}
        ${selected ? detailPanel(selected, meta, generation) : ''}
      </div>
      </div>`;
  bindResourceIdActions(workspace);
  return generation;
}

function resourceTable(meta) {
  const pagination = paginateResources(state.rows, state.page, PAGE_SIZE);
  if (state.page !== pagination.page) state.page = pagination.page;
  return `<section class="library-list-pane min-h-0 flex flex-col">
    <div class="border-b border-slate-200 px-4 py-3 flex items-center shrink-0"><h2 class="font-semibold text-slate-900">${meta.plural}清单</h2><span class="ml-2 text-xs text-slate-500">${state.rows.length} 条</span><span class="ml-auto text-xs text-slate-400">第 ${pagination.page} / ${pagination.totalPages} 页</span></div>
    <div class="mobile-card-list divide-y divide-slate-100">${pagination.rows.length ? pagination.rows.map(item => resourceMobileCard(item, state.prices.get(item.id))).join('') : `<div class="px-5 py-16 text-center text-sm text-slate-400">暂无符合条件的${meta.singular}。</div>`}</div>
    <div class="mobile-table overflow-auto scroll-thin flex-1 min-h-0"><table class="w-full text-sm"><thead class="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500"><tr><th class="px-3 py-2 text-left">编码 / 名称</th><th class="px-3 text-left">规格型号</th><th class="px-3 text-left">分类</th><th class="px-3 text-right">当前价</th><th class="px-3 text-left">状态</th><th class="px-3 w-28"></th></tr></thead>
    <tbody class="divide-y divide-slate-100">${pagination.rows.length ? pagination.rows.map(item => resourceRowHtml(item, state.prices.get(item.id), item.id === state.selectedId)).join('') : `<tr><td colspan="6" class="py-16 text-center text-slate-400">暂无符合条件的${meta.singular}。</td></tr>`}</tbody></table></div>
    ${resourcePaginationMarkup(pagination)}
  </section>`;
}

export function paginateResources(rows = [], page = 1, pageSize = PAGE_SIZE) {
  const total = Array.isArray(rows) ? rows.length : 0;
  const safeSize = Math.max(1, Number(pageSize) || PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  return { page: safePage, totalPages, start: total ? (safePage - 1) * safeSize + 1 : 0, end: Math.min(total, safePage * safeSize), rows: rows.slice((safePage - 1) * safeSize, safePage * safeSize) };
}

function resourcePaginationMarkup({ page, totalPages, start, end, rows }) {
  return `<footer class="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 shrink-0"><span>${rows.length ? `显示 ${start}–${end} 条` : '暂无数据'}</span><div class="flex items-center gap-2"><button data-resource-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} class="h-8 px-3 border border-slate-300 bg-white disabled:cursor-not-allowed disabled:opacity-40">上一页</button><span class="tabular-nums">${page} / ${totalPages}</span><button data-resource-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''} class="h-8 px-3 border border-slate-300 bg-white disabled:cursor-not-allowed disabled:opacity-40">下一页</button></div></footer>`;
}

function resourceMobileCard(item, price) {
  return `<article class="px-4 py-3"><div class="flex items-start gap-3"><button data-resource-action="openMobileDetail" data-resource-id="${esc(item.id)}" class="min-w-0 flex-1 text-left"><div class="flex items-center gap-2"><span class="badge ${item.status === 'inactive' ? 'badge-gray' : 'badge-green'}">${item.status === 'inactive' ? '停用' : '启用'}</span><span class="text-xs text-slate-500">${esc(item.category || '未分类')}</span></div><div class="mt-2 truncate font-semibold text-slate-900">${esc(item.name)}</div><div class="mt-1 truncate text-xs text-slate-500">${esc(item.code || '未编码')} · ${esc(item.specModel || '未填规格')} · ${esc(item.unit || '-')}</div><div class="mt-3 text-sm font-semibold tabular-nums ${price ? 'text-slate-900' : 'text-amber-700'}">${price ? fmtMoney(price.unitPrice) : '待询价'}</div></button><button aria-label="编辑${esc(item.name)}" data-resource-action="edit" data-resource-id="${esc(item.id)}" class="h-11 w-11 shrink-0 border border-slate-200 text-slate-500"><span class="material-symbols-outlined" aria-hidden="true">edit</span></button></div></article>`;
}

export function resourceRowHtml(item, price, active) {
  return `<tr class="${active ? 'bg-teal-50/70' : 'hover:bg-slate-50'}"><td class="px-3 py-3"><button data-resource-action="select" data-resource-id="${esc(item.id)}" class="block text-left"><span class="block font-medium text-slate-900">${esc(item.name)}</span><span class="mt-0.5 block text-xs font-data text-slate-500">${esc(item.code || '未编码')} · ${esc(item.unit)}</span></button></td><td class="px-3 text-slate-600">${esc(item.specModel || '-')}</td><td class="px-3 text-slate-600">${esc(item.category || '未分类')}</td><td class="px-3 text-right tabular-nums">${price ? fmtMoney(price.unitPrice) : '<span class="text-amber-600">待询价</span>'}</td><td class="px-3"><span class="badge ${item.status === 'inactive' ? 'badge-gray' : 'badge-green'}">${item.status === 'inactive' ? '停用' : '启用'}</span></td><td class="px-3"><div class="flex justify-end gap-1"><button aria-label="编辑" title="编辑" data-resource-action="edit" data-resource-id="${esc(item.id)}" class="h-8 w-8 text-slate-500 hover:bg-slate-100"><span class="material-symbols-outlined text-[17px]">edit</span></button><button aria-label="复制" title="复制" data-resource-action="copy" data-resource-id="${esc(item.id)}" class="h-8 w-8 text-slate-500 hover:bg-slate-100"><span class="material-symbols-outlined text-[17px]">content_copy</span></button></div></td></tr>`;
}

function detailPanel(item, meta, generation) {
  const current = state.prices.get(item.id);
  const usage = state.usage || {};
  return `<aside class="library-detail-pane overflow-auto">
    <div class="p-4 border-b border-slate-200"><div class="flex items-start gap-3"><div class="min-w-0 flex-1"><div class="text-xs text-slate-500">${esc(item.code || '未编码')}</div><h2 class="mt-1 text-lg font-semibold text-slate-900">${esc(item.name)}</h2><p class="mt-1 text-sm text-slate-500">${esc(item.specModel || '未填规格')} · ${esc(item.unit)}</p></div><button data-resource-action="toggleStatus" data-resource-id="${esc(item.id)}" class="h-8 px-2 border border-slate-300 bg-white text-xs">${item.status === 'inactive' ? '恢复启用' : '停用'}</button></div>
      <div class="mt-4 grid grid-cols-2 gap-2 text-xs">${field('分类', item.category)}${field('品牌 / 厂家', item.brand || item.manufacturer)}${field('执行标准', item.standard)}${field('工艺段', item.processStage)}</div>
      ${item.tags?.length ? `<div class="mt-3 flex flex-wrap gap-1">${item.tags.map(tag => `<span class="badge badge-blue">${esc(tag)}</span>`).join('')}</div>` : ''}
      ${item.note ? `<p class="mt-3 text-xs leading-5 text-slate-500">${esc(item.note)}</p>` : ''}
    </div>
    <section class="p-4 border-b border-slate-200"><div class="flex items-center"><div><h3 class="font-semibold text-slate-900">价格历史</h3><p class="mt-1 text-xs text-slate-500">${current ? `当前价 ${fmtMoney(current.unitPrice)} · ${esc(current.priceDate)}` : '还没有价格快照'}</p></div><div class="flex-1"></div><button data-resource-action="addPrice" data-resource-id="${esc(item.id)}" class="h-8 px-3 border border-teal-300 bg-white text-xs text-teal-700">新增价格</button></div><div id="resourcePriceHistory" class="mt-3 text-xs text-slate-400">正在读取价格历史…</div></section>
    <section class="p-4 border-b border-slate-200"><h3 class="font-semibold text-slate-900">使用位置</h3><div class="mt-3 grid grid-cols-2 gap-2">${metric('定额引用', usage.quotaUsageCount || 0)}${metric('项目清单', usage.projectLineCount || 0)}</div>${usage.total ? `<p class="mt-3 text-xs leading-5 text-slate-500">定额 ID：${esc((usage.quotaItemIds || []).join('、') || '-')}<br>项目 ID：${esc((usage.projectIds || []).join('、') || '-')}</p>` : '<p class="mt-3 text-xs text-slate-400">尚未被定额或项目清单引用。</p>'}</section>
    ${attachmentPanelShell(item.id, generation)}
    <div class="p-4 flex flex-wrap gap-2">${state.resourceType === 'equipment' ? `<button data-resource-action="addToProject" data-resource-id="${esc(item.id)}" ${current && item.status !== 'inactive' ? '' : 'disabled'} class="h-9 flex-1 brand-bg px-3 text-sm text-white disabled:opacity-40">加入项目</button>` : ''}<button data-resource-action="edit" data-resource-id="${esc(item.id)}" class="h-9 px-3 border border-slate-300 bg-white text-sm">编辑</button><button data-resource-action="merge" data-resource-id="${esc(item.id)}" class="h-9 px-3 border border-amber-300 bg-white text-sm text-amber-800">合并重复项</button><button data-resource-action="remove" data-resource-id="${esc(item.id)}" class="h-9 px-3 border border-red-200 bg-white text-sm text-red-600">停用 / 移除</button></div>
  </aside>`;
}

function emptyDetail(meta) { return `<aside class="library-detail-pane min-h-[420px] flex items-center justify-center p-8 text-center"><div><span class="material-symbols-outlined text-4xl text-slate-300">${meta.icon}</span><h2 class="mt-3 font-semibold text-slate-800">选择一条${meta.singular}</h2><p class="mt-1 text-sm text-slate-400">详情、价格和引用位置会显示在这里。</p></div></aside>`; }
function resourceMetric(label, value, unit, icon, tone) { return `<div class="library-metric-card px-4 py-3"><div class="flex items-start justify-between"><div><div class="text-xs font-medium text-slate-500">${label}</div><div class="mt-2 flex items-end gap-2"><span class="text-2xl font-semibold tabular-nums text-slate-950">${value}</span><span class="pb-1 text-xs text-slate-500">${unit}</span></div></div><span class="icon-surface ${tone}"><span class="material-symbols-outlined icon-kpi">${icon}</span></span></div></div>`; }
function field(label, value) { return `<div class="border border-slate-100 bg-slate-50 px-2 py-2"><div class="text-slate-400">${label}</div><div class="mt-1 text-slate-700">${esc(value || '-')}</div></div>`; }
function metric(label, value) { return `<div class="border border-slate-200 bg-slate-50 px-3 py-2"><div class="text-xs text-slate-500">${label}</div><div class="mt-1 text-lg font-semibold tabular-nums text-slate-900">${value}</div></div>`; }

function exposeActions(workspace, generation) {
  const context = { workspace, generation };
  window.__resources = {
    select: id => { runAtomicResourceRefresh.invalidate(); return selectResource(id, context); },
    openMobileDetail: async id => {
      runAtomicResourceRefresh.invalidate();
      await selectResource(id, context);
      const item = state.rows.find(row => row.id === id);
      if (item) openModal(`${LABELS[state.resourceType].singular}详情`, mobileResourceDetail(item, state.prices.get(id)));
    },
    filter: (key, value) => { if (!isResourceContextCurrent(context)) return; state[key] = value; state.page = 1; clearTimeout(window.__resourceFilterTimer); window.__resourceFilterTimer = setTimeout(() => refresh(workspace, generation), 150); },
    clearFilters: () => { if (!isResourceContextCurrent(context)) return; state.keyword = ''; state.category = ''; state.status = ''; state.page = 1; refresh(workspace, generation); },
    setPage: page => { if (!isResourceContextCurrent(context)) return; state.page = Math.max(1, Number(page) || 1); paint(workspace); },
    clearHealthFilter: () => { if (!isResourceContextCurrent(context)) return; state.resourceIds = []; state.healthLabel = ''; refresh(workspace, generation); },
    edit: id => showResourceEditor(id, workspace, generation),
    copy: async id => { const copy = await resourceService.copy(id); if (!isResourceContextCurrent(context)) return; state.selectedId = copy.id; toast('已创建副本', 'success'); await refresh(workspace, generation); },
    toggleStatus: async id => { const item = await resourceService.get(id); if (!isResourceContextCurrent(context)) return; await resourceService.setStatus(id, item.status === 'inactive' ? 'active' : 'inactive'); if (!isResourceContextCurrent(context)) return; toast('状态已更新', 'success'); await refresh(workspace, generation); },
    remove: id => removeResource(id, workspace, generation),
    addPrice: id => showPriceEditor(id, workspace, generation),
    merge: id => showResourceMerge(id, workspace, generation),
    preferPrice: async (resourceId, priceId) => { await resourceService.setPreferredPrice(resourceId, priceId); if (!isResourceContextCurrent(context)) return; toast('已设为首选价格', 'success'); await refresh(workspace, generation); await loadPriceHistory(resourceId, workspace, generation); },
    withdrawPrice: async (resourceId, priceId) => { if (!confirm('撤回这条价格快照？历史记录和附件仍保留。')) return; await resourcePriceService.withdraw(priceId); if (!isResourceContextCurrent(context)) return; await refresh(workspace, generation); await loadPriceHistory(resourceId, workspace, generation); },
    addToProject: id => showAddToProject(id, context),
    importExcel: () => window.__app.go('ai-import', { targetType: state.resourceType }),
    downloadTemplate: () => exportResourceTemplate(state.resourceType),
  };
}

function mobileResourceDetail(item, price) {
  const meta = LABELS[state.resourceType];
  return `<div class="space-y-4 text-sm"><div><div class="text-xs text-slate-500">${esc(item.code || '未编码')} · ${esc(item.category || '未分类')}</div><h2 class="mt-1 text-lg font-semibold text-slate-900">${esc(item.name)}</h2><p class="mt-1 text-slate-500">${esc(item.specModel || '未填规格')} · ${esc(item.unit || '-')}</p></div><div class="grid grid-cols-2 gap-2">${field('状态', item.status === 'inactive' ? '停用' : '启用')}${field('当前参考价', price ? fmtMoney(price.unitPrice) : '待询价')}${field('品牌 / 厂家', item.brand || item.manufacturer)}${field('工艺段', item.processStage)}</div><div class="grid grid-cols-2 gap-2"><button onclick="window.__resources.edit('${esc(item.id)}')" class="h-11 brand-bg text-white">编辑${meta.singular}</button><button onclick="window.__resources.addPrice('${esc(item.id)}')" class="h-11 border border-teal-300 bg-white text-teal-700">新增价格</button></div></div>`;
}

async function loadPriceHistory(resourceId, workspace = document.getElementById('workspace'), generation = resourceRenderGeneration) {
  const context = { workspace, generation };
  if (!isResourceContextCurrent(context)) return false;
  const host = workspace.querySelector('#resourcePriceHistory');
  if (!host || state.selectedId !== resourceId) return false;
  const [resource, prices] = await Promise.all([resourceService.get(resourceId), resourcePriceService.listByResource(resourceId)]);
  if (!isResourceContextCurrent(context) || state.selectedId !== resourceId || workspace.querySelector('#resourcePriceHistory') !== host) return false;
  host.innerHTML = prices.length ? `<div class="space-y-2">${prices.map(price => `<div class="border ${price.id === resource.preferredPriceId ? 'border-teal-300 bg-teal-50/50' : 'border-slate-200'} p-2"><div class="flex items-center gap-2"><span class="font-semibold text-slate-900">${fmtMoney(price.unitPrice)}</span>${price.id === resource.preferredPriceId ? '<span class="badge badge-green">首选</span>' : ''}${price.status === 'withdrawn' ? '<span class="badge badge-gray">已撤回</span>' : isPriceEffective(price) ? '<span class="badge badge-green">可计价</span>' : '<span class="badge badge-yellow">当前不可用</span>'}<span class="ml-auto text-slate-500">${esc(price.priceDate)}</span></div><div class="mt-1 text-slate-500">${esc(price.region?.province || '')}${esc(price.region?.city || '')} · ${sourceLabel(price.sourceType)} · ${basisLabel(price.priceBasis)} · ${price.taxIncluded ? '含税' : '未税'}${price.supplier ? ` · ${esc(price.supplier)}` : ''}</div><div class="mt-1 text-slate-400">有效期：${esc(price.validFrom || '未限定')} ~ ${esc(price.validTo || '长期')}</div><div class="mt-2 flex gap-3">${price.status === 'withdrawn' ? '' : `<button data-price-action="prefer" data-resource-id="${esc(resourceId)}" data-price-id="${esc(price.id)}" class="text-teal-700">设为首选</button><button data-price-action="withdraw" data-resource-id="${esc(resourceId)}" data-price-id="${esc(price.id)}" class="text-red-600">撤回</button>`}</div></div>`).join('')}</div>` : '<div class="border border-dashed border-slate-200 p-4 text-center">暂无价格历史。</div>';
  host.querySelectorAll('[data-price-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.priceAction === 'prefer' ? 'preferPrice' : 'withdrawPrice';
    window.__resources[action](button.dataset.resourceId, button.dataset.priceId);
  }));
  return true;
}

function bindResourceIdActions(root) {
  root?.querySelectorAll('[data-resource-action]').forEach(button => button.addEventListener('click', () => {
    window.__resources[button.dataset.resourceAction]?.(button.dataset.resourceId);
  }));
  root?.querySelectorAll('[data-resource-page]').forEach(button => button.addEventListener('click', () => window.__resources.setPage(button.dataset.resourcePage)));
}

async function showResourceEditor(id = '', workspace = document.getElementById('workspace'), generation = resourceRenderGeneration) {
  const context = { workspace, generation };
  const resourceType = state.resourceType;
  const item = id ? await resourceService.get(id) : { resourceType, status: 'active', tags: [] };
  if (!isResourceContextCurrent(context)) return;
  const meta = LABELS[resourceType];
  openModal(`${id ? '编辑' : '新增'}${meta.singular}`, `<form id="resourceEditForm" class="grid grid-cols-2 gap-3 text-sm">
    ${input('编码', 'code', item.code)}${input('分类', 'category', item.category)}${input('名称 *', 'name', item.name, 'col-span-2', true)}${input('规格型号', 'specModel', item.specModel)}${input('单位 *', 'unit', item.unit, '', true)}${input('品牌', 'brand', item.brand)}${input('生产厂家', 'manufacturer', item.manufacturer)}${input('执行标准', 'standard', item.standard)}${input('工艺段', 'processStage', item.processStage)}${input('标签（逗号分隔）', 'tags', (item.tags || []).join(','), 'col-span-2')}${input('备注', 'note', item.note, 'col-span-2')}
  </form>`, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="saveResourceButton" class="h-9 px-4 brand-bg text-white text-sm">保存</button>`);
  document.getElementById('saveResourceButton').onclick = async () => {
    const data = Object.fromEntries(new FormData(document.getElementById('resourceEditForm')));
    await resourceService.save({ ...item, ...data, id: id || undefined, resourceType, tags: String(data.tags || '').split(/[,，]/).map(value => value.trim()).filter(Boolean) });
    if (!isResourceContextCurrent(context)) return;
    closeModal(); toast(`${meta.singular}已保存`, 'success'); await refresh(workspace, generation);
  };
}

async function showPriceEditor(resourceId, workspace = document.getElementById('workspace'), generation = resourceRenderGeneration) {
  const context = { workspace, generation };
  if (!isResourceContextCurrent(context)) return;
  openModal('新增价格快照', `<form id="resourcePriceForm" class="grid grid-cols-2 gap-3 text-sm">
    <label>价格来源<select name="sourceType" class="mt-1 h-9 w-full border border-slate-300 bg-white px-2"><option value="official">官方信息价</option><option value="supplier_quote">供应商报价</option><option value="transaction">历史成交价</option></select></label>
    <label>价格口径<select name="priceBasis" class="mt-1 h-9 w-full border border-slate-300 bg-white px-2"><option value="delivered">到场价</option><option value="ex_factory">出厂价</option><option value="installed_composite">安装综合价</option></select></label>
    ${input('单价 *', 'unitPrice', '', '', true, 'number')}${input('价格日期 *', 'priceDate', new Date().toISOString().slice(0, 10), '', true, 'date')}${input('生效日期', 'validFrom', '', '', false, 'date')}${input('失效日期', 'validTo', '', '', false, 'date')}${input('省', 'province')}${input('市', 'city')}${input('区县', 'district')}${input('供应商', 'supplier')}${input('税率 %', 'taxRate', '0', '', false, 'number')}${input('安装范围', 'installationScope')}
    ${input('基础价', 'componentBase', '0', '', false, 'number')}${input('运杂费', 'componentFreight', '0', '', false, 'number')}${input('安装费', 'componentInstallation', '0', '', false, 'number')}${input('调试费', 'componentCommissioning', '0', '', false, 'number')}
    <label class="col-span-2 flex items-center gap-2"><input name="taxIncluded" value="true" type="checkbox">含税价</label>
  </form>`, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="saveResourcePriceButton" class="h-9 px-4 brand-bg text-white text-sm">保存快照</button>`);
  document.getElementById('saveResourcePriceButton').onclick = async () => {
    const form = document.getElementById('resourcePriceForm'); const data = Object.fromEntries(new FormData(form));
    await resourcePriceService.save({ ...data, resourceId, region: { province: data.province, city: data.city, district: data.district }, components: { base: data.componentBase, freight: data.componentFreight, installation: data.componentInstallation, commissioning: data.componentCommissioning }, taxIncluded: Boolean(data.taxIncluded) });
    if (!isResourceContextCurrent(context)) return;
    closeModal(); toast('价格快照已保存', 'success'); await refresh(workspace, generation); await loadPriceHistory(resourceId, workspace, generation);
  };
}

async function showResourceMerge(sourceId, workspace = document.getElementById('workspace'), generation = resourceRenderGeneration) {
  const context = { workspace, generation };
  const source = await resourceService.get(sourceId);
  const candidates = (await resourceService.list({ resourceType: source?.resourceType || '' })).filter(item => item.id !== sourceId && item.status !== 'inactive');
  if (!source || !candidates.length) return toast('没有可作为合并目标的同类启用资源', 'error');
  openModal('合并重复资源', `<div class="space-y-3 text-sm"><p>将“${esc(source.name)}”的实时引用迁移到目标资源；历史快照保持不变，源资源会停用。</p><label class="block">保留的目标资源<select id="resourceMergeTarget" class="mt-1 h-9 w-full border border-slate-300 bg-white px-2">${candidates.map(item => `<option value="${esc(item.id)}">${esc(item.code || '未编码')} · ${esc(item.name)} · ${esc(item.specModel || '-')}</option>`).join('')}</select></label></div>`, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="confirmResourceMerge" class="h-9 px-4 bg-amber-600 text-white text-sm">确认合并</button>`);
  document.getElementById('confirmResourceMerge').onclick = async () => {
    if (!confirm('合并后源资源将停用，是否继续？')) return;
    await resourceService.merge(sourceId, document.getElementById('resourceMergeTarget').value);
    if (!isResourceContextCurrent(context)) return;
    closeModal(); state.selectedId = ''; toast('资源已合并，历史快照已保留', 'success'); await refresh(workspace, generation);
  };
}

async function removeResource(id, workspace = document.getElementById('workspace'), generation = resourceRenderGeneration) {
  const context = { workspace, generation };
  if (!confirm('停用或移除这条主数据？有历史记录时将保留为停用档案。')) return;
  try { await resourceService.remove(id); if (!isResourceContextCurrent(context)) return; state.selectedId = ''; toast('已移除未使用资源', 'success'); await refresh(workspace, generation); }
  catch (error) { if (!isResourceContextCurrent(context)) return; if (error.code !== 'RESOURCE_IN_USE' || !confirm(`该资源有 ${error.usage.total} 条历史或引用。继续将只停用主数据，不删除价格、附件和引用，是否继续？`)) throw error; await resourceService.remove(id, { force: true }); if (!isResourceContextCurrent(context)) return; state.selectedId = ''; toast('已停用，历史与引用完整保留', 'success'); await refresh(workspace, generation); }
}

async function showAddToProject(resourceId, context = { workspace: document.getElementById('workspace'), generation: resourceRenderGeneration }) {
  const [projects, prices, quotas] = await Promise.all([projectRepo.all(), resourcePriceService.listByResource(resourceId), quotaRepo.all()]);
  if (!isResourceContextCurrent(context)) return;
  if (!projects.length) return toast('请先建立项目');
  const dialog = buildEquipmentPackageDialog({ projects, prices, quotas });
  openModal('设备加入项目', dialog.body, dialog.footer);
  if (!dialog.hasActivePrices) return;
  document.getElementById('addEquipmentPackageButton').onclick = async () => { const data = Object.fromEntries(new FormData(document.getElementById('equipmentPackageForm'))); await boqService.addEquipmentPackage(data.projectId, resourceId, data.priceId, Number(data.qty), { installQuotaId: data.installQuotaId || undefined }); closeModal(); toast('设备已加入项目清单', 'success'); };
}

export function buildEquipmentPackageDialog({ projects = [], prices = [], quotas = [] } = {}) {
  const activePrices = prices.filter(price => isPriceEffective(price) && ['delivered', 'installed_composite'].includes(price.priceBasis));
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
