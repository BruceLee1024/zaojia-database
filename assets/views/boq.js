// 视图：工程量清单
import { projectRepo, quotaRepo, boqRepo } from '../data/repository.js?v=2.8';
import { boqService } from '../services/boqService.js?v=2.8';
import { versionService, defaultVersionName } from '../services/versionService.js?v=2.8';
import { dataEngineService } from '../services/dataEngineService.js?v=2.8';
import { fmtMoney, esc, openModal, closeModal, toast } from '../utils/dom.js';
import { parseExcel, detectRowKind, rowToBOQ, exportBOQExcel } from '../data/excel.js?v=2.8';
import { hasMissingPrice } from '../utils/costing.js?v=2.8';
import { categoryGuess } from '../utils/stats.js';

const boqState = {
  keyword: '',
  priceStatus: '',
  selectedIds: new Set(),
  activeId: '',
};
let searchTimer = null;
let boqDetailHeight = Number(localStorage.getItem('boq_detail_height') || 320);
const BOQ_DETAIL_MIN_HEIGHT = 180;

function clampBoqDetailHeight(value) {
  const max = Math.max(260, Math.floor(window.innerHeight * 0.7));
  return Math.min(Math.max(value, BOQ_DETAIL_MIN_HEIGHT), max);
}

function applyBoqDetailHeight() {
  const detail = document.getElementById('boqDetail');
  const body = document.getElementById('boqDetailBody');
  if (!detail) return;
  boqDetailHeight = clampBoqDetailHeight(boqDetailHeight);
  detail.style.height = `${boqDetailHeight}px`;
  if (body) body.style.maxHeight = `${Math.max(80, boqDetailHeight - 116)}px`;
  localStorage.setItem('boq_detail_height', String(boqDetailHeight));
}

function startBoqResize(e) {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = boqDetailHeight;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'row-resize';
  const move = ev => {
    boqDetailHeight = clampBoqDetailHeight(startHeight + startY - ev.clientY);
    applyBoqDetailHeight();
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
  const projects = await projectRepo.all();
  const proj = projects.find(p => p.id === window.__app.state.currentProjectId) || projects[0];
  if (!proj) {
    document.getElementById('workspace').innerHTML = `<div class="card p-10 text-center text-gray-400">还没有项目，先去 <a class="text-teal-700 underline" onclick="window.__app.go('projects')">新建项目</a></div>`;
    return;
  }
  window.__app.state.currentProjectId = proj.id;

  const boq = await boqService.listByProject(proj.id);
  const filteredBoq = filterLines(boq);
  if (boqState.activeId && !boq.find(b => b.id === boqState.activeId)) boqState.activeId = '';
  const activeLine = boq.find(b => b.id === boqState.activeId) || filteredBoq[0] || null;
  if (!boqState.activeId && activeLine) boqState.activeId = activeLine.id;
  const totalCost = boq.reduce((s, b) => s + (b.amount || 0), 0);
  const missingPriceCount = boq.filter(b => hasMissingPrice(b.unitPrice)).length;
  const selectedCount = boq.filter(b => boqState.selectedIds.has(b.id)).length;
  const selectedTotal = boq.filter(b => boqState.selectedIds.has(b.id)).reduce((s, b) => s + (b.amount || 0), 0);
  const categories = groupByCategory(boq);

  document.getElementById('workspace').innerHTML = `
    <div class="h-full min-h-0 flex flex-col gap-3">
      <section class="card p-4">
        <div class="flex items-center gap-3">
          <div class="text-sm text-slate-500">当前项目</div>
          <select id="projSel" class="h-9 min-w-72 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800">
            ${projects.map(p => `<option value="${p.id}" ${p.id === proj.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
          <div class="flex-1"></div>
          <button id="btnSaveVer" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">保存版本</button>
          <button id="btnVersions" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">版本管理</button>
          <button id="btnExp" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[18px]">download</span>导出报价单
          </button>
        </div>
        <div class="mt-4 grid grid-cols-5 gap-3">
          ${boqMetric('清单条目', boq.length, '条')}
          ${boqMetric('缺单价风险', missingPriceCount, '处', missingPriceCount ? 'text-amber-700' : '')}
          ${boqMetric('选中条目', selectedCount, '条')}
          ${boqMetric('选中合价', fmtMoney(selectedTotal), '')}
          ${boqMetric('项目总造价', fmtMoney(totalCost), '')}
        </div>
      </section>

      <section class="card p-3">
        <div class="flex items-center gap-2 flex-wrap">
          <div class="relative flex-1 min-w-[280px]">
            <span class="material-symbols-outlined pointer-events-none absolute left-3 top-2 text-[18px] text-slate-400">search</span>
            <input id="boqKw" value="${esc(boqState.keyword)}" class="h-9 w-full rounded border border-slate-300 bg-white pl-9 pr-3 text-sm" placeholder="搜索编码 / 清单名称 / 项目特征..." />
          </div>
          <select id="boqPriceStatus" class="h-9 rounded border border-slate-300 bg-white px-2 text-sm">
            <option value="" ${!boqState.priceStatus ? 'selected' : ''}>全部价格</option>
            <option value="missing" ${boqState.priceStatus === 'missing' ? 'selected' : ''}>仅缺单价</option>
            <option value="priced" ${boqState.priceStatus === 'priced' ? 'selected' : ''}>已有单价</option>
          </select>
          <button id="btnAdd" class="h-9 inline-flex items-center gap-1.5 px-3 brand-bg text-white text-sm font-medium">
            <span class="material-symbols-outlined text-[18px]">add</span>添加清单
          </button>
          <button id="btnImportBOQ" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">导入 Excel</button>
          <button id="btnAdj" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">全部调价</button>
          <button id="btnBatchSelected" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50 ${selectedCount ? '' : 'opacity-50'}">选中调价</button>
          <button id="btnClearSelection" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50 ${selectedCount ? '' : 'hidden'}">清除选择</button>
        </div>
      </section>

      <section class="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden flex-1 min-h-[220px]">
        <div class="bg-slate-50 px-4 py-2 border-b border-slate-200 flex items-center justify-between text-sm shrink-0">
          <div class="flex items-center gap-4 text-slate-500">
            <span>显示 ${filteredBoq.length} / ${boq.length} 项</span>
            ${missingPriceCount ? `<button id="btnOnlyMissing" class="text-amber-700 hover:underline">定位缺单价 ${missingPriceCount}</button>` : '<span>无缺单价风险</span>'}
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-500">
            ${categories.slice(0, 3).map(c => `<span class="badge badge-gray">${esc(c.name)} ${fmtMoney(c.amount)}</span>`).join('')}
          </div>
        </div>
        <div class="overflow-auto scroll-thin flex-1 min-h-0">
          <table class="w-full text-sm table-fixed">
            <thead><tr class="text-left border-b border-slate-200 bg-white sticky top-0">
              <th class="py-3 px-3 w-10"><input id="boqSelectAll" type="checkbox" ${filteredBoq.length && filteredBoq.every(b => boqState.selectedIds.has(b.id)) ? 'checked' : ''} /></th>
              <th class="py-3 px-2 w-10">序</th>
              <th class="px-2 w-24">编码</th>
              <th class="w-52 px-2">清单名称</th>
              <th class="px-2">项目特征</th>
              <th class="w-14 px-2 text-center">单位</th>
              <th class="w-24 px-2 text-right">工程量</th>
              <th class="w-28 px-2 text-right">综合单价</th>
              <th class="w-16 px-2 text-right">系数</th>
              <th class="w-32 px-2 text-right">合价</th>
              <th class="w-16 px-2 text-right">操作</th>
            </tr></thead>
            <tbody id="boqList"></tbody>
            <tfoot>
              <tr class="bg-white border-t border-slate-200 font-semibold">
                <td colspan="9" class="px-3 py-4 text-right text-slate-500 uppercase tracking-wider text-xs">项目合计</td>
                <td class="px-3 py-4 text-right tabular-nums text-slate-900 text-lg" id="boqTotal">${fmtMoney(totalCost)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section id="boqDetail" class="card shrink-0 overflow-hidden" style="height:${clampBoqDetailHeight(boqDetailHeight)}px">
        ${detailPanel(activeLine)}
      </section>
    </div>
  `;

  document.getElementById('projSel').onchange = e => { window.__app.state.currentProjectId = e.target.value; render(); };
  document.getElementById('btnAdd').onclick = pickQuota;
  document.getElementById('btnImportBOQ').onclick = () => importBOQExcel(proj.id, boq.length);
  document.getElementById('btnAdj').onclick = batchAdjust;
  document.getElementById('btnBatchSelected').onclick = () => batchAdjust(true);
  document.getElementById('btnClearSelection')?.addEventListener('click', () => { boqState.selectedIds.clear(); render(); });
  document.getElementById('btnOnlyMissing')?.addEventListener('click', () => { boqState.priceStatus = 'missing'; render(); });
  document.getElementById('btnSaveVer').onclick = () => saveVersion(proj.id);
  document.getElementById('btnVersions').onclick = () => manageVersions(proj.id);
  document.getElementById('boqKw').oninput = e => {
    boqState.keyword = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(), 180);
  };
  document.getElementById('boqPriceStatus').onchange = e => { boqState.priceStatus = e.target.value; render(); };
  document.getElementById('boqSelectAll')?.addEventListener('change', e => {
    filteredBoq.forEach(b => e.target.checked ? boqState.selectedIds.add(b.id) : boqState.selectedIds.delete(b.id));
    render();
  });
  document.getElementById('btnExp').onclick = async () => {
    const fresh = await projectRepo.findById(proj.id);
    const lines = await boqService.listByProject(proj.id);
    exportBOQExcel(fresh, lines);
    toast('已导出 Excel 报价单', 'success');
  };

  const tbody = document.getElementById('boqList');
  tbody.innerHTML = filteredBoq.map((b, i) => `
    <tr class="border-b border-slate-100 hover:bg-slate-50/80 ${b.id === boqState.activeId ? 'bg-teal-50/60' : ''}" data-id="${b.id}">
      <td class="px-3 py-2"><input type="checkbox" data-select="${b.id}" ${boqState.selectedIds.has(b.id) ? 'checked' : ''} /></td>
      <td class="px-2 py-2 text-slate-400">${i + 1}</td>
      <td class="px-2"><input class="w-full bg-transparent text-slate-700 border-0 px-0 py-1" value="${esc(b.code || '')}" /></td>
      <td class="px-2 font-medium text-slate-800 cursor-pointer" title="${esc(b.name || '')}" data-open-detail>${esc(b.name)}</td>
      <td class="px-2 text-slate-500 truncate cursor-pointer" title="${esc(b.feature || '')}" data-open-detail>${esc((b.feature || '').slice(0, 60))}</td>
      <td class="px-2 text-center">${esc(b.unit || '')}</td>
      <td class="px-2 text-right tabular-nums"><input type="number" step="0.01" class="w-20 text-right bg-transparent border-0 px-0 py-1" value="${b.qty || 0}" /></td>
      <td class="px-2 text-right tabular-nums">
        <input type="number" step="0.01" class="w-24 text-right bg-transparent border-0 px-0 py-1 ${hasMissingPrice(b.unitPrice) ? 'text-amber-700 font-semibold' : ''}" value="${b.unitPrice || 0}" title="${hasMissingPrice(b.unitPrice) ? '综合单价为空或为 0，合价会按 0 计' : ''}" />
      </td>
      <td class="px-2 text-right"><input type="number" step="0.001" class="w-14 text-right bg-transparent border-0 px-0 py-1" value="${b.factor || 1}" /></td>
      <td class="px-2 text-right tabular-nums font-semibold ${hasMissingPrice(b.unitPrice) ? 'text-amber-700' : 'text-slate-900'}" data-amount>${fmtMoney(b.amount || 0)}</td>
      <td class="px-2 text-right"><button class="text-red-600 hover:underline text-xs" data-del="${b.id}">删除</button></td>
    </tr>
  `).join('') || `<tr><td colspan="11" class="py-20">
    <div class="flex flex-col items-center justify-center text-center">
      <div class="w-64 h-44 mb-6 bg-white border border-slate-200 rounded-xl flex flex-col items-center justify-center gap-4">
          <div class="w-16 h-16 rounded-lg bg-teal-50 flex items-center justify-center text-teal-700">
            <span class="material-symbols-outlined text-[32px]">post_add</span>
          </div>
          <div class="w-3/4 h-2 bg-slate-100 rounded-full"></div>
          <div class="w-1/2 h-2 bg-slate-100 rounded-full"></div>
      </div>
      <div class="text-base font-semibold text-slate-700 mb-2">暂无清单数据</div>
      <div class="text-slate-500 mb-6 max-w-md">当前项目下尚未添加任何工程量清单。可以手动选择定额后填写工程量。</div>
      <button id="btnEmptyAdd" class="inline-flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50 hover:text-teal-700">
        <span class="material-symbols-outlined text-[20px] text-teal-700">add</span>立即添加清单
      </button>
    </div>
  </td></tr>`;

  tbody.querySelectorAll('tr[data-id]').forEach(tr => bindRowEvents(tr, proj.id));
  tbody.querySelectorAll('[data-open-detail]').forEach(el => el.onclick = () => { boqState.activeId = el.closest('tr').dataset.id; render(); });
  tbody.querySelectorAll('[data-select]').forEach(inp => inp.onchange = e => {
    e.target.checked ? boqState.selectedIds.add(e.target.dataset.select) : boqState.selectedIds.delete(e.target.dataset.select);
    render();
  });
  tbody.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (confirm('删除该清单项？')) { await boqService.remove(b.dataset.del); render(); }
  });
  document.getElementById('btnEmptyAdd')?.addEventListener('click', pickQuota);
  document.getElementById('boqResize')?.addEventListener('pointerdown', startBoqResize);
  document.getElementById('detailSave')?.addEventListener('click', () => saveDetail(activeLine?.id));
  document.getElementById('detailDelete')?.addEventListener('click', async () => {
    if (!activeLine || !confirm('删除该清单项？')) return;
    await boqService.remove(activeLine.id);
    boqState.selectedIds.delete(activeLine.id);
    boqState.activeId = '';
    toast('已删除清单项', 'success');
    render();
  });
  applyBoqDetailHeight();
}

function filterLines(lines) {
  const kw = boqState.keyword.trim().toLowerCase();
  return lines.filter(b => {
    if (boqState.priceStatus === 'missing' && !hasMissingPrice(b.unitPrice)) return false;
    if (boqState.priceStatus === 'priced' && hasMissingPrice(b.unitPrice)) return false;
    if (!kw) return true;
    return `${b.code || ''} ${b.name || ''} ${b.feature || ''} ${b.unit || ''}`.toLowerCase().includes(kw);
  });
}

function groupByCategory(lines) {
  const map = {};
  lines.forEach(b => {
    const name = b.majorCategory || b.category || categoryGuess(b.name);
    map[name] = (map[name] || 0) + Number(b.amount || 0);
  });
  return Object.entries(map).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
}

function boqMetric(label, value, suffix = '', cls = '') {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-3">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-lg font-semibold tabular-nums text-slate-900 ${cls}">${value}<span class="ml-1 text-xs font-normal text-slate-500">${suffix}</span></div>
  </div>`;
}

function detailPanel(line) {
  if (!line) {
    return `<div class="h-full flex flex-col bg-white">
      <div id="boqResize" class="h-2 cursor-row-resize bg-slate-100 hover:bg-teal-100 border-b border-slate-200" title="拖动调整明细区高度"></div>
      <div class="flex-1 flex items-center justify-center text-center text-slate-400">
        <div>
          <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded border border-slate-200 bg-slate-50">
            <span class="material-symbols-outlined text-[24px]">receipt_long</span>
          </div>
          <div class="font-medium text-slate-600">未选择清单项</div>
          <div class="mt-1 text-sm">从上方表格选择一行查看和编辑明细。</div>
        </div>
      </div>
    </div>`;
  }
  return `<div class="h-full flex flex-col bg-slate-50">
    <div id="boqResize" class="h-2 cursor-row-resize bg-slate-100 hover:bg-teal-100 border-b border-slate-200 shrink-0" title="拖动调整明细区高度"></div>
    <div class="px-4 py-3 border-b border-slate-200 bg-white shrink-0">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="font-semibold text-slate-800">清单明细编辑</div>
          <div class="mt-1 text-xs text-slate-500 truncate" title="${esc(line.name || '')}">${esc(line.name || '')} ${hasMissingPrice(line.unitPrice) ? '· 缺少综合单价' : ''}</div>
        </div>
        <div class="flex items-center gap-2">
          ${hasMissingPrice(line.unitPrice) ? '<span class="badge badge-yellow">缺单价</span>' : ''}
          <button id="detailDelete" class="px-3 py-1.5 text-sm rounded border border-red-200 text-red-600 hover:bg-red-50">删除</button>
          <button id="detailSave" class="px-3 py-1.5 text-sm rounded brand-bg text-white">保存明细</button>
        </div>
      </div>
    </div>

    <div id="boqDetailBody" class="flex-1 overflow-auto scroll-thin p-4">
      <div class="grid grid-cols-[320px_minmax(0,1fr)] gap-4">
        <section class="bg-white border border-slate-200 rounded-xl p-4">
          <div class="mb-3 font-medium text-slate-800">基础信息</div>
          <div class="space-y-3">
            <label class="block text-xs font-medium text-slate-500">项目编码
              <input id="detailCode" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(line.code || '')}" />
            </label>
            <label class="block text-xs font-medium text-slate-500">单位
              <input id="detailUnit" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(line.unit || '')}" />
            </label>
            <label class="block text-xs font-medium text-slate-500">工程量
              <input id="detailQty" type="number" step="0.01" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm text-right tabular-nums" value="${line.qty || 0}" />
            </label>
            <label class="block text-xs font-medium text-slate-500">综合单价
              <input id="detailUnitPrice" type="number" step="0.01" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm text-right tabular-nums" value="${line.unitPrice || 0}" />
            </label>
            <label class="block text-xs font-medium text-slate-500">调整系数
              <input id="detailFactor" type="number" step="0.001" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm text-right tabular-nums" value="${line.factor || 1}" />
            </label>
          </div>
        </section>

        <section class="bg-white border border-slate-200 rounded-xl p-4">
          <div class="mb-3 font-medium text-slate-800">清单内容</div>
          <div class="grid grid-cols-2 gap-3">
            <label class="col-span-2 block text-xs font-medium text-slate-500">清单名称
              <input id="detailName" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(line.name || '')}" />
            </label>
            <label class="col-span-2 block text-xs font-medium text-slate-500">项目特征
              <textarea id="detailFeature" rows="4" class="mt-1 w-full resize-y rounded border border-slate-300 px-2 py-2 text-sm">${esc(line.feature || '')}</textarea>
            </label>
            <div class="col-span-2 rounded border border-slate-200 bg-slate-50 p-3">
              <div class="text-xs text-slate-500">合价</div>
              <div class="mt-1 text-xl font-semibold tabular-nums text-slate-900">${fmtMoney(line.amount || 0)}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>`;
}

function bindRowEvents(tr, projectId) {
  const id = tr.dataset.id;
  const inputs = tr.querySelectorAll('input');
  const codeInp = inputs[1], qtyInp = inputs[2], priceInp = inputs[3], factorInp = inputs[4];
  const amtCell = tr.querySelector('[data-amount]');

  const refresh = async () => {
    await boqService.update(id, {
      code: codeInp.value,
      qty: parseFloat(qtyInp.value) || 0,
      unitPrice: parseFloat(priceInp.value) || 0,
      factor: parseFloat(factorInp.value) || 1,
    });
    const fresh = await boqRepo.all();
    const b = fresh.find(x => x.id === id);
    if (b) amtCell.textContent = fmtMoney(b.amount || 0);
    // 刷新合计
    const lines = await boqService.listByProject(projectId);
    const total = lines.reduce((s, b) => s + (b.amount || 0), 0);
    const totalCell = document.getElementById('boqTotal');
    if (totalCell) totalCell.textContent = fmtMoney(total);
  };
  codeInp.onchange = refresh;
  qtyInp.onchange = refresh;
  priceInp.onchange = refresh;
  factorInp.onchange = refresh;
}

async function saveDetail(id) {
  if (!id) return;
  await boqService.update(id, {
    code: document.getElementById('detailCode').value,
    name: document.getElementById('detailName').value,
    feature: document.getElementById('detailFeature').value,
    unit: document.getElementById('detailUnit').value,
    qty: parseFloat(document.getElementById('detailQty').value) || 0,
    unitPrice: parseFloat(document.getElementById('detailUnitPrice').value) || 0,
    factor: parseFloat(document.getElementById('detailFactor').value) || 1,
  });
  toast('清单明细已保存', 'success');
  render();
}

async function pickQuota() {
  const items = await quotaRepo.all();
  openModal('选择定额条目', `
    <input id="pickKw" placeholder="搜索清单名称…" class="w-full border rounded px-3 py-2 mb-3" />
    <div class="max-h-[60vh] overflow-auto scroll-thin border rounded">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 sticky top-0"><tr class="text-left text-gray-500">
          <th class="py-2 px-2">分类</th><th class="px-2">清单名称</th><th class="px-2">项目特征</th><th class="px-2 w-14">单位</th><th class="px-2 w-24 text-right">综合单价</th><th class="px-2 w-12"></th>
        </tr></thead>
        <tbody id="pickBody"></tbody>
      </table>
    </div>
  `, `<button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>`);

  const renderChoices = (kw = '') => {
    const rows = items.filter(it => {
      if (!kw) return true;
      return (`${it.name} ${it.feature} ${(it.tags || []).join(' ')}`).toLowerCase().includes(kw.toLowerCase());
    }).slice(0, 300);
    document.getElementById('pickBody').innerHTML = rows.map(it => `
      <tr class="border-b hover:bg-gray-50">
        <td class="py-1.5 px-2"><span class="badge badge-gray">${esc(it.category || '')}</span></td>
        <td class="px-2">${esc(it.name)}</td>
        <td class="px-2 text-gray-500 truncate" title="${esc(it.feature || '')}">${esc((it.feature || '').slice(0, 40))}</td>
        <td class="px-2">${esc(it.unit || '')}</td>
        <td class="px-2 text-right tabular-nums">
          ${hasMissingPrice(it.priceTotal)
            ? '<span class="badge badge-yellow" title="选择后该清单合价会按 0 计">缺单价</span>'
            : fmtMoney(it.priceTotal)}
        </td>
        <td class="px-2 text-right"><button class="text-teal-700 hover:underline text-xs" data-pick="${it.id}">选</button></td>
      </tr>
    `).join('') || `<tr><td colspan="6" class="py-6 text-center text-gray-400">无匹配</td></tr>`;
    document.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => {
      const chosen = items.find(it => it.id === b.dataset.pick);
      if (chosen && hasMissingPrice(chosen.priceTotal) && !confirm('该定额综合单价为空或为 0，加入清单后合价会按 0 计。仍然添加？')) return;
      await boqService.addFromQuota(window.__app.state.currentProjectId, b.dataset.pick, 0);
      closeModal();
      render();
    });
  };
  document.getElementById('pickKw').oninput = e => renderChoices(e.target.value);
  renderChoices();
}

function importBOQExcel(projectId, currentLineCount = 0) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const rows = await parseExcel(file);
      const boqRows = rows
        .filter(row => detectRowKind(row) === 'boq')
        .map(row => rowToBOQ(row, projectId))
        .filter(row => row.name);
      if (!boqRows.length) {
        toast('没有识别到工程量清单表头，请检查 Excel 格式', 'error');
        return;
      }
      const missing = boqRows.filter(row => hasMissingPrice(row.unitPrice)).length;
      const preview = boqRows.slice(0, 5);
      openModal('导入工程量清单', `
        <div class="space-y-4 text-sm">
          <div class="rounded border border-slate-200 bg-slate-50 p-3">
            <div class="font-medium text-slate-800">${esc(file.name)}</div>
            <div class="mt-1 text-slate-500">识别到 ${boqRows.length} 条清单，缺单价 ${missing} 条。当前项目已有 ${currentLineCount} 条清单。</div>
          </div>
          <div>
            <div class="mb-2 font-medium text-slate-700">导入方式</div>
            <label class="mr-4"><input type="radio" name="boq_import_mode" value="append" checked /> 追加到当前清单</label>
            <label><input type="radio" name="boq_import_mode" value="replace" /> 覆盖当前项目清单</label>
          </div>
          <div class="border rounded overflow-hidden">
            <table class="w-full text-xs">
              <thead class="bg-slate-50 text-slate-500"><tr><th class="py-2 px-2 text-left">名称</th><th class="px-2">单位</th><th class="px-2 text-right">工程量</th><th class="px-2 text-right">单价</th></tr></thead>
              <tbody>
                ${preview.map(row => `<tr class="border-t"><td class="py-2 px-2">${esc(row.name)}</td><td class="px-2">${esc(row.unit || '')}</td><td class="px-2 text-right tabular-nums">${row.qty || 0}</td><td class="px-2 text-right tabular-nums">${hasMissingPrice(row.unitPrice) ? '<span class="badge badge-yellow">缺单价</span>' : fmtMoney(row.unitPrice)}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>
          ${missing ? '<div class="text-amber-700 text-xs">提示：综合单价为空或为 0 的清单会按 0 计入合价，导入后请优先补价。</div>' : ''}
        </div>
      `, `
        <button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
        <button id="boq_import_ok" class="px-3 py-1.5 text-sm brand-bg text-white rounded">确认导入</button>
      `);
      document.getElementById('boq_import_ok').onclick = async () => {
        const mode = document.querySelector('input[name="boq_import_mode"]:checked')?.value || 'append';
        if (mode === 'replace' && currentLineCount && !confirm('覆盖会删除当前项目现有清单，但不会删除报价版本。确定覆盖？')) return;
        const result = await boqService.importLines(projectId, boqRows, { mode });
        const engine = await dataEngineService.ingestBOQ(projectId, {
          sourceType: 'excel',
          sourceId: file.name,
        });
        closeModal();
        toast(`导入成功 ${result.success} 条，已生成沉淀候选 ${engine.candidates.length} 条，匹配率 ${Math.round((engine.report.matchRate || 0) * 100)}%`, 'success');
        showImportResult(result, engine);
        boqState.selectedIds.clear();
        boqState.activeId = '';
        render();
      };
    } catch (e) {
      console.error(e);
      toast(`导入失败：${e.message}`, 'error');
    }
  };
  input.click();
}

function showImportResult(result, engine) {
  openModal('导入结果与数据沉淀', `
    <div class="space-y-4 text-sm">
      <div class="grid grid-cols-4 gap-2">
        ${resultMetric('成功导入', result.success, '条')}
        ${resultMetric('缺单价', result.missingPrice, '条')}
        ${resultMetric('匹配定额', result.matchedQuota, '条')}
        ${resultMetric('沉淀候选', engine.candidates.length, '条')}
      </div>
      <div class="rounded border border-slate-200 bg-slate-50 p-3">
        <div class="flex items-center justify-between">
          <div class="font-medium text-slate-800">质量报告：${esc(engine.report.qualityLevel)}</div>
          <span class="badge badge-gray">匹配率 ${Math.round((engine.report.matchRate || 0) * 100)}%</span>
        </div>
        <div class="mt-2 space-y-1 text-xs text-slate-600">
          ${engine.report.issues.length ? engine.report.issues.map(i => `<div>${esc(i.message)}</div>`).join('') : '<div>未发现明显风险，候选样本已写入数据引擎。</div>'}
        </div>
      </div>
      <div class="text-xs text-slate-500">候选样本不会直接参与默认指标统计，可在「指标分析 / 样本池」中查看并提升为正式样本。</div>
    </div>
  `, `<button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">知道了</button>`);
}

function resultMetric(label, value, unit) {
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-lg font-semibold tabular-nums text-slate-900">${value}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
  </div>`;
}

function batchAdjust(selectedOnly = false) {
  const count = selectedOnly ? boqState.selectedIds.size : null;
  if (selectedOnly && !count) {
    toast('请先勾选要调价的清单项', 'error');
    return;
  }
  openModal(selectedOnly ? '选中清单调价' : '批量调价', `
    <div class="space-y-3 text-sm">
      <div class="text-gray-500">${selectedOnly ? `输入调整系数，仅对当前勾选的 ${count} 条清单项生效。` : '输入调整系数，对当前项目所有清单项生效。'}</div>
      <label class="block">调整系数
        <input id="ba_factor" type="number" step="0.001" value="1.08" class="mt-1 w-full border rounded px-2 py-1.5 tabular-nums" />
      </label>
    </div>
  `, `
    <button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
    <button id="ba_ok" class="px-3 py-1.5 text-sm brand-bg text-white rounded">应用</button>
  `);
  document.getElementById('ba_ok').onclick = async () => {
    const f = parseFloat(document.getElementById('ba_factor').value) || 1;
    if (selectedOnly) {
      for (const id of boqState.selectedIds) {
        const all = await boqRepo.all();
        const line = all.find(b => b.id === id);
        if (line && line.projectId === window.__app.state.currentProjectId) {
          await boqService.update(id, { factor: (line.factor || 1) * f });
        }
      }
    } else {
      await boqService.batchAdjust(window.__app.state.currentProjectId, '全部', f);
    }
    closeModal();
    toast('已应用调价', 'success');
    render();
  };
}

function saveVersion(projectId) {
  const name = defaultVersionName();
  openModal('保存报价版本', `
    <div class="space-y-3 text-sm">
      <label class="block">版本名称
        <input id="ver_name" class="mt-1 w-full border rounded px-2 py-1.5" value="${esc(name)}" />
      </label>
      <label class="block">备注
        <textarea id="ver_note" rows="3" class="mt-1 w-full border rounded px-2 py-1.5" placeholder="例如：调整设备单价后提交业主"></textarea>
      </label>
      <div class="text-xs text-gray-500">版本保存为不可变快照；后续修改当前清单不会影响已保存版本。</div>
    </div>
  `, `
    <button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
    <button id="ver_save" class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存版本</button>
  `);
  document.getElementById('ver_save').onclick = async () => {
    const version = await versionService.createFromCurrent(projectId, {
      name: document.getElementById('ver_name').value,
      note: document.getElementById('ver_note').value,
    });
    closeModal();
    toast(`已保存版本：${version.name}，${version.lineCount} 条，${fmtMoney(version.totalCost)}`, 'success');
  };
}

async function manageVersions(projectId) {
  const versions = await versionService.listByProject(projectId);
  openModal('报价版本管理', `
    <div class="space-y-3 text-sm">
      <div class="flex items-center gap-2">
        <select id="ver_left" class="border rounded px-2 py-1.5 flex-1">
          <option value="">选择对比版本 A</option>
          ${versions.map(v => `<option value="${v.id}">${esc(v.name)} · ${fmtMoney(v.totalCost)}</option>`).join('')}
        </select>
        <select id="ver_right" class="border rounded px-2 py-1.5 flex-1">
          <option value="">选择对比版本 B</option>
          ${versions.map(v => `<option value="${v.id}">${esc(v.name)} · ${fmtMoney(v.totalCost)}</option>`).join('')}
        </select>
        <button id="ver_compare" class="px-3 py-1.5 text-sm rounded border border-teal-600 text-teal-700">对比</button>
      </div>
      <div class="border rounded overflow-auto scroll-thin max-h-[56vh]">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 sticky top-0"><tr class="text-left text-gray-500">
            <th class="py-2 px-2">版本</th>
            <th class="px-2">创建时间</th>
            <th class="px-2 text-right">总价</th>
            <th class="px-2 text-right">条数</th>
            <th class="px-2 text-right">缺单价</th>
            <th class="px-2">备注</th>
            <th class="px-2 text-right">操作</th>
          </tr></thead>
          <tbody>
            ${versions.map(v => `
              <tr class="border-b hover:bg-gray-50">
                <td class="py-2 px-2 font-medium">${esc(v.name)}</td>
                <td class="px-2 text-gray-500 tabular-nums">${formatTime(v.createdAt)}</td>
                <td class="px-2 text-right tabular-nums">${fmtMoney(v.totalCost || 0)}</td>
                <td class="px-2 text-right tabular-nums">${v.lineCount || 0}</td>
                <td class="px-2 text-right tabular-nums">${v.missingPriceCount ? `<span class="badge badge-yellow">${v.missingPriceCount}</span>` : '0'}</td>
                <td class="px-2 text-gray-500 truncate" title="${esc(v.note || '')}">${esc(v.note || '-')}</td>
                <td class="px-2 text-right whitespace-nowrap">
                  <button class="text-teal-700 hover:underline text-xs" data-view-ver="${v.id}">查看</button>
                  <button class="text-blue-700 hover:underline text-xs ml-2" data-restore-ver="${v.id}">恢复</button>
                  <button class="text-red-600 hover:underline text-xs ml-2" data-del-ver="${v.id}">删除</button>
                </td>
              </tr>
            `).join('') || `<tr><td colspan="7" class="py-10 text-center text-gray-400">还没有报价版本。点击「保存版本」创建第一个快照。</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `, `<button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">关闭</button>`);

  document.getElementById('ver_compare').onclick = async () => {
    const left = document.getElementById('ver_left').value;
    const right = document.getElementById('ver_right').value;
    if (!left || !right || left === right) { toast('请选择两个不同版本', 'error'); return; }
    const diff = await versionService.compare(left, right);
    showVersionDiff(diff, projectId);
  };
  document.querySelectorAll('[data-view-ver]').forEach(btn => btn.onclick = async () => {
    const version = await versionService.get(btn.dataset.viewVer);
    if (version) viewVersion(version, projectId);
  });
  document.querySelectorAll('[data-restore-ver]').forEach(btn => btn.onclick = async () => {
    const version = await versionService.get(btn.dataset.restoreVer);
    if (!version) return;
    if (!confirm(`恢复「${version.name}」会覆盖当前项目清单，但不会删除任何历史版本。确定恢复？`)) return;
    const result = await versionService.restore(version.id);
    closeModal();
    toast(`已恢复 ${result.restoredCount} 条清单，当前总价 ${fmtMoney(result.totalCost)}`, 'success');
    render();
  });
  document.querySelectorAll('[data-del-ver]').forEach(btn => btn.onclick = async () => {
    if (!confirm('删除该报价版本？此操作不会影响当前清单。')) return;
    await versionService.remove(btn.dataset.delVer);
    toast('已删除版本', 'success');
    manageVersions(projectId);
  });
}

function viewVersion(version, projectId) {
  openModal(`查看版本：${version.name}`, `
    <div class="space-y-3 text-sm">
      <div class="grid grid-cols-4 gap-2">
        ${versionSummary('总价', fmtMoney(version.totalCost || 0))}
        ${versionSummary('清单条数', version.lineCount || 0)}
        ${versionSummary('缺单价', version.missingPriceCount || 0)}
        ${versionSummary('创建时间', formatTime(version.createdAt))}
      </div>
      ${version.note ? `<div class="text-gray-600 border rounded p-2 bg-gray-50">${esc(version.note)}</div>` : ''}
      ${renderLinesTable(version.lines || [])}
    </div>
  `, `
    <button id="ver_back" class="px-3 py-1.5 text-sm border rounded">返回版本管理</button>
    <button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>
  `);
  document.getElementById('ver_back').onclick = () => manageVersions(projectId);
}

function showVersionDiff(diff, projectId) {
  openModal(`版本对比：${diff.left.name} → ${diff.right.name}`, `
    <div class="space-y-4 text-sm">
      <div class="grid grid-cols-4 gap-2">
        ${versionSummary('版本 A', fmtMoney(diff.left.totalCost || 0))}
        ${versionSummary('版本 B', fmtMoney(diff.right.totalCost || 0))}
        ${versionSummary('价差', `${diff.totalDelta >= 0 ? '+' : ''}${fmtMoney(diff.totalDelta)}`)}
        ${versionSummary('变化项', diff.added.length + diff.removed.length + diff.modified.length)}
      </div>
      ${diffSection('新增项', diff.added.map(line => lineRowText(line)))}
      ${diffSection('删除项', diff.removed.map(line => lineRowText(line)))}
      ${diffSection('修改项', diff.modified.map(item => {
        const changes = item.changes.map(c => `${c.label}: ${fmtNumber(c.before)} → ${fmtNumber(c.after)}`).join('；');
        return `${item.right.name}｜${changes}`;
      }))}
    </div>
  `, `
    <button id="ver_diff_back" class="px-3 py-1.5 text-sm border rounded">返回版本管理</button>
    <button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>
  `);
  document.getElementById('ver_diff_back').onclick = () => manageVersions(projectId);
}

function renderLinesTable(lines) {
  return `<div class="border rounded overflow-auto scroll-thin max-h-[48vh]">
    <table class="w-full text-sm table-fixed">
      <thead class="bg-gray-50 sticky top-0"><tr class="text-left text-gray-500">
        <th class="py-2 px-2 w-10">序</th>
        <th class="px-2 w-28">编码</th>
        <th class="px-2 w-52">清单名称</th>
        <th class="px-2">项目特征</th>
        <th class="px-2 w-14">单位</th>
        <th class="px-2 w-20 text-right">工程量</th>
        <th class="px-2 w-24 text-right">单价</th>
        <th class="px-2 w-16 text-right">系数</th>
        <th class="px-2 w-28 text-right">合价</th>
      </tr></thead>
      <tbody>
        ${lines.map((line, i) => `
          <tr class="border-b">
            <td class="py-1.5 px-2 text-gray-400">${i + 1}</td>
            <td class="px-2">${esc(line.code || '')}</td>
            <td class="px-2 font-medium truncate" title="${esc(line.name || '')}">${esc(line.name || '')}</td>
            <td class="px-2 text-gray-500 truncate" title="${esc(line.feature || '')}">${esc(line.feature || '')}</td>
            <td class="px-2">${esc(line.unit || '')}</td>
            <td class="px-2 text-right tabular-nums">${fmtNumber(line.qty)}</td>
            <td class="px-2 text-right tabular-nums">${hasMissingPrice(line.unitPrice) ? '<span class="badge badge-yellow">缺单价</span>' : fmtMoney(line.unitPrice)}</td>
            <td class="px-2 text-right tabular-nums">${fmtNumber(line.factor)}</td>
            <td class="px-2 text-right tabular-nums">${fmtMoney(line.amount || 0)}</td>
          </tr>
        `).join('') || `<tr><td colspan="9" class="py-8 text-center text-gray-400">该版本没有清单项</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function diffSection(title, rows) {
  return `<div>
    <div class="font-medium mb-1">${title}（${rows.length}）</div>
    <div class="border rounded bg-gray-50 max-h-40 overflow-auto scroll-thin">
      ${rows.length ? rows.map(row => `<div class="px-3 py-2 border-b last:border-b-0">${esc(row)}</div>`).join('') : '<div class="px-3 py-4 text-gray-400">无</div>'}
    </div>
  </div>`;
}

function versionSummary(label, value) {
  return `<div class="border rounded p-2 bg-white">
    <div class="text-xs text-gray-500">${label}</div>
    <div class="font-semibold tabular-nums">${value}</div>
  </div>`;
}

function lineRowText(line) {
  return `${line.name || '未命名'}｜${fmtNumber(line.qty)} ${line.unit || ''} × ${fmtMoney(line.unitPrice || 0)} × ${fmtNumber(line.factor)} = ${fmtMoney(line.amount || 0)}`;
}

function formatTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}
