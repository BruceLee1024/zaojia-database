// 视图：独立清单库
import { boqLibraryService } from '../services/boqLibraryService.js?v=1.0';
import { projectRepo } from '../data/repository.js?v=1.0';
import { exportBoqLibraryTemplate } from '../data/excel.js?v=1.0';
import { esc, openModal, closeModal, toast } from '../utils/dom.js';

const state = { keyword: '', selectedId: '' };
let items = [];

export async function render() {
  const route = window.__app && window.__app.state ? window.__app.state.routeParams || {} : {};
  if (route.keyword != null) state.keyword = route.keyword;
  if (route.selectedId) state.selectedId = route.selectedId;
  window.__boqLibrary = { select, create, apply, remove, importExcel };
  document.getElementById('workspace').innerHTML = `
    <div class="h-full min-h-[700px] flex flex-col gap-4">
      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <div class="flex items-center gap-3"><div><h1 class="text-xl font-semibold">我的清单库</h1><p class="mt-1 text-xs text-slate-500">独立于项目的通用清单库，套用后可在项目内独立调整。</p></div><div class="flex-1"></div><button id="libImport" class="h-10 px-4 brand-bg text-white text-sm">导入 Excel</button><button onclick="window.__boqLibrary.create()" class="h-10 px-4 bg-teal-700 text-white text-sm">新建清单</button><button id="libTemplate" class="h-10 px-4 border text-sm">下载模板</button></div>
        <div class="mt-4 relative"><input id="libKeyword" value="${esc(state.keyword)}" placeholder="搜索清单编码 / 名称 / 项目特征" class="h-10 w-full border px-3 text-sm" /></div>
      </section>
      <div id="libraryMetrics" class="grid grid-cols-4 gap-4"></div>
      <div class="grid grid-cols-[minmax(0,1fr)_400px] gap-4 flex-1 min-h-0"><section class="rounded-lg border bg-white overflow-auto"><table class="w-full text-sm"><thead class="sticky top-0 bg-slate-50"><tr><th class="p-3 text-left">清单编码</th><th class="p-3 text-left">清单名称</th><th class="p-3 text-left">项目特征</th><th class="p-3 text-left">单位</th><th class="p-3 text-right">默认工程量</th><th class="p-3 text-center">关联定额</th></tr></thead><tbody id="libraryRows"></tbody></table></section><aside id="libraryDetail" class="rounded-lg border border-slate-200 bg-white overflow-hidden min-w-0"></aside></div>
    </div>`;
  document.getElementById('libImport').onclick = importExcel;
  document.getElementById('libTemplate').onclick = exportBoqLibraryTemplate;
  document.getElementById('libKeyword').oninput = function (event) { state.keyword = event.target.value; renderRows(); };
  await renderRows();
}

async function renderRows() {
  items = await boqLibraryService.list({ keyword: state.keyword });
  if (!items.some(function (item) { return item.id === state.selectedId; })) state.selectedId = items[0] ? items[0].id : '';
  const all = await boqLibraryService.list({});
  const refs = all.reduce(function (sum, item) { return sum + (Number(item.referenceCount) || 0); }, 0);
  document.getElementById('libraryMetrics').innerHTML = metric('清单总数', all.length) + metric('水处理工程清单', all.filter(function (item) { return /水处理|污水/.test((item.major || '') + (item.scope || '')); }).length) + metric('本月新增', all.filter(function (item) { return (item.createdAt || '').slice(0, 7) === new Date().toISOString().slice(0, 7); }).length) + metric('被引用次数', refs);
  document.getElementById('libraryRows').innerHTML = items.length ? items.map(function (item) { return `<tr data-library-id="${item.id}" class="border-t cursor-pointer hover:bg-teal-50 ${item.id === state.selectedId ? 'bg-teal-50' : ''}"><td class="p-3 text-teal-700">${esc(item.code || '-')}</td><td class="p-3 font-medium">${esc(item.name)}</td><td class="p-3 text-slate-500">${esc(item.feature || '-')}</td><td class="p-3">${esc(item.unit)}</td><td class="p-3 text-right">${item.defaultQty || 0}</td><td class="p-3 text-center">${(item.quotaItemIds || []).length}</td></tr>`; }).join('') : '<tr><td colspan="6" class="p-12 text-center text-slate-400">暂无清单，可新建或导入 Excel。</td></tr>';
  document.querySelectorAll('[data-library-id]').forEach(function (row) { row.onclick = function () { select(row.dataset.libraryId); }; });
  renderDetail(items.find(function (item) { return item.id === state.selectedId; }));
}

function metric(label, value) { return `<div class="rounded-lg border bg-white p-4"><div class="text-xs text-slate-500">${label}</div><div class="mt-2 text-2xl font-semibold">${value}</div></div>`; }
function select(id) { state.selectedId = id; renderRows(); }
export function getLibraryDetailSummary(item = {}) {
  const source = String(item.source || '').trim();
  const version = String(item.version || '').trim();
  const project = String(item.lastReferencedProjectName || '').trim();
  const date = String(item.lastReferencedAt || '').slice(0, 10);
  return {
    code: String(item.code || '').trim() || '未编码',
    sourceLabel: [source || '未标注来源', version].filter(Boolean).join(' · '),
    statusLabel: item.status === 'inactive' ? '已停用' : '启用',
    qty: String(item.defaultQty ?? 0),
    quotaCount: (item.quotaItemIds || []).length,
    referenceLabel: `${Number(item.referenceCount) || 0} 次`,
    lastReference: [project, date].filter(Boolean).join(' · ') || '尚未引用',
  };
}

function renderDetail(item) {
  const target = document.getElementById('libraryDetail');
  if (!item) {
    target.innerHTML = `<div class="h-full flex items-center justify-center p-8 text-center"><div><div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100 text-slate-400"><span class="material-symbols-outlined text-[26px]">format_list_bulleted</span></div><div class="font-semibold text-slate-700">选择清单查看详情</div><div class="mt-1 text-sm text-slate-500">从左侧列表选择一条标准清单。</div></div></div>`;
    return;
  }
  const detail = getLibraryDetailSummary(item);
  target.innerHTML = `<div class="h-full flex flex-col"><div class="shrink-0 border-b border-slate-200 px-4 py-4"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><div class="text-xs font-semibold text-teal-700">${esc(detail.code)}</div><h2 class="mt-2 text-xl font-semibold leading-7 text-slate-950">${esc(item.name || '未命名清单')}</h2><div class="mt-2 flex flex-wrap gap-2"><span class="badge badge-blue">${esc(detail.sourceLabel)}</span><span class="rounded border px-2 py-0.5 text-xs ${item.status === 'inactive' ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}">${esc(detail.statusLabel)}</span></div></div><span class="material-symbols-outlined text-slate-300">article</span></div></div><div class="flex-1 min-h-0 overflow-auto scroll-thin p-4 space-y-5"><div class="grid grid-cols-3 divide-x divide-slate-200 rounded-lg border border-slate-200 bg-slate-50">${detailMetric('单位', item.unit || '-')}${detailMetric('默认工程量', detail.qty)}${detailMetric('关联定额', `${detail.quotaCount} 项`)}</div>${detailSection('项目特征', item.feature || '未填写项目特征。', 'whitespace-pre-line')}${detailSection('适用信息', `<div class="grid grid-cols-2 gap-3"><div><div class="text-xs text-slate-500">专业</div><div class="mt-1 text-sm text-slate-700">${esc(item.major || '未设置')}</div></div><div><div class="text-xs text-slate-500">适用范围</div><div class="mt-1 text-sm text-slate-700">${esc(item.scope || '未设置')}</div></div><div><div class="text-xs text-slate-500">结构分组</div><div class="mt-1 text-sm text-slate-700">${esc(item.structureGroup || '未设置')}</div></div><div><div class="text-xs text-slate-500">版本</div><div class="mt-1 text-sm text-slate-700">${esc(item.version || '未设置')}</div></div></div>`, 'raw')}${detailSection('引用记录', `<div class="flex items-center justify-between gap-4"><div><div class="text-xs text-slate-500">累计被引用</div><div class="mt-1 text-lg font-semibold tabular-nums text-slate-900">${esc(detail.referenceLabel)}</div></div><div class="min-w-0 text-right"><div class="text-xs text-slate-500">最近引用</div><div class="mt-1 truncate text-sm text-slate-700" title="${esc(detail.lastReference)}">${esc(detail.lastReference)}</div></div></div>`, 'raw')}${item.note ? detailSection('备注', item.note, 'whitespace-pre-line') : ''}</div><div class="shrink-0 border-t border-slate-200 bg-white p-4"><button onclick="window.__boqLibrary.apply()" class="h-10 w-full text-sm brand-bg text-white flex items-center justify-center gap-1.5"><span class="material-symbols-outlined text-[18px]">playlist_add</span>加入项目清单</button><div class="mt-2 text-center text-xs text-slate-500">套用后将在项目中创建独立清单行，不会修改本库条目。</div></div></div>`;
}

function detailMetric(label, value) { return `<div class="px-3 py-3"><div class="text-xs text-slate-500">${label}</div><div class="mt-1 text-base font-semibold tabular-nums text-slate-900">${esc(value)}</div></div>`; }
function detailSection(title, value, className) { return `<section><div class="mb-2 text-sm font-semibold text-slate-800">${title}</div><div class="text-sm leading-6 text-slate-600 ${className === 'raw' ? '' : className}">${className === 'raw' ? value : esc(value)}</div></section>`; }
function create() { openModal('新建清单', '<label class="block text-sm">清单名称 <input id="newName" class="mt-1 h-9 w-full border px-2" /></label><label class="mt-3 block text-sm">单位 <input id="newUnit" class="mt-1 h-9 w-full border px-2" /></label><label class="mt-3 block text-sm">项目特征 <textarea id="newFeature" class="mt-1 w-full border px-2"></textarea></label>', '<button onclick="window.__modalClose()" class="px-3 py-1.5 border">取消</button><button id="saveNewLibrary" class="px-3 py-1.5 bg-teal-700 text-white">保存</button>'); document.getElementById('saveNewLibrary').onclick = async function () { try { await boqLibraryService.save({ name: document.getElementById('newName').value, unit: document.getElementById('newUnit').value, feature: document.getElementById('newFeature').value }); closeModal(); render(); } catch (err) { toast(err.message, 'error'); } }; }
async function apply() { const item = items.find(function (row) { return row.id === state.selectedId; }); const projects = await projectRepo.all(); if (!item || !projects.length) return toast('请先建立项目档案', 'error'); const project = projects[0]; const line = await boqLibraryService.applyToProject(item.id, project.id); window.__app.go('boq', { projectId: project.id, activeId: line.id }); }
function remove() {}
function importExcel() { window.__app.go('ai-import', { targetType: 'boq_library' }); }
