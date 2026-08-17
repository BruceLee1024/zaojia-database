// 视图：独立清单库
import { boqLibraryService } from '../services/boqLibraryService.js?v=6.15';
import { suggestLibraryItem } from '../services/aiAssistService.js?v=6.15';
import { projectRepo, quotaRepo } from '../data/repository.js?v=6.15';
import { exportBoqLibraryTemplate } from '../data/excel.js?v=6.15';
import { esc, openModal, closeModal, toast, scopedDom } from '../utils/dom.js?v=6.15';
import { ICONS } from '../utils/icons.js?v=6.15';

const state = { keyword: '', selectedId: '' };
let items = [];

export async function render(workspace = document.getElementById('workspace')) {
  const route = window.__app && window.__app.state ? window.__app.state.routeParams || {} : {};
  if (!route.selectedId) state.selectedId = '';
  if (route.keyword != null) state.keyword = route.keyword;
  if (route.selectedId) state.selectedId = route.selectedId;
  window.__boqLibrary = { select: id => select(workspace, id), create, edit, apply, remove, importExcel };
  workspace.innerHTML = `
    <div class="page-frame library-workbench h-full flex flex-col">
      <section class="library-toolbar library-toolbar--compact">
        <div class="library-filter-row"><div class="relative"><input id="libKeyword" value="${esc(state.keyword)}" placeholder="搜索清单编码 / 名称 / 项目特征" class="h-10 w-full border px-3 text-sm" /></div><div class="library-filter-controls"><button id="libTemplate" class="h-10 px-3 border border-slate-300 bg-white text-sm text-slate-700">下载模板</button><button id="libImport" class="h-10 px-3 border border-teal-300 bg-white text-sm text-teal-700">导入 Excel</button><button onclick="window.__boqLibrary.create()" class="h-10 px-4 brand-bg text-white text-sm">新建清单</button></div></div>
      </section>
      <div id="libraryMetrics" class="library-summary-grid library-summary-grid--4"></div>
      <div id="librarySplit" class="library-split ${state.selectedId ? 'library-split--detail' : 'library-split--list-only'}"><section class="library-list-pane overflow-auto"><table class="w-full text-sm"><thead class="sticky top-0 bg-slate-50"><tr><th class="p-3 text-left">清单编码</th><th class="p-3 text-left">清单名称</th><th class="p-3 text-left">项目特征</th><th class="p-3 text-left">单位</th><th class="p-3 text-right">默认工程量</th><th class="p-3 text-center">关联定额</th></tr></thead><tbody id="libraryRows"></tbody></table></section><aside id="libraryDetail" class="library-detail-pane"></aside></div>
    </div>`;
  const document = scopedDom(workspace);
  document.getElementById('libImport').onclick = importExcel;
  document.getElementById('libTemplate').onclick = exportBoqLibraryTemplate;
  document.getElementById('libKeyword').oninput = function (event) { state.keyword = event.target.value; renderRows(workspace); };
  await renderRows(workspace);
}

async function renderRows(workspace = document.getElementById('workspace')) {
  const document = scopedDom(workspace);
  items = await boqLibraryService.list({ keyword: state.keyword });
  if (state.selectedId && !items.some(function (item) { return item.id === state.selectedId; })) state.selectedId = '';
  const all = await boqLibraryService.list({});
  const refs = all.reduce(function (sum, item) { return sum + (Number(item.referenceCount) || 0); }, 0);
  const water = all.filter(function (item) { return /水处理|污水/.test((item.major || '') + (item.scope || '')); }).length;
  const added = all.filter(function (item) { return (item.createdAt || '').slice(0, 7) === new Date().toISOString().slice(0, 7); }).length;
  document.getElementById('libraryMetrics').innerHTML = buildLibraryMetricCards({ total: all.length, water, added, references: refs }).map(metric).join('');
  document.getElementById('libraryRows').innerHTML = items.length ? items.map(function (item) { return `<tr data-library-id="${item.id}" class="border-t cursor-pointer hover:bg-teal-50 ${item.id === state.selectedId ? 'bg-teal-50' : ''}"><td class="p-3 text-teal-700">${esc(item.code || '-')}</td><td class="p-3 font-medium">${esc(item.name)}</td><td class="p-3 text-slate-500">${esc(item.feature || '-')}</td><td class="p-3">${esc(item.unit)}</td><td class="p-3 text-right">${item.defaultQty || 0}</td><td class="p-3 text-center"><span class="badge ${item.quotaCount ? 'badge-green' : 'badge-gray'}">${item.quotaCount || 0} 条</span></td></tr>`; }).join('') : '<tr><td colspan="6" class="p-12 text-center text-slate-400">暂无清单，可新建或导入 Excel。</td></tr>';
  document.querySelectorAll('[data-library-id]').forEach(function (row) { row.onclick = function () { select(workspace, row.dataset.libraryId); }; });
  renderDetail(workspace, items.find(function (item) { return item.id === state.selectedId; }));
  const split = document.getElementById('librarySplit');
  split?.classList.toggle('library-split--detail', Boolean(state.selectedId));
  split?.classList.toggle('library-split--list-only', !state.selectedId);
}

const METRIC_TONES = {
  blue: { surface: 'icon-surface-blue', note: 'text-blue-700' },
  teal: { surface: 'icon-surface-teal', note: 'text-teal-700' },
  amber: { surface: 'icon-surface-amber', note: 'text-amber-700' },
  slate: { surface: 'icon-surface-slate', note: 'text-slate-500' },
};

export function buildLibraryMetricCards({ total = 0, water = 0, added = 0, references = 0 } = {}) {
  const number = function (value) { return Number(value || 0).toLocaleString('en-US'); };
  const ratio = total ? `${Math.round(water / total * 1000) / 10}%` : '0%';
  return [
    { label: '清单总数', value: number(total), unit: '个', note: '全部标准清单', icon: ICONS.resource.boq, tone: 'blue' },
    { label: '水处理工程清单', value: number(water), unit: '个', note: `占比 ${ratio}`, icon: 'water_drop', tone: 'teal' },
    { label: '本月新增清单', value: number(added), unit: '个', note: '本月新增', icon: ICONS.action.add, tone: 'blue' },
    { label: '被引用次数', value: number(references), unit: '次', note: '累计引用', icon: 'trending_up', tone: 'amber' },
  ];
}

function metric(card) {
  const tone = METRIC_TONES[card.tone] || METRIC_TONES.blue;
  return `<div class="library-metric-card px-4 py-3"><div class="kpi-content-top flex h-full gap-3"><div class="icon-surface ${tone.surface}"><span class="material-symbols-outlined icon-kpi">${card.icon}</span></div><div class="min-w-0"><div class="text-xs font-medium text-slate-500">${esc(card.label)}</div><div class="mt-1 flex items-baseline gap-2"><span class="text-2xl font-semibold leading-tight tabular-nums text-slate-950">${esc(card.value)}</span><span class="text-xs text-slate-500">${esc(card.unit)}</span></div><div class="mt-1 text-xs font-medium ${tone.note}">${esc(card.note)}</div></div></div></div>`;
}
function select(workspace, id) { state.selectedId = id; renderRows(workspace); }
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
    quotaCount: Number(item.quotaCount ?? item.quotaRelations?.length ?? item.quotaItemIds?.length) || 0,
    referenceLabel: `${Number(item.referenceCount) || 0} 次`,
    lastReference: [project, date].filter(Boolean).join(' · ') || '尚未引用',
  };
}

export function buildLibraryEditPayload(existing = {}, fields = {}) {
  const clean = function (value) { return String(value ?? '').trim(); };
  const quotaItemIds = Array.isArray(fields.quotaItemIds) ? fields.quotaItemIds : [];
  return {
    ...existing,
    code: clean(fields.code), name: clean(fields.name), feature: clean(fields.feature), unit: clean(fields.unit),
    defaultQty: Number(fields.defaultQty) || 0,
    major: clean(fields.major), scope: clean(fields.scope), structureGroup: clean(fields.structureGroup),
    source: clean(fields.source), version: clean(fields.version), status: fields.status === 'inactive' ? 'inactive' : 'active',
    note: clean(fields.note), quotaItemIds: [...new Set(quotaItemIds.map(clean).filter(Boolean))],
  };
}

export function applyLibraryAISuggestions(fields = {}, selectedQuotaIds = [], result = {}) {
  const editable = new Set(['feature', 'unit', 'major', 'scope', 'structureGroup']);
  const nextFields = {};
  (result.suggestions || []).forEach(function (suggestion) {
    if (suggestion.apply && editable.has(suggestion.field)) nextFields[suggestion.field] = suggestion.suggestedValue;
  });
  const quotaItemIds = [...new Set([...(selectedQuotaIds || []), ...(result.quotaSuggestions || []).filter(function (suggestion) { return suggestion.apply; }).map(function (suggestion) { return suggestion.quotaId; }).filter(Boolean)])];
  return { fields: nextFields, quotaItemIds };
}

function renderDetail(workspace, item) {
  const target = workspace.querySelector('#libraryDetail');
  if (!item) {
    target.innerHTML = `<div class="h-full flex items-center justify-center p-8 text-center"><div><div class="icon-surface icon-surface-slate mx-auto mb-3"><span class="material-symbols-outlined icon-empty">${ICONS.resource.boq}</span></div><div class="font-semibold text-slate-700">选择清单查看详情</div><div class="mt-1 text-sm text-slate-500">从左侧列表选择一条标准清单。</div></div></div>`;
    return;
  }
  const detail = getLibraryDetailSummary(item);
  target.innerHTML = `<div class="h-full flex flex-col"><div class="shrink-0 border-b border-slate-200 px-4 py-4"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><div class="text-xs font-semibold text-teal-700">${esc(detail.code)}</div><h2 class="mt-2 text-xl font-semibold leading-7 text-slate-950">${esc(item.name || '未命名清单')}</h2><div class="mt-2 flex flex-wrap gap-2"><span class="badge badge-blue">${esc(detail.sourceLabel)}</span><span class="rounded border px-2 py-0.5 text-xs ${item.status === 'inactive' ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}">${esc(detail.statusLabel)}</span></div></div><span class="material-symbols-outlined icon-page text-slate-300">article</span></div></div><div class="flex-1 min-h-0 overflow-auto scroll-thin p-4 space-y-5"><div class="grid grid-cols-3 divide-x divide-slate-200 rounded-lg border border-slate-200 bg-slate-50">${detailMetric('单位', item.unit || '-')}${detailMetric('参考组成价', item.quotaCount ? Number(item.referenceUnitPrice || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-')}${detailMetric('套用定额', `${detail.quotaCount} 项`)}</div>${detailSection('项目特征', item.feature || '未填写项目特征。', 'whitespace-pre-line')}${quotaRelationsSection(item)}${detailSection('适用信息', `<div class="grid grid-cols-2 gap-3"><div><div class="text-xs text-slate-500">专业</div><div class="mt-1 text-sm text-slate-700">${esc(item.major || '未设置')}</div></div><div><div class="text-xs text-slate-500">适用范围</div><div class="mt-1 text-sm text-slate-700">${esc(item.scope || '未设置')}</div></div><div><div class="text-xs text-slate-500">结构分组</div><div class="mt-1 text-sm text-slate-700">${esc(item.structureGroup || '未设置')}</div></div><div><div class="text-xs text-slate-500">版本</div><div class="mt-1 text-sm text-slate-700">${esc(item.version || '未设置')}</div></div></div>`, 'raw')}${detailSection('引用记录', `<div class="flex items-center justify-between gap-4"><div><div class="text-xs text-slate-500">累计被引用</div><div class="mt-1 text-lg font-semibold tabular-nums text-slate-900">${esc(detail.referenceLabel)}</div></div><div class="min-w-0 text-right"><div class="text-xs text-slate-500">最近引用</div><div class="mt-1 truncate text-sm text-slate-700" title="${esc(detail.lastReference)}">${esc(detail.lastReference)}</div></div></div>`, 'raw')}${item.note ? detailSection('备注', item.note, 'whitespace-pre-line') : ''}</div><div class="shrink-0 border-t border-slate-200 bg-white p-4"><button onclick="window.__boqLibrary.edit()" class="mb-2 h-10 w-full border border-teal-700 text-sm text-teal-700 flex items-center justify-center gap-1.5"><span class="material-symbols-outlined icon-action">${ICONS.action.edit}</span>编辑清单</button><button onclick="window.__boqLibrary.apply()" class="h-10 w-full text-sm brand-bg text-white flex items-center justify-center gap-1.5"><span class="material-symbols-outlined icon-action">${ICONS.action.apply}</span>加入项目清单</button><div class="mt-2 text-center text-xs text-slate-500">套用时会复制当前定额关系和价格快照，项目内可独立调整。</div></div></div>`;
}

function quotaRelationsSection(item) {
  const rows = item.quotaRelations || [];
  const body = rows.length ? rows.map((relation, index) => {
    const quota = relation.quotaSnapshot || {};
    const value = Number(relation.quantityValue || 0);
    const contribution = Number(quota.priceTotal || 0) * value * Number(relation.adjustmentFactor || 1);
    const status = Number(quota.priceTotal || 0) < 0 ? '<span class="badge badge-yellow">调整</span>' : relation.referenceStatus === 'missing' ? '<span class="badge badge-red">引用失效</span>' : '';
    return `<div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="flex items-start gap-2"><span class="text-xs text-slate-400">${index + 1}</span><div class="min-w-0 flex-1"><div class="font-medium text-slate-800">${esc(quota.code || '未编码')} · ${esc(quota.name || '未命名定额')} ${status}</div><div class="mt-1 text-xs text-slate-500">${esc(quota.unit || '-')} · ${relation.quantityBasis === 'total' ? '总套用量' : '单位含量'} ${value.toLocaleString('zh-CN')} · 快照价 ${Number(quota.priceTotal || 0).toLocaleString('zh-CN')}</div><div class="mt-1 text-xs font-medium ${contribution < 0 ? 'text-amber-700' : 'text-teal-700'}">贡献单价 ${contribution.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}</div></div></div></div>`;
  }).join('') : '<div class="rounded border border-dashed border-slate-200 py-5 text-center text-sm text-slate-400">尚未套用定额</div>';
  return `<section><div class="mb-2 flex items-center justify-between"><div class="text-sm font-semibold text-slate-800">套用定额</div><div class="text-xs text-slate-500">${rows.length} 条关系</div></div><div class="space-y-2">${body}</div></section>`;
}

function detailMetric(label, value) { return `<div class="px-3 py-3"><div class="text-xs text-slate-500">${label}</div><div class="mt-1 text-base font-semibold tabular-nums text-slate-900">${esc(value)}</div></div>`; }
function detailSection(title, value, className) { return `<section><div class="mb-2 text-sm font-semibold text-slate-800">${title}</div><div class="text-sm leading-6 text-slate-600 ${className === 'raw' ? '' : className}">${className === 'raw' ? value : esc(value)}</div></section>`; }

async function edit() {
  const item = items.find(function (row) { return row.id === state.selectedId; });
  if (!item) return;
  const quotas = await quotaRepo.all();
  const selectedQuotaIds = new Set(item.quotaItemIds || []);
  const relationDrafts = new Map((item.quotaRelations || []).map(row => [row.quotaItemId, { ...row }]));
  openModal('编辑清单', libraryEditForm(item), `<button onclick="window.__modalClose()" class="px-3 py-1.5 border">取消</button><button id="libraryAIAssist" class="px-3 py-1.5 border border-teal-700 text-teal-700">AI 辅助完善</button><button id="saveLibraryEdit" class="px-3 py-1.5 bg-teal-700 text-white">保存</button>`);
  const quotaList = document.getElementById('libraryQuotaList');
  const quotaSearch = document.getElementById('libraryQuotaSearch');
  const renderQuotaOptions = function () {
    const keyword = (quotaSearch.value || '').trim().toLowerCase();
    const visible = quotas.filter(function (quota) {
      return !keyword || [quota.code, quota.name, quota.unit].join(' ').toLowerCase().includes(keyword);
    });
    quotaList.innerHTML = visible.length ? visible.map(function (quota) {
      const checked = selectedQuotaIds.has(quota.id) ? ' checked' : '';
      const draft = relationDrafts.get(quota.id) || { quantityBasis: 'per_unit', quantityValue: 1 };
      return `<div class="grid grid-cols-[auto_1fr_88px_90px] items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50"><input type="checkbox" data-library-quota-id="${esc(quota.id)}"${checked} /><span class="min-w-0"><span class="font-medium text-slate-800">${esc(quota.name || '未命名定额')}</span><span class="ml-2 text-xs text-teal-700">${esc(quota.code || '未编码')}</span><span class="block text-xs text-slate-500">${esc(quota.unit || '-')} · ${Number(quota.priceTotal || 0).toLocaleString('zh-CN')}</span></span><select data-library-quota-basis="${esc(quota.id)}" class="h-8 border px-1 text-xs"><option value="per_unit" ${draft.quantityBasis === 'total' ? '' : 'selected'}>单位含量</option><option value="total" ${draft.quantityBasis === 'total' ? 'selected' : ''}>总套用量</option></select><input data-library-quota-qty="${esc(quota.id)}" type="number" step="any" value="${Number(draft.quantityValue ?? 1)}" class="h-8 border px-2 text-right text-xs" /></div>`;
    }).join('') : '<div class="px-3 py-5 text-center text-sm text-slate-400">没有匹配的定额</div>';
    quotaList.querySelectorAll('[data-library-quota-id]').forEach(function (input) {
      input.onchange = function () { if (input.checked) selectedQuotaIds.add(input.dataset.libraryQuotaId); else selectedQuotaIds.delete(input.dataset.libraryQuotaId); updateQuotaCount(); };
    });
    quotaList.querySelectorAll('[data-library-quota-basis]').forEach(select => { select.onchange = () => { const draft = relationDrafts.get(select.dataset.libraryQuotaBasis) || {}; draft.quantityBasis = select.value; relationDrafts.set(select.dataset.libraryQuotaBasis, draft); }; });
    quotaList.querySelectorAll('[data-library-quota-qty]').forEach(input => { input.oninput = () => { const draft = relationDrafts.get(input.dataset.libraryQuotaQty) || {}; draft.quantityValue = Number(input.value || 0); relationDrafts.set(input.dataset.libraryQuotaQty, draft); }; });
    updateQuotaCount();
  };
  const updateQuotaCount = function () {
    const target = document.getElementById('libraryQuotaCount');
    if (target) target.textContent = `已选择 ${selectedQuotaIds.size} 项`;
  };
  quotaSearch.oninput = renderQuotaOptions;
  renderQuotaOptions();
  document.getElementById('libraryAIAssist').onclick = async function () {
    const button = document.getElementById('libraryAIAssist');
    const current = {
      code: document.getElementById('libraryEditCode').value, name: document.getElementById('libraryEditName').value,
      feature: document.getElementById('libraryEditFeature').value, unit: document.getElementById('libraryEditUnit').value,
      major: document.getElementById('libraryEditMajor').value, scope: document.getElementById('libraryEditScope').value,
      structureGroup: document.getElementById('libraryEditStructureGroup').value,
    };
    button.disabled = true;
    button.textContent = 'AI 分析中…';
    try {
      const result = await suggestLibraryItem(current, quotas);
      renderLibraryAISuggestions(result, current, selectedQuotaIds, renderQuotaOptions);
    } catch (err) {
      toast(`AI 建议生成失败：${err.message || err}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'AI 辅助完善';
    }
  };
  document.getElementById('saveLibraryEdit').onclick = async function () {
    const field = function (id) { return document.getElementById(id).value; };
    const payload = buildLibraryEditPayload(item, {
      code: field('libraryEditCode'), name: field('libraryEditName'), feature: field('libraryEditFeature'), unit: field('libraryEditUnit'), defaultQty: field('libraryEditDefaultQty'),
      major: field('libraryEditMajor'), scope: field('libraryEditScope'), structureGroup: field('libraryEditStructureGroup'), source: field('libraryEditSource'),
      version: field('libraryEditVersion'), status: document.getElementById('libraryEditStatus').value, note: field('libraryEditNote'), quotaItemIds: [...selectedQuotaIds],
    });
    payload.quotaRelations = [...selectedQuotaIds].map((quotaItemId, index) => {
      const quota = quotas.find(row => row.id === quotaItemId) || {};
      return { ...(relationDrafts.get(quotaItemId) || {}), quotaItemId, sortOrder: index, quotaSnapshot: relationDrafts.get(quotaItemId)?.quotaSnapshot || quota };
    });
    try {
      await boqLibraryService.save(payload);
      closeModal();
      await render();
      toast('清单已更新', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
}

function renderLibraryAISuggestions(result, current, selectedQuotaIds, renderQuotaOptions) {
  let target = document.getElementById('libraryAISuggestions');
  if (!target) {
    document.getElementById('libraryEditFeature')?.closest('label')?.insertAdjacentHTML('afterend', '<div id="libraryAISuggestions"></div>');
    target = document.getElementById('libraryAISuggestions');
  }
  if (!target) return;
  const fieldLabel = { feature: '项目特征', unit: '单位', major: '专业', scope: '适用范围', structureGroup: '结构分组' };
  const fieldRows = (result.suggestions || []).map(function (suggestion, index) {
    return `<label class="flex gap-2 rounded border border-slate-200 p-2 text-sm"><input type="checkbox" data-library-ai-index="${index}"${suggestion.apply ? ' checked' : ''} /><span class="min-w-0"><span class="font-medium text-slate-800">${esc(fieldLabel[suggestion.field] || suggestion.field)}：${esc(suggestion.suggestedValue)}</span><span class="ml-2 text-xs ${suggestion.confidence === 'high' ? 'text-emerald-700' : 'text-amber-700'}">${esc(suggestion.confidence || 'medium')}</span><span class="mt-0.5 block text-xs text-slate-500">${esc(suggestion.reason || '')}</span></span></label>`;
  }).join('');
  const quotaRows = (result.quotaSuggestions || []).map(function (suggestion, index) {
    return `<label class="flex gap-2 rounded border border-slate-200 p-2 text-sm"><input type="checkbox" data-library-ai-quota-index="${index}"${suggestion.apply ? ' checked' : ''} /><span class="min-w-0"><span class="font-medium text-slate-800">${esc(suggestion.name || '未命名定额')}</span><span class="ml-2 text-xs text-teal-700">${esc(suggestion.code || '')}</span><span class="ml-2 text-xs text-slate-500">${esc(suggestion.unit || '-')} · ${esc(suggestion.confidence || 'medium')}</span><span class="mt-0.5 block text-xs text-slate-500">${esc(suggestion.reason || '')}</span></span></label>`;
  }).join('');
  target.innerHTML = `<section class="rounded-lg border border-teal-200 bg-teal-50 p-3"><div class="font-medium text-teal-900">AI 辅助建议</div><div class="mt-0.5 text-xs text-teal-800">${esc(result.summary || '')}${result.source === 'remote' ? ' · 已使用远端增强' : ' · 本地规则'}</div>${result.warnings?.length ? `<div class="mt-2 text-xs text-amber-700">${esc(result.warnings.join('；'))}</div>` : ''}<div class="mt-3 space-y-2">${fieldRows || '<div class="text-sm text-slate-500">暂无字段建议</div>'}</div>${quotaRows ? `<div class="mt-3 border-t border-teal-200 pt-3"><div class="mb-2 text-sm font-medium text-slate-800">推荐关联定额</div><div class="space-y-2">${quotaRows}</div></div>` : ''}<div class="mt-3 flex justify-end"><button id="applyLibraryAISuggestions" class="h-8 px-3 border border-teal-700 bg-white text-sm text-teal-700">应用选中建议</button></div></section>`;
  document.getElementById('applyLibraryAISuggestions').onclick = function () {
    const selectedFields = (result.suggestions || []).map(function (suggestion, index) { return { ...suggestion, apply: document.querySelector(`[data-library-ai-index="${index}"]`)?.checked || false }; });
    const selectedQuotas = (result.quotaSuggestions || []).map(function (suggestion, index) { return { ...suggestion, apply: document.querySelector(`[data-library-ai-quota-index="${index}"]`)?.checked || false }; });
    const applied = applyLibraryAISuggestions(current, [...selectedQuotaIds], { suggestions: selectedFields, quotaSuggestions: selectedQuotas });
    Object.entries(applied.fields).forEach(function ([field, value]) {
      const input = document.getElementById(`libraryEdit${field.charAt(0).toUpperCase()}${field.slice(1)}`);
      if (input) input.value = value;
    });
    applied.quotaItemIds.forEach(function (id) { selectedQuotaIds.add(id); });
    renderQuotaOptions();
    toast('已应用选中的 AI 建议，保存后才会更新清单库。', 'success');
  };
}

function libraryEditForm(item) {
  const value = function (field) { return esc(item[field] ?? ''); };
  return `<div class="max-h-[65vh] space-y-4 overflow-auto pr-1 text-sm"><div class="grid grid-cols-2 gap-3"><label>清单编码<input id="libraryEditCode" value="${value('code')}" class="mt-1 h-9 w-full border px-2" /></label><label>清单名称 <span class="text-red-600">*</span><input id="libraryEditName" value="${value('name')}" class="mt-1 h-9 w-full border px-2" /></label><label>单位 <span class="text-red-600">*</span><input id="libraryEditUnit" value="${value('unit')}" class="mt-1 h-9 w-full border px-2" /></label><label>默认工程量<input id="libraryEditDefaultQty" type="number" min="0" step="any" value="${value('defaultQty')}" class="mt-1 h-9 w-full border px-2" /></label></div><label class="block">项目特征<textarea id="libraryEditFeature" class="mt-1 min-h-16 w-full border px-2 py-1.5">${value('feature')}</textarea></label><div class="grid grid-cols-2 gap-3"><label>专业<input id="libraryEditMajor" value="${value('major')}" class="mt-1 h-9 w-full border px-2" /></label><label>适用范围<input id="libraryEditScope" value="${value('scope')}" class="mt-1 h-9 w-full border px-2" /></label><label>结构分组<input id="libraryEditStructureGroup" value="${value('structureGroup')}" class="mt-1 h-9 w-full border px-2" /></label><label>来源<input id="libraryEditSource" value="${value('source')}" class="mt-1 h-9 w-full border px-2" /></label><label>版本<input id="libraryEditVersion" value="${value('version')}" class="mt-1 h-9 w-full border px-2" /></label><label>状态<select id="libraryEditStatus" class="mt-1 h-9 w-full border px-2"><option value="active"${item.status === 'inactive' ? '' : ' selected'}>启用</option><option value="inactive"${item.status === 'inactive' ? ' selected' : ''}>停用</option></select></label></div><label class="block">备注<textarea id="libraryEditNote" class="mt-1 min-h-16 w-full border px-2 py-1.5">${value('note')}</textarea></label><section><div class="mb-1 flex items-center justify-between"><label for="libraryQuotaSearch" class="font-medium text-slate-800">关联定额</label><span id="libraryQuotaCount" class="text-xs text-slate-500"></span></div><input id="libraryQuotaSearch" placeholder="搜索定额编码 / 名称 / 单位" class="h-9 w-full border px-2" /><div id="libraryQuotaList" class="mt-2 max-h-48 overflow-auto rounded border border-slate-200"></div></section></div>`;
}

function create() { openModal('新建清单', '<label class="block text-sm">清单名称 <input id="newName" class="mt-1 h-9 w-full border px-2" /></label><label class="mt-3 block text-sm">单位 <input id="newUnit" class="mt-1 h-9 w-full border px-2" /></label><label class="mt-3 block text-sm">项目特征 <textarea id="newFeature" class="mt-1 w-full border px-2"></textarea></label>', '<button onclick="window.__modalClose()" class="px-3 py-1.5 border">取消</button><button id="saveNewLibrary" class="px-3 py-1.5 bg-teal-700 text-white">保存</button>'); document.getElementById('saveNewLibrary').onclick = async function () { try { await boqLibraryService.save({ name: document.getElementById('newName').value, unit: document.getElementById('newUnit').value, feature: document.getElementById('newFeature').value }); closeModal(); render(); } catch (err) { toast(err.message, 'error'); } }; }
async function apply() { const item = items.find(function (row) { return row.id === state.selectedId; }); const projects = await projectRepo.all(); if (!item || !projects.length) return toast('请先建立项目档案', 'error'); const project = projects[0]; const line = await boqLibraryService.applyToProject(item.id, project.id); window.__app.go('boq', { projectId: project.id, activeId: line.id }); }
function remove() {}
function importExcel() { window.__app.go('ai-import', { targetType: 'boq_quota_bundle' }); }
