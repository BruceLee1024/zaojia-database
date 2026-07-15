// 视图：定额库
import { quotaService } from '../services/quotaService.js?v=6.2';
import { boqService } from '../services/boqService.js?v=6.2';
import { fmtMoney, esc, $, openModal, closeModal, toast } from '../utils/dom.js?v=6.2';
import { exportQuotaTemplate } from '../data/excel.js?v=6.2';
import { hasMissingPrice } from '../utils/costing.js?v=6.2';
import { BREAKDOWN_KEYS, compositionPanelShell, normalizeBreakdown, parseQuotaBreakdownInputValues } from './quotaResourceComposition.js?v=6.2';
import { mountQuotaResourceComposition } from './quotaResourceCompositionPanel.js?v=6.2';

const BREAKDOWN_COLORS = ['bg-blue-600', 'bg-emerald-500', 'bg-cyan-600', 'bg-amber-500', 'bg-purple-500', 'bg-sky-500', 'bg-rose-400'];
const filterState = { keyword: '', category: '', unit: '', priceStatus: '' };
let editorState = { selectedId: '', modalItem: null };
let lastRows = [];

const emptyQuota = () => ({
  id: '',
  category: '',
  name: '',
  feature: '',
  work: '',
  rule: '',
  unit: '',
  priceTotal: 0,
  breakdown: normalizeBreakdown(),
  useBreakdown: false,
  tags: [],
});

function exposeQuotaActions() {
  window.__quota = {
    newItem: () => openQuotaForm(emptyQuota(), 'new'),
    select: id => selectQuota(id),
    edit: () => {
      const it = selectedItem();
      if (it) openQuotaForm(it, 'edit');
    },
    composition: () => {
      const it = selectedItem();
      if (it) openQuotaCompositionModal(it);
    },
    copy: () => copySelectedQuota(),
    addToBoq: () => addSelectedToBoq(),
    remove: id => removeQuota(id),
    save: () => saveFromModal(),
    aiAssist: mode => aiAssistQuotaForm(mode),
    toggleBreakdown: checked => {
      document.getElementById('qf_bd')?.classList.toggle('hidden', !checked);
      updateBreakdownSum();
    },
    updateBreakdownSum,
    clearFilters: () => {
      filterState.keyword = '';
      filterState.category = '';
      filterState.unit = '';
      filterState.priceStatus = '';
      render();
    },
    showMissing: () => {
      filterState.priceStatus = 'missing';
      render();
    },
  };
}

export async function render(workspace = document.getElementById('workspace')) {
  const params = window.__app?.state?.routeParams || {};
  if (params.keyword != null) filterState.keyword = params.keyword;
  if (params.priceStatus != null) filterState.priceStatus = params.priceStatus;
  if (params.selectedId) editorState.selectedId = params.selectedId;
  if (!params.selectedId && Array.isArray(params.quotaItemIds) && params.quotaItemIds[0]) editorState.selectedId = params.quotaItemIds[0];
  const routeNotice = quotaRouteNotice(params);
  const [cats, units, allRows] = await Promise.all([
    quotaService.categories(),
    quotaService.units(),
    quotaService.list(),
  ]);
  exposeQuotaActions();
  workspace.innerHTML = `
    <div class="page-frame h-full min-h-[760px] flex flex-col gap-4">
      <section class="rounded-lg border border-slate-200 bg-white px-4 py-4 shrink-0">
        <div class="flex items-center gap-4">
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-xl font-semibold text-slate-950">我的定额库</h1>
              <span class="text-slate-300">/</span>
              <span class="text-sm font-medium text-slate-500">价格参考 · 常用定额整理</span>
            </div>
            <div class="mt-1 text-xs text-slate-500">维护自己的常用价格、项目特征、计算规则和人材机组成。</div>
          </div>
          <div class="flex-1"></div>
          <button id="btnImport" class="h-10 px-4 text-sm brand-bg text-white flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[18px]">upload</span>导入 Excel
          </button>
          <button onclick="window.__quota.newItem()" class="h-10 px-4 text-sm bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[18px]">add</span>新增定额
          </button>
          <button id="btnTpl" class="h-10 px-4 text-sm border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[18px]">download</span>下载模板
          </button>
        </div>

        ${routeNotice ? `<div role="status" class="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">${esc(routeNotice)}</div>` : ''}

        <div class="mt-4 flex items-center gap-2">
          <div class="relative flex-1 min-w-[320px]">
            <input id="qKw" value="${esc(filterState.keyword)}" placeholder="搜索清单名称 / 项目特征 / 关键词..."
              class="h-10 w-full border border-slate-300 bg-white pl-10 pr-3 text-sm" />
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[19px]">search</span>
          </div>
          <select id="qCat" class="h-10 w-36 border border-slate-300 bg-white px-2 text-sm">
            <option value="">全部分类</option>
            ${cats.map(c => `<option value="${esc(c)}" ${filterState.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
          <select id="qUnit" class="h-10 w-32 border border-slate-300 bg-white px-2 text-sm">
            <option value="">全部单位</option>
            ${units.map(u => `<option value="${esc(u)}" ${filterState.unit === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}
          </select>
          <select id="qPrice" class="h-10 w-36 border border-slate-300 bg-white px-2 text-sm">
            <option value="">价格状态</option>
            <option value="priced" ${filterState.priceStatus === 'priced' ? 'selected' : ''}>已有单价</option>
            <option value="missing" ${filterState.priceStatus === 'missing' ? 'selected' : ''}>缺单价</option>
          </select>
          <button onclick="window.__quota.clearFilters()" class="h-10 px-3 text-sm border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 flex items-center gap-1">
            <span class="material-symbols-outlined text-[17px]">filter_alt_off</span>清空
          </button>
        </div>
      </section>

      <div id="quotaKpis" class="grid grid-cols-3 gap-4 shrink-0">${kpiStrip(allRows)}</div>

      <div class="grid grid-cols-[minmax(0,1fr)_400px] gap-4 flex-1 min-h-0">
        <section class="rounded-lg border border-slate-200 bg-white overflow-hidden flex flex-col min-w-0">
          <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between shrink-0">
            <div>
              <div class="font-semibold text-slate-900">定额条目</div>
              <div id="qCount" class="mt-1 text-xs text-slate-500">加载中...</div>
            </div>
            <button onclick="window.__quota.showMissing()" class="px-3 py-1.5 text-xs rounded border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100">查看缺单价</button>
          </div>
          <div class="overflow-auto scroll-thin flex-1 min-h-0">
            <table class="w-full text-sm table-fixed">
              <thead>
                <tr class="text-left border-b">
                  <th class="py-2.5 px-3 w-36">分类</th>
                  <th class="px-3 w-52">清单名称</th>
                  <th class="px-3">项目特征</th>
                  <th class="px-3 w-16">单位</th>
                  <th class="px-3 w-28 text-right">综合单价(元)</th>
                  <th class="px-3 w-24 text-center">状态</th>
                </tr>
              </thead>
              <tbody id="qList"></tbody>
            </table>
          </div>
          <div id="qPager" class="px-4 py-3 border-t border-slate-200 bg-white shrink-0"></div>
        </section>

        <aside id="quotaInspector" class="rounded-lg border border-slate-200 bg-white overflow-hidden min-w-0"></aside>
      </div>

      <section id="quotaBottom" class="grid grid-cols-3 gap-4 shrink-0"></section>
    </div>
  `;

  $('#qKw').oninput = e => { filterState.keyword = e.target.value; renderList(); };
  $('#qCat').onchange = e => { filterState.category = e.target.value; renderList(); };
  $('#qUnit').onchange = e => { filterState.unit = e.target.value; renderList(); };
  $('#qPrice').onchange = e => { filterState.priceStatus = e.target.value; renderList(); };
  $('#btnImport').onclick = importExcel;
  $('#btnTpl').onclick = exportQuotaTemplate;
  await renderList();
}

export function quotaRouteNotice(params = {}) {
  if (params.healthReason !== 'pending-resource-updates') return '';
  const count = Math.max(0, Number(params.affectedCount) || 0);
  return `来自“资源健康”：${count} 条定额的材料/设备价格或元数据已变更，请打开人材机组成对比并确认刷新快照。`;
}

async function renderList() {
  const [rows, allRows] = await Promise.all([quotaService.list(filterState), quotaService.list()]);
  lastRows = rows;
  if (!rows.some(row => row.id === editorState.selectedId)) {
    editorState.selectedId = rows[0]?.id || '';
  }

  document.getElementById('quotaKpis').innerHTML = kpiStrip(allRows);
  document.getElementById('qCount').textContent = `显示 ${rows.length} / ${allRows.length} 条，最多展示前 500 条`;
  document.getElementById('qList').innerHTML = quotaRows(rows);
  document.getElementById('qPager').innerHTML = pager(rows);
  document.getElementById('quotaInspector').innerHTML = inspector(selectedItem());
  document.getElementById('quotaBottom').innerHTML = bottomPanels(allRows);
}

function quotaRows(rows) {
  const visible = rows.slice(0, 500);
  if (!visible.length) {
    return `<tr><td colspan="6" class="py-12 text-center text-slate-400">没有匹配的定额条目。可调整筛选条件，或点击「导入 Excel」上传定额库。</td></tr>`;
  }
  return visible.map(it => {
    const active = editorState.selectedId === it.id;
    const missing = hasMissingPrice(it.priceTotal);
    return `
      <tr class="border-b border-slate-100 cursor-pointer ${active ? 'bg-teal-50/80 shadow-[inset_3px_0_0_#0f766e]' : 'hover:bg-slate-50'}" onclick="window.__quota.select('${it.id}')">
        <td class="py-2.5 px-3"><span class="badge badge-blue">${esc(it.category || '未分类')}</span></td>
        <td class="px-3 font-semibold text-slate-800 truncate" title="${esc(it.name)}">${esc(it.name)}</td>
        <td class="px-3 text-slate-600 truncate" title="${esc(it.feature || '')}">${esc(it.feature || '-')}</td>
        <td class="px-3 font-medium text-slate-700">${esc(it.unit || '-')}</td>
        <td class="px-3 text-right tabular-nums text-slate-900">${missing ? '-' : fmtMoney(it.priceTotal)}</td>
        <td class="px-3 text-center">${priceBadge(it)}</td>
      </tr>
    `;
  }).join('');
}

function pager(rows) {
  return `
    <div class="flex items-center gap-3 text-xs text-slate-500">
      <span>共 ${rows.length} 条</span>
      <span class="rounded border border-slate-200 bg-slate-50 px-2 py-1">20 条/页</span>
      <div class="flex-1"></div>
      <button class="h-7 w-7 rounded border border-slate-200 text-slate-400" disabled>‹</button>
      <span class="h-7 w-7 rounded bg-teal-700 text-white flex items-center justify-center">1</span>
      <button class="h-7 w-7 rounded border border-slate-200 bg-white text-slate-600">2</button>
      <button class="h-7 w-7 rounded border border-slate-200 bg-white text-slate-600">3</button>
      <span>...</span>
      <button class="h-7 w-7 rounded border border-slate-200 bg-white text-slate-600">›</button>
      <span>前往</span>
      <span class="h-7 w-10 rounded border border-slate-200 bg-white flex items-center justify-center">1</span>
      <span>页</span>
    </div>
  `;
}

function kpiStrip(rows) {
  const total = rows.length;
  const missing = rows.filter(row => hasMissingPrice(row.priceTotal)).length;
  const priced = total - missing;
  const pricedRate = total ? Math.round(priced / total * 1000) / 10 : 0;
  const missingRate = total ? Math.round(missing / total * 1000) / 10 : 0;
  return `
    ${kpiCard('定额总数', total, '条', 'table_chart', 'text-teal-700', '')}
    ${kpiCard('已有单价', priced, '条', 'paid', 'text-emerald-700', `${pricedRate}%`)}
    ${kpiCard('缺单价', missing, '条', 'warning', 'text-orange-600', `${missingRate}%`)}
  `;
}

function kpiCard(label, value, unit, icon, color, note) {
  return `<div class="rounded-lg border border-slate-200 bg-white px-4 py-3">
    <div class="flex items-start justify-between">
      <div>
        <div class="text-xs font-medium text-slate-500">${label}</div>
        <div class="mt-2 flex items-end gap-2">
          <span class="text-2xl font-semibold tabular-nums text-slate-950">${value}</span>
          <span class="pb-1 text-xs text-slate-500">${unit}</span>
          ${note ? `<span class="pb-1 text-xs font-semibold ${color}">${note}</span>` : ''}
        </div>
      </div>
      <span class="icon-surface icon-surface-slate ${color}">
        <span class="material-symbols-outlined icon-kpi">${icon}</span>
      </span>
    </div>
  </div>`;
}

function inspector(it) {
  if (!it) {
    return `<div class="h-full flex items-center justify-center text-center p-8">
      <div>
        <div class="mx-auto mb-3 h-12 w-12 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center">
          <span class="material-symbols-outlined text-[26px]">fact_check</span>
        </div>
        <div class="font-semibold text-slate-700">选择定额查看明细</div>
        <div class="mt-1 text-sm text-slate-500">从左侧列表选择一条定额，或点击新增创建定额。</div>
      </div>
    </div>`;
  }

  const missing = hasMissingPrice(it.priceTotal);
  const rows = breakdownRows(it);
  return `
    <div class="h-full flex flex-col">
      <div class="px-4 py-4 border-b border-slate-200 shrink-0">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs font-semibold text-teal-700">质量提醒</div>
            <h2 class="mt-2 text-xl font-semibold leading-7 text-slate-950">${esc(it.name || '未命名定额')}</h2>
            <div class="mt-2 flex flex-wrap gap-2">
              <span class="badge badge-blue">${esc(it.category || '未分类')}</span>
              ${priceBadge(it)}
            </div>
          </div>
          <button onclick="window.__quota.remove('${it.id}')" class="h-8 w-8 rounded border border-slate-200 text-slate-400 hover:bg-red-50 hover:text-red-600" title="删除">
            <span class="material-symbols-outlined text-[18px]">delete</span>
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto scroll-thin p-4 space-y-4">
        <div class="grid grid-cols-3 divide-x divide-slate-200 rounded-lg border border-slate-200 bg-slate-50">
          ${detailMetric('单位', esc(it.unit || '-'))}
          ${detailMetric('综合单价', missing ? '-' : fmtMoney(it.priceTotal))}
          ${detailMetric('价格状态', missing ? '缺单价' : '已定价')}
        </div>

        ${detailBlock('项目特征', it.feature || '未填写项目特征。')}
        ${detailBlock('工作内容', it.work || '未填写工作内容。')}
        ${detailBlock('计算规则', it.rule || '按设计图示或当前定额口径计算。')}

        <section>
          <div class="mb-3 flex items-center justify-between">
            <div class="font-semibold text-slate-800">价格组成（元 / ${esc(it.unit || '单位')}）</div>
            <div class="text-xs text-slate-500">合计 ${missing ? '-' : fmtMoney(it.priceTotal)}</div>
          </div>
          <div class="space-y-3">
            ${rows.map((row, index) => breakdownBar(row, index)).join('')}
          </div>
        </section>
      </div>

      <div class="px-4 py-4 border-t border-slate-200 bg-white shrink-0">
        <div class="grid grid-cols-2 gap-2">
          <button onclick="window.__quota.edit()" class="h-10 text-sm brand-bg text-white flex items-center justify-center gap-1.5">
            <span class="material-symbols-outlined text-[18px]">edit</span>编辑定额
          </button>
          <button onclick="window.__quota.composition()" class="h-10 text-sm border border-slate-300 bg-white text-slate-700 flex items-center justify-center gap-1.5 hover:bg-slate-50">
            <span class="material-symbols-outlined text-[18px]">inventory_2</span>资源组成
          </button>
          <button onclick="window.__quota.copy()" class="h-10 text-sm border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 flex items-center justify-center gap-1.5">
            <span class="material-symbols-outlined text-[18px]">content_copy</span>复制
          </button>
          <button onclick="window.__quota.addToBoq()" class="h-10 text-sm border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 flex items-center justify-center gap-1.5">
            <span class="material-symbols-outlined text-[18px]">playlist_add</span>加入清单
          </button>
        </div>
        ${missing ? `<div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
          <div class="flex items-center gap-2 font-semibold"><span class="material-symbols-outlined text-[18px]">warning</span>价格提醒</div>
          <div class="mt-1 text-xs leading-5">该定额缺少综合单价，加入报价会按 0 计价，建议先补价。</div>
        </div>` : ''}
      </div>
    </div>
  `;
}

function detailMetric(label, value) {
  return `<div class="px-3 py-3">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-base font-semibold tabular-nums text-slate-900">${value}</div>
  </div>`;
}

function detailBlock(title, value) {
  return `<section>
    <div class="mb-1 text-sm font-semibold text-slate-800">${title}</div>
    <div class="text-sm leading-6 text-slate-600">${esc(value)}</div>
  </section>`;
}

function breakdownRows(it) {
  const price = Number(it.priceTotal || 0);
  const base = it.breakdown || {};
  const sum = BREAKDOWN_KEYS.reduce((total, key) => total + Number(base[key] || 0), 0);
  const source = it.useBreakdown && sum > 0
    ? base
    : { 人工: price * 0.24, 材料: price * 0.1, 机械: price * 0.52, 管理费: price * 0.09, 利润: price * 0.03, 风险: price * 0.02 };
  const total = BREAKDOWN_KEYS.reduce((acc, key) => acc + Number(source[key] || 0), 0) || 1;
  return BREAKDOWN_KEYS.map(key => ({
    key,
    value: Number(source[key] || 0),
    ratio: Number(source[key] || 0) / total,
  }));
}

function breakdownBar(row, index) {
  return `<div class="grid grid-cols-[56px_minmax(0,1fr)_72px_52px] items-center gap-2 text-xs">
    <div class="font-medium text-slate-600">${row.key}</div>
    <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
      <div class="h-full rounded-full ${BREAKDOWN_COLORS[index]}" style="width:${Math.max(3, Math.round(row.ratio * 100))}%"></div>
    </div>
    <div class="text-right tabular-nums text-slate-700">${row.value.toFixed(2)}</div>
    <div class="text-right tabular-nums text-slate-400">${Math.round(row.ratio * 100)}%</div>
  </div>`;
}

function bottomPanels(rows) {
  const missingRows = rows.filter(row => hasMissingPrice(row.priceTotal));
  const unitMissing = rows.filter(row => !row.unit);
  const unclassified = rows.filter(row => !row.category || row.category === '未分类');
  const recent = [...rows].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 3);
  return `
    <div class="rounded-lg border border-slate-200 bg-white p-4">
      <div class="mb-3 flex items-center justify-between">
        <div class="font-semibold text-slate-900">最近导入</div>
        <button class="text-xs text-slate-500 hover:text-teal-700">更多 ›</button>
      </div>
      <div class="space-y-2">${recent.length ? recent.map(row => bottomRow(row.name, row.category || '未分类', row.updatedAt ? new Date(row.updatedAt).toLocaleDateString('zh-CN') : '本地数据', 'badge-green', '成功')).join('') : emptyBottom('暂无导入记录')}</div>
    </div>
    <div class="rounded-lg border border-slate-200 bg-white p-4">
      <div class="mb-3 flex items-center justify-between">
        <div class="font-semibold text-slate-900">质量提醒（近 7 天）</div>
        <button onclick="window.__quota.showMissing()" class="text-xs text-slate-500 hover:text-teal-700">更多 ›</button>
      </div>
      <div class="space-y-2">
        ${qualityRow('缺单价条目', missingRows.length, 'warning', 'text-red-600')}
        ${qualityRow('单位缺失条目', unitMissing.length, 'warning', 'text-amber-600')}
        ${qualityRow('分类未识别条目', unclassified.length, 'description', 'text-orange-600')}
      </div>
    </div>
    <div class="rounded-lg border border-slate-200 bg-white p-4">
      <div class="mb-3 flex items-center justify-between">
        <div class="font-semibold text-slate-900">缺单价待补（共 ${missingRows.length} 条）</div>
        <button onclick="window.__quota.showMissing()" class="text-xs text-slate-500 hover:text-teal-700">更多 ›</button>
      </div>
      <div class="space-y-2">${missingRows.slice(0, 3).map(row => bottomRow(row.name, row.category || '未分类', row.unit || '-', 'badge-yellow', '待补')).join('') || emptyBottom('暂无缺单价条目')}</div>
    </div>
  `;
}

function bottomRow(title, meta, extra, badgeCls, badgeText) {
  return `<div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-sm">
    <div class="font-medium text-slate-700 truncate" title="${esc(title)}">${esc(title || '-')}</div>
    <div class="text-xs text-slate-500 truncate max-w-[120px]">${esc(meta || '-')}</div>
    <span class="badge ${badgeCls}">${esc(badgeText)}</span>
  </div>`;
}

function qualityRow(label, value, icon, cls) {
  return `<div class="flex items-center gap-2 text-sm">
    <span class="material-symbols-outlined text-[17px] ${cls}">${icon}</span>
    <span class="text-slate-700">${label}</span>
    <div class="flex-1"></div>
    <span class="font-semibold tabular-nums ${cls}">${value}</span>
    <span class="text-xs text-slate-500">条</span>
  </div>`;
}

function emptyBottom(text) {
  return `<div class="py-5 text-center text-sm text-slate-400">${esc(text)}</div>`;
}

function priceBadge(it) {
  return hasMissingPrice(it.priceTotal)
    ? '<span class="badge badge-red">缺单价</span>'
    : '<span class="badge badge-green">已定价</span>';
}

function selectedItem() {
  return lastRows.find(row => row.id === editorState.selectedId) || null;
}

async function selectQuota(id) {
  editorState.selectedId = id;
  document.getElementById('qList').innerHTML = quotaRows(lastRows);
  document.getElementById('quotaInspector').innerHTML = inspector(selectedItem());
}

async function removeQuota(id) {
  if (!confirm('确定删除该定额？未被引用时可直接删除。')) return;
  let usage;
  try {
    usage = await quotaService.remove(id);
  } catch (err) {
    if (err?.code !== 'QUOTA_IN_USE') throw err;
    const detail = `项目清单 ${err.usage.projectLineCount} 条、清单库 ${err.usage.libraryItemCount} 条正在引用。强制删除会保留项目当前单价，但标记这些行“关联定额已删除”；清单库会解除关联。确定继续？`;
    if (!confirm(detail)) return;
    usage = await quotaService.remove(id, { force: true });
  }
  if (editorState.selectedId === id) editorState.selectedId = '';
  await renderList();
  toast(usage.total ? `已删除，已处理 ${usage.total} 处引用` : '已删除');
}

function openQuotaForm(item, mode = 'edit') {
  const draft = {
    ...emptyQuota(),
    ...item,
    id: mode === 'copy' ? '' : item.id,
    name: mode === 'copy' ? `${item.name || '未命名定额'} 副本` : item.name,
    breakdown: normalizeBreakdown(item.breakdown),
    tags: [...(item.tags || [])],
  };
  editorState.modalItem = draft;
  const title = mode === 'new' ? '新增定额' : mode === 'copy' ? '复制为新定额' : '编辑定额';
  openModal(title, quotaForm(draft), `
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border border-slate-300 bg-white text-slate-700 rounded">取消</button>
    <button onclick="window.__quota.save()" class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存定额</button>
  `);
  updateBreakdownSum();
  mountQuotaResourceComposition(draft, { onApplied: syncAppliedCompositionToForm, getBaseBreakdown: captureQuotaFormBreakdown });
}

function openQuotaCompositionModal(item) {
  const quota = { ...item, breakdown: normalizeBreakdown(item.breakdown) };
  openModal('资源组成', `<div class="text-sm text-slate-700">${compositionPanelShell(quota)}</div>`, `
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700">关闭</button>
  `);
  mountQuotaResourceComposition(quota, { onApplied: async () => { await renderList(); } });
}

function syncAppliedCompositionToForm(updated) {
  editorState.modalItem = { ...(editorState.modalItem || {}), ...updated, breakdown: normalizeBreakdown(updated.breakdown) };
  const useBreakdown = document.getElementById('qf_usebd');
  if (!useBreakdown) return;
  useBreakdown.checked = true;
  document.getElementById('qf_bd')?.classList.remove('hidden');
  document.getElementById('qf_price').value = updated.priceTotal || 0;
  BREAKDOWN_KEYS.forEach(key => {
    const input = document.querySelector(`#qf_bd input[data-bd="${key}"]`);
    if (input) input.value = updated.breakdown?.[key] || 0;
  });
  updateBreakdownSum();
}

function captureQuotaFormBreakdown() {
  const rawValues = {};
  BREAKDOWN_KEYS.forEach(key => {
    const input = document.querySelector(`#qf_bd input[data-bd="${key}"]`);
    rawValues[key] = input?.value ?? '';
  });
  return parseQuotaBreakdownInputValues(rawValues);
}

function quotaForm(it) {
  const b = it.breakdown || {};
  return `
    <div class="space-y-4 text-sm text-slate-700">
      <section class="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2 font-semibold text-teal-950">
              <span class="material-symbols-outlined text-[18px] text-teal-700" aria-hidden="true">auto_awesome</span>
              AI 辅助录入
            </div>
            <div class="mt-1 text-xs text-teal-800/80">根据清单名称、项目特征和综合单价，补全分类、单位、标签、工作内容、计算规则和人材机拆分。</div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button type="button" onclick="window.__quota.aiAssist('fill')" class="h-8 px-3 text-xs font-medium brand-bg text-white flex items-center gap-1">
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">magic_button</span>AI 补全
            </button>
            <button type="button" onclick="window.__quota.aiAssist('breakdown')" class="h-8 px-3 text-xs font-medium border border-teal-300 bg-white text-teal-800 hover:bg-teal-50 flex items-center gap-1">
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">account_tree</span>拆分价格
            </button>
          </div>
        </div>
      </section>

      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <div class="mb-3 font-semibold text-slate-900">基础信息</div>
        <div class="grid grid-cols-4 gap-3">
          <label class="block">
            <span class="text-xs font-medium text-slate-500">分类</span>
            <input id="qf_cat" class="mt-1 h-10 w-full border bg-slate-50 px-3 text-sm" value="${esc(it.category)}" />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">单位</span>
            <input id="qf_unit" class="mt-1 h-10 w-full border bg-slate-50 px-3 text-sm" value="${esc(it.unit)}" />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">综合单价 <span class="text-red-500">*</span></span>
            <input id="qf_price" type="number" step="0.01" class="mt-1 h-10 w-full border bg-slate-50 px-3 text-sm tabular-nums" value="${it.priceTotal || 0}" />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">关键词标签</span>
            <input id="qf_tags" class="mt-1 h-10 w-full border bg-slate-50 px-3 text-sm" placeholder="土方, 人工, 水池" value="${esc((it.tags || []).join(','))}" />
          </label>
        </div>
      </section>

      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <div class="mb-3 font-semibold text-slate-900">定额内容</div>
        <div class="grid grid-cols-2 gap-3">
          <label class="block col-span-2">
            <span class="text-xs font-medium text-slate-500">清单名称 <span class="text-red-500">*</span></span>
            <input id="qf_name" class="mt-1 h-10 w-full border bg-slate-50 px-3 text-sm" value="${esc(it.name)}" />
          </label>
          <label class="block col-span-2">
            <span class="text-xs font-medium text-slate-500">项目特征</span>
            <textarea id="qf_feature" rows="3" class="mt-1 w-full border bg-slate-50 px-3 py-2 text-sm leading-6 resize-y">${esc(it.feature || '')}</textarea>
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">工作内容</span>
            <textarea id="qf_work" rows="4" class="mt-1 w-full border bg-slate-50 px-3 py-2 text-sm leading-6 resize-y">${esc(it.work || '')}</textarea>
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">工程量计算规则</span>
            <textarea id="qf_rule" rows="4" class="mt-1 w-full border bg-slate-50 px-3 py-2 text-sm leading-6 resize-y">${esc(it.rule || '')}</textarea>
          </label>
        </div>
      </section>

      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <div class="mb-3 flex items-start justify-between gap-4">
          <div>
            <div class="font-semibold text-slate-900">人材机拆分</div>
            <div class="mt-1 text-xs text-slate-500">启用后，右侧详情会按拆分项展示价格组成。</div>
          </div>
          <label class="flex items-center gap-3 cursor-pointer select-none">
            <span class="text-sm font-medium text-slate-700">启用拆分</span>
            <input id="qf_usebd" type="checkbox" onchange="window.__quota.toggleBreakdown(this.checked)" class="peer sr-only" ${it.useBreakdown ? 'checked' : ''}/>
            <span class="relative h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-teal-700 after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-5"></span>
          </label>
        </div>
        <div id="qf_bd" class="${it.useBreakdown ? '' : 'hidden'}">
          <div class="grid grid-cols-4 gap-3">
            ${BREAKDOWN_KEYS.map(key => `
              <label class="block rounded-lg border border-slate-200 bg-slate-50 p-3">
                <span class="text-xs font-medium text-slate-500">${key}</span>
                <input data-bd="${key}" oninput="window.__quota.updateBreakdownSum()" type="number" step="0.01" class="mt-1 h-9 w-full border bg-white px-2 text-sm tabular-nums" value="${b[key] || 0}" />
              </label>
            `).join('')}
          </div>
          <div class="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600" id="qf_bdsum">分项合计：¥0</div>
        </div>
      </section>
      ${compositionPanelShell(it)}
    </div>
  `;
}

function inferQuotaIntent(it) {
  const text = `${it.name || ''} ${it.feature || ''} ${(it.tags || []).join(' ')}`.toLowerCase();
  const has = (...words) => words.some(word => text.includes(word.toLowerCase()));
  if (has('防水', '防腐', '涂料', '卷材')) return 'waterproof';
  if (has('土方', '挖土', '开挖', '回填', '运土', '弃土')) return 'earthwork';
  if (has('钢筋')) return 'rebar';
  if (has('混凝土', '砼', '垫层', '池壁', '底板')) return 'concrete';
  if (has('管道', '管线', '电缆', '桥架', '阀门')) return 'pipe';
  if (has('设备', '水泵', '泵', '格栅', '曝气', '风机', '搅拌机')) return 'equipment';
  return 'default';
}

function suggestedUnit(intent, it) {
  const text = `${it.name || ''} ${it.feature || ''}`;
  if (/(钢筋)/.test(text)) return 't';
  if (/(防水|防腐|涂料|模板|抹灰|找平|铺贴)/.test(text)) return 'm²';
  if (/(管道|管线|电缆|桥架|桩|栏杆)/.test(text)) return 'm';
  if (/(设备|水泵|泵|阀门|格栅|风机|搅拌机)/.test(text)) return '台';
  if (/(土方|开挖|回填|混凝土|砼|垫层|砂石|碎石)/.test(text)) return 'm³';
  if (intent === 'equipment') return '台';
  if (intent === 'pipe') return 'm';
  if (intent === 'waterproof') return 'm²';
  return it.unit || 'm³';
}

function suggestedCategory(intent) {
  const categories = {
    earthwork: '土石方与支护',
    concrete: '混凝土与钢筋',
    rebar: '混凝土与钢筋',
    waterproof: '防水防腐',
    pipe: '安装管线',
    equipment: '安装设备',
    default: '其他',
  };
  return categories[intent] || categories.default;
}

function suggestedWork(intent) {
  const works = {
    earthwork: '施工准备、测量放线、机械或人工开挖、修坡清底、场内堆放或装车外运。',
    concrete: '基层清理、混凝土运输、浇筑、振捣、养护、缺陷修补及成品保护。',
    rebar: '钢筋调直、切断、弯制、绑扎或焊接、安装定位、保护层控制。',
    waterproof: '基层清理、阴阳角及节点处理、涂刷或铺贴防水层、收头密封、成品保护。',
    pipe: '材料转运、测量下料、管道安装连接、支架固定、试压或通水检查。',
    equipment: '开箱检查、基础复核、吊装就位、找平找正、固定连接及单机检查。',
    default: '施工准备、材料转运、现场安装或施工、质量检查、成品保护。',
  };
  return works[intent] || works.default;
}

function suggestedRule(unit) {
  if (unit === 'm³') return '按设计图示尺寸以体积计算。';
  if (unit === 'm²') return '按设计图示尺寸以面积计算，扣除规则按当前定额口径执行。';
  if (unit === 'm') return '按设计图示中心线长度计算。';
  if (unit === 't') return '按设计图示钢筋理论重量计算。';
  if (unit === '台' || unit === '套') return `按设计图示设备数量以${unit}计算。`;
  return `按设计图示工程量以${unit || '计量单位'}计算。`;
}

function suggestedTags(intent, it) {
  const base = {
    earthwork: ['土方', '开挖', '机械'],
    concrete: ['混凝土', '水池', '浇筑'],
    rebar: ['钢筋', '绑扎', '水池'],
    waterproof: ['防水', '防腐', '水池'],
    pipe: ['管道', '安装', '试压'],
    equipment: ['设备', '安装', '调试'],
    default: ['常用定额', '污水处理'],
  }[intent] || [];
  return [...new Set([...(it.tags || []), ...base])].slice(0, 6);
}

function breakdownSuggestion(total, intent) {
  const ratios = {
    earthwork: { 人工: 0.1, 材料: 0, 设备: 0, 机械: 0.75, 管理费: 0.06, 利润: 0.06, 风险: 0.03 },
    concrete: { 人工: 0.18, 材料: 0.55, 设备: 0, 机械: 0.12, 管理费: 0.06, 利润: 0.06, 风险: 0.03 },
    rebar: { 人工: 0.22, 材料: 0.58, 设备: 0, 机械: 0.05, 管理费: 0.06, 利润: 0.06, 风险: 0.03 },
    waterproof: { 人工: 0.25, 材料: 0.55, 设备: 0, 机械: 0.04, 管理费: 0.07, 利润: 0.06, 风险: 0.03 },
    pipe: { 人工: 0.18, 材料: 0.58, 设备: 0, 机械: 0.1, 管理费: 0.06, 利润: 0.06, 风险: 0.02 },
    equipment: { 人工: 0.15, 材料: 0, 设备: 0.65, 机械: 0.08, 管理费: 0.05, 利润: 0.05, 风险: 0.02 },
    default: { 人工: 0.2, 材料: 0.45, 设备: 0, 机械: 0.2, 管理费: 0.06, 利润: 0.06, 风险: 0.03 },
  }[intent] || {};
  const result = {};
  let used = 0;
  BREAKDOWN_KEYS.forEach((key, index) => {
    if (index === BREAKDOWN_KEYS.length - 1) {
      result[key] = Math.max(0, Math.round((total - used) * 100) / 100);
      return;
    }
    result[key] = Math.round((total * (ratios[key] || 0)) * 100) / 100;
    used += result[key];
  });
  return result;
}

function buildQuotaSuggestion(it) {
  const intent = inferQuotaIntent(it);
  const unit = suggestedUnit(intent, it);
  return {
    category: suggestedCategory(intent),
    unit,
    tags: suggestedTags(intent, it),
    work: suggestedWork(intent),
    rule: suggestedRule(unit),
    breakdown: breakdownSuggestion(parseFloat(it.priceTotal) || 0, intent),
  };
}

function setFieldValue(id, value, overwrite = false) {
  const el = document.getElementById(id);
  if (!el || value == null || value === '') return false;
  if (!overwrite && `${el.value || ''}`.trim()) return false;
  el.value = value;
  return true;
}

function applyQuotaSuggestion(suggestion, mode) {
  const overwrite = mode === 'breakdown';
  let changed = 0;
  changed += setFieldValue('qf_cat', suggestion.category, false) ? 1 : 0;
  changed += setFieldValue('qf_unit', suggestion.unit, false) ? 1 : 0;
  changed += setFieldValue('qf_work', suggestion.work, false) ? 1 : 0;
  changed += setFieldValue('qf_rule', suggestion.rule, false) ? 1 : 0;

  const tagInput = document.getElementById('qf_tags');
  if (tagInput) {
    const merged = [...new Set([...(tagInput.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean), ...(suggestion.tags || [])])];
    if (merged.length && merged.join(', ') !== tagInput.value) {
      tagInput.value = merged.join(', ');
      changed += 1;
    }
  }

  const total = parseFloat(document.getElementById('qf_price')?.value) || 0;
  const shouldApplyBreakdown = total > 0 && (mode === 'breakdown' || mode === 'fill');
  if (shouldApplyBreakdown) {
    const checkbox = document.getElementById('qf_usebd');
    if (checkbox) checkbox.checked = true;
    window.__quota.toggleBreakdown(true);
    BREAKDOWN_KEYS.forEach(key => {
      const input = document.querySelector(`#qf_bd input[data-bd="${key}"]`);
      if (input && (overwrite || !parseFloat(input.value))) {
        input.value = suggestion.breakdown[key] || 0;
        changed += 1;
      }
    });
    updateBreakdownSum();
  }
  return changed;
}

function aiAssistQuotaForm(mode = 'fill') {
  const it = syncModalDraft();
  if (!it.name && !it.feature) {
    toast('先填写清单名称或项目特征，AI 才能判断定额类型。', 'error');
    document.getElementById('qf_name')?.focus();
    return;
  }
  const suggestion = buildQuotaSuggestion(it);
  const changed = applyQuotaSuggestion(suggestion, mode);
  syncModalDraft();
  if (!changed) {
    toast('当前字段已经比较完整，可直接检查后保存。');
    return;
  }
  toast(mode === 'breakdown' ? '已按综合单价生成价格拆分' : 'AI 已补全空白字段，请检查后保存', 'success');
}

function syncModalDraft() {
  const it = editorState.modalItem || emptyQuota();
  const val = id => document.getElementById(id)?.value;
  it.category = (val('qf_cat') || '').trim();
  it.unit = (val('qf_unit') || '').trim();
  it.priceTotal = parseFloat(val('qf_price')) || 0;
  it.tags = (val('qf_tags') || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  it.name = (val('qf_name') || '').trim();
  it.feature = (val('qf_feature') || '').trim();
  it.work = (val('qf_work') || '').trim();
  it.rule = (val('qf_rule') || '').trim();
  it.useBreakdown = !!document.getElementById('qf_usebd')?.checked;
  const breakdown = { ...emptyQuota().breakdown };
  document.querySelectorAll('#qf_bd input[data-bd]').forEach(el => {
    breakdown[el.dataset.bd] = parseFloat(el.value) || 0;
  });
  it.breakdown = breakdown;
  editorState.modalItem = it;
  return it;
}

function updateBreakdownSum() {
  const el = document.getElementById('qf_bdsum');
  if (!el) return;
  const sum = Array.from(document.querySelectorAll('#qf_bd input[data-bd]')).reduce((total, input) => total + (parseFloat(input.value) || 0), 0);
  el.textContent = '分项合计：¥' + sum.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

async function saveFromModal() {
  const it = syncModalDraft();
  if (!it.name) {
    toast('请填写清单名称', 'error');
    return;
  }
  const saved = await quotaService.save({
    id: it.id || null,
    category: it.category || '',
    name: it.name,
    feature: it.feature || '',
    work: it.work || '',
    rule: it.rule || '',
    unit: it.unit || '',
    priceTotal: parseFloat(it.priceTotal) || 0,
    breakdown: it.breakdown || emptyQuota().breakdown,
    useBreakdown: !!it.useBreakdown,
    tags: it.tags || [],
  });
  editorState.selectedId = saved.id;
  editorState.modalItem = null;
  closeModal();
  toast('已保存', 'success');
  await renderList();
}

function copySelectedQuota() {
  const it = selectedItem();
  if (!it) return;
  openQuotaForm(it, 'copy');
}

async function addSelectedToBoq() {
  const it = selectedItem();
  const projectId = window.__app?.state?.currentProjectId;
  if (!it) return;
  if (!projectId) {
    toast('先去「我的项目」新建/选择项目，或进入「工程量清单」选择项目后再加入清单。', 'error');
    return;
  }
  await boqService.addFromQuota(projectId, it.id, 0);
  toast('已加入当前项目清单', 'success');
}

async function importExcel() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const r = await quotaService.importFromExcel(file);
      localStorage.setItem('quota_last_import', JSON.stringify({
        fileName: file.name,
        importedAt: new Date().toISOString(),
        success: r.success,
        missingPrice: r.missingPrice,
      }));
      showImportResult(r);
      toast(`导入完成：成功 ${r.success} / 失败 ${r.failed} / 缺单价 ${r.missingPrice}`, r.failed ? 'error' : 'success');
      await render();
    } catch (err) {
      toast('导入失败：' + err.message, 'error');
    }
  };
  input.click();
}

function showImportResult(r) {
  openModal('Excel 导入结果', `
    <div class="grid grid-cols-4 gap-2 text-sm mb-4">
      ${summaryBox('总行数', r.total)}
      ${summaryBox('成功', r.success)}
      ${summaryBox('失败', r.failed)}
      ${summaryBox('缺单价', r.missingPrice)}
    </div>
    <div class="text-sm text-gray-600 mb-2">新增 ${r.added} 条，更新 ${r.updated} 条，跳过 ${r.skipped} 条。</div>
    ${(r.warnings || []).length ? `
      <div class="border border-amber-200 bg-amber-50 rounded p-3 max-h-56 overflow-auto scroll-thin">
        <div class="font-medium text-amber-800 mb-1">需要注意</div>
        <ul class="list-disc pl-5 text-sm text-amber-800 space-y-1">
          ${r.warnings.slice(0, 30).map(w => `<li>${esc(w)}</li>`).join('')}
        </ul>
        ${r.warnings.length > 30 ? `<div class="text-xs text-amber-700 mt-2">仅显示前 30 条提示。</div>` : ''}
      </div>
    ` : '<div class="text-sm text-gray-500">未发现导入警告。</div>'}
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">知道了</button>`);
}

function summaryBox(label, value) {
  return `<div class="border rounded p-3 bg-white">
    <div class="text-xs text-gray-500">${label}</div>
    <div class="text-xl font-semibold tabular-nums">${value}</div>
  </div>`;
}
