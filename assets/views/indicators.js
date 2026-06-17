// 视图：指标分析
import { indicatorService } from '../services/indicatorService.js?v=3.4';
import { dataEngineService } from '../services/dataEngineService.js?v=3.4';
import { projectRepo, dataFactRepo, dataCandidateRepo, dataQualityReportRepo, dataJobRepo } from '../data/repository.js?v=3.4';
import { fmt, fmtMoney, esc, openModal, toast } from '../utils/dom.js';

const state = {
  tab: 'overview',
  filters: { type: '', scale: '', process: '', structure: '', region: '', year: '' },
  excludeOutliers: false,
  benchmarkProjectId: '',
  estimate: { area: '', dailyCapacity: '' },
  sample: { projectId: '', sourceType: '', quality: '' },
  scope: 'formal',
};

let cache = { indicators: [], projects: [], archived: [], benchmark: null, estimate: null, facts: [], candidates: [], reports: [], jobs: [] };

export async function render() {
  await indicatorService.recompute(scopeOptions());
  cache.projects = await projectRepo.all();
  cache.archived = cache.projects.filter(p => p.status === 'archived');
  [cache.facts, cache.candidates, cache.reports, cache.jobs] = await Promise.all([dataFactRepo.all(), dataCandidateRepo.all(), dataQualityReportRepo.all(), dataJobRepo.all()]);
  cache.indicators = await indicatorService.list(state.filters);
  if (!state.benchmarkProjectId) {
    state.benchmarkProjectId = (cache.projects.find(p => p.status === 'doing') || cache.archived[0] || cache.projects[0] || {}).id || '';
  }
  cache.benchmark = state.benchmarkProjectId ? await indicatorService.benchmarkProject(state.benchmarkProjectId) : null;
  cache.estimate = await indicatorService.estimate(state.filters, state.estimate);

  expose();
  document.getElementById('workspace').innerHTML = `
    <div class="h-full min-h-0 flex flex-col gap-3">
      ${filters()}
      ${summary()}
      <section class="card p-0 flex-1 min-h-0 overflow-hidden">
        <div class="px-4 pt-3 border-b border-slate-200 flex items-center gap-2">
          ${tabButton('overview', '指标总览')}
          ${tabButton('benchmark', '项目对标')}
          ${tabButton('deviation', '偏差分析')}
          ${tabButton('estimate', '快速估算')}
          ${tabButton('samples', '样本池')}
          <div class="flex-1"></div>
          <button onclick="window.__indicators.recompute()" class="mb-2 px-3 py-1.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-50">重算指标</button>
        </div>
        <div class="h-full min-h-0 overflow-auto scroll-thin p-4 pb-12">
          ${state.tab === 'overview' ? overview() : ''}
          ${state.tab === 'benchmark' ? benchmark() : ''}
          ${state.tab === 'deviation' ? deviation() : ''}
          ${state.tab === 'estimate' ? estimateView() : ''}
          ${state.tab === 'samples' ? samplesView() : ''}
        </div>
      </section>
    </div>
  `;
  bindFilters();
  drawCharts();
}

function expose() {
  window.__indicators = {
    tab: async tab => { state.tab = tab; await render(); },
    recompute: async () => { await indicatorService.recompute(scopeOptions()); toast('指标已重算', 'success'); await render(); },
    setScope: async value => { state.scope = value; await render(); },
    drill: idx => drill(cache.indicators[idx]),
    selectProject: async value => { state.benchmarkProjectId = value; await render(); },
    updateEstimate: async (field, value) => { state.estimate[field] = value; await render(); },
    sampleFilter: async (field, value) => { state.sample[field] = value; await render(); },
    promote: async id => { await dataEngineService.promoteCandidates([id]); toast('候选样本已提升为正式事实', 'success'); await render(); },
    lineage: id => showLineage(id),
    repair: async (id, action) => repairSample(id, action),
    promoteVisible: async () => {
      const ids = filteredSamples().filter(s => s.status === 'candidate').map(s => s.id);
      if (!ids.length) return toast('当前筛选下没有候选样本', 'error');
      await dataEngineService.promoteCandidates(ids);
      toast(`已提升 ${ids.length} 条候选样本`, 'success');
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
          <option value="formal" ${state.scope === 'formal' ? 'selected' : ''}>仅正式归档样本</option>
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

function overview() {
  return `<div class="grid grid-cols-12 gap-4">
    <div class="col-span-8 card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200">
        <div class="font-semibold">指标主表</div>
        <div class="mt-1 text-xs text-slate-500">加入样本可信度、离散度和异常值数量，避免小样本指标被误用。</div>
      </div>
      <div class="overflow-auto scroll-thin max-h-[520px]">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 sticky top-0 text-left text-slate-500">
            <tr>
              <th class="px-3 py-2">归类键</th><th class="px-2">指标</th><th class="px-2 text-right">样本</th><th class="px-2 text-right">P25</th><th class="px-2 text-right">中位</th><th class="px-2 text-right">P75</th><th class="px-2 text-right">离散度</th><th class="px-2">可信度</th><th class="px-2"></th>
            </tr>
          </thead>
          <tbody>
            ${cache.indicators.length ? cache.indicators.map((it, i) => `
              <tr class="border-b border-slate-100 hover:bg-slate-50">
                <td class="px-3 py-2 max-w-[220px] truncate" title="${esc(it.typeKey)}">${esc(it.typeKey)}</td>
                <td class="px-2">${esc(it.metric)}<span class="badge badge-gray ml-1">${esc(it.level)}</span></td>
                <td class="px-2 text-right tabular-nums">${it.n}${it.outlierCount ? `<span class="ml-1 text-xs text-amber-600">+${it.outlierCount}异常</span>` : ''}</td>
                <td class="px-2 text-right tabular-nums">${fmt(it.p25)}</td>
                <td class="px-2 text-right tabular-nums font-semibold text-teal-700">${fmt(it.median)}</td>
                <td class="px-2 text-right tabular-nums">${fmt(it.p75)}</td>
                <td class="px-2 text-right tabular-nums">${fmt((it.dispersion || 0) * 100)}%</td>
                <td class="px-2">${confidenceBadge(it)}</td>
                <td class="px-2 text-right"><button onclick="window.__indicators.drill(${i})" class="text-xs text-teal-700 hover:underline">下钻</button></td>
              </tr>
            `).join('') : `<tr><td colspan="9" class="py-12 text-center text-slate-400">当前筛选下没有指标，请先归档项目或放宽筛选条件。</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    <div class="col-span-4 space-y-4">
      <div class="card p-4">
        <div class="font-semibold">样本可信度分布</div>
        <canvas id="confidenceChart" height="180" class="mt-3"></canvas>
      </div>
      <div class="card p-4">
        <div class="font-semibold">年度趋势</div>
        <div class="mt-1 text-xs text-slate-500">按归档/报价年份统计中位总造价。</div>
        <canvas id="trendChart" height="180" class="mt-3"></canvas>
      </div>
    </div>
  </div>`;
}

function projectSelect() {
  return `<select onchange="window.__indicators.selectProject(this.value)" class="h-9 rounded border border-slate-300 bg-white px-2 text-sm">
    ${cache.projects.map(p => `<option value="${p.id}" ${state.benchmarkProjectId === p.id ? 'selected' : ''}>${esc(p.name)}${p.status === 'archived' ? '（已归档）' : ''}</option>`).join('')}
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
        <div class="font-semibold">估算说明</div>
        <p class="mt-2 text-sm leading-6 text-slate-600">估算区间使用同类历史样本的 P25 / 中位数 / P75 生成。样本数不足或顶部筛选过窄时，请放宽筛选后再用于报价决策。</p>
      </div>
    </div>
  </div>`;
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
      ${sampleMetric('正式事实', official, '条')}
      ${sampleMetric('候选样本', candidate, '条')}
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
        <button onclick="window.__indicators.promoteVisible()" class="h-9 px-3 text-sm rounded border border-teal-600 text-teal-700 bg-white hover:bg-teal-50">提升当前候选</button>
      </div>
    </div>
    <div class="card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200">
        <div class="font-semibold">数据来源明细</div>
        <div class="mt-1 text-xs text-slate-500">正式事实参与默认指标统计；候选样本需提升后才进入指标。</div>
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
      <button onclick="window.__indicators.lineage('${s.id}')" class="text-xs text-slate-600 hover:underline">血缘</button>
      ${s.status === 'candidate' ? `<button onclick="window.__indicators.promote('${s.id}')" class="ml-2 text-xs text-teal-700 hover:underline">提升</button>` : ''}
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
  openModal('数据血缘详情', `
    <div class="space-y-4 text-sm">
      <div class="grid grid-cols-2 gap-2">
        ${lineageTile('项目', project?.name || '-')}
        ${lineageTile('事实类型', sample.factType)}
        ${lineageTile('来源', `${sample.sourceType} / ${sample.sourceId || '-'}`)}
        ${lineageTile('质量', sample.quality?.level || '-')}
        ${lineageTile('血缘 ID', sample.lineageId || '-')}
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
  `, `<button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>`);
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

function drawCharts() {
  if (state.tab !== 'overview' || typeof Chart === 'undefined') return;
  const confCanvas = document.getElementById('confidenceChart');
  if (confCanvas) {
    const labels = ['高可信', '中可信', '低可信', '仅参考'];
    const data = labels.map(l => cache.indicators.filter(i => i.confidence === l).length);
    new Chart(confCanvas, { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: ['#0f766e', '#64748b', '#f59e0b', '#ef4444'] }] }, options: { plugins: { legend: { position: 'bottom' } } } });
  }
  const trendCanvas = document.getElementById('trendChart');
  if (trendCanvas) {
    const byYear = {};
    cache.archived.forEach(p => {
      const y = indicatorService.projectDims(p).year;
      if (y && y !== '未填写' && p.totalCost) (byYear[y] = byYear[y] || []).push(Number(p.totalCost));
    });
    const labels = Object.keys(byYear).sort();
    const data = labels.map(y => byYear[y].sort((a, b) => a - b)[Math.floor((byYear[y].length - 1) / 2)]);
    new Chart(trendCanvas, { type: 'line', data: { labels, datasets: [{ data, borderColor: '#0f766e', backgroundColor: 'rgba(15,118,110,.08)', tension: .25, fill: true }] }, options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => fmt(v) } } } } });
  }
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
  `, `<button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">关闭</button>`);
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
