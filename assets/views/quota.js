// 视图：定额库
import { quotaService } from '../services/quotaService.js?v=3.2';
import { fmtMoney, esc, $, openModal, toast } from '../utils/dom.js';
import { exportQuotaTemplate } from '../data/excel.js?v=3.2';
import { hasMissingPrice } from '../utils/costing.js?v=3.2';

const filterState = { keyword: '', category: '', unit: '', priceStatus: '' };
let editorState = { mode: 'empty', item: null, tab: 'base' };
let detailHeight = Number(localStorage.getItem('quota_detail_height') || 320);
const DETAIL_MIN_HEIGHT = 180;

const emptyQuota = () => ({
  id: '',
  category: '',
  name: '',
  feature: '',
  work: '',
  rule: '',
  unit: '',
  priceTotal: 0,
  breakdown: { 人工: 0, 材料: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 },
  useBreakdown: false,
  tags: [],
});

function exposeQuotaActions() {
  window.__quota = {
    newItem: () => {
      editorState = { mode: 'new', item: emptyQuota(), tab: 'base' };
      renderEditor();
    },
    select: id => selectQuota(id),
    remove: id => removeQuota(id),
    tab: id => {
      syncEditorDraft();
      editorState.tab = id;
      renderEditor();
    },
    cancel: () => {
      editorState = { mode: 'empty', item: null, tab: 'base' };
      renderEditor();
    },
    save: () => save(),
    toggleBreakdown: checked => {
      document.getElementById('qf_bd')?.classList.toggle('hidden', !checked);
      syncEditorDraft();
    },
    updateBreakdownSum,
    startResize,
  };
}

function clampDetailHeight(value) {
  const max = Math.max(260, Math.floor(window.innerHeight * 0.7));
  return Math.min(Math.max(value, DETAIL_MIN_HEIGHT), max);
}

function applyDetailHeight() {
  const detail = document.getElementById('quotaDetail');
  const body = document.getElementById('quotaDetailBody');
  if (!detail) return;
  detailHeight = clampDetailHeight(detailHeight);
  detail.style.height = `${detailHeight}px`;
  if (body) body.style.maxHeight = `${Math.max(80, detailHeight - 118)}px`;
  localStorage.setItem('quota_detail_height', String(detailHeight));
}

function startResize(e) {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = detailHeight;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'row-resize';
  const move = ev => {
    detailHeight = clampDetailHeight(startHeight + startY - ev.clientY);
    applyDetailHeight();
  };
  const up = () => {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export async function render() {
  const [cats, units] = await Promise.all([quotaService.categories(), quotaService.units()]);
  exposeQuotaActions();
  document.getElementById('workspace').innerHTML = `
    <div class="h-full min-h-0 flex flex-col gap-3">
      <div class="flex items-center gap-2 bg-white border border-slate-200 rounded-xl p-3 flex-wrap shrink-0">
        <input id="qKw" value="${esc(filterState.keyword)}" placeholder="搜索清单名称 / 项目特征 / 关键词..."
          class="flex-1 min-w-72 border border-gray-300 px-3 py-1.5 text-sm" />
        <select id="qCat" class="border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">全部分类</option>
          ${cats.map(c => `<option ${filterState.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <select id="qUnit" class="border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">全部单位</option>
          ${units.map(u => `<option ${filterState.unit === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}
        </select>
        <select id="qPrice" class="border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">全部价格</option>
          <option value="priced" ${filterState.priceStatus === 'priced' ? 'selected' : ''}>已有单价</option>
          <option value="missing" ${filterState.priceStatus === 'missing' ? 'selected' : ''}>缺失/为 0</option>
        </select>
        <button id="btnImport" class="px-3 py-1.5 text-sm brand-bg text-white">导入 Excel</button>
        <button id="btnNew" onclick="window.__quota.newItem()" class="px-3 py-1.5 text-sm border border-gray-300 bg-white hover:bg-slate-50">+ 新增</button>
        <button id="btnTpl" class="px-3 py-1.5 text-sm border border-gray-300 bg-white hover:bg-slate-50">下载模板</button>
      </div>

      <section class="card flex flex-col overflow-hidden flex-1 min-h-[220px]">
        <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div class="font-semibold text-slate-800">定额条目</div>
            <div class="text-xs text-slate-500 mt-1">选择一条定额后，可在下方直接查看和编辑明细。</div>
          </div>
          <div id="qCount" class="text-xs text-slate-500"></div>
        </div>
        <div class="overflow-auto scroll-thin flex-1 min-h-0">
          <table class="w-full text-sm table-fixed">
            <thead><tr class="text-left text-gray-500 border-b">
              <th class="py-2 px-3 w-44">分类</th>
              <th class="w-72 px-3">清单名称</th>
              <th class="px-3">项目特征</th>
              <th class="w-16 px-3">单位</th>
              <th class="w-24 px-3 text-right">综合单价</th>
              <th class="w-32 px-3 text-right">操作</th>
            </tr></thead>
            <tbody id="qList"></tbody>
          </table>
        </div>
      </section>

      <section id="quotaDetail" class="card shrink-0 overflow-hidden" style="height:${clampDetailHeight(detailHeight)}px"></section>
    </div>
  `;

  $('#qKw').oninput = e => { filterState.keyword = e.target.value; renderList(); };
  $('#qCat').onchange = e => { filterState.category = e.target.value; renderList(); };
  $('#qUnit').onchange = e => { filterState.unit = e.target.value; renderList(); };
  $('#qPrice').onchange = e => { filterState.priceStatus = e.target.value; renderList(); };
  $('#btnImport').onclick = importExcel;
  $('#btnTpl').onclick = exportQuotaTemplate;
  renderList();
}

async function renderList() {
  const rows = await quotaService.list(filterState);
  const tbody = document.getElementById('qList');
  const selectedId = editorState.item?.id;
  document.getElementById('qCount').textContent = `共 ${rows.length} 条`;
  tbody.innerHTML = rows.slice(0, 500).map(it => `
    <tr class="border-b hover:bg-slate-50 cursor-pointer ${selectedId === it.id ? 'bg-teal-50/70' : ''}" data-select="${it.id}" onclick="window.__quota.select('${it.id}')">
      <td class="py-2 px-3"><span class="badge badge-gray">${esc(it.category || '未分类')}</span></td>
      <td class="px-3 font-medium text-slate-800 truncate" title="${esc(it.name)}">${esc(it.name)}</td>
      <td class="px-3 text-gray-600 truncate" title="${esc(it.feature)}">${esc((it.feature || '').slice(0, 90))}</td>
      <td class="px-3">${esc(it.unit || '')}</td>
      <td class="px-3 text-right tabular-nums">
        ${hasMissingPrice(it.priceTotal)
          ? '<span class="badge badge-yellow" title="综合单价为空或为 0，报价会按 0 计">缺单价</span>'
          : fmtMoney(it.priceTotal)}
      </td>
      <td class="px-3 text-right">
        <button class="text-teal-700 hover:underline text-xs" data-edit="${it.id}" onclick="event.stopPropagation();window.__quota.select('${it.id}')">明细</button>
        <button class="text-red-600 hover:underline text-xs ml-2" data-del="${it.id}" onclick="event.stopPropagation();window.__quota.remove('${it.id}')">删除</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="py-10 text-center text-gray-400">没有匹配的定额条目。可调整筛选条件，或点击「导入 Excel」上传定额库。</td></tr>`;

  if (rows.length > 500) {
    tbody.innerHTML += `<tr><td colspan="6" class="py-2 text-center text-xs text-gray-400">仅显示前 500 / ${rows.length} 条</td></tr>`;
  }
  renderEditor();
  applyDetailHeight();
}

async function removeQuota(id) {
  if (!confirm('确定删除？')) return;
  await quotaService.remove(id);
  if (editorState.item?.id === id) editorState = { mode: 'empty', item: null, tab: 'base' };
  await renderList();
  toast('已删除');
}

async function selectQuota(id) {
  const it = await quotaService.get(id);
  if (!it) return;
  editorState = { mode: 'edit', item: it, tab: 'base' };
  await renderList();
}

function renderEditor() {
  const box = document.getElementById('quotaDetail');
  if (!box) return;
  const it = editorState.item;
  if (!it) {
    box.innerHTML = `
      <div class="h-full flex flex-col bg-white">
        <div class="h-2 cursor-row-resize bg-slate-100 hover:bg-teal-100 border-b border-slate-200" onpointerdown="window.__quota.startResize(event)" title="拖动调整明细区高度"></div>
        <div class="flex-1 flex items-center justify-center text-center">
        <div>
          <div class="w-12 h-12 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
            <span class="material-symbols-outlined text-[26px]">fact_check</span>
          </div>
          <div class="font-semibold text-slate-700">选择定额查看明细</div>
          <div class="text-sm text-slate-500 mt-1">从上方列表选择一条定额，或点击“新增”创建定额条目。</div>
        </div>
        </div>
      </div>
    `;
    applyDetailHeight();
    return;
  }

  const b = it.breakdown || {};
  const activeTab = editorState.tab || 'base';
  box.innerHTML = `
    <div class="h-full flex flex-col bg-slate-50">
      <div class="h-2 cursor-row-resize bg-slate-100 hover:bg-teal-100 border-b border-slate-200 shrink-0" onpointerdown="window.__quota.startResize(event)" title="拖动调整明细区高度"></div>
      <div class="px-4 py-3 border-b border-slate-200 bg-white shrink-0">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="font-semibold text-slate-800">${editorState.mode === 'new' ? '新增定额明细' : '定额明细编辑'}</div>
            <div class="text-xs text-slate-500 mt-1">${it.name ? esc(it.name) : '填写基础信息后保存为新的定额条目'}</div>
          </div>
          <div class="flex gap-2">
            <button id="qf_cancel" onclick="window.__quota.cancel()" class="px-3 py-1.5 text-sm border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">取消</button>
            <button id="qf_save" onclick="window.__quota.save()" data-id="${esc(it.id || '')}" class="px-3 py-1.5 text-sm brand-bg text-white">保存</button>
          </div>
        </div>
        <div class="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1">
          ${tabButton('base', '基础信息', activeTab)}
          ${tabButton('content', '定额内容', activeTab)}
          ${tabButton('cost', '人材机拆分', activeTab)}
        </div>
      </div>

      <div id="quotaDetailBody" class="flex-1 overflow-auto scroll-thin p-4">
        ${activeTab === 'base' ? baseTab(it) : ''}
        ${activeTab === 'content' ? contentTab(it) : ''}
        ${activeTab === 'cost' ? costTab(it, b) : ''}
      </div>
    </div>
  `;

  bindEditor();
  applyDetailHeight();
}

function tabButton(id, label, activeTab) {
  return `<button data-tab="${id}" onclick="window.__quota.tab('${id}')" class="px-4 py-1.5 text-sm ${activeTab === id ? 'bg-white text-teal-800 border border-slate-200' : 'text-slate-600 hover:text-slate-900'}">${label}</button>`;
}

function baseTab(it) {
  return `
    <section class="bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-700">
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
  `;
}

function contentTab(it) {
  return `
    <section class="bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-700">
      <div class="grid grid-cols-2 gap-3">
        <label class="block col-span-2">
          <span class="text-xs font-medium text-slate-500">清单名称 <span class="text-red-500">*</span></span>
          <input id="qf_name" class="mt-1 h-10 w-full border bg-slate-50 px-3 text-sm" value="${esc(it.name)}" />
        </label>
        <label class="block col-span-2">
          <span class="text-xs font-medium text-slate-500">项目特征</span>
          <textarea id="qf_feature" rows="3" class="mt-1 w-full border bg-slate-50 px-3 py-2 text-sm leading-6 resize-y">${esc(it.feature)}</textarea>
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
  `;
}

function costTab(it, b) {
  return `
    <section class="bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-700">
      <div class="flex items-start justify-between gap-4 mb-3">
        <div>
          <div class="font-semibold text-slate-800">人材机拆分</div>
          <div class="text-xs text-slate-500 mt-1">启用后可记录人工、材料、机械、管理费、利润和风险构成。</div>
        </div>
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <span class="text-sm font-medium text-slate-700">启用拆分</span>
          <input id="qf_usebd" type="checkbox" onchange="window.__quota.toggleBreakdown(this.checked)" class="peer sr-only" ${it.useBreakdown ? 'checked' : ''}/>
          <span class="relative h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-teal-700 after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-5"></span>
        </label>
      </div>
      <div id="qf_bd" class="${it.useBreakdown ? '' : 'hidden'}">
        <div class="grid grid-cols-6 gap-3">
          ${['人工', '材料', '机械', '管理费', '利润', '风险'].map(k => `
            <label class="block border border-slate-200 rounded-lg bg-slate-50 p-3">
              <span class="text-xs font-medium text-slate-500">${k}</span>
              <input data-bd="${k}" oninput="window.__quota.updateBreakdownSum()" type="number" step="0.01" class="mt-1 h-9 w-full border bg-white px-2 text-sm tabular-nums" value="${b[k] || 0}" />
            </label>
          `).join('')}
        </div>
        <div class="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600" id="qf_bdsum">分项合计：¥${fmtSum(b)}</div>
      </div>
    </section>
  `;
}

function bindEditor() {
}

function syncEditorDraft() {
  if (!editorState.item) return;
  const it = editorState.item;
  const val = id => document.getElementById(id)?.value;
  if (val('qf_cat') != null) it.category = val('qf_cat').trim();
  if (val('qf_unit') != null) it.unit = val('qf_unit').trim();
  if (val('qf_price') != null) it.priceTotal = parseFloat(val('qf_price')) || 0;
  if (val('qf_tags') != null) it.tags = val('qf_tags').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (val('qf_name') != null) it.name = val('qf_name').trim();
  if (val('qf_feature') != null) it.feature = val('qf_feature').trim();
  if (val('qf_work') != null) it.work = val('qf_work').trim();
  if (val('qf_rule') != null) it.rule = val('qf_rule').trim();
  const useBreakdown = document.getElementById('qf_usebd');
  if (useBreakdown) it.useBreakdown = useBreakdown.checked;
  const bdInputs = document.querySelectorAll('#qf_bd input[data-bd]');
  if (bdInputs.length) {
    const breakdown = { ...(it.breakdown || {}) };
    bdInputs.forEach(el => breakdown[el.dataset.bd] = parseFloat(el.value) || 0);
    it.breakdown = breakdown;
  }
}

function updateBreakdownSum() {
  const s = Array.from(document.querySelectorAll('#qf_bd input[data-bd]')).reduce((sum, e) => sum + (parseFloat(e.value) || 0), 0);
  document.getElementById('qf_bdsum').textContent = '分项合计：¥' + s.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function fmtSum(b) {
  return Object.values(b).reduce((a, c) => a + (c || 0), 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

async function save() {
  syncEditorDraft();
  const it = editorState.item || emptyQuota();
  const obj = {
    id: it.id || null,
    category: it.category || '',
    name: it.name || '',
    feature: it.feature || '',
    work: it.work || '',
    rule: it.rule || '',
    unit: it.unit || '',
    priceTotal: parseFloat(it.priceTotal) || 0,
    breakdown: it.breakdown || { 人工: 0, 材料: 0, 机械: 0, 管理费: 0, 利润: 0, 风险: 0 },
    useBreakdown: !!it.useBreakdown,
    tags: it.tags || [],
  };
  if (!obj.name) { toast('请填写清单名称', 'error'); return; }
  const saved = await quotaService.save(obj);
  editorState = { mode: 'edit', item: saved, tab: editorState.tab || 'base' };
  toast('已保存', 'success');
  await renderList();
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
      showImportResult(r);
      toast(`导入完成：成功 ${r.success} / 失败 ${r.failed} / 缺单价 ${r.missingPrice}`, r.failed ? 'error' : 'success');
      render();
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
  `, `<button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">知道了</button>`);
}

function summaryBox(label, value) {
  return `<div class="border rounded p-3 bg-white">
    <div class="text-xs text-gray-500">${label}</div>
    <div class="text-xl font-semibold tabular-nums">${value}</div>
  </div>`;
}
