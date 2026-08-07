// 视图：造价参考
import { indicatorService } from '../services/indicatorService.js?v=6.10';
import { dataEngineService } from '../services/dataEngineService.js?v=6.10';
import { parseEstimatePrompt, explainIndicators } from '../services/aiAssistService.js?v=6.10';
import { projectRepo, dataFactRepo, dataCandidateRepo, dataQualityReportRepo, dataJobRepo } from '../data/repository.js?v=6.10';
import { fmt, fmtMoney, esc, openModal, toast } from '../utils/dom.js?v=6.10';

const state = {
  tab: 'overview',
  filters: { type: '', scale: '', process: '', structure: '', region: '', year: '' },
  keyword: '',
  selectedFamily: '单水造价',
  excludeOutliers: false,
  benchmarkProjectId: '',
  estimate: { area: '', dailyCapacity: '' },
  sample: { projectId: '', sourceType: '', quality: '' },
  scope: 'formal',
  benchmarkQueueIds: [],
};

let cache = { indicators: [], projects: [], archived: [], benchmark: null, queue: [], estimate: null, facts: [], candidates: [], reports: [], jobs: [] };
const chartState = { confidence: null, year: null };
const favoriteKeys = new Set(readFavorites());

export async function render(workspace = document.getElementById('workspace')) {
  const params = window.__app?.state?.routeParams || {};
  if (params.keyword != null) state.keyword = params.keyword;
  if (params.selectedFamily) state.selectedFamily = params.selectedFamily;
  if (params.benchmarkProjectId) state.benchmarkProjectId = params.benchmarkProjectId;
  if (params.filters) state.filters = { ...state.filters, ...params.filters };
  await indicatorService.recompute(scopeOptions());
  cache.projects = await projectRepo.all();
  cache.archived = cache.projects.filter(p => p.status === 'archived');
  [cache.facts, cache.candidates, cache.reports, cache.jobs] = await Promise.all([dataFactRepo.all(), dataCandidateRepo.all(), dataQualityReportRepo.all(), dataJobRepo.all()]);
  cache.indicators = await indicatorService.list(state.filters);
  if (!state.benchmarkProjectId) {
    state.benchmarkProjectId = (cache.projects.find(p => p.status === 'doing') || cache.archived[0] || cache.projects[0] || {}).id || '';
  }
  if (state.benchmarkProjectId && !state.benchmarkQueueIds.length) state.benchmarkQueueIds = [state.benchmarkProjectId];
  state.benchmarkQueueIds = state.benchmarkQueueIds.filter(id => cache.projects.some(project => project.id === id));
  cache.benchmark = state.benchmarkProjectId ? await indicatorService.benchmarkProject(state.benchmarkProjectId) : null;
  cache.queue = (await Promise.all(state.benchmarkQueueIds.map(id => indicatorService.benchmarkProject(id)))).filter(Boolean);
  cache.estimate = await indicatorService.estimate(state.filters, state.estimate);

  expose(workspace);
  workspace.innerHTML = `
    <div class="page-frame min-h-full flex flex-col gap-3">
      ${decisionHeader()}
      ${trustExplainer()}
      ${decisionFilters()}
      ${decisionCanvas()}
      ${estimateView()}
      <section class="card p-0 overflow-hidden">
        ${benchmarkQueue()}
      </section>
    </div>
  `;
  drawCharts(workspace);
}

function trustExplainer() {
  return `<section class="rounded-lg border border-slate-200 bg-white px-4 py-3">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3 text-sm">
      ${trustTile('保存版本', '不可变报价快照，可用于回退和对比；保存版本不等同于案例收录。', 'history')}
      ${trustTile('收录案例', '价格完整、工程量可信且已有版本后，才会用于造价参考。', 'inventory_2')}
      ${trustTile('复盘笔记', '来自报价审查、版本保存或案例复盘，供 AI 查阅，不参与指标计算。', 'psychology_alt')}
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
      <span>样本不足时建议：</span>
      <button onclick="window.__app.go('projects')" class="rounded border border-slate-300 bg-white px-2.5 py-1 text-teal-700">去我的项目收录案例</button>
      <button onclick="window.__app.go('boq')" class="rounded border border-slate-300 bg-white px-2.5 py-1 text-teal-700">去清单保存版本</button>
      <button onclick="window.__app.go('settings')" class="rounded border border-slate-300 bg-white px-2.5 py-1 text-teal-700">去设置重建指标</button>
    </div>
  </section>`;
}

function trustTile(title, desc, icon) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2 flex items-start gap-3">
    <span class="material-symbols-outlined mt-0.5 text-[20px] text-teal-700">${icon}</span>
    <span>
      <span class="block font-semibold text-slate-900">${title}</span>
      <span class="mt-1 block text-xs leading-5 text-slate-500">${desc}</span>
    </span>
  </div>`;
}

function expose(workspace) {
  window.__indicators = {
    tab: async tab => { state.tab = tab; await render(); },
    recompute: async () => { await indicatorService.recompute(scopeOptions()); toast('指标已重算', 'success'); await render(); },
    setScope: async value => { state.scope = value; await render(); },
    setDecisionScope: async value => {
      if (value === 'outliers') state.excludeOutliers = !state.excludeOutliers;
      else state.scope = value;
      await render();
    },
    setFilter: async (name, value) => { state.filters[name] = state.filters[name] === value ? '' : value; await render(); },
    updateKeyword: async value => { state.keyword = value; await render(); },
    selectFamily: async family => { state.selectedFamily = family; await render(); },
    addEstimate: () => toast('已加入估算参考，可在快速估算中继续调整', 'success'),
    parseEstimate: async () => {
      const text = workspace.querySelector('#estimatePrompt')?.value || '';
      const result = parseEstimatePrompt(text);
      (result.suggestions || []).forEach(item => {
        if (item.field === 'area') state.estimate.area = item.suggestedValue;
        if (item.field === 'dailyCapacity') state.estimate.dailyCapacity = item.suggestedValue;
        if (item.field === 'process') state.filters.process = item.suggestedValue;
        if (item.field === 'type') state.filters.type = item.suggestedValue;
      });
      toast(result.summary || '已提取估算参数', 'success');
      await render();
    },
    explainEstimate: () => showAiIndicatorExplain(),
    showMouth: () => showIndicatorMouth(),
    drill: idx => drill(cache.indicators[idx]),
    selectProject: async value => { state.benchmarkProjectId = value; await render(); },
    queueAdd: async () => {
      if (!state.benchmarkProjectId) return toast('请先选择项目', 'error');
      if (state.benchmarkQueueIds.includes(state.benchmarkProjectId)) return toast('该项目已在对标队列中');
      state.benchmarkQueueIds.push(state.benchmarkProjectId);
      toast('已加入对标队列', 'success');
      await render();
    },
    queueRemove: async id => { state.benchmarkQueueIds = state.benchmarkQueueIds.filter(item => item !== id); await render(); },
    queueClear: async () => { state.benchmarkQueueIds = []; await render(); },
    toggleFavorite: key => {
      if (favoriteKeys.has(key)) favoriteKeys.delete(key);
      else favoriteKeys.add(key);
      saveFavorites();
      toast(favoriteKeys.has(key) ? '已收藏指标' : '已取消收藏');
      render();
    },
    exportCurrent: () => exportCurrentIndicators(),
    updateEstimate: async (field, value) => { state.estimate[field] = value; await render(); },
    sampleFilter: async (field, value) => { state.sample[field] = value; await render(); },
    promote: async id => { await dataEngineService.promoteCandidates([id]); toast('已确认记录可用于造价参考', 'success'); await render(); },
    lineage: id => showLineage(id),
    repair: async (id, action) => repairSample(id, action),
    promoteVisible: async () => {
      const ids = filteredSamples().filter(s => s.status === 'candidate').map(s => s.id);
      if (!ids.length) return toast('当前筛选下没有待检查记录', 'error');
      await dataEngineService.promoteCandidates(ids);
      toast(`已确认 ${ids.length} 条记录可用于参考`, 'success');
      await render();
    },
  };
}

function scopeOptions() {
  return {
    excludeOutliers: state.excludeOutliers,
    includeCandidates: state.scope === 'candidates',
    includeVersions: state.scope === 'versions',
  };
}

function uniqueValues(key) {
  const vals = cache.archived.map(p => indicatorService.projectDims(p)[key]).filter(Boolean);
  return [...new Set(vals)].filter(v => v !== '未填写').sort();
}

function decisionHeader() {
  const rows = filteredDecisionIndicators();
  const sampleIds = new Set(rows.flatMap(({ it }) => it.sampleProjectIds || []));
  const reference = rows.filter(({ it }) => it.confidence === '仅参考').length;
  return `<section class="flex flex-col 2xl:flex-row 2xl:items-end 2xl:justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-normal text-slate-950">指标决策台</h1>
      <div class="mt-2 text-sm text-slate-500">先判断样本可信度，再引用造价区间。</div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      ${decisionStatusChip('groups', `${fmt(sampleIds.size)} 个可用样本`, 'teal')}
      ${decisionStatusChip('bar_chart', `${fmt(rows.length)} 组指标`, 'sky')}
      ${decisionStatusChip('info', `仅参考 ${fmt(reference)}`, reference ? 'amber' : 'teal')}
    </div>
  </section>`;
}

function decisionStatusChip(icon, text, tone = 'slate') {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-700'
    : tone === 'sky' ? 'border-sky-200 bg-sky-50 text-sky-700'
      : 'border-teal-200 bg-teal-50 text-teal-700';
  return `<span class="inline-flex items-center gap-2 rounded-lg border ${cls} px-3 py-2 text-sm font-medium">
    <span class="material-symbols-outlined text-[18px]">${icon}</span>${esc(text)}
  </span>`;
}

function decisionFilters() {
  return `<section class="card p-4">
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(280px,1fr)_420px_auto] gap-3 items-center">
      <label class="relative block">
        <input id="indicatorKeyword" value="${esc(state.keyword)}" onchange="window.__indicators.updateKeyword(this.value)" onkeydown="if(event.key==='Enter') window.__indicators.updateKeyword(this.value)" type="search" placeholder="搜索项目类型、工艺、指标名称..."
          class="h-10 w-full rounded border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-800 placeholder:text-slate-400" />
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-slate-400">search</span>
      </label>
      <div class="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
        ${scopeSegment('formal', '可用案例')}
        ${scopeSegment('candidates', '含候选')}
        ${scopeSegment('outliers', '剔除异常')}
      </div>
      <div class="flex items-center justify-end gap-2">
        <button onclick="window.__indicators.recompute()" class="inline-flex h-10 items-center gap-1.5 rounded px-3 text-sm brand-bg text-white">
          <span class="material-symbols-outlined text-[18px]">refresh</span>重算指标
        </button>
        <button onclick="window.__indicators.exportCurrent()" class="inline-flex h-10 items-center gap-1.5 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50">
          <span class="material-symbols-outlined text-[18px]">download</span>导出当前指标
        </button>
      </div>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      ${chipGroup('项目类型', 'type', ['', ...uniqueValues('type').slice(0, 3)])}
      ${chipGroup('工艺', 'process', ['', ...uniqueValues('process').slice(0, 3)])}
      ${chipGroup('结构', 'structure', ['', ...uniqueValues('structure').slice(0, 3)])}
      ${chipGroup('年份', 'year', ['', ...uniqueValues('year').slice(0, 3)])}
    </div>
  </section>`;
}

function scopeSegment(value, label) {
  const active = value === 'outliers' ? state.excludeOutliers : state.scope === value;
  return `<button onclick="window.__indicators.setDecisionScope('${value}')" class="h-8 rounded px-4 text-sm ${active ? 'brand-bg text-white shadow-sm' : 'text-slate-600 hover:bg-white'}">${label}</button>`;
}

function chipGroup(label, name, values) {
  return `<div class="flex items-center gap-2 min-w-0">
    <span class="text-xs font-medium text-slate-500 shrink-0">${label}</span>
    <div class="flex flex-wrap gap-1.5">
      ${values.map(value => filterChip(name, value)).join('')}
    </div>
  </div>`;
}

function filterChip(name, value) {
  const active = (state.filters[name] || '') === value;
  const label = value || '全部';
  return `<button onclick="window.__indicators.setFilter('${name}','${escAttr(value)}')" class="rounded-lg border px-2.5 py-1 text-xs ${active ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}">${esc(label)}</button>`;
}

function filteredDecisionIndicators() {
  const keyword = String(state.keyword || '').trim().toLowerCase();
  return cache.indicators
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => {
      if (!keyword) return true;
      const text = [it.metric, it.typeKey, it.category, it.confidence].filter(Boolean).join(' ').toLowerCase();
      return text.includes(keyword);
    })
    .sort((a, b) => familyOrder(metricFamily(a.it.metric)) - familyOrder(metricFamily(b.it.metric))
      || confidenceRank(b.it) - confidenceRank(a.it)
      || Number(b.it.n || 0) - Number(a.it.n || 0));
}

function decisionCanvas() {
  const rows = filteredDecisionIndicators();
  const selected = selectedIndicator(rows);
  return `<section class="grid grid-cols-1 2xl:grid-cols-[320px_minmax(0,1fr)_360px] gap-3 items-start">
    ${indicatorCatalog(rows, selected)}
    ${selected ? indicatorDecisionCard(selected) : emptyDecisionCard()}
    <aside class="grid grid-cols-1 gap-3">
      ${confidenceDiagnosis(selected)}
      ${yearTrendCard(selected)}
      ${mouthBoundaryCard(selected)}
    </aside>
  </section>`;
}

function selectedIndicator(rows = filteredDecisionIndicators()) {
  let entry = rows.find(({ it }) => metricFamily(it.metric) === state.selectedFamily);
  if (!entry) entry = rows[0];
  if (entry && metricFamily(entry.it.metric) !== state.selectedFamily) state.selectedFamily = metricFamily(entry.it.metric);
  return entry || null;
}

function indicatorCatalog(rows, selected) {
  const families = indicatorFamilies(rows);
  const sampleIds = new Set(rows.flatMap(({ it }) => it.sampleProjectIds || []));
  return `<section class="card p-0 overflow-hidden min-h-[520px]">
    <div class="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
      <div class="font-semibold text-slate-900">指标目录</div>
      <span class="material-symbols-outlined text-[16px] text-slate-400">info</span>
    </div>
    <div class="p-3 space-y-2">
      ${families.map(f => catalogRow(f, selected)).join('') || `<div class="py-10 text-center text-sm text-slate-400">当前筛选下暂无指标</div>`}
    </div>
    <div class="m-3 mt-5 rounded-lg border border-sky-100 bg-sky-50 px-3 py-3 text-xs leading-5 text-sky-800">
      当前筛选口径下仅 ${fmt(sampleIds.size)} 个样本，建议扩大项目类型或年份。
    </div>
  </section>`;
}

function indicatorFamilies(rows) {
  const familyNames = ['总造价', '单方造价', '单水造价', '分项造价占比', '分项造价'];
  return familyNames.map(name => {
    const entries = rows.filter(({ it }) => metricFamily(it.metric) === name);
    const best = entries.slice().sort((a, b) => confidenceRank(b.it) - confidenceRank(a.it))[0]?.it;
    return {
      name,
      count: entries.length,
      confidence: best?.confidence || '无样本',
      confidenceScore: best ? confidenceScore(best) : 0,
      desc: familyDesc(name),
      icon: familyIcon(name),
    };
  }).filter(f => f.count || f.name === state.selectedFamily);
}

function catalogRow(f, selected) {
  const active = selected && f.name === metricFamily(selected.it.metric);
  return `<button onclick="window.__indicators.selectFamily('${f.name}')" class="w-full rounded-lg border px-3 py-3 text-left ${active ? 'border-teal-300 bg-teal-50 shadow-sm' : 'border-slate-200 bg-white hover:bg-slate-50'}">
    <div class="flex items-start gap-3">
      <div class="h-9 w-9 rounded-lg border ${active ? 'border-teal-200 bg-white text-teal-700' : 'border-slate-200 bg-slate-50 text-slate-600'} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[18px]">${f.icon}</span>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2">
          <div class="font-semibold ${active ? 'text-teal-900' : 'text-slate-800'}">${esc(f.name)}</div>
          <span class="text-xs text-slate-500">${fmt(f.count)} 项</span>
        </div>
        <div class="mt-1 text-xs text-slate-500 truncate">${esc(f.desc)}</div>
        <div class="mt-2 flex items-center gap-2">
          <div class="h-1.5 flex-1 rounded bg-slate-100 overflow-hidden"><div class="h-1.5 rounded ${confidenceBarColor(f.confidence)}" style="width:${Math.max(8, f.confidenceScore)}%"></div></div>
          <span class="badge ${confidenceBadgeClass(f.confidence)}">${esc(f.confidence)}</span>
        </div>
      </div>
    </div>
  </button>`;
}

function indicatorDecisionCard(entry) {
  const it = entry.it;
  const dims = bucketParts(it.typeKey);
  const key = indicatorFavoriteKey(it);
  const favorite = favoriteKeys.has(key);
  return `<section class="card p-0 overflow-hidden min-h-[520px]">
    <div class="px-4 py-3 border-b border-slate-200 flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <div class="font-semibold text-slate-900">${esc(metricDisplayName(it.metric))}指标</div>
        <div class="mt-2 flex flex-wrap gap-1.5">${dims.slice(0, 3).map(v => `<span class="badge badge-blue">${esc(v)}</span>`).join('') || '<span class="badge badge-gray">未归类</span>'}</div>
      </div>
      <button onclick="window.__indicators.toggleFavorite('${escAttr(key)}')" title="${favorite ? '取消收藏' : '收藏指标'}" class="p-1.5 rounded ${favorite ? 'text-teal-700 bg-teal-50' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-700'}"><span class="material-symbols-outlined text-[18px]">bookmark</span></button>
      <button onclick="window.__indicators.showMouth()" title="查看口径与边界" class="p-1.5 rounded text-slate-400 hover:bg-slate-50 hover:text-slate-700"><span class="material-symbols-outlined text-[18px]">more_vert</span></button>
    </div>
    <div class="p-4">
      ${rangeDecisionBand(it)}
      <div class="mt-6 text-center">
        <div class="text-3xl font-semibold tabular-nums text-slate-950">${formatDecisionValue(it)}</div>
        <div class="mt-1 text-sm text-slate-500">当前口径中位值 <span class="material-symbols-outlined align-[-3px] text-[16px] text-slate-400">info</span></div>
      </div>
      <button onclick="window.__indicators.drill(${entry.index})" class="mt-5 w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-left text-sm text-amber-800 hover:bg-amber-100">
        <span class="material-symbols-outlined align-[-4px] mr-1 text-[18px]">warning</span>
        ${decisionWarning(it)}
        <span class="material-symbols-outlined float-right text-[18px]">chevron_right</span>
      </button>
      <div class="mt-4">
        <div class="font-semibold text-slate-800">样本构成（${fmt((it.sampleProjectIds || []).length)} 个可用样本）</div>
        <div class="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 overflow-hidden">
          ${evidenceRows(it)}
        </div>
      </div>
      <div class="mt-4 grid grid-cols-3 gap-2">
        <button onclick="window.__indicators.drill(${entry.index})" class="h-10 rounded border border-teal-200 bg-white text-sm text-teal-700 hover:bg-teal-50"><span class="material-symbols-outlined align-[-4px] mr-1 text-[18px]">search</span>下钻样本</button>
        <button onclick="window.__indicators.addEstimate()" class="h-10 rounded brand-bg text-sm text-white"><span class="material-symbols-outlined align-[-4px] mr-1 text-[18px]">add_circle</span>加入估算</button>
        <button onclick="window.__indicators.showMouth()" class="h-10 rounded border border-slate-300 bg-white text-sm text-teal-700 hover:bg-slate-50"><span class="material-symbols-outlined align-[-4px] mr-1 text-[18px]">article</span>查看口径</button>
      </div>
    </div>
  </section>`;
}

function rangeDecisionBand(it) {
  const values = [Number(it.p25 || 0), Number(it.median || 0), Number(it.p75 || 0)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * 0.25);
  const axisMin = min - span * 0.5;
  const axisMax = max + span * 0.5;
  const pos = v => Math.max(0, Math.min(100, ((Number(v || 0) - axisMin) / (axisMax - axisMin || 1)) * 100));
  return `<div class="px-2 pt-2 pb-4">
    <div class="grid grid-cols-3 text-sm">
      ${rangeLabel('P25', it.p25, it.metric)}
      ${rangeLabel('中位', it.median, it.metric, true)}
      ${rangeLabel('P75', it.p75, it.metric)}
    </div>
    <div class="relative mt-7 h-10">
      <div class="absolute left-0 right-0 top-4 h-2 rounded-full bg-slate-100"></div>
      <div class="absolute top-4 h-2 rounded-full bg-teal-100" style="left:${pos(it.p25)}%; width:${Math.max(2, pos(it.p75) - pos(it.p25))}%"></div>
      <div class="absolute top-2 h-6 w-2 -translate-x-1/2 rounded bg-teal-500" style="left:${pos(it.p25)}%"></div>
      <div class="absolute top-1 h-8 w-8 -translate-x-1/2 rounded-full border-4 border-white bg-teal-600 shadow" style="left:${pos(it.median)}%"></div>
      <div class="absolute top-2 h-6 w-2 -translate-x-1/2 rounded bg-teal-500" style="left:${pos(it.p75)}%"></div>
    </div>
    <div class="flex justify-between text-xs tabular-nums text-slate-500">
      <span>${fmt(axisMin)}</span><span>${fmt(axisMax)}</span>
    </div>
  </div>`;
}

function rangeLabel(label, value, metric, active = false) {
  return `<div class="${active ? 'text-center' : label === 'P25' ? 'text-left' : 'text-right'}">
    <div class="${active ? 'text-teal-700' : 'text-slate-500'}">${label}</div>
    <div class="mt-1 font-semibold tabular-nums ${active ? 'text-xl text-teal-700' : 'text-slate-800'}">${formatIndicatorValue(metric, value)}</div>
  </div>`;
}

function confidenceDiagnosis(entry) {
  const it = entry?.it;
  if (!it) return `<section class="card p-4 text-sm text-slate-400">暂无可信度诊断</section>`;
  const nScore = Math.min(100, Number(it.n || 0) / 6 * 100);
  const dispersionScore = Math.max(0, 100 - Number(it.dispersion || 0) * 100);
  const outlierScore = Math.max(0, 100 - Number(it.outlierCount || 0) * 25);
  return `<section class="card p-4">
    <div class="flex items-center justify-between">
      <div class="font-semibold text-slate-900">可信度诊断</div>
      <span class="badge ${confidenceBadgeClass(it.confidence)}">${esc(it.confidence || '仅参考')}</span>
    </div>
    <div class="mt-4 grid grid-cols-[112px_minmax(0,1fr)] gap-4 items-center">
      <div class="h-24 w-24 rounded-full border-[10px] ${confidenceRingClass(it.confidence)} flex items-center justify-center text-lg font-semibold">${esc(it.confidence || '仅参考')}</div>
      <div class="space-y-2 text-sm">
        ${diagnosisPair('样本数', `${fmt(it.n || 0)} 个`)}
        ${diagnosisPair('离散度', `${fmt((it.dispersion || 0) * 100)}%`)}
        ${diagnosisPair('异常值', `${fmt(it.outlierCount || 0)} 个`)}
      </div>
    </div>
    <div class="mt-4 space-y-3">
      ${diagnosisBar('样本数量', nScore, `${fmt(it.n || 0)}/6`, nScore >= 50 ? 'teal' : 'amber')}
      ${diagnosisBar('离散度', dispersionScore, dispersionScore >= 80 ? '优秀' : '需关注', dispersionScore >= 80 ? 'teal' : 'amber')}
      ${diagnosisBar('异常压力', outlierScore, outlierScore >= 80 ? '良好' : '偏高', outlierScore >= 80 ? 'teal' : 'amber')}
    </div>
  </section>`;
}

function diagnosisPair(label, value) {
  return `<div class="flex items-center justify-between gap-3"><span class="text-slate-500">${label}</span><span class="font-semibold tabular-nums text-slate-800">${value}</span></div>`;
}

function diagnosisBar(label, percent, note, tone = 'teal') {
  const color = tone === 'amber' ? 'bg-amber-500' : 'bg-teal-600';
  return `<div>
    <div class="mb-1 flex items-center justify-between text-xs"><span class="text-slate-600">${label}</span><span class="${tone === 'amber' ? 'text-amber-700' : 'text-teal-700'}">${note}</span></div>
    <div class="h-2 rounded bg-slate-100"><div class="h-2 rounded ${color}" style="width:${Math.max(4, Math.min(100, percent))}%"></div></div>
  </div>`;
}

function yearTrendCard(entry) {
  const points = indicatorTrendPoints(entry?.it);
  const hasTrend = points.length >= 2;
  return `<section class="card p-4">
    <div class="flex items-center justify-between gap-3">
      <div class="font-semibold text-slate-900">年度趋势</div>
      <span class="text-xs text-slate-500 truncate">${esc(metricDisplayName(entry?.it?.metric || '指标'))}</span>
    </div>
    ${hasTrend
      ? '<div class="mt-3 relative overflow-hidden" style="height:150px;min-height:150px;max-height:150px;"><canvas id="indicatorYearTrendChart" width="320" height="150" style="display:block;width:100%;height:150px;max-height:150px;"></canvas></div>'
      : emptyTrendState(points, entry?.it)}
  </section>`;
}

function emptyTrendState(points, it) {
  const latest = points[0];
  return `<div class="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-5 text-center">
    <div class="mx-auto h-9 w-9 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 flex items-center justify-center">
      <span class="material-symbols-outlined text-[19px]">timeline</span>
    </div>
    <div class="mt-2 text-sm font-medium text-slate-700">年度样本不足</div>
    <div class="mt-1 text-xs leading-5 text-slate-500">
      ${latest ? `${esc(latest.year)} 当前值 ${formatIndicatorValue(it?.metric, latest.value)} ${unitForMetric(it?.metric)}` : '当前口径没有可绘制的年度样本'}
    </div>
  </div>`;
}

function mouthBoundaryCard(entry) {
  const it = entry?.it;
  return `<section class="card p-4">
    <div class="font-semibold text-slate-900">口径与边界</div>
    <div class="mt-3 space-y-3 text-xs leading-5 text-slate-600">
      ${mouthItem('指标定义', it ? `${metricDisplayName(it.metric)} / ${unitForMetric(it.metric)}` : '-')}
      ${mouthItem('计算口径', '含土建、设备、电气、安装等全部费用')}
      ${mouthItem('适用边界', `${bucketParts(it?.typeKey).slice(0, 3).join(' / ') || '当前筛选口径'}，设计水量 500 ~ 50,000 m³/d`)}
      ${mouthItem('风险提示', Number(it?.n || 0) < 3 ? '样本过少，可能无法代表真实市场水平。' : '可用于同类项目快速校核。', 'amber')}
    </div>
  </section>`;
}

function mouthItem(label, text, tone = 'teal') {
  const icon = tone === 'amber' ? 'warning' : 'check_box';
  const color = tone === 'amber' ? 'text-amber-700' : 'text-teal-700';
  return `<div class="flex items-start gap-2"><span class="material-symbols-outlined mt-0.5 text-[16px] ${color}">${icon}</span><div><span class="font-medium text-slate-800">${label}</span><span class="ml-2">${esc(text)}</span></div></div>`;
}

function benchmarkQueue() {
  const rows = benchmarkQueueRows();
  return `<div>
    <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
      <div>
        <div class="font-semibold text-slate-900">指标对标队列</div>
        <div class="mt-1 text-xs text-slate-500">将选中的项目组成对标队列，快速评估偏差与合理性。</div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="window.__indicators.queueAdd()" class="inline-flex h-9 items-center gap-1.5 rounded border border-teal-300 bg-white px-3 text-sm text-teal-700 hover:bg-teal-50"><span class="material-symbols-outlined text-[18px]">add</span>加入当前项目</button>
        <button onclick="window.__indicators.queueClear()" class="inline-flex h-9 items-center gap-1.5 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"><span class="material-symbols-outlined text-[18px]">delete</span>清空队列</button>
      </div>
    </div>
    <div class="p-3 space-y-2">
      ${rows.map(queueRow).join('') || `<div class="py-10 text-center text-sm text-slate-400">暂无对标项目</div>`}
    </div>
  </div>`;
}

function benchmarkQueueRows() {
  return cache.queue.map(benchmark => {
    const metric = benchmark.metrics.find(item => metricFamily(item.label) === state.selectedFamily) || benchmark.metrics[0];
    const indicator = metric?.indicator || null;
    const current = Number(metric?.value || 0);
    const median = Number(indicator?.median || 0);
    const dev = median ? Math.round((current - median) / median * 100) : 0;
    return {
      project: benchmark.project,
      metric: metric?.label || '总造价(元)',
      current,
      p25: Number(indicator?.p25 || 0),
      p75: Number(indicator?.p75 || 0),
      dev,
      confidence: indicator?.confidence || '样本不足',
    };
  });
}

function queueRow(row) {
  const tone = row.dev > 20 ? 'red' : row.dev < -20 ? 'amber' : 'teal';
  const status = row.dev > 20 ? '偏高' : row.dev < -20 ? '偏低' : '正常';
  return `<div class="grid grid-cols-1 xl:grid-cols-[minmax(220px,1fr)_180px_120px_160px_110px_140px_72px] gap-3 items-center rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm">
    <div class="flex items-center gap-2 min-w-0"><span class="h-2 w-2 rounded-full bg-teal-600 shrink-0"></span><span class="font-medium text-slate-800 truncate">${esc(row.project.name || '未命名项目')}</span></div>
    <div><span class="badge badge-blue">${esc(metricDisplayName(row.metric))}</span></div>
    <div class="tabular-nums text-slate-800">${row.current ? fmt(row.current) : '-'}</div>
    <div class="tabular-nums text-slate-600">${fmt(row.p25)} ~ ${fmt(row.p75)}</div>
    <div class="font-semibold tabular-nums ${tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-700' : 'text-teal-700'}">${row.current ? `${row.dev > 0 ? '+' : ''}${row.dev}%` : '-'}</div>
    <div class="flex items-center gap-2"><span class="badge ${tone === 'red' ? 'badge-red' : tone === 'amber' ? 'badge-yellow' : 'badge-green'}">${status}</span><span class="badge ${confidenceBadgeClass(row.confidence)}">${esc(row.confidence)}</span></div>
    <div class="flex justify-end gap-1">
      <button onclick="window.__indicators.selectProject('${escAttr(row.project.id)}')" class="h-8 w-8 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" title="查看"><span class="material-symbols-outlined text-[17px]">visibility</span></button>
      <button onclick="window.__indicators.queueRemove('${escAttr(row.project.id)}')" class="h-8 w-8 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" title="移除"><span class="material-symbols-outlined text-[17px]">delete</span></button>
    </div>
  </div>`;
}

function emptyDecisionCard() {
  return `<section class="card p-10 text-center text-slate-400 min-h-[520px] flex items-center justify-center">当前筛选下没有可用指标。</section>`;
}

function metricFamily(metric = '') {
  const text = String(metric || '');
  if (text.includes('单水造价')) return '单水造价';
  if (text.includes('单方造价')) return '单方造价';
  if (text.includes('分项造价占比')) return '分项造价占比';
  if (text.includes('分项造价')) return '分项造价';
  if (text.includes('总造价')) return '总造价';
  return '总造价';
}

function familyOrder(name) {
  return ['总造价', '单方造价', '单水造价', '分项造价占比', '分项造价'].indexOf(name);
}

function familyDesc(name) {
  return {
    '总造价': '总造价',
    '单方造价': '分摊到建筑面积',
    '单水造价': '分摊到设计水量',
    '分项造价占比': '分项造价占总造价',
    '分项造价': '分项造价金额',
  }[name] || '指标';
}

function familyIcon(name) {
  return {
    '总造价': 'account_balance_wallet',
    '单方造价': 'square_foot',
    '单水造价': 'hub',
    '分项造价占比': 'donut_large',
    '分项造价': 'category',
  }[name] || 'analytics';
}

function bucketParts(typeKey = '') {
  return String(typeKey || '').split('/').map(v => v.trim()).filter(Boolean);
}

function confidenceScore(it) {
  const rank = { '高可信': 100, '中可信': 72, '低可信': 46, '仅参考': 24, '无样本': 8 };
  if (Number.isFinite(Number(it.confidenceScore))) return Math.min(100, Math.max(0, Number(it.confidenceScore)));
  return rank[it.confidence] || 20;
}

function confidenceBadgeClass(confidence = '') {
  return confidence === '高可信' ? 'badge-green'
    : confidence === '中可信' ? 'badge-blue'
      : confidence === '低可信' ? 'badge-yellow'
        : confidence === '仅参考' ? 'badge-yellow'
          : 'badge-gray';
}

function confidenceBarColor(confidence = '') {
  return confidence === '高可信' ? 'bg-teal-600'
    : confidence === '中可信' ? 'bg-sky-500'
      : confidence === '低可信' ? 'bg-amber-500'
        : confidence === '仅参考' ? 'bg-amber-500'
          : 'bg-slate-300';
}

function confidenceRingClass(confidence = '') {
  return confidence === '高可信' ? 'border-teal-500 text-teal-700 bg-teal-50'
    : confidence === '中可信' ? 'border-sky-500 text-sky-700 bg-sky-50'
      : 'border-amber-300 text-amber-700 bg-amber-50';
}

function formatDecisionValue(it) {
  if (!it) return '-';
  return `${formatIndicatorValue(it.metric, it.median)} ${unitForMetric(it.metric)}`;
}

function unitForMetric(metric = '') {
  const text = String(metric || '');
  if (text.includes('单水造价')) return '元/(m³·d)';
  if (text.includes('单方造价')) return '元/㎡';
  if (text.includes('占比')) return '%';
  if (text.includes('造价')) return '元';
  return '';
}

function decisionWarning(it) {
  if (!it) return '当前没有可用样本';
  if (Number(it.n || 0) < 3) return `仅供参考：样本数 ${fmt(it.n || 0)}，未达到正式引用阈值`;
  if (it.confidence === '低可信' || it.confidence === '仅参考') return `仅供参考：${esc(it.confidence)}，建议复核后引用`;
  return '可用于同类项目快速校核，建议结合项目边界复核';
}

function evidenceRows(it) {
  const ids = it.sampleProjectIds || [];
  const projects = ids.map(id => cache.projects.find(p => p.id === id)).filter(Boolean);
  const rows = (projects.length ? projects : cache.archived).slice(0, 3);
  if (!rows.length) return `<div class="px-3 py-6 text-center text-sm text-slate-400">暂无样本构成</div>`;
  return rows.map((p, idx) => {
    const normal = idx < Math.max(1, Number(it.n || 0));
    return `<div class="grid grid-cols-[minmax(0,1fr)_80px_120px_80px] gap-3 px-3 py-2.5 text-sm items-center">
      <div class="min-w-0 flex items-center gap-2"><span class="h-2 w-2 rounded-full ${normal ? 'bg-teal-600' : 'bg-amber-500'} shrink-0"></span><span class="truncate">${esc(p.name || '未命名项目')}</span></div>
      <div class="tabular-nums text-slate-500">${esc(indicatorService.projectDims(p).year || '-')}</div>
      <div class="text-right tabular-nums text-slate-800">${fmtMoney(p.totalCost || 0)}</div>
      <div class="text-right ${normal ? 'text-teal-700' : 'text-amber-700'}">${normal ? '正常' : '样本不足'}</div>
    </div>`;
  }).join('');
}

function showIndicatorMouth() {
  const entry = selectedIndicator();
  const it = entry?.it;
  openModal('指标口径与适用边界', `
    <div class="space-y-3 text-sm leading-6 text-slate-700">
      ${lineageTile('指标定义', it ? `${metricDisplayName(it.metric)} / ${unitForMetric(it.metric)}` : '-')}
      ${lineageTile('计算口径', '按当前筛选项目的已收录案例计算 P25 / 中位 / P75，默认排除未收录项目。')}
      ${lineageTile('适用边界', bucketParts(it?.typeKey).join(' / ') || '当前筛选口径')}
      ${lineageTile('风险提示', Number(it?.n || 0) < 3 ? '样本数量不足，仅可作为早期估算或复核提示。' : '可用于同类项目快速校核，正式报价前仍需结合清单复核。')}
    </div>
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>`);
}

function escAttr(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

function indicatorFavoriteKey(indicator = {}) {
  return [indicator.typeKey, indicator.level, indicator.metric].join('::');
}

function readFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem('indicator_favorites') || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem('indicator_favorites', JSON.stringify([...favoriteKeys]));
}

function exportCurrentIndicators() {
  const payload = {
    exportedAt: new Date().toISOString(),
    filters: { ...state.filters },
    scope: state.scope,
    excludeOutliers: state.excludeOutliers,
    indicators: cache.indicators,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `造价参考指标-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function select(name, label) {
  return `<label class="text-xs font-medium text-slate-500">${label}
    <select id="if_${name}" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-700">
      <option value="">全部</option>
      ${uniqueValues(name).map(v => `<option value="${esc(v)}" ${state.filters[name] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    </select>
  </label>`;
}

function filters() {
  return `<section class="card p-4">
    <div class="grid grid-cols-6 gap-3">
      ${select('type', '项目类型')}
      ${select('scale', '规模等级')}
      ${select('process', '工艺类型')}
      ${select('structure', '结构形式')}
      ${select('region', '地区')}
      ${select('year', '建设/报价年份')}
    </div>
    <div class="mt-3 flex items-center gap-3 text-xs text-slate-500">
      <label class="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
        统计口径
        <select onchange="window.__indicators.setScope(this.value)" class="h-7 rounded border border-slate-300 bg-white px-2 text-xs">
          <option value="formal" ${state.scope === 'formal' ? 'selected' : ''}>仅已收录案例</option>
          <option value="candidates" ${state.scope === 'candidates' ? 'selected' : ''}>正式 + 候选</option>
          <option value="versions" ${state.scope === 'versions' ? 'selected' : ''}>正式 + 报价版本</option>
        </select>
      </label>
      <label class="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
        <input id="if_outliers" type="checkbox" ${state.excludeOutliers ? 'checked' : ''} />
        剔除 IQR 异常值
      </label>
      <span>同类样本按类型 / 规模 / 结构匹配，样本少于 3 时仅作参考。</span>
    </div>
  </section>`;
}

function bindFilters() {
  ['type', 'scale', 'process', 'structure', 'region', 'year'].forEach(k => {
    const el = document.getElementById(`if_${k}`);
    if (el) el.onchange = async () => { state.filters[k] = el.value; await render(); };
  });
  const outliers = document.getElementById('if_outliers');
  if (outliers) outliers.onchange = async () => { state.excludeOutliers = outliers.checked; await render(); };
}

function medianOf(metric) {
  const arr = cache.indicators.filter(i => i.metric === metric);
  if (!arr.length) return 0;
  return arr.reduce((s, i) => s + (i.median || 0), 0) / arr.length;
}

function summary() {
  const high = cache.indicators.filter(i => i.confidence === '高可信').length;
  const sampleIds = new Set(cache.indicators.flatMap(i => i.sampleProjectIds || []));
  const medianTotal = medianOf('总造价(元)');
  const medianArea = medianOf('单方造价(元/㎡)');
  const medianWater = medianOf('单水造价(元/(m³·d))');
  return `<section class="grid grid-cols-5 gap-3">
    ${summaryCard('可用样本项目', sampleIds.size, '个')}
    ${summaryCard('指标桶', cache.indicators.length, '组')}
    ${summaryCard('高可信指标', high, '组')}
    ${summaryCard('中位总造价', fmtMoney(medianTotal), '')}
    ${summaryCard('中位单水造价', fmt(medianWater), '元/(m³·d)')}
  </section>`;
}

function summaryCard(label, value, suffix) {
  return `<div class="card p-4">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-2 text-xl font-semibold tabular-nums text-slate-900">${value}<span class="ml-1 text-xs font-normal text-slate-500">${suffix}</span></div>
  </div>`;
}

function tabButton(id, label) {
  const active = state.tab === id;
  return `<button onclick="window.__indicators.tab('${id}')" class="mb-2 rounded px-3 py-1.5 text-sm ${active ? 'bg-teal-50 text-teal-700 border border-teal-200' : 'text-slate-500 hover:bg-slate-50 border border-transparent'}">${label}</button>`;
}

function confidenceBadge(it) {
  const cls = it.confidence === '高可信' ? 'badge-green' : it.confidence === '中可信' ? 'badge-gray' : it.confidence === '低可信' ? 'badge-yellow' : 'badge-red';
  return `<span class="badge ${cls}" title="样本数 ${it.n}，离散度 ${(it.dispersion * 100).toFixed(0)}%，异常值 ${it.outlierCount} 个">${esc(it.confidence || '仅参考')}</span>`;
}

function overviewRows() {
  return cache.indicators
    .map((it, index) => ({ it, index }))
    .sort((a, b) => confidenceRank(b.it) - confidenceRank(a.it)
      || Number(b.it.n || 0) - Number(a.it.n || 0)
      || levelRank(b.it.level) - levelRank(a.it.level)
      || String(a.it.typeKey || '').localeCompare(String(b.it.typeKey || ''), 'zh-CN')
      || String(a.it.metric || '').localeCompare(String(b.it.metric || ''), 'zh-CN'));
}

function confidenceRank(it) {
  const rank = { '高可信': 4, '中可信': 3, '低可信': 2, '仅参考': 1 };
  return Number(it.confidenceScore || rank[it.confidence] || 0);
}

function levelRank(level) {
  return level === 'project' ? 2 : level === 'subitem' ? 1 : 0;
}

function miniStat(label, value, tone = 'slate') {
  const cls = tone === 'teal' ? 'border-teal-200 bg-teal-50 text-teal-700'
    : tone === 'red' ? 'border-red-200 bg-red-50 text-red-700'
      : 'border-slate-200 bg-slate-50 text-slate-600';
  return `<span class="inline-flex items-center gap-1 rounded border ${cls} px-2 py-1">
    <span>${esc(label)}</span><span class="font-semibold tabular-nums">${fmt(value)}</span>
  </span>`;
}

function indicatorQualityNotice(rows) {
  if (!rows.length) return '';
  const scarce = rows.filter(({ it }) => Number(it.n || 0) < 3).length;
  const onlyReference = rows.filter(({ it }) => it.confidence === '仅参考').length;
  const outliers = rows.reduce((sum, { it }) => sum + Number(it.outlierCount || 0), 0);
  if (!scarce && !onlyReference && !outliers) return '';
  return `<div class="border-b border-amber-200 bg-amber-50 px-4 py-2.5">
    <div class="flex items-start gap-2 text-xs leading-5 text-amber-800">
      <span class="material-symbols-outlined mt-0.5 text-[16px]">priority_high</span>
      <div class="min-w-0">
        当前口径下 ${fmt(scarce)} 组指标样本少于 3 个，${fmt(onlyReference)} 组仅作参考${outliers ? `，另有 ${fmt(outliers)} 个异常值` : ''}。
        报价决策前建议放宽筛选或补充可用案例。
      </div>
    </div>
  </div>`;
}

function indicatorItem({ it, index }) {
  const scarce = Number(it.n || 0) < 3;
  return `<div class="px-4 py-3 ${scarce ? 'bg-amber-50/20' : 'bg-white'} hover:bg-slate-50">
    <div class="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)_150px_64px] gap-3 items-center">
      <div class="min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="badge ${it.level === 'project' ? 'badge-blue' : 'badge-gray'} shrink-0">${esc(metricScopeLabel(it.level))}</span>
          <div class="font-semibold text-slate-900 truncate" title="${esc(it.metric)}">${esc(metricDisplayName(it.metric))}</div>
        </div>
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
          ${bucketChips(it.typeKey)}
          ${it.category ? `<span class="rounded bg-slate-100 px-1.5 py-0.5">${esc(it.category)}</span>` : ''}
        </div>
      </div>
      ${quartileBand(it)}
      ${sampleQuality(it)}
      <div class="2xl:text-right">
        <button onclick="window.__indicators.drill(${index})" class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-teal-200 text-teal-700 bg-white hover:bg-teal-50">
          <span class="material-symbols-outlined text-[15px]">travel_explore</span>下钻
        </button>
      </div>
    </div>
  </div>`;
}

function metricScopeLabel(level) {
  return level === 'project' ? '项目' : level === 'subitem' ? '分项' : level || '指标';
}

function metricDisplayName(metric = '') {
  return String(metric || '').replace('分项造价占比-', '占比 · ').replace('分项造价-', '金额 · ');
}

function bucketChips(typeKey = '') {
  const parts = String(typeKey || '').split('/').map(v => v.trim()).filter(Boolean);
  if (!parts.length) return '<span class="text-slate-400">未归类</span>';
  return parts.slice(0, 4).map((part, idx) => `<span class="rounded ${idx === 0 ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-600'} px-1.5 py-0.5">${esc(part)}</span>`).join('');
}

function quartileBand(it) {
  return `<div>
    <div class="grid grid-cols-3 gap-1.5">
      ${quartileCell('P25', it.p25, it.metric)}
      ${quartileCell('中位', it.median, it.metric, true)}
      ${quartileCell('P75', it.p75, it.metric)}
    </div>
    <div class="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
      <span>离散度 ${fmt((it.dispersion || 0) * 100)}%</span>
      ${it.outlierCount ? `<span class="text-amber-700">异常 ${fmt(it.outlierCount)} 个</span>` : '<span>无异常值</span>'}
    </div>
  </div>`;
}

function quartileCell(label, value, metric, strong = false) {
  return `<div class="rounded border ${strong ? 'border-teal-200 bg-teal-50' : 'border-slate-200 bg-white'} px-2 py-1.5">
    <div class="text-[11px] ${strong ? 'text-teal-700' : 'text-slate-500'}">${label}</div>
    <div class="mt-0.5 truncate text-right text-sm font-semibold tabular-nums ${strong ? 'text-teal-700' : 'text-slate-800'}">${formatIndicatorValue(metric, value)}</div>
  </div>`;
}

function formatIndicatorValue(metric, value) {
  if (String(metric || '').includes('(%)')) return `${fmt(value)}%`;
  return fmt(value);
}

function sampleQuality(it) {
  const n = Number(it.n || 0);
  const sampleTone = n >= 3 ? 'text-teal-700' : 'text-amber-700';
  return `<div>
    <div class="flex items-center gap-2">
      ${confidenceBadge(it)}
      <span class="text-xs ${sampleTone}">样本 ${fmt(n)}</span>
    </div>
    <div class="mt-2 grid grid-cols-2 gap-1.5">
      ${qualityPill('离散', `${fmt((it.dispersion || 0) * 100)}%`, Number(it.dispersion || 0) > 0.8 ? 'amber' : 'slate')}
      ${qualityPill('异常', `${fmt(it.outlierCount || 0)}个`, it.outlierCount ? 'amber' : 'slate')}
    </div>
  </div>`;
}

function qualityPill(label, value, tone = 'slate') {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-600';
  return `<div class="rounded border ${cls} px-2 py-1">
    <div class="text-[10px] opacity-75">${label}</div>
    <div class="text-xs font-semibold tabular-nums">${esc(value)}</div>
  </div>`;
}

function emptyIndicatorList() {
  return `<div class="px-4 py-12 text-center">
    <div class="mx-auto h-10 w-10 rounded border border-slate-200 bg-slate-50 text-slate-400 flex items-center justify-center">
      <span class="material-symbols-outlined text-[20px]">analytics</span>
    </div>
    <div class="mt-3 font-medium text-slate-700">当前筛选下没有指标</div>
    <div class="mt-1 text-sm text-slate-500">可以先收录项目、确认待检查记录，或放宽顶部筛选条件。</div>
  </div>`;
}

function overview() {
  const rows = overviewRows();
  return `<div class="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
    <div class="xl:col-span-8 card p-0 overflow-hidden self-start">
      <div class="px-4 py-3 border-b border-slate-200 flex items-start gap-3">
        <div class="min-w-0">
          <div class="font-semibold">指标主表</div>
          <div class="mt-1 text-xs text-slate-500">按指标条目查看样本数、四分位区间和可信度，低样本指标默认弱化展示。</div>
        </div>
        <div class="flex-1"></div>
        <div class="hidden 2xl:flex items-center gap-2 text-xs">
          ${miniStat('高可信', rows.filter(r => r.it.confidence === '高可信').length, 'teal')}
          ${miniStat('仅参考', rows.filter(r => r.it.confidence === '仅参考').length, 'red')}
        </div>
      </div>
      ${indicatorQualityNotice(rows)}
      <div class="hidden 2xl:grid grid-cols-[minmax(0,1fr)_minmax(260px,320px)_150px_64px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-medium text-slate-500">
        <div>指标条目</div>
        <div>四分位区间</div>
        <div>样本质量</div>
        <div class="text-right">操作</div>
      </div>
      <div class="overflow-auto scroll-thin max-h-[560px]">
        ${rows.length ? `<div class="divide-y divide-slate-100">${rows.map(indicatorItem).join('')}</div>` : emptyIndicatorList()}
      </div>
    </div>
    <div class="xl:col-span-4 grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-1 gap-4">
      <div class="card p-4">
        <div class="flex items-center justify-between gap-2">
          <div class="font-semibold">样本可信度分布</div>
          <span class="badge badge-gray">${rows.length} 组</span>
        </div>
        <canvas id="confidenceChart" height="180" class="mt-3"></canvas>
      </div>
      <div class="card p-4">
        <div class="font-semibold">年度趋势</div>
        <div class="mt-1 text-xs text-slate-500">按案例收录/报价年份统计中位总造价。</div>
        <canvas id="trendChart" height="180" class="mt-3"></canvas>
      </div>
    </div>
  </div>`;
}

function projectSelect() {
  return `<select onchange="window.__indicators.selectProject(this.value)" class="h-9 rounded border border-slate-300 bg-white px-2 text-sm">
    ${cache.projects.map(p => `<option value="${p.id}" ${state.benchmarkProjectId === p.id ? 'selected' : ''}>${esc(p.name)}${p.status === 'archived' ? '（已收录）' : ''}</option>`).join('')}
  </select>`;
}

function statusBadge(status) {
  const cls = status.tone === 'red' ? 'badge-red' : status.tone === 'blue' ? 'badge-gray' : status.tone === 'green' ? 'badge-green' : 'badge-yellow';
  return `<span class="badge ${cls}">${esc(status.label)}</span>`;
}

function benchmark() {
  const bm = cache.benchmark;
  if (!bm) return `<div class="card p-10 text-center text-slate-400">暂无项目可对标。</div>`;
  return `<div class="space-y-4">
    <div class="card p-4 flex items-center gap-3">
      <div>
        <div class="font-semibold">选择对标项目</div>
        <div class="mt-1 text-xs text-slate-500">自动按类型 / 规模 / 结构匹配同类历史样本。</div>
      </div>
      <div class="flex-1"></div>
      ${projectSelect()}
    </div>
    <div class="grid grid-cols-3 gap-3">
      ${bm.metrics.map(m => metricCard(m)).join('')}
    </div>
    <div class="card p-4">
      <div class="flex items-center gap-2">
        <div class="font-semibold">项目落点</div>
        <span class="badge badge-gray">样本 ${bm.sampleCount}</span>
        <span class="badge badge-gray">${esc(bm.confidence)}</span>
      </div>
      <div class="mt-4 space-y-3">
        ${bm.metrics.map(m => positionBar(m)).join('')}
      </div>
    </div>
    <div class="card p-4">
      <div class="font-semibold">结论摘要</div>
      <p class="mt-2 text-sm leading-6 text-slate-700">${esc(bm.conclusion)}</p>
    </div>
  </div>`;
}

function metricCard(m) {
  return `<div class="card p-4 bg-white">
    <div class="flex items-center justify-between gap-2">
      <div class="text-xs text-slate-500">${esc(m.label)}</div>
      ${statusBadge(m.status)}
    </div>
    <div class="mt-2 text-xl font-semibold tabular-nums">${fmt(m.value)}</div>
    <div class="mt-1 text-xs text-slate-500">同类中位：${fmt(m.indicator?.median)}</div>
  </div>`;
}

function positionBar(m) {
  return `<div>
    <div class="mb-1 flex items-center justify-between text-xs text-slate-500">
      <span>${esc(m.label)}</span>
      <span>P25 ${fmt(m.indicator?.p25)} · P75 ${fmt(m.indicator?.p75)}</span>
    </div>
    <div class="relative h-3 rounded bg-slate-100">
      <div class="absolute left-1/4 top-0 h-3 w-1/2 rounded bg-teal-100"></div>
      <div class="absolute top-[-3px] h-5 w-1.5 rounded bg-teal-700" style="left:${m.status.percentile}%"></div>
    </div>
  </div>`;
}

function deviation() {
  const bm = cache.benchmark;
  if (!bm) return `<div class="card p-10 text-center text-slate-400">暂无项目可分析。</div>`;
  const rows = bm.deviations.slice(0, 8);
  return `<div class="grid grid-cols-12 gap-4">
    <div class="col-span-5 card p-4">
      <div class="font-semibold">偏差来源 Top 5</div>
      <div class="mt-1 text-xs text-slate-500">按“当前项目分项金额 - 同类中位金额”排序。</div>
      <div class="mt-4 space-y-3">
        ${rows.slice(0, 5).map(d => deviationBar(d)).join('') || `<div class="py-8 text-center text-slate-400">暂无偏差数据</div>`}
      </div>
    </div>
    <div class="col-span-7 card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200 flex items-center gap-3">
        <div>
          <div class="font-semibold">分项对比明细</div>
          <div class="mt-1 text-xs text-slate-500">用于解释“高在哪里 / 低在哪里”。</div>
        </div>
        <div class="flex-1"></div>
        ${projectSelect()}
      </div>
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-slate-500"><tr><th class="px-3 py-2">分项</th><th class="px-2 text-right">本项目</th><th class="px-2 text-right">同类中位</th><th class="px-2 text-right">偏差</th><th class="px-2 text-right">占比</th></tr></thead>
        <tbody>
          ${rows.map(d => `<tr class="border-b border-slate-100">
            <td class="px-3 py-2">${esc(d.category)}</td>
            <td class="px-2 text-right tabular-nums">${fmtMoney(d.amount)}</td>
            <td class="px-2 text-right tabular-nums">${fmtMoney(d.median)}</td>
            <td class="px-2 text-right tabular-nums ${d.delta >= 0 ? 'text-red-600' : 'text-teal-700'}">${d.delta >= 0 ? '+' : ''}${fmtMoney(d.delta)}</td>
            <td class="px-2 text-right tabular-nums">${fmt(d.ratio)}%</td>
          </tr>`).join('') || `<tr><td colspan="5" class="py-10 text-center text-slate-400">暂无分项数据</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

function deviationBar(d) {
  const width = Math.max(6, Math.min(100, Math.abs(d.delta) / Math.max(Math.abs(d.amount), Math.abs(d.median), 1) * 100));
  return `<div>
    <div class="mb-1 flex items-center justify-between text-xs">
      <span class="font-medium text-slate-700">${esc(d.category)}</span>
      <span class="${d.delta >= 0 ? 'text-red-600' : 'text-teal-700'}">${d.delta >= 0 ? '+' : ''}${fmtMoney(d.delta)}</span>
    </div>
    <div class="h-2 rounded bg-slate-100"><div class="h-2 rounded ${d.delta >= 0 ? 'bg-red-400' : 'bg-teal-500'}" style="width:${width}%"></div></div>
  </div>`;
}

function estimateView() {
  const est = cache.estimate || {};
  return `<div class="grid grid-cols-12 gap-4">
    <div class="col-span-4 card p-4">
      <div class="font-semibold">快速估算输入</div>
      <div class="mt-1 text-xs text-slate-500">沿用顶部筛选条件作为估算口径。</div>
      <div class="mt-4 space-y-3">
        <label class="block text-xs font-medium text-slate-500">一句话描述项目
          <textarea id="estimatePrompt" rows="3" class="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm" placeholder="例如：新建 5 万吨/日 AAO 污水厂，占地 4 公顷"></textarea>
        </label>
        <button onclick="window.__indicators.parseEstimate()" class="h-9 w-full rounded border border-teal-300 bg-teal-50 text-sm text-teal-700 inline-flex items-center justify-center gap-1">
          <span class="material-symbols-outlined text-[16px]">auto_awesome</span>AI 提取估算参数
        </button>
        <label class="block text-xs font-medium text-slate-500">建筑面积（㎡）
          <input value="${esc(state.estimate.area)}" oninput="window.__indicators.updateEstimate('area', this.value)" type="number" step="0.01" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm tabular-nums" />
        </label>
        <label class="block text-xs font-medium text-slate-500">日处理量（万m³/d）
          <input value="${esc(state.estimate.dailyCapacity)}" oninput="window.__indicators.updateEstimate('dailyCapacity', this.value)" type="number" step="0.01" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm tabular-nums" />
        </label>
      </div>
    </div>
    <div class="col-span-8 grid grid-cols-2 gap-4">
      ${estimateCard('按单方造价估算', est.byArea, est.areaInd)}
      ${estimateCard('按单水造价估算', est.byWater, est.waterInd)}
      <div class="col-span-2 card p-4">
        <div class="flex items-center justify-between gap-3">
          <div class="font-semibold">估算说明</div>
          <button onclick="window.__indicators.explainEstimate()" class="px-2.5 py-1.5 text-xs rounded border border-teal-300 bg-teal-50 text-teal-700 inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[15px]">auto_awesome</span>AI 解读指标
          </button>
        </div>
        <p class="mt-2 text-sm leading-6 text-slate-600">估算区间使用同类历史样本的 P25 / 中位数 / P75 生成。样本数不足或顶部筛选过窄时，请放宽筛选后再用于报价决策。</p>
      </div>
    </div>
  </div>`;
}

function showAiIndicatorExplain() {
  const result = explainIndicators({ estimate: cache.estimate, filters: state.filters });
  openModal('AI 指标解读', `
    <div class="space-y-3 text-sm">
      <div class="rounded border border-teal-200 bg-teal-50 p-3 text-teal-900 whitespace-pre-line">${esc(result.summary)}</div>
      ${(result.warnings || []).length ? `<div class="rounded border border-amber-200 bg-amber-50 p-3 text-amber-800">${result.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="text-xs text-slate-500">参考解读基于当前筛选和案例记录，案例不足时只能作为趋势提示。</div>
    </div>
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">知道了</button>`);
}

function estimateCard(title, data, indicator) {
  return `<div class="card p-4">
    <div class="flex items-center justify-between">
      <div class="font-semibold">${title}</div>
      ${indicator ? confidenceBadge(indicator) : '<span class="badge badge-gray">无样本</span>'}
    </div>
    ${data ? `<div class="mt-4 grid grid-cols-3 gap-2 text-center">
      <div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="text-xs text-slate-500">保守低值</div><div class="mt-1 font-semibold tabular-nums">${fmtMoney(data.low)}</div></div>
      <div class="rounded border border-teal-200 bg-teal-50 p-3"><div class="text-xs text-teal-700">推荐中值</div><div class="mt-1 font-semibold tabular-nums text-teal-700">${fmtMoney(data.mid)}</div></div>
      <div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="text-xs text-slate-500">高值边界</div><div class="mt-1 font-semibold tabular-nums">${fmtMoney(data.high)}</div></div>
    </div><div class="mt-3 text-xs text-slate-500">参考样本 ${data.n} 个</div>` : `<div class="py-10 text-center text-slate-400">请输入面积/日处理量，并确认当前筛选下有可用指标。</div>`}
  </div>`;
}

function samplesView() {
  const samples = filteredSamples();
  const official = cache.facts.length;
  const candidate = cache.candidates.length;
  const low = [...cache.facts, ...cache.candidates].filter(s => s.quality?.level === '低可信').length;
  return `<div class="space-y-4">
    <div class="grid grid-cols-4 gap-3">
      ${sampleMetric('可用案例', official, '条')}
      ${sampleMetric('待检查记录', candidate, '条')}
      ${sampleMetric('低可信', low, '条')}
      ${sampleMetric('质量报告', cache.reports.length, '份')}
    </div>
    <div class="card p-4">
      <div class="flex items-end gap-3">
        <label class="text-xs font-medium text-slate-500">项目
          <select onchange="window.__indicators.sampleFilter('projectId', this.value)" class="mt-1 h-9 w-56 rounded border border-slate-300 bg-white px-2 text-sm">
            <option value="">全部项目</option>
            ${cache.projects.map(p => `<option value="${p.id}" ${state.sample.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>
        <label class="text-xs font-medium text-slate-500">来源
          <select onchange="window.__indicators.sampleFilter('sourceType', this.value)" class="mt-1 h-9 w-40 rounded border border-slate-300 bg-white px-2 text-sm">
            ${['', 'excel', 'current_boq', 'version', 'archived_project'].map(v => `<option value="${v}" ${state.sample.sourceType === v ? 'selected' : ''}>${v || '全部来源'}</option>`).join('')}
          </select>
        </label>
        <label class="text-xs font-medium text-slate-500">质量
          <select onchange="window.__indicators.sampleFilter('quality', this.value)" class="mt-1 h-9 w-40 rounded border border-slate-300 bg-white px-2 text-sm">
            ${['', '可用', '需复核', '低可信'].map(v => `<option value="${v}" ${state.sample.quality === v ? 'selected' : ''}>${v || '全部质量'}</option>`).join('')}
          </select>
        </label>
        <div class="flex-1"></div>
        <button onclick="window.__indicators.promoteVisible()" class="h-9 px-3 text-sm rounded border border-teal-600 text-teal-700 bg-white hover:bg-teal-50">确认当前记录可用</button>
      </div>
    </div>
    <div class="card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200">
        <div class="font-semibold">数据来源明细</div>
        <div class="mt-1 text-xs text-slate-500">可用案例参与默认参考；待检查记录确认后才会进入参考。</div>
      </div>
      <div class="max-h-[540px] overflow-auto scroll-thin">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-slate-50 text-left text-slate-500">
            <tr><th class="py-2 px-3">状态</th><th class="px-2">类型</th><th class="px-2">项目</th><th class="px-2">来源</th><th class="px-2">内容</th><th class="px-2">质量</th><th class="px-2 text-right">时间</th><th class="px-3 text-right">操作</th></tr>
          </thead>
          <tbody>
            ${samples.length ? samples.map(s => sampleRow(s)).join('') : `<tr><td colspan="8" class="py-12 text-center text-slate-400">当前筛选下没有样本。</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function filteredSamples() {
  return [...cache.facts, ...cache.candidates]
    .filter(s => !state.sample.projectId || s.projectId === state.sample.projectId)
    .filter(s => !state.sample.sourceType || s.sourceType === state.sample.sourceType)
    .filter(s => !state.sample.quality || s.quality?.level === state.sample.quality)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function sampleMetric(label, value, unit) {
  return `<div class="card p-4">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-2 text-xl font-semibold tabular-nums text-slate-900">${fmt(value)}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
  </div>`;
}

function sampleRow(s) {
  const project = cache.projects.find(p => p.id === s.projectId);
  const label = s.factType === 'project_cost'
    ? `${esc(s.payload?.name || project?.name || '项目造价')} · ${fmtMoney(s.payload?.totalCost || 0)}`
    : s.factType === 'category_cost'
      ? `${esc(s.payload?.category || '分项')} · ${fmtMoney(s.payload?.amount || 0)}`
      : `${esc(s.payload?.name || '清单项')} · ${fmtMoney(s.payload?.amount || 0)}`;
  return `<tr class="border-b border-slate-100 hover:bg-slate-50">
    <td class="py-2 px-3"><span class="badge ${s.status === 'formal' ? 'badge-green' : 'badge-yellow'}">${s.status === 'formal' ? '正式' : '候选'}</span></td>
    <td class="px-2 text-slate-600">${esc(s.factType)}</td>
    <td class="px-2">${esc(project?.name || '-')}</td>
    <td class="px-2 text-slate-500">${esc(s.sourceType)}</td>
    <td class="px-2 max-w-[320px] truncate" title="${label.replace(/"/g, '&quot;')}">${label}</td>
    <td class="px-2"><span class="badge ${s.quality?.level === '低可信' ? 'badge-red' : s.quality?.level === '需复核' ? 'badge-yellow' : 'badge-gray'}">${esc(s.quality?.level || '-')}</span></td>
    <td class="px-2 text-right text-slate-500 tabular-nums">${esc(formatTime(s.createdAt))}</td>
    <td class="px-3 text-right whitespace-nowrap">
      <button onclick="window.__indicators.lineage('${s.id}')" class="text-xs text-slate-600 hover:underline">来源</button>
      ${s.status === 'candidate' ? `<button onclick="window.__indicators.promote('${s.id}')" class="ml-2 text-xs text-teal-700 hover:underline">确认可用</button>` : ''}
      ${s.quality?.issues?.includes('missing_price') ? `<button onclick="window.__indicators.repair('${s.id}','price')" class="ml-2 text-xs text-amber-700 hover:underline">补单价</button>` : ''}
      ${s.quality?.issues?.includes('unmatched_quota') ? `<button onclick="window.__indicators.repair('${s.id}','quota')" class="ml-2 text-xs text-blue-700 hover:underline">匹配定额</button>` : ''}
    </td>
  </tr>`;
}

function allSamples() {
  return [...cache.facts, ...cache.candidates];
}

function showLineage(id) {
  const sample = allSamples().find(s => s.id === id);
  if (!sample) return;
  const project = cache.projects.find(p => p.id === sample.projectId);
  const job = cache.jobs.find(j => j.id === sample.jobId);
  const report = cache.reports.find(r => r.jobId === sample.jobId || r.sourceId === sample.sourceId);
  openModal('来源与计算依据', `
    <div class="space-y-4 text-sm">
      <div class="grid grid-cols-2 gap-2">
        ${lineageTile('项目', project?.name || '-')}
        ${lineageTile('事实类型', sample.factType)}
        ${lineageTile('来源', `${sample.sourceType} / ${sample.sourceId || '-'}`)}
        ${lineageTile('质量', sample.quality?.level || '-')}
        ${lineageTile('来源记录 ID', sample.lineageId || '-')}
        ${lineageTile('数据集', sample.datasetKey || '-')}
      </div>
      <div class="rounded border border-slate-200 bg-slate-50 p-3">
        <div class="font-medium text-slate-800">流水线任务</div>
        <div class="mt-2 grid grid-cols-5 gap-2">
          ${(job?.stages || []).map(stage => `<div class="rounded border border-slate-200 bg-white p-2">
            <div class="text-xs text-slate-500">${esc(stage.name)}</div>
            <div class="mt-1 text-xs ${stage.status === 'done' ? 'text-teal-700' : 'text-slate-400'}">${stage.status === 'done' ? '完成' : '待处理'}</div>
          </div>`).join('') || '<div class="col-span-5 text-slate-400">未关联任务</div>'}
        </div>
      </div>
      <div class="rounded border border-slate-200 bg-white p-3">
        <div class="font-medium text-slate-800">质量建议</div>
        <div class="mt-2 space-y-1 text-xs text-slate-600">
          ${(report?.recommendations || sample.quality?.issues || []).map(v => `<div>• ${esc(v)}</div>`).join('') || '<div class="text-slate-400">暂无建议</div>'}
        </div>
      </div>
    </div>
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>`);
}

function lineageTile(label, value) {
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 break-all font-medium text-slate-800">${esc(String(value || '-'))}</div>
  </div>`;
}

async function repairSample(id, action) {
  const sample = allSamples().find(s => s.id === id);
  if (!sample?.projectId) return;
  if (action === 'price') {
    window.__app.state.currentProjectId = sample.projectId;
    window.__app.go('boq', { projectId: sample.projectId });
    setTimeout(() => {
      const app = window.__app;
      if (app) toast('已跳转到清单，请筛选缺单价后补价', 'success');
    }, 100);
    return;
  }
  if (action === 'quota') {
    window.__app.state.currentProjectId = sample.projectId;
    window.__app.go('boq', { projectId: sample.projectId });
    setTimeout(() => toast('已跳转到清单，可在明细区使用关联定额推荐', 'success'), 100);
  }
}

function formatTime(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}

function drawCharts(workspace = document.getElementById('workspace')) {
  if (typeof Chart === 'undefined') return;
  const yearCanvas = workspace.querySelector('#indicatorYearTrendChart');
  if (!yearCanvas) {
    if (chartState.year) {
      chartState.year.destroy();
      chartState.year = null;
    }
    return;
  }
  if (chartState.year) {
    chartState.year.destroy();
    chartState.year = null;
  }
  const entry = selectedIndicator();
  const points = indicatorTrendPoints(entry?.it);
  if (points.length < 2) return;
  yearCanvas.style.height = '150px';
  yearCanvas.style.maxHeight = '150px';
  yearCanvas.parentElement.style.height = '150px';
  yearCanvas.parentElement.style.maxHeight = '150px';
  const labels = points.map(p => p.year);
  const data = points.map(p => p.value);
  chartState.year = new Chart(yearCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#0f766e',
        backgroundColor: '#0f766e',
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
        tension: .3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 120,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          callbacks: { label: ctx => `${formatIndicatorValue(entry?.it?.metric, ctx.raw || 0)} ${unitForMetric(entry?.it?.metric)}` },
        },
      },
      scales: {
        x: { grid: { color: '#f1f5f9' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y: { grid: { color: '#e2e8f0' }, ticks: { callback: v => compactChartNumber(v), color: '#64748b', font: { size: 11 }, maxTicksLimit: 5 } },
      },
    },
  });
}

function indicatorTrendPoints(it) {
  if (!it) return [];
  const sampleProjects = cache.projects.filter(p => (it.sampleProjectIds || []).includes(p.id));
  const projects = sampleProjects.length ? sampleProjects : cache.archived;
  const byYear = {};
  projects.forEach(p => {
    const year = indicatorService.projectDims(p).year;
    const value = projectMetricValue(p, it);
    if (!year || year === '未填写' || !Number.isFinite(value)) return;
    (byYear[year] = byYear[year] || []).push(value);
  });
  return Object.keys(byYear).sort().map(year => {
    const arr = byYear[year].slice().sort((a, b) => a - b);
    return { year, value: arr[Math.floor((arr.length - 1) / 2)] || 0, count: arr.length };
  });
}

function projectMetricValue(project, it) {
  const metric = String(it?.metric || '');
  const total = Number(project.totalCost || 0);
  if (metric.includes('单水造价')) {
    const capacity = Number(project.dailyCapacity || 0);
    return capacity ? total / (capacity * 10000) : NaN;
  }
  if (metric.includes('单方造价')) {
    const area = Number(project.area || project.buildingArea || 0);
    return area ? total / area : NaN;
  }
  if (metric.includes('总造价') && it.level === 'project') return total;
  const fallbackIndex = (it.sampleProjectIds || []).indexOf(project.id);
  const fallback = Array.isArray(it.values) ? Number(it.values[fallbackIndex]) : NaN;
  return Number.isFinite(fallback) ? fallback : NaN;
}

function compactChartNumber(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 10000) return `${fmt(n / 10000)}万`;
  return fmt(n);
}

function drill(it) {
  if (!it) return;
  const samples = cache.projects.filter(p => (it.sampleProjectIds || []).includes(p.id));
  const values = (it.values || []).slice().sort((a, b) => a - b);
  openModal(`下钻：${it.metric}`, `
    <div class="space-y-4 text-sm">
      <div class="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
        数据来源：${it.n} 个有效样本，${it.outlierCount || 0} 个异常样本；可信度为 ${esc(it.confidence)}，离散度 ${fmt((it.dispersion || 0) * 100)}%。
      </div>
      <div>
        <div class="mb-2 font-medium">样本项目</div>
        <ul class="space-y-1">
          ${samples.map(p => `<li class="flex justify-between rounded border border-slate-100 px-3 py-2"><span>${esc(p.name)}</span><span class="tabular-nums text-slate-500">${fmtMoney(p.totalCost || 0)}</span></li>`).join('') || '<li class="text-slate-400">无</li>'}
        </ul>
      </div>
      <div>
        <div class="mb-2 font-medium">分布直方图</div>
        <canvas id="drillChart" height="120"></canvas>
      </div>
    </div>
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">关闭</button>`);
  if (!values.length || typeof Chart === 'undefined') return;
  const bins = 6;
  const min = values[0], max = values[values.length - 1];
  const w = (max - min) / bins || 1;
  const labels = [], data = [];
  for (let i = 0; i < bins; i++) {
    const lo = min + i * w, hi = i === bins - 1 ? max : min + (i + 1) * w;
    labels.push(`${fmt(lo)}~${fmt(hi)}`);
    data.push(values.filter(v => v >= lo && v < (i === bins - 1 ? hi + 1 : hi)).length);
  }
  new Chart(document.getElementById('drillChart'), { type: 'bar', data: { labels, datasets: [{ data, backgroundColor: '#0f766e' }] }, options: { plugins: { legend: { display: false } } } });
}
