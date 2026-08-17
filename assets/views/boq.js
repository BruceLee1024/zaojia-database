// 视图：工程量清单
import { projectRepo, quotaRepo, boqRepo, boqLibraryRepo, projectBoqQuotaRelationRepo, resourcePriceRepo } from '../data/repository.js?v=6.15';
import { boqService, groupForLine } from '../services/boqService.js?v=6.15';
import { boqLibraryService } from '../services/boqLibraryService.js?v=6.15';
import { projectService } from '../services/projectService.js?v=6.15';
import { versionService, defaultVersionName, exportVersionDiffText } from '../services/versionService.js?v=6.15';
import { suggestBoqDraft, suggestBoqLine, suggestMissingPrices, suggestVersionSummary, reviewQuote } from '../services/aiAssistService.js?v=6.15';
import { getAIConfig } from '../services/aiService.js?v=6.15';
import { openReview } from './experience.js?v=6.15';
import { fmtMoney, esc, openModal, closeModal, toast, scopedDom } from '../utils/dom.js?v=6.15';
import { exportBOQExcel } from '../data/excel.js?v=6.15';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.15';
import { categoryGuess } from '../utils/stats.js?v=6.15';
import { archiveEligibility, archiveBlockerText } from '../services/projectWorkflow.js?v=6.15';
import { annotateBoqResourceAuditIssues, buildBoqResourceViewModel, renderBoqResourceReference, withBoqResourcePriceMetadata } from './boqResourceReference.js?v=6.15';
import { loadQuoteAuditViewModel, renderQuoteAuditViewModel } from './boqAuditViewModel.js?v=6.15';

const BOQ_PAGE_SIZE = 500;
const BOQ_AUDIT_LINE_KEYS = ['missingFeature', 'unitMismatch', 'unconfirmedQuotaQuantity', 'priceDeviation'];
const boqState = {
  keyword: '',
  priceStatus: '',
  riskStatus: '',
  page: 1,
  selectedIds: new Set(),
  activeId: '',
  detailTab: 'content',
  treeKeyword: '',
  treeGroup: '',
  detailCollapsed: localStorage.getItem('boq_detail_collapsed') === 'true',
  expandedProjectIds: new Set(),
  collapsedSourceSections: new Set(),
  currency: 'CNY',
  workspaceTab: 'boq',
};
let searchTimer = null;
// 明细区在桌面端是主要编辑面板，不应只留给表单一小段可视空间。
// 使用新 key，避免旧版偏小的本地偏好延续到新版布局。

function money(value) { return fmtMoney(value, boqState.currency); }

export async function render(workspace = document.getElementById('workspace')) {
  const document = scopedDom(workspace);
  const projects = await projectRepo.all();
  if (workspace.isInvalidated) return;
  const proj = projects.find(p => p.id === window.__app.state.currentProjectId) || projects[0];
  if (!proj) {
    workspace.innerHTML = `<div class="page-frame"><div class="card p-10 text-center text-gray-400">还没有项目，先去 <a class="text-teal-700 underline" onclick="window.__app.go('projects')">新建项目</a></div></div>`;
    return;
  }
  boqState.currency = proj.currency || 'CNY';
  window.__app.state.currentProjectId = proj.id;
  const routeParams = window.__app.state.routeParams || {};
  if ((!routeParams.projectId || routeParams.projectId === proj.id) && routeParams.priceStatus) {
    boqState.priceStatus = routeParams.priceStatus;
  }
  if ((!routeParams.projectId || routeParams.projectId === proj.id) && routeParams.riskStatus) {
    boqState.riskStatus = routeParams.riskStatus;
  }
  if ((!routeParams.projectId || routeParams.projectId === proj.id) && routeParams.keyword) {
    boqState.keyword = routeParams.keyword;
  }
  if ((!routeParams.projectId || routeParams.projectId === proj.id) && routeParams.activeId) boqState.activeId = routeParams.activeId;
  boqState.expandedProjectIds.add(proj.id);

  const [allProjectBoq, versions, resourcePrices, serviceAudit] = await Promise.all([
    boqRepo.all(),
    versionService.listByProject(proj.id),
    resourcePriceRepo.all(),
    boqService.audit(proj.id),
  ]);
  const priceMap = new Map(resourcePrices.map(price => [price.id, price]));
  const displayLines = allProjectBoq.filter(line => line.projectId === proj.id).map(line => withBoqResourcePriceMetadata(line, priceMap));
  const boq = annotateBoqResourceAuditIssues(displayLines, serviceAudit).map(line => ({
    ...line,
    boqAuditIssueKeys: BOQ_AUDIT_LINE_KEYS.filter(key => (serviceAudit.issues?.[key] || []).some(issue => issue.id === line.id)),
  }));
  if (boqState.treeGroup && !structureGroups(boq, proj).some(group => group.id === boqState.treeGroup)) {
    boqState.treeGroup = '';
  }
  const filteredBoq = filterLines(boq);
  const pageCount = Math.max(1, Math.ceil(filteredBoq.length / BOQ_PAGE_SIZE));
  if (boqState.page > pageCount) boqState.page = pageCount;
  if (boqState.page < 1) boqState.page = 1;
  const pageStart = (boqState.page - 1) * BOQ_PAGE_SIZE;
  const pageRows = filteredBoq.slice(pageStart, pageStart + BOQ_PAGE_SIZE);
  if (boqState.activeId && !filteredBoq.find(b => b.id === boqState.activeId)) boqState.activeId = '';
  const activeLine = boq.find(b => b.id === boqState.activeId) || filteredBoq[0] || null;
  if (!boqState.activeId && activeLine) boqState.activeId = activeLine.id;
  const activeRecommendations = activeLine && activeLine.lineType !== 'other_charge' ? await boqService.recommendQuota(activeLine, 4) : [];
  const activeQuotaRelations = activeLine ? await projectBoqQuotaRelationRepo.byBoqLine(activeLine.id) : [];
  const librarySource = activeLine?.boqLibraryItemId ? await boqLibraryRepo.findById(activeLine.boqLibraryItemId) : null;
  const totalCost = boq.reduce((s, b) => s + (b.amount || 0), 0);
  const missingPriceCount = boq.filter(b => hasMissingPrice(b.unitPrice)).length;
  const selectedCount = boq.filter(b => boqState.selectedIds.has(b.id)).length;
  const selectedTotal = boq.filter(b => boqState.selectedIds.has(b.id)).reduce((s, b) => s + (b.amount || 0), 0);
  const categories = groupByCategory(boq);
  const workbench = boqWorkbenchStatus(proj, boq, versions, { selectedCount, selectedTotal, imported: routeParams.imported && (!routeParams.projectId || routeParams.projectId === proj.id) });

  workspace.innerHTML = `
    <div class="page-frame h-full min-h-0 flex flex-col gap-3">
      ${boqWorkbenchHeader(proj, projects, workbench)}
      ${boqWorkspaceTabs(workbench)}
      ${boqState.workspaceTab === 'boq' ? `${boqToolbar(selectedCount)}
      <div class="boq-main-grid grid grid-cols-[minmax(0,1fr)_380px] gap-3 flex-1 min-h-0">
        <div class="min-w-0 min-h-0 flex flex-col gap-3">
          <section class="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden flex-1 min-h-[220px]">
            <div class="bg-slate-50 px-4 py-2 border-b border-slate-200 flex items-center justify-between text-sm shrink-0">
              <div class="flex items-center gap-4 text-slate-500">
                <span>显示 ${filteredBoq.length} / ${boq.length} 项${boqState.treeGroup ? ` · ${esc(groupLabel(boqState.treeGroup))}` : ''}${filteredBoq.length > BOQ_PAGE_SIZE ? ` · 第 ${boqState.page}/${pageCount} 页` : ''}</span>
                ${boqState.treeGroup ? '<button id="btnClearTreeGroup" class="text-teal-700 hover:underline">清除结构筛选</button>' : ''}
                ${missingPriceCount ? `<button id="btnOnlyMissing" class="text-amber-700 hover:underline">定位缺单价 ${missingPriceCount}</button>` : '<span>无缺单价风险</span>'}
              </div>
              <div class="flex items-center gap-2 text-xs text-slate-500">
                ${filteredBoq.length > BOQ_PAGE_SIZE ? `<button id="btnPagePrev" class="h-7 px-2 rounded border border-slate-300 bg-white ${boqState.page <= 1 ? 'opacity-40' : ''}">上一页</button><button id="btnPageNext" class="h-7 px-2 rounded border border-slate-300 bg-white ${boqState.page >= pageCount ? 'opacity-40' : ''}">下一页</button>` : ''}
                ${categories.slice(0, 3).map(c => `<span class="badge badge-gray">${esc(c.name)} ${money(c.amount)}</span>`).join('')}
              </div>
            </div>
            <div id="boqMobileList" class="boq-mobile-list mobile-card-list"></div>
            <div class="mobile-table overflow-auto scroll-thin flex-1 min-h-0">
              <table class="w-full min-w-[1120px] text-sm table-fixed">
                <thead><tr class="text-left border-b border-slate-200 bg-white sticky top-0">
                  <th class="py-3 px-3 w-10"><input id="boqSelectAll" type="checkbox" ${filteredBoq.length && filteredBoq.every(b => boqState.selectedIds.has(b.id)) ? 'checked' : ''} /></th>
                  <th class="py-3 px-2 w-10">序</th>
                  <th class="px-2 w-24">编码</th>
                  <th class="px-2 w-28">状态</th>
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
                    <td colspan="10" class="px-3 py-4 text-right text-slate-500 uppercase tracking-wider text-xs">项目合计</td>
                    <td class="px-3 py-4 text-right tabular-nums text-slate-900 text-lg" id="boqTotal">${money(totalCost)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </div>
        <aside id="boqDetail" class="boq-detail-inspector card min-h-0 overflow-hidden">
          ${detailPanel(activeLine, activeRecommendations, librarySource, activeQuotaRelations)}
        </aside>
      </div>` : boqWorkspacePanel(workbench, versions)}
    </div>
  `;

  document.getElementById('projSel').onchange = e => {
    window.__app.state.currentProjectId = e.target.value;
    boqState.treeGroup = '';
    boqState.activeId = '';
    boqState.selectedIds.clear();
    render();
  };
  document.querySelectorAll('[data-boq-workspace-tab]').forEach(button => button.addEventListener('click', () => {
    boqState.workspaceTab = button.dataset.boqWorkspaceTab;
    render();
  }));
  if (boqState.workspaceTab !== 'boq') {
    bindBoqWorkspacePanelActions(proj, workbench);
    return;
  }
  document.getElementById('treeKw')?.addEventListener('input', e => {
    boqState.treeKeyword = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(), 120);
  });
  document.querySelectorAll('[data-tree-group]').forEach(b => b.onclick = () => {
    window.__app.state.currentProjectId = b.dataset.projectId;
    boqState.treeGroup = b.dataset.treeGroup;
    boqState.activeId = '';
    render();
  });
  document.querySelectorAll('[data-add-group]').forEach(b => b.onclick = async () => {
    const name = prompt('输入结构分组名称，例如：工艺设备清单');
    if (!name || !name.trim()) return;
    const project = await projectRepo.findById(b.dataset.addGroup);
    const group = { id: `custom:${name.trim()}`, label: name.trim(), icon: 'folder_open' };
    const groups = project?.structureGroups || [];
    if (project && !groups.some(g => g.id === group.id)) await projectRepo.update(project.id, { structureGroups: [...groups, group] });
    window.__app.state.currentProjectId = b.dataset.addGroup;
    boqState.expandedProjectIds.add(b.dataset.addGroup);
    boqState.treeGroup = group.id;
    render();
  });
  document.querySelectorAll('[data-drop-group]').forEach(el => {
    el.addEventListener('dragover', ev => { ev.preventDefault(); el.classList.add('bg-teal-50'); });
    el.addEventListener('dragleave', () => el.classList.remove('bg-teal-50'));
    el.addEventListener('drop', async ev => {
      ev.preventDefault();
      el.classList.remove('bg-teal-50');
      const lineId = ev.dataTransfer.getData('text/boq-line');
      const projectId = el.dataset.dropProject;
      if (!lineId) return;
      await boqService.updateStructureGroup(lineId, el.dataset.dropGroup);
      window.__app.state.currentProjectId = projectId;
      boqState.treeGroup = el.dataset.dropGroup;
      toast('已移动到结构分组', 'success');
      render();
    });
  });
  document.getElementById('btnAdd').onclick = pickQuota;
  document.getElementById('btnAiDraft').onclick = () => openAiDraftDialog(proj);
  document.getElementById('btnAddLibrary').onclick = pickBoqLibrary;
  document.getElementById('btnImportBOQ').onclick = () => window.__app.go('ai-import', { targetType: 'project_boq', projectId: proj.id });
  document.getElementById('btnAdj').onclick = batchAdjust;
  document.getElementById('btnBatchSelected').onclick = () => batchAdjust(true);
  document.getElementById('btnAiMissing')?.addEventListener('click', () => showAiMissingPrices(proj.id));
  document.getElementById('btnClearSelection')?.addEventListener('click', () => { boqState.selectedIds.clear(); render(); });
  document.getElementById('btnOnlyMissing')?.addEventListener('click', () => { boqState.priceStatus = 'missing'; render(); });
  document.getElementById('btnClearTreeGroup')?.addEventListener('click', () => { boqState.treeGroup = ''; render(); });
  document.getElementById('btnSaveVer').onclick = () => saveVersion(proj.id);
  document.getElementById('btnVersions').onclick = () => manageVersions(proj.id);
  document.getElementById('btnNextMissing')?.addEventListener('click', () => { boqState.priceStatus = 'missing'; render(); });
  document.getElementById('btnNextZeroQty')?.addEventListener('click', () => { boqState.riskStatus = 'zeroQty'; render(); });
  document.getElementById('btnNextSaveVer')?.addEventListener('click', () => saveVersion(proj.id));
  document.getElementById('btnNextAdd')?.addEventListener('click', pickQuota);
  document.getElementById('btnNextBlocked')?.addEventListener('click', () => {
    const action = workbench.eligibility?.primaryAction;
    if (!action) return;
    if (action.params?.priceStatus) boqState.priceStatus = action.params.priceStatus;
    if (action.params?.riskStatus) boqState.riskStatus = action.params.riskStatus;
    boqState.page = 1;
    render();
  });
  document.getElementById('btnNextArchive')?.addEventListener('click', async () => {
    if (!confirm('收录后会把当前项目作为案例，用于后续造价参考。确定收录？')) return;
    try {
      const updated = await projectService.archive(proj.id);
      toast('案例已收录，造价参考已同步', 'success');
      if (updated?.status === 'archived') openReview({ projectId: updated.id, sourceType: 'project_archive' });
      render();
    } catch (err) {
      if (err?.code === 'ARCHIVE_BLOCKED') {
        toast(`暂不能收录：${archiveBlockerText(err.eligibility)}`, 'error');
        return;
      }
      throw err;
    }
  });
  document.getElementById('btnNextIndicators')?.addEventListener('click', () => window.__app.go('indicators'));
  document.getElementById('boqKw').oninput = e => {
    boqState.keyword = e.target.value;
    boqState.page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(), 180);
  };
  document.getElementById('boqPriceStatus').onchange = e => { boqState.priceStatus = e.target.value; boqState.page = 1; render(); };
  document.getElementById('boqRiskStatus').onchange = e => { boqState.riskStatus = e.target.value; boqState.page = 1; render(); };
  document.getElementById('btnClearBoqFilters')?.addEventListener('click', () => {
    boqState.keyword = '';
    boqState.priceStatus = '';
    boqState.riskStatus = '';
    boqState.treeGroup = '';
    boqState.page = 1;
    render();
  });
  document.getElementById('btnPagePrev')?.addEventListener('click', () => { if (boqState.page > 1) { boqState.page--; render(); } });
  document.getElementById('btnPageNext')?.addEventListener('click', () => { if (boqState.page < pageCount) { boqState.page++; render(); } });
  document.getElementById('btnAudit').onclick = () => showQuoteAudit(proj.id);
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

  const mobileList = document.getElementById('boqMobileList');
  mobileList.innerHTML = pageRows.map((b, i) => boqMobileCard(b, pageStart + i + 1)).join('') || `<div class="px-5 py-12 text-center text-sm text-slate-400">${boq.length ? '当前筛选没有结果，请清除筛选后重试。' : '暂无清单数据，可使用上方“添加清单”开始编制。'}</div>`;
  mobileList.querySelectorAll('[data-mobile-boq-open]').forEach(button => button.onclick = () => {
    boqState.activeId = button.dataset.mobileBoqOpen;
    const line = boq.find(item => item.id === boqState.activeId);
    if (line) {
      openModal('清单详情', detailPanel(line, [], null));
      bindDetailActions(line, proj);
    }
  });
  mobileList.querySelectorAll('[data-mobile-boq-select]').forEach(input => input.onchange = event => {
    event.target.checked ? boqState.selectedIds.add(event.target.dataset.mobileBoqSelect) : boqState.selectedIds.delete(event.target.dataset.mobileBoqSelect);
    render();
  });

  const tbody = document.getElementById('boqList');
  tbody.innerHTML = renderBoqTableRows(pageRows, pageStart, filteredBoq) || (boq.length ? `<tr><td colspan="12" class="py-16">
    <div class="flex flex-col items-center justify-center text-center">
      <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded border border-amber-200 bg-amber-50 text-amber-700">
        <span class="material-symbols-outlined text-[24px]">filter_alt_off</span>
      </div>
      <div class="text-base font-semibold text-slate-700 mb-2">当前筛选没有结果</div>
      <div class="text-slate-500 mb-5 max-w-md">项目共有 ${boq.length} 条清单，但当前搜索、价格状态、风险状态或结构分组筛选后为空。</div>
      <button id="btnClearBoqFilters" class="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50">
        <span class="material-symbols-outlined text-[18px]">close</span>清除筛选查看全部
      </button>
    </div>
  </td></tr>` : `<tr><td colspan="12" class="py-20">
    <div class="flex flex-col items-center justify-center text-center">
      <div class="w-64 h-44 mb-6 bg-white border border-slate-200 rounded-xl flex flex-col items-center justify-center gap-4">
          <div class="w-16 h-16 rounded-lg bg-teal-50 flex items-center justify-center text-teal-700">
            <span class="material-symbols-outlined text-[32px]">post_add</span>
          </div>
          <div class="w-3/4 h-2 bg-slate-100 rounded-full"></div>
          <div class="w-1/2 h-2 bg-slate-100 rounded-full"></div>
      </div>
      <div class="text-base font-semibold text-slate-700 mb-2">暂无清单数据</div>
      <div class="text-slate-500 mb-6 max-w-lg">描述项目建设内容，AI 可从本地定额库筛选清单草稿；所有建议都需预览确认后才会写入。</div>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <button id="btnEmptyAi" class="inline-flex items-center gap-2 px-5 py-2.5 brand-bg text-white text-sm font-medium hover:opacity-90">
          <span class="material-symbols-outlined text-[20px]">auto_awesome</span>AI 生成清单草稿
        </button>
        <button id="btnEmptyAdd" class="inline-flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 hover:text-teal-700">
          <span class="material-symbols-outlined text-[20px] text-teal-700">add</span>手动添加清单
        </button>
      </div>
    </div>
  </td></tr>`);

  tbody.querySelectorAll('tr[data-id]').forEach(tr => bindRowEvents(tr, proj.id));
  tbody.querySelectorAll('[data-boq-section-toggle]').forEach(button => button.onclick = () => {
    const key = button.dataset.boqSectionToggle;
    boqState.collapsedSourceSections.has(key)
      ? boqState.collapsedSourceSections.delete(key)
      : boqState.collapsedSourceSections.add(key);
    render();
  });
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('text/boq-line', tr.dataset.id);
      ev.dataTransfer.effectAllowed = 'move';
    });
  });
  tbody.querySelectorAll('[data-open-detail]').forEach(el => el.onclick = () => { boqState.activeId = el.closest('tr').dataset.id; render(); });
  tbody.querySelectorAll('[data-select]').forEach(inp => inp.onchange = e => {
    e.target.checked ? boqState.selectedIds.add(e.target.dataset.select) : boqState.selectedIds.delete(e.target.dataset.select);
    render();
  });
  tbody.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (confirm('删除该清单项？')) { await boqService.remove(b.dataset.del); render(); }
  });
  document.getElementById('btnEmptyAdd')?.addEventListener('click', pickQuota);
  document.getElementById('btnEmptyAi')?.addEventListener('click', () => openAiDraftDialog(proj));
  if (routeParams.action === 'ai-draft') {
    window.__app.state.routeParams = { projectId: proj.id };
    openAiDraftDialog(proj);
  }
  document.getElementById('btnClearBoqFilters')?.addEventListener('click', () => {
    boqState.keyword = '';
    boqState.priceStatus = '';
    boqState.riskStatus = '';
    boqState.treeGroup = '';
    boqState.page = 1;
    render();
  });
  bindDetailActions(activeLine, proj);
}

function renderBoqTableRows(lines, pageStart = 0, summaryLines = lines) {
  let html = '';
  let activeKey = '';
  let activeLines = [];
  const closeSection = () => {
    if (!activeKey || !activeLines.length) return;
    const subtotal = activeLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const missing = activeLines.filter(line => hasMissingPrice(line.unitPrice)).length;
    html += `<tr class="border-b border-slate-200 bg-slate-50/70 text-xs">
      <td colspan="10" class="px-3 py-2 text-right font-medium text-slate-500">分部小计${missing ? ` · <span class="text-amber-700">缺价 ${missing} 项</span>` : ''}</td>
      <td class="px-2 py-2 text-right font-semibold tabular-nums text-slate-800">${money(subtotal)}</td><td></td>
    </tr>`;
  };

  lines.forEach((line, index) => {
    const key = sourceSectionKey(line);
    if (key !== activeKey) {
      closeSection();
      activeKey = key;
      activeLines = key ? summaryLines.filter(item => sourceSectionKey(item) === key) : [];
      if (key) {
        const collapsed = boqState.collapsedSourceSections.has(key);
        html += `<tr class="border-y border-slate-200 bg-slate-100/90">
          <td colspan="12" class="p-0">
            <button type="button" data-boq-section-toggle="${esc(key)}" aria-expanded="${collapsed ? 'false' : 'true'}" class="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-100">
              <span class="material-symbols-outlined text-[18px] text-slate-500">${collapsed ? 'chevron_right' : 'expand_more'}</span>
              <span class="font-mono text-xs text-slate-500">${esc(line.sourceSectionCode || '')}</span>
              <span class="font-semibold text-slate-900">${esc(line.sourceSectionName || '未命名分部')}</span>
              ${line.sourceUnitName ? `<span class="text-xs text-slate-400">${esc(line.sourceUnitName)}</span>` : ''}
              <span class="ml-auto text-xs tabular-nums text-slate-500">${activeLines.length} 项 · ${money(activeLines.reduce((sum, item) => sum + Number(item.amount || 0), 0))}</span>
            </button>
          </td>
        </tr>`;
      }
    }
    if (!key || !boqState.collapsedSourceSections.has(key)) html += boqTableLineRow(line, pageStart + index + 1);
    if (!key) activeLines = [];
  });
  closeSection();
  return html;
}

function boqTableLineRow(line, index) {
  return `<tr class="border-b border-slate-100 hover:bg-slate-50/80 ${line.id === boqState.activeId ? 'bg-teal-50 ring-1 ring-inset ring-teal-200' : ''}" data-id="${esc(line.id)}" draggable="true">
    <td class="px-3 py-2"><input type="checkbox" data-select="${esc(line.id)}" ${boqState.selectedIds.has(line.id) ? 'checked' : ''} /></td>
    <td class="px-2 py-2 text-slate-400">${index}</td>
    <td class="px-2"><input class="w-full bg-transparent text-slate-700 border-0 px-0 py-1" value="${esc(line.code || '')}" /></td>
    <td class="px-2">${riskBadges(line)}</td>
    <td class="px-2 font-medium text-slate-800 cursor-pointer" title="${esc(line.name || '')}" data-open-detail>${esc(line.name)}</td>
    <td class="px-2 text-slate-500 truncate cursor-pointer" title="${esc(line.feature || '')}" data-open-detail>${esc((line.feature || '').slice(0, 60))}</td>
    <td class="px-2 text-center">${esc(line.unit || '')}</td>
    <td class="px-2 text-right tabular-nums"><input type="number" step="0.01" class="w-20 text-right bg-transparent border-0 px-0 py-1" value="${line.qty || 0}" /></td>
    <td class="px-2 text-right tabular-nums"><input type="number" step="0.01" class="w-24 text-right bg-transparent border-0 px-0 py-1 ${hasMissingPrice(line.unitPrice) ? 'text-amber-700 font-semibold' : ''}" value="${line.unitPrice || 0}" title="${hasMissingPrice(line.unitPrice) ? '综合单价为空或为 0，合价会按 0 计' : ''}" /></td>
    <td class="px-2 text-right"><input type="number" step="0.001" class="w-14 text-right bg-transparent border-0 px-0 py-1" value="${line.factor || 1}" /></td>
    <td class="px-2 text-right tabular-nums font-semibold ${hasMissingPrice(line.unitPrice) ? 'text-amber-700' : 'text-slate-900'}" data-amount>${money(line.amount || 0)}</td>
    <td class="px-2 text-right"><button class="text-red-600 hover:underline text-xs" data-del="${esc(line.id)}">删除</button></td>
  </tr>`;
}

function sourceSectionKey(line = {}) {
  if (!line.sourceSectionName && !line.sourceSectionCode) return '';
  return [line.sourceUnitName, line.sourceSectionCode, line.sourceSectionName].map(value => String(value || '').trim()).join(' · ');
}

function boqMobileCard(line, index) {
  const missing = hasMissingPrice(line.unitPrice);
  return `<article class="boq-mobile-card ${line.id === boqState.activeId ? 'bg-teal-50/50' : 'bg-white'}">
    <div class="flex items-start gap-3"><input type="checkbox" class="mt-1 h-5 w-5 shrink-0" aria-label="选择${esc(line.name || '清单项')}" data-mobile-boq-select="${esc(line.id)}" ${boqState.selectedIds.has(line.id) ? 'checked' : ''} />
      <button type="button" class="min-w-0 flex-1 text-left" data-mobile-boq-open="${esc(line.id)}"><div class="flex items-center gap-2"><span class="text-xs text-slate-400">${index}</span>${line.sourceSectionName ? `<span class="badge badge-gray">${esc(line.sourceSectionName)}</span>` : ''}${riskBadges(line)}</div><div class="mt-1 truncate font-semibold text-slate-900">${esc(line.name || '未命名清单')}</div><div class="mt-1 truncate text-xs text-slate-500">${esc(line.code || '未编码')} · ${esc(line.feature || '未填写项目特征')}</div><div class="mt-3 grid grid-cols-3 gap-2 text-xs"><span><b class="block text-slate-400 font-normal">工程量</b><span class="mt-0.5 block tabular-nums text-slate-800">${line.qty || 0} ${esc(line.unit || '')}</span></span><span><b class="block text-slate-400 font-normal">综合单价</b><span class="mt-0.5 block tabular-nums ${missing ? 'text-amber-700' : 'text-slate-800'}">${missing ? '待补价' : money(line.unitPrice)}</span></span><span class="text-right"><b class="block text-slate-400 font-normal">合价</b><span class="mt-0.5 block tabular-nums font-semibold text-slate-900">${money(line.amount || 0)}</span></span></div></button><span class="material-symbols-outlined mt-8 text-slate-400" aria-hidden="true">chevron_right</span>
    </div>
  </article>`;
}

function boqWorkbenchStatus(project, lines, versions, extra = {}) {
  const missing = lines.filter(line => hasMissingPrice(line.unitPrice)).length;
  const zeroQty = lines.filter(line => !(Number(line.qty) > 0)).length;
  const factorRisk = lines.filter(line => Number(line.factor || 1) > 1.2 || Number(line.factor || 1) < 0.8).length;
  const unmatched = lines.filter(line => line.lineType !== 'other_charge' && !line.quotaItemId).length;
  const priced = lines.length - missing;
  const completion = lines.length ? Math.round(priced / lines.length * 100) : 0;
  const totalCost = lines.reduce((s, b) => s + Number(b.amount || 0), 0);
  const eligibility = archiveEligibility(project, lines, versions);
  const next = boqNextAction(project, { lines, versions, missing, zeroQty, imported: extra.imported, eligibility });
  return {
    project,
    lines,
    versions,
    lineCount: lines.length,
    missing,
    zeroQty,
    factorRisk,
    unmatched,
    versionCount: versions.length,
    completion,
    totalCost,
    selectedCount: extra.selectedCount || 0,
    selectedTotal: extra.selectedTotal || 0,
    imported: !!extra.imported,
    eligibility,
    next,
  };
}

function boqNextAction(project, { lines, versions, missing, zeroQty, imported, eligibility }) {
  if (!lines.length) return {
    icon: 'post_add',
    tone: 'slate',
    title: '当前项目还没有清单',
    desc: '先添加清单或导入 Excel，才能形成报价和指标样本。',
    button: '添加清单',
    id: 'btnNextAdd',
  };
  if (missing) return {
    icon: imported ? 'download_done' : 'priority_high',
    tone: 'amber',
    title: imported ? `刚导入清单，可先补齐 ${missing} 条缺单价` : `下一步：补齐 ${missing} 条缺单价`,
    desc: '缺单价会低估项目总造价，建议先定位处理，再保存报价版本。',
    button: '定位缺单价',
    id: 'btnNextMissing',
  };
  if (zeroQty) return {
    icon: 'warning',
    tone: 'amber',
    title: `下一步：复核 ${zeroQty} 条 0 工程量`,
    desc: '0 工程量可能是暂估项，也可能会遗漏计价依据。',
    button: '查看风险项',
    id: 'btnNextZeroQty',
  };
  if (!versions.length) return {
    icon: imported ? 'download_done' : 'history',
    tone: 'teal',
    title: imported ? '刚导入完成，建议保存第一个报价版本' : '下一步：保存报价版本',
    desc: '版本是后续对比、恢复和沉淀指标样本的基准。',
    button: '保存版本',
    id: 'btnNextSaveVer',
  };
  if (project.status !== 'archived' && eligibility?.allowed) return {
    icon: 'inventory_2',
    tone: 'slate',
    title: '下一步：收录为参考案例',
    desc: '价格完整且已有版本，可收录为后续造价参考。',
    button: '收录案例',
    id: 'btnNextArchive',
  };
  if (project.status !== 'archived') {
    const text = archiveBlockerText(eligibility);
    return {
      icon: 'lock',
      tone: 'amber',
      title: `暂不能收录：${text}`,
      desc: '可用案例需要价格完整、工程量可信，并至少保留一个报价版本。',
      button: eligibility?.primaryAction?.label || '处理阻断项',
      id: 'btnNextBlocked',
    };
  }
  return {
    icon: 'analytics',
    tone: 'teal',
    title: '下一步：查看指标对标',
    desc: '项目已收录，可进入造价参考查看区间和案例口径。',
    button: '查看参考',
    id: 'btnNextIndicators',
  };
}

function boqWorkflowStrip(status) {
  const steps = [
    ['工作稿', status.lineCount ? '完成' : '待建立', status.lineCount ? 'teal' : 'slate'],
    ['保存版本', status.versionCount ? `${status.versionCount} 个` : '待保存', status.versionCount ? 'teal' : 'amber'],
    ['收录案例', status.project.status === 'archived' ? '已收录' : (status.eligibility.allowed ? '可收录' : '受阻'), status.project.status === 'archived' || status.eligibility.allowed ? 'teal' : 'amber'],
    ['造价参考', status.project.status === 'archived' ? '可引用' : '收录后可用', status.project.status === 'archived' ? 'teal' : 'slate'],
    ['经验复盘', '可沉淀', 'slate'],
  ];
  return `<section class="rounded-lg border border-slate-200 bg-white px-4 py-2 shrink-0">
    <div class="flex flex-wrap items-center gap-2 text-xs">
      ${steps.map(([label, state, tone], index) => {
        const cls = tone === 'teal' ? 'border-teal-200 bg-teal-50 text-teal-700'
          : tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-700'
            : 'border-slate-200 bg-slate-50 text-slate-500';
        return `${index ? '<span class="text-slate-300">→</span>' : ''}<span class="inline-flex items-center gap-2 rounded border ${cls} px-2.5 py-1.5"><b class="font-medium">${label}</b><span>${state}</span></span>`;
      }).join('')}
      <span class="ml-auto text-slate-500">版本是可回退快照；收录案例后才会用于造价参考，复盘笔记供 AI 查阅。</span>
    </div>
  </section>`;
}

function boqWorkbenchHeader(project, projects, status) {
  return `<section class="rounded-lg border border-slate-200 bg-white p-4 shrink-0">
    <div class="flex items-center gap-4">
      <div>
        <h1 class="text-xl font-semibold text-slate-950">报价编制工作台</h1>
        <div class="mt-1 text-xs text-slate-500">按工作主题切换，专注处理当前任务。</div>
      </div>
      <label class="ml-auto h-10 min-w-[300px] rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
        <span class="material-symbols-outlined text-[18px] text-teal-700">domain</span>
        <select id="projSel" class="w-full bg-transparent outline-none">
          ${projects.map(p => `<option value="${p.id}" ${p.id === project.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>
    </div>
  </section>`;
}

function boqWorkspaceTabs(status) {
  const tabs = [
    ['boq', 'format_list_bulleted', '清单编制', `${status.lineCount} 项`],
    ['risk', 'priority_high', '价格风险', status.missing + status.zeroQty + status.factorRisk + status.unmatched ? `${status.missing + status.zeroQty + status.factorRisk + status.unmatched} 处` : '已通过'],
    ['versions', 'history', '报价版本', `${status.versionCount} 个`],
    ['overview', 'dashboard', '项目概览', `${status.completion}% 完整`],
  ];
  return `<nav class="boq-workspace-tabs rounded-lg border border-slate-200 bg-white px-2 pt-2 shrink-0" aria-label="报价工作区">
    <div class="flex gap-1 overflow-x-auto">
      ${tabs.map(([id, icon, label, note]) => {
        const active = boqState.workspaceTab === id;
        return `<button type="button" data-boq-workspace-tab="${id}" class="${active ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-800'} inline-flex min-w-[136px] flex-1 items-center justify-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold whitespace-nowrap" aria-current="${active ? 'page' : 'false'}"><span class="material-symbols-outlined text-[18px]">${icon}</span><span>${label}</span><span class="text-[11px] font-medium ${active ? 'text-teal-700' : 'text-slate-400'}">${note}</span></button>`;
      }).join('')}
    </div>
  </nav>`;
}

function boqWorkspacePanel(status, versions) {
  if (boqState.workspaceTab === 'risk') {
    return `<section class="flex-1 min-h-0 rounded-xl border border-slate-200 bg-white p-5 overflow-auto scroll-thin">
      <div class="flex items-start justify-between gap-4"><div><h2 class="text-lg font-semibold text-slate-900">价格风险</h2><p class="mt-1 text-sm text-slate-500">集中处理缺单价、工程量和定额匹配异常，处理后再进入版本保存。</p></div><button id="btnRiskAudit" class="inline-flex h-9 items-center gap-1 rounded border border-amber-300 bg-amber-50 px-3 text-sm text-amber-800"><span class="material-symbols-outlined text-[17px]">fact_check</span>报价审查</button></div>
      <div class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        ${riskCard('缺单价', status.missing, 'payments', 'btnRiskMissing', '补齐单价', 'amber')}
        ${riskCard('工程量为 0', status.zeroQty, 'warning', 'btnRiskZero', '查看清单', 'amber')}
        ${riskCard('系数异常', status.factorRisk, 'tune', 'btnRiskFactor', '复核系数', 'amber')}
        ${riskCard('未匹配定额', status.unmatched, 'link_off', 'btnRiskUnmatched', '匹配定额', 'slate')}
      </div>
      ${boqNextBanner(status)}
    </section>`;
  }
  if (boqState.workspaceTab === 'versions') {
    return `<section class="flex-1 min-h-0 rounded-xl border border-slate-200 bg-white p-5 overflow-auto scroll-thin">
      <div class="flex items-start justify-between gap-4"><div><h2 class="text-lg font-semibold text-slate-900">报价版本</h2><p class="mt-1 text-sm text-slate-500">保存可回退快照，并在版本管理中比较、恢复或沉淀复盘。</p></div><div class="flex gap-2"><button id="btnVersionManage" class="h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700">版本管理</button><button id="btnVersionSave" class="h-9 rounded brand-bg px-3 text-sm text-white">保存版本</button></div></div>
      <div class="mt-5 overflow-hidden rounded-lg border border-slate-200"><table class="w-full text-sm"><thead class="bg-slate-50 text-left text-slate-500"><tr><th class="px-4 py-3">版本</th><th class="px-4 py-3">创建时间</th><th class="px-4 py-3 text-right">总价</th><th class="px-4 py-3 text-right">条数</th><th class="px-4 py-3 text-right">缺单价</th><th class="px-4 py-3">备注</th></tr></thead><tbody>${versions.map(version => `<tr class="border-t border-slate-100"><td class="px-4 py-3 font-medium text-slate-800">${esc(version.name || '未命名版本')}</td><td class="px-4 py-3 text-slate-500">${formatTime(version.createdAt)}</td><td class="px-4 py-3 text-right tabular-nums">${money(version.totalCost || 0)}</td><td class="px-4 py-3 text-right tabular-nums">${version.lineCount || 0}</td><td class="px-4 py-3 text-right">${version.missingPriceCount ? `<span class="badge badge-yellow">${version.missingPriceCount}</span>` : '0'}</td><td class="px-4 py-3 text-slate-500">${esc(version.note || '-')}</td></tr>`).join('') || '<tr><td colspan="6" class="px-4 py-14 text-center text-slate-400">还没有报价版本。保存当前清单后即可形成第一个快照。</td></tr>'}</tbody></table></div>
    </section>`;
  }
  return `<section class="flex-1 min-h-0 rounded-xl border border-slate-200 bg-white p-5 overflow-auto scroll-thin">
    <div><h2 class="text-lg font-semibold text-slate-900">项目概览</h2><p class="mt-1 text-sm text-slate-500">查看报价进度、项目总价和后续工作建议。</p></div>
    <div class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      ${boqMetric('项目总造价', money(status.totalCost), '')}
      ${boqMetric('价格完整度', `${status.completion}%`, '', status.missing ? 'text-amber-700' : 'text-teal-700')}
      ${boqMetric('报价版本', status.versionCount, '个', status.versionCount ? '' : 'text-amber-700')}
      ${boqMetric('风险状态', status.missing + status.zeroQty + status.factorRisk + status.unmatched, '处', status.missing ? 'text-amber-700' : '')}
      ${boqMetric('选中合价', money(status.selectedTotal), '')}
    </div>
    <div class="mt-5">${boqWorkflowStrip(status)}</div>
    <div class="mt-3">${boqNextBanner(status)}</div>
  </section>`;
}

function riskCard(label, count, icon, id, action, tone) {
  const cls = count ? (tone === 'amber' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50') : 'border-slate-200 bg-white';
  return `<article class="rounded-xl border ${cls} p-4"><div class="flex items-center justify-between"><span class="text-sm text-slate-600">${label}</span><span class="material-symbols-outlined text-[20px] ${count ? 'text-amber-700' : 'text-teal-700'}">${icon}</span></div><div class="mt-3 text-2xl font-semibold tabular-nums text-slate-900">${count}<span class="ml-1 text-xs font-normal text-slate-500">处</span></div><button id="${id}" class="mt-4 text-sm ${count ? 'text-teal-700 hover:underline' : 'text-slate-400'}" ${count ? '' : 'disabled'}>${action}</button></article>`;
}

function bindBoqWorkspacePanelActions(project, status) {
  document.getElementById('btnRiskAudit')?.addEventListener('click', () => showQuoteAudit(project.id));
  const openRisk = risk => {
    boqState.workspaceTab = 'boq';
    boqState.priceStatus = risk === 'missingPrice' ? 'missing' : '';
    boqState.riskStatus = risk === 'missingPrice' ? '' : risk;
    boqState.page = 1;
    render();
  };
  document.getElementById('btnRiskMissing')?.addEventListener('click', () => openRisk('missingPrice'));
  document.getElementById('btnRiskZero')?.addEventListener('click', () => openRisk('zeroQty'));
  document.getElementById('btnRiskFactor')?.addEventListener('click', () => openRisk('factorRisk'));
  document.getElementById('btnRiskUnmatched')?.addEventListener('click', () => openRisk('unmatchedQuota'));
  document.getElementById('btnVersionSave')?.addEventListener('click', () => saveVersion(project.id));
  document.getElementById('btnVersionManage')?.addEventListener('click', () => manageVersions(project.id));
  document.getElementById('btnNextMissing')?.addEventListener('click', () => openRisk('missingPrice'));
  document.getElementById('btnNextZeroQty')?.addEventListener('click', () => openRisk('zeroQty'));
  document.getElementById('btnNextSaveVer')?.addEventListener('click', () => saveVersion(project.id));
  document.getElementById('btnNextAdd')?.addEventListener('click', () => { boqState.workspaceTab = 'boq'; render(); });
  document.getElementById('btnNextBlocked')?.addEventListener('click', () => {
    const action = status.eligibility?.primaryAction;
    if (!action) return;
    boqState.workspaceTab = action.params?.priceStatus || action.params?.riskStatus ? 'boq' : 'overview';
    boqState.priceStatus = action.params?.priceStatus || '';
    boqState.riskStatus = action.params?.riskStatus || '';
    render();
  });
  document.getElementById('btnNextArchive')?.addEventListener('click', async () => {
    if (!confirm('收录后会把当前项目作为案例，用于后续造价参考。确定收录？')) return;
    try {
      const updated = await projectService.archive(project.id);
      toast('案例已收录，造价参考已同步', 'success');
      if (updated?.status === 'archived') openReview({ projectId: updated.id, sourceType: 'project_archive' });
      render();
    } catch (err) {
      if (err?.code === 'ARCHIVE_BLOCKED') toast(`暂不能收录：${archiveBlockerText(err.eligibility)}`, 'error');
      else throw err;
    }
  });
  document.getElementById('btnNextIndicators')?.addEventListener('click', () => window.__app.go('indicators'));
}

function boqNextBanner(status) {
  const tone = status.next.tone === 'amber'
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : status.next.tone === 'teal'
      ? 'border-teal-200 bg-teal-50 text-teal-800'
      : 'border-slate-200 bg-white text-slate-700';
  return `<section class="rounded-lg border ${tone} px-4 py-3 flex items-center gap-3 shrink-0">
    <span class="material-symbols-outlined text-[22px]">${status.next.icon}</span>
    <div class="min-w-0">
      <div class="font-semibold">${esc(status.next.title)}</div>
      <div class="mt-0.5 text-xs opacity-80">${esc(status.next.desc)}</div>
    </div>
    <div class="flex-1"></div>
    <button id="${status.next.id}" class="h-9 px-4 rounded border border-current bg-white/70 text-sm font-medium">${esc(status.next.button)}</button>
  </section>`;
}

function boqToolbar(selectedCount) {
  return `<section class="rounded-lg border border-slate-200 bg-white p-3 shrink-0">
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
      <select id="boqRiskStatus" class="h-9 rounded border border-slate-300 bg-white px-2 text-sm">
        <option value="" ${!boqState.riskStatus ? 'selected' : ''}>全部状态</option>
        <option value="missingPrice" ${boqState.riskStatus === 'missingPrice' ? 'selected' : ''}>缺单价</option>
        <option value="zeroQty" ${boqState.riskStatus === 'zeroQty' ? 'selected' : ''}>工程量为 0</option>
        <option value="factorRisk" ${boqState.riskStatus === 'factorRisk' ? 'selected' : ''}>系数异常</option>
        <option value="unmatchedQuota" ${boqState.riskStatus === 'unmatchedQuota' ? 'selected' : ''}>未匹配定额</option>
        <option value="invalidQuotaReference" ${boqState.riskStatus === 'invalidQuotaReference' ? 'selected' : ''}>关联定额已删除</option>
        <option value="invalidResourceReference" ${boqState.riskStatus === 'invalidResourceReference' ? 'selected' : ''}>资源引用失效</option>
        <option value="expiredResourcePrice" ${boqState.riskStatus === 'expiredResourcePrice' ? 'selected' : ''}>资源价格过期</option>
        <option value="missingResourcePriceBasis" ${boqState.riskStatus === 'missingResourcePriceBasis' ? 'selected' : ''}>缺价格口径</option>
        <option value="duplicateEquipmentInstallation" ${boqState.riskStatus === 'duplicateEquipmentInstallation' ? 'selected' : ''}>设备安装重复计取</option>
        <option value="missingFeature" ${boqState.riskStatus === 'missingFeature' ? 'selected' : ''}>缺项目特征</option>
        <option value="unitMismatch" ${boqState.riskStatus === 'unitMismatch' ? 'selected' : ''}>定额单位不一致</option>
        <option value="unconfirmedQuotaQuantity" ${boqState.riskStatus === 'unconfirmedQuotaQuantity' ? 'selected' : ''}>定额用量待确认</option>
        <option value="priceDeviation" ${boqState.riskStatus === 'priceDeviation' ? 'selected' : ''}>单价偏离定额</option>
      </select>
      ${toolbarGroup('数据', [
        ['btnAdd', 'add', '添加清单', 'primary'],
        ['btnAiDraft', 'auto_awesome', 'AI 生成草稿', 'ai'],
        ['btnAddLibrary', 'library_add', '从清单库', 'plain'],
        ['btnImportBOQ', 'upload_file', '导入 Excel', 'plain'],
      ])}
      ${toolbarGroup('调价', [
        ['btnAdj', 'percent', '全部调价', 'plain'],
        ['btnBatchSelected', 'tune', '选中调价', selectedCount ? 'plain' : 'disabled'],
        ['btnAiMissing', 'auto_awesome', 'AI 补缺价', 'warn'],
      ])}
      ${toolbarGroup('版本', [
        ['btnSaveVer', 'history', '保存版本', 'plain'],
        ['btnVersions', 'manage_history', '版本管理', 'plain'],
      ])}
      ${toolbarGroup('输出', [
        ['btnAudit', 'fact_check', '报价审查', 'warn'],
        ['btnExp', 'download', '导出报价单', 'plain'],
      ])}
      <button id="btnClearSelection" class="h-9 px-3 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50 ${selectedCount ? '' : 'hidden'}">清除选择</button>
    </div>
  </section>`;
}

function toolbarGroup(label, buttons) {
  return `<div class="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-1.5 py-1">
    <span class="px-1.5 text-[11px] font-medium text-slate-500">${esc(label)}</span>
    ${buttons.map(([id, icon, text, kind]) => {
      const cls = kind === 'primary' ? 'brand-bg text-white'
        : kind === 'ai' ? 'border border-teal-300 bg-teal-50 text-teal-800 hover:bg-teal-100'
        : kind === 'warn' ? 'border border-amber-300 bg-white text-amber-700 hover:bg-amber-50'
          : kind === 'disabled' ? 'border border-slate-300 bg-white text-slate-400 opacity-50'
            : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50';
      return `<button id="${id}" class="h-8 px-2.5 text-xs rounded ${cls} inline-flex items-center gap-1.5">
        <span class="material-symbols-outlined text-[16px]">${icon}</span>${esc(text)}
      </button>`;
    }).join('')}
  </div>`;
}

function filterLines(lines) {
  const kw = boqState.keyword.trim().toLowerCase();
  return lines.filter(b => {
    if (boqState.treeGroup && classifyLineGroup(b) !== boqState.treeGroup) return false;
    if (boqState.priceStatus === 'missing' && !hasMissingPrice(b.unitPrice)) return false;
    if (boqState.priceStatus === 'priced' && hasMissingPrice(b.unitPrice)) return false;
    if (boqState.riskStatus && !lineRisks(b).some(r => r.id === boqState.riskStatus)) return false;
    if (!kw) return true;
    return `${b.code || ''} ${b.name || ''} ${b.feature || ''} ${b.unit || ''}`.toLowerCase().includes(kw);
  });
}

function projectTree(currentProject, lines) {
  const kw = boqState.treeKeyword.trim().toLowerCase();
  const groups = structureGroups(lines, currentProject)
    .map(group => ({ ...group, riskCount: lines.filter(line => classifyLineGroup(line) === group.id && lineRisks(line).length).length }))
    .filter(group => group.count || String(group.id).startsWith('custom:'))
    .filter(group => !kw || `${group.label} ${group.id}`.toLowerCase().includes(kw));
  const pricedCount = lines.filter(line => !hasMissingPrice(line.unitPrice)).length;
  const completion = lines.length ? Math.round(pricedCount / lines.length * 100) : 0;
  return `<aside class="card p-0 overflow-hidden min-h-0 flex flex-col">
    <div class="p-4 border-b border-slate-200 bg-white">
      <div class="flex items-center justify-between">
        <div class="min-w-0">
          <div class="font-semibold text-slate-800">项目清单</div>
          <div class="mt-1 truncate text-xs text-slate-500" title="${esc(currentProject.name || '')}">${esc(currentProject.name || '未命名项目')}</div>
        </div>
        <span class="badge badge-gray">${lines.length} 项</span>
      </div>
      <div class="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
        <div class="flex items-center justify-between text-xs">
          <span class="text-slate-500">价格完整度</span>
          <span class="${completion < 100 ? 'text-amber-700' : 'text-teal-700'} tabular-nums">${completion}%</span>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded bg-slate-200">
          <div class="h-2 rounded ${completion < 100 ? 'bg-amber-500' : 'bg-teal-600'}" style="width:${completion}%"></div>
        </div>
      </div>
      <div class="relative mt-3">
        <span class="material-symbols-outlined pointer-events-none absolute left-3 top-2 text-[18px] text-slate-400">search</span>
        <input id="treeKw" value="${esc(boqState.treeKeyword)}" class="h-9 w-full rounded border border-slate-300 bg-slate-50 pl-9 pr-3 text-sm" placeholder="搜索结构分组..." />
      </div>
    </div>
    <div class="flex-1 min-h-0 overflow-auto scroll-thin p-3 space-y-2 bg-slate-50">
      <div class="rounded-lg bg-white border border-teal-200">
        <div class="flex items-center gap-2 px-2 py-2 text-left">
          <span class="material-symbols-outlined text-[22px] text-amber-500">folder</span>
          <span class="min-w-0 flex-1 truncate font-medium text-slate-900" title="${esc(currentProject.name || '')}">${esc(currentProject.name || '未命名项目')}</span>
          <span class="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">${lines.length}项</span>
        </div>
        <div class="pb-2 pl-8 pr-2 space-y-1">
          <button data-add-group="${currentProject.id}" class="w-full flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-left text-xs text-slate-500 hover:border-teal-300 hover:text-teal-700">
            <span class="material-symbols-outlined text-[16px]">add</span>
            新建结构分组
          </button>
          ${groups.map(group => {
            const active = boqState.treeGroup === group.id;
            return `
            <button data-tree-group="${group.id}" data-project-id="${currentProject.id}" data-drop-group="${group.id}" data-drop-project="${currentProject.id}" class="w-full rounded-lg border px-3 py-2 text-left ${active ? 'bg-teal-50 text-teal-700 border-teal-200' : 'bg-white/70 text-slate-600 hover:bg-white border-slate-200'}">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-[18px]">${group.icon}</span>
                <span class="min-w-0 flex-1 truncate font-medium">${esc(group.label)}</span>
                <span class="text-xs tabular-nums ${active ? 'text-teal-700' : 'text-slate-400'}">${group.count}</span>
              </div>
              <div class="mt-1 flex items-center justify-between text-xs">
                <span class="${group.riskCount ? 'text-amber-700' : 'text-slate-400'}">${group.riskCount ? `风险 ${group.riskCount}` : '无风险'}</span>
                <span class="text-slate-400">拖入归类</span>
              </div>
            </button>
          `; }).join('') || `<div class="rounded border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">当前项目暂无匹配结构</div>`}
        </div>
      </div>
    </div>
  </aside>`;
}

function projectTreeNode(project, lines, active) {
  const expanded = boqState.expandedProjectIds.has(project.id);
  const groups = structureGroups(lines, project);
  const totalCount = lines.length;
  return `<div class="rounded-lg ${active ? 'bg-white border border-teal-200' : 'border border-transparent'}">
    <button data-tree-project="${project.id}" class="w-full flex items-center gap-2 px-2 py-2 text-left hover:bg-white">
      <span class="material-symbols-outlined text-[18px] text-slate-400">${expanded ? 'expand_more' : 'chevron_right'}</span>
      <span class="material-symbols-outlined text-[22px] ${active ? 'text-amber-500' : 'text-slate-300'}">folder</span>
      <span class="min-w-0 flex-1 truncate font-medium ${active ? 'text-slate-900' : 'text-slate-600'}" title="${esc(project.name || '')}">${esc(project.name || '未命名项目')}</span>
      <span class="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">${totalCount}项</span>
    </button>
    ${expanded ? `<div class="pb-2 pl-10 pr-2 space-y-1">
      <button data-add-group="${project.id}" class="w-full flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-left text-xs text-slate-500 hover:border-teal-300 hover:text-teal-700">
        <span class="material-symbols-outlined text-[16px]">add</span>
        新建结构分组
      </button>
      ${groups.map(group => group.count || String(group.id).startsWith('custom:') ? `
        <button data-tree-group="${group.id}" data-project-id="${project.id}" data-drop-group="${group.id}" data-drop-project="${project.id}" class="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left ${active && boqState.treeGroup === group.id ? 'bg-teal-50 text-teal-700 border border-teal-200' : 'text-slate-600 hover:bg-white border border-transparent'}">
          <span class="material-symbols-outlined text-[18px]">${group.icon}</span>
          <span class="min-w-0 flex-1 truncate font-medium">${group.label}</span>
          <span class="text-xs text-slate-400">${group.count}</span>
        </button>
      ` : '').join('') || `<div class="rounded border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">暂无清单结构</div>`}
    </div>` : ''}
  </div>`;
}

function structureGroups(lines, project = {}) {
  const defaults = [
    { id: 'civil', label: '土建工程清单', icon: 'description', count: 0 },
    { id: 'equipment', label: '设备安装清单', icon: 'inventory_2', count: 0 },
    { id: 'electric', label: '电气自控清单', icon: 'bolt', count: 0 },
    { id: 'pipe', label: '管网管道清单', icon: 'linear_scale', count: 0 },
    { id: 'other', label: '其他清单', icon: 'article', count: 0 },
  ];
  const projectGroups = (project.structureGroups || []).filter(g => g?.id && !defaults.some(d => d.id === g.id));
  const customIds = [...new Set(lines.map(line => line.structureGroup).filter(id => id && !defaults.some(g => g.id === id)))];
  const custom = [...projectGroups, ...customIds.filter(id => !projectGroups.some(g => g.id === id)).map(id => ({
    id,
    label: customGroupLabel(id),
    icon: 'folder_open',
    count: 0,
  }))];
  const groups = [...defaults, ...custom];
  lines.forEach(line => {
    const id = classifyLineGroup(line);
    const group = groups.find(g => g.id === id) || groups[groups.length - 1];
    group.count++;
  });
  return groups;
}

function classifyLineGroup(line) {
  return groupForLine(line);
}

function groupLabel(id) {
  if (String(id || '').startsWith('custom:')) return customGroupLabel(id);
  return (structureGroups([]).find(g => g.id === id) || {}).label || '结构筛选';
}

function customGroupLabel(id) {
  return String(id || '').replace(/^custom:/, '') || '自定义分组';
}

function lineRisks(line) {
  const risks = [];
  if (hasMissingPrice(line.unitPrice)) risks.push({ id: 'missingPrice', label: '缺单价', cls: 'badge-yellow' });
  if (!(Number(line.qty) > 0)) risks.push({ id: 'zeroQty', label: '工程量0', cls: 'badge-gray' });
  if (Number(line.factor || 1) > 1.2 || Number(line.factor || 1) < 0.8) risks.push({ id: 'factorRisk', label: '系数异常', cls: 'badge-red' });
  if (line.lineType !== 'other_charge' && !line.quotaItemId) risks.push({ id: 'unmatchedQuota', label: '未匹配', cls: 'badge-gray' });
  if (line.quotaReferenceStatus === 'missing') risks.push({ id: 'invalidQuotaReference', label: '定额已删除', cls: 'badge-red' });
  const auditLabels = {
    missingFeature: ['缺项目特征', 'badge-yellow'],
    unitMismatch: ['单位不一致', 'badge-red'],
    unconfirmedQuotaQuantity: ['用量待确认', 'badge-yellow'],
    priceDeviation: ['单价偏离', 'badge-yellow'],
  };
  (line.boqAuditIssueKeys || []).forEach(key => {
    const [label, cls] = auditLabels[key] || [];
    if (label) risks.push({ id: key, label, cls });
  });
  const resourceView = buildBoqResourceViewModel(line);
  resourceView.badges.forEach(label => risks.push({
    id: label === '引用失效' ? 'invalidResourceReference'
      : label === '价格过期' ? 'expiredResourcePrice'
        : label === '安装重复计取' ? 'duplicateEquipmentInstallation'
          : 'missingResourcePriceBasis',
    label,
    cls: label === '引用失效' ? 'badge-red' : 'badge-yellow',
  }));
  return risks.filter((risk, index) => risks.findIndex(item => item.id === risk.id) === index);
}

function riskBadges(line) {
  const risks = lineRisks(line);
  if (!risks.length) return '<span class="badge badge-green">正常</span>';
  const [primary, ...rest] = risks;
  return `<div class="flex items-center gap-1 whitespace-nowrap" title="${esc(risks.map(risk => risk.label).join('、'))}"><span class="badge ${primary.cls}">${primary.label}</span>${rest.length ? `<span class="badge badge-gray">+${rest.length}</span>` : ''}</div>`;
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

function detailPanel(line, recommendations = [], librarySource = null, quotaRelations = []) {
  const collapsed = false;
  const activeTab = ['content', 'pricing', 'relation'].includes(boqState.detailTab) ? boqState.detailTab : 'content';
  const tabClass = key => `detail-tab inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold ${activeTab === key ? 'bg-white text-teal-800 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'}`;
  const header = `
    <div class="px-4 py-3 border-b border-slate-200 bg-white shrink-0">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <div class="font-semibold text-slate-800">清单明细编辑</div>
            ${line && hasMissingPrice(line.unitPrice) ? '<span class="badge badge-yellow">缺单价</span>' : ''}
          </div>
          <div class="mt-1 text-xs text-slate-500 truncate" title="${esc(line?.name || '')}">${line ? `${esc(line.name || '')} · ${esc(groupLabel(classifyLineGroup(line)))}` : '选择一行后查看和编辑明细'}</div>
        </div>
        <div class="shrink-0 text-right"><div class="text-[11px] text-slate-500">当前合价</div><div class="font-semibold tabular-nums text-slate-900">${line ? money(line.amount || 0) : '-'}</div></div>
      </div>
      ${line ? `<div class="mt-3 grid grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1" role="tablist" aria-label="清单明细分类"><button data-detail-tab="content" class="${tabClass('content')}" role="tab" aria-selected="${activeTab === 'content'}" tabindex="${activeTab === 'content' ? 0 : -1}"><span class="material-symbols-outlined text-[15px]" aria-hidden="true">description</span><span class="truncate">清单内容</span></button><button data-detail-tab="pricing" class="${tabClass('pricing')}" role="tab" aria-selected="${activeTab === 'pricing'}" tabindex="${activeTab === 'pricing' ? 0 : -1}"><span class="material-symbols-outlined text-[15px]" aria-hidden="true">payments</span><span class="truncate">计价归属</span></button><button data-detail-tab="relation" class="${tabClass('relation')}" role="tab" aria-selected="${activeTab === 'relation'}" tabindex="${activeTab === 'relation' ? 0 : -1}"><span class="material-symbols-outlined text-[15px]" aria-hidden="true">${line.lineType === 'other_charge' ? 'account_balance_wallet' : 'link'}</span><span class="truncate">${line.lineType === 'other_charge' ? '费用口径' : '定额关联'}</span></button></div>` : ''}
    </div>`;
  if (!line) {
    return `<div class="h-full flex flex-col bg-white">
      ${header}
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
  if (collapsed) {
    return `<div class="h-full flex flex-col bg-white">${header}</div>`;
  }
  return `<div class="h-full flex flex-col bg-slate-50">
    ${header}

    <div id="boqDetailBody" class="flex-1 overflow-auto scroll-thin p-4">
      <div class="boq-detail-form-grid space-y-4">
        <section data-detail-pane="pricing" class="detail-pane ${activeTab === 'pricing' ? '' : 'hidden'} bg-white border border-slate-200 rounded-xl p-4">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <div class="font-medium text-slate-800">基础信息</div>
              <div class="mt-1 text-xs text-slate-500">计价与归属字段</div>
            </div>
            <span class="material-symbols-outlined text-slate-400" aria-hidden="true">tune</span>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="block text-xs font-medium text-slate-500">项目编码
              <input id="detailCode" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(line.code || '')}" />
            </label>
            <label class="block text-xs font-medium text-slate-500">单位
              <input id="detailUnit" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(line.unit || '')}" />
            </label>
            ${librarySource ? `<div class="col-span-2 rounded border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-800"><div class="font-medium">来自清单库</div><div class="mt-1 truncate" title="${esc(librarySource.name || '')}">${esc(librarySource.code || '未编码')} · ${esc(librarySource.name || '')}</div></div>` : ''}
            ${line.sourceSectionName ? `<div class="col-span-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"><div class="font-medium text-slate-800">原始清单层级</div><div class="mt-1">${esc([line.sourceUnitName, [line.sourceSectionCode, line.sourceSectionName].filter(Boolean).join(' ')].filter(Boolean).join(' / '))}</div><div class="mt-1 text-slate-400">${esc(line.sourceSheetName || 'Excel')} · 原始第 ${Number(line.sourceRowNumber || 0) || '-'} 行</div></div>` : ''}
            <label class="col-span-2 block text-xs font-medium text-slate-500">结构分组
              <select id="detailStructureGroup" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm">
                ${structureGroups([line]).map(g => `<option value="${esc(g.id)}" ${classifyLineGroup(line) === g.id ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}
              </select>
            </label>
            <label class="block text-xs font-medium text-slate-500">工程量
              <input id="detailQty" type="number" step="0.01" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm text-right tabular-nums" value="${line.qty || 0}" />
            </label>
            <label class="block text-xs font-medium text-slate-500">综合单价
              <input id="detailUnitPrice" type="number" step="0.01" ${line.pricingMode === 'composition' ? 'readonly' : ''} class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm text-right tabular-nums ${line.pricingMode === 'composition' ? 'bg-slate-100 text-slate-600' : ''}" value="${line.unitPrice || 0}" />
            </label>
            <label class="col-span-2 block text-xs font-medium text-slate-500">调整系数
              <input id="detailFactor" type="number" step="0.001" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm text-right tabular-nums" value="${line.factor || 1}" />
            </label>
          </div>
        </section>

        <section data-detail-pane="content" class="detail-pane ${activeTab === 'content' ? '' : 'hidden'} bg-white border border-slate-200 rounded-xl p-4">
          <div class="mb-4 flex items-center justify-between gap-3">
            <div>
              <div class="font-medium text-slate-800">清单内容</div>
              <div class="mt-1 text-xs text-slate-500">名称与项目特征</div>
            </div>
            <div class="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-right">
              <div class="text-[11px] text-slate-500">当前合价</div>
              <div class="mt-0.5 font-semibold tabular-nums text-slate-900">${money(line.amount || 0)}</div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="col-span-2 block text-xs font-medium text-slate-500">清单名称
              <input id="detailName" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(line.name || '')}" />
            </label>
            <label class="col-span-2 block text-xs font-medium text-slate-500">项目特征
              <textarea id="detailFeature" rows="4" class="mt-1 w-full resize-y rounded border border-slate-300 px-2 py-2 text-sm">${esc(line.feature || '')}</textarea>
            </label>
            <button id="detailAiFill" type="button" class="col-span-2 inline-flex h-9 items-center justify-center gap-1 rounded border border-teal-300 bg-teal-50 px-3 text-sm text-teal-700 hover:bg-teal-100"><span class="material-symbols-outlined text-[16px]">auto_awesome</span>AI 补全项目特征</button>
          </div>
        </section>
        <section data-detail-pane="relation" class="detail-pane ${activeTab === 'relation' ? '' : 'hidden'} bg-white border border-slate-200 rounded-xl p-4">
          ${line.lineType === 'other_charge' ? `<div class="rounded border border-teal-200 bg-teal-50 px-3 py-3 text-sm text-teal-800"><div class="font-medium">其他项目费无需匹配定额</div><div class="mt-1 text-xs">该行以 Excel 汇总金额为报价依据，内部成本可在“成本测算”中单独复核。</div></div>` : `<div class="mb-3 flex items-center justify-between"><div><div class="font-medium text-slate-800">定额与资源关联</div><div class="mt-1 text-xs text-slate-500">项目内保存独立用量和价格快照，不随定额库自动变价。</div></div>${quotaRelations.length || line.quotaItemId ? `<span class="badge badge-green">${quotaRelations.length || 1} 条定额</span>` : '<span class="badge badge-yellow">未匹配</span>'}</div>${projectQuotaRelationsHtml(quotaRelations)}${renderBoqResourceReference(buildBoqResourceViewModel(line))}<div class="mt-3 grid grid-cols-1 gap-2">${recommendations.length ? recommendations.map(item => `<button data-replace-quota="${item.id}" class="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:border-teal-200 hover:bg-teal-50"><div class="truncate font-medium text-slate-800">${esc(item.name || '')}</div><div class="mt-1 flex justify-between text-xs text-slate-500"><span>${esc(item.unit || '-')} · 匹配 ${Number(item.score || 0).toFixed(1)}</span><span>${hasMissingPrice(item.priceTotal) ? '缺单价' : money(item.priceTotal)}</span></div></button>`).join('') : '<div class="rounded border border-dashed border-slate-200 py-5 text-center text-sm text-slate-400">暂无相似定额</div>'}</div>`}
        </section>
      </div>
    </div>
    <div class="flex items-center justify-between gap-2 border-t border-slate-200 bg-white p-3"><div class="flex gap-2"><button id="detailDelete" type="button" class="h-9 rounded border border-red-200 px-3 text-sm text-red-600 hover:bg-red-50">删除</button><button id="detailDuplicate" type="button" class="inline-flex h-9 items-center gap-1 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"><span class="material-symbols-outlined text-[17px]">content_copy</span>复制</button></div><button id="detailSave" type="button" class="inline-flex h-9 items-center gap-1 rounded brand-bg px-3 text-sm text-white"><span class="material-symbols-outlined text-[17px]">save</span>保存明细</button></div>
  </div>`;
}

function projectQuotaRelationsHtml(relations = []) {
  if (!relations.length) return '<div class="mb-3 rounded border border-dashed border-slate-200 py-4 text-center text-sm text-slate-400">该项目清单尚未保存多定额组成</div>';
  return `<div class="mb-3 space-y-2">${[...relations].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0)).map((relation, index) => {
    const quota = relation.quotaSnapshot || {};
    const adjustment = Number(quota.priceTotal || 0) < 0;
    return `<div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="flex items-start gap-2"><span class="text-xs text-slate-400">${index + 1}</span><div class="min-w-0 flex-1"><div class="font-medium text-slate-800">${esc(quota.code || '未编码')} · ${esc(quota.name || '未命名定额')} ${adjustment ? '<span class="badge badge-yellow">负价调整</span>' : ''}</div><div class="mt-1 text-xs text-slate-500">${relation.quantityBasis === 'total' ? '总套用量' : '单位含量'} ${Number(relation.quantityValue || 0).toLocaleString('zh-CN')} · ${esc(quota.unit || '-')} · 快照价 ${Number(quota.priceTotal || 0).toLocaleString('zh-CN')}</div></div></div></div>`;
  }).join('')}</div>`;
}

function bindDetailActions(line, project) {
  document.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => {
    const tab = button.dataset.detailTab;
    boqState.detailTab = tab;
    document.querySelectorAll('[data-detail-tab]').forEach(item => {
      const selected = item === button;
      item.className = `detail-tab inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold ${selected ? 'bg-white text-teal-800 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'}`;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-detail-pane]').forEach(pane => pane.classList.toggle('hidden', pane.dataset.detailPane !== tab));
  }));
  document.querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-detail-tab]')];
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(tabs.indexOf(button) + offset + tabs.length) % tabs.length];
    next?.focus();
    next?.click();
  }));
  document.getElementById('detailSave')?.addEventListener('click', () => saveDetail(line?.id));
  document.getElementById('detailAiFill')?.addEventListener('click', () => showAiLineAssist(line, project));
  document.querySelectorAll('[data-replace-quota]').forEach(btn => btn.onclick = async () => {
    if (!line || !confirm('用该定额替换当前清单的名称、特征、单位和综合单价？工程量和系数会保留。')) return;
    await boqService.replaceQuota(line.id, btn.dataset.replaceQuota);
    toast('已替换关联定额', 'success');
    render();
  });
  document.getElementById('detailDelete')?.addEventListener('click', async () => {
    if (!line || !confirm('删除该清单项？')) return;
    await boqService.remove(line.id);
    boqState.selectedIds.delete(line.id);
    boqState.activeId = '';
    toast('已删除清单项', 'success');
    render();
  });
  document.getElementById('detailDuplicate')?.addEventListener('click', async () => {
    if (!line) return;
    try {
      const copy = await boqService.duplicateLine(line.id);
      boqState.activeId = copy.id;
      toast('已复制清单及其计价依据，请修改工程量或项目特征', 'success');
      render();
    } catch (error) { toast(error.message || '复制清单失败', 'error'); }
  });
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
    if (b) amtCell.textContent = money(b.amount || 0);
    // 刷新合计
    const lines = await boqService.listByProject(projectId);
    const total = lines.reduce((s, b) => s + (b.amount || 0), 0);
    const totalCell = document.getElementById('boqTotal');
    if (totalCell) totalCell.textContent = money(total);
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
    structureGroup: document.getElementById('detailStructureGroup').value,
    qty: parseFloat(document.getElementById('detailQty').value) || 0,
    unitPrice: parseFloat(document.getElementById('detailUnitPrice').value) || 0,
    factor: parseFloat(document.getElementById('detailFactor').value) || 1,
  });
  toast('清单明细已保存', 'success');
  render();
}

function openAiDraftDialog(project) {
  if (project?.status === 'archived') {
    toast('该项目已收录为案例，当前为只读状态。', 'error');
    return;
  }
  const aiConfigured = Boolean(getAIConfig().api_key);
  openModal('AI 生成清单草稿', `
    <div class="space-y-4 text-sm">
      <div class="rounded-lg border border-teal-200 bg-teal-50 p-3 text-teal-900">
        <div class="font-medium">从本地定额库筛选，不凭空编价</div>
        <div class="mt-1 text-xs leading-5 text-teal-800">AI 只生成候选清单，工程量默认为 0；预览勾选并确认后才写入项目。</div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="text-xs text-slate-500">当前项目</div><div class="mt-1 font-medium text-slate-900">${esc(project.name || '未命名项目')}</div><div class="mt-1 text-xs text-slate-500">${esc([project.type, project.structure, project.process].filter(Boolean).join(' · ') || '尚未填写项目特征')}</div></div>
        <div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="text-xs text-slate-500">生成边界</div><div class="mt-1 font-medium text-slate-900">本地定额候选 + 人工确认</div><div class="mt-1 text-xs text-slate-500">不自动生成工程量，不直接覆盖现有清单。</div></div>
      </div>
      <label class="block text-xs font-medium text-slate-600">建设内容 / 清单范围 <span class="text-red-500">*</span>
        <textarea id="aiDraftBrief" rows="5" maxlength="1200" class="mt-1 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm leading-6" placeholder="例如：填写主要建设内容、结构形式、专业范围和需要纳入报价的工作。"></textarea>
      </label>
      ${aiConfigured ? '<label class="flex items-start gap-2 rounded border border-slate-200 p-3 text-xs text-slate-600"><input id="aiDraftRemote" type="checkbox" class="mt-0.5" /><span><b class="block text-slate-800">使用已配置的远端模型增强</b><span class="mt-1 block">将发送去标识化的项目概况、上述描述和候选定额摘要。</span></span></label>' : '<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">未配置远端模型，本次使用本地匹配生成草稿。</div>'}
    </div>
  `, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="aiDraftGenerate" class="h-9 px-4 brand-bg text-white text-sm">AI 生成草稿</button>`);
  document.getElementById('aiDraftBrief').focus();
  document.getElementById('aiDraftGenerate').onclick = async event => {
    const brief = document.getElementById('aiDraftBrief').value.trim();
    if (!brief) { toast('请先填写建设内容或清单范围', 'error'); return; }
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在生成…';
    try {
      const result = await suggestBoqDraft(project, brief, { useRemote: Boolean(document.getElementById('aiDraftRemote')?.checked) });
      showAiDraftPreview(project, result);
    } catch (error) {
      toast(error.message || '清单草稿生成失败', 'error');
      button.disabled = false;
      button.textContent = 'AI 生成草稿';
    }
  };
}

function showAiDraftPreview(project, result) {
  const rows = result.suggestions || [];
  openModal('AI 清单草稿预览', `
    <div class="space-y-3 text-sm">
      <div class="rounded border border-teal-200 bg-teal-50 px-3 py-2 text-teal-900"><div class="font-medium">${esc(result.summary || '已生成清单草稿')}</div><div class="mt-1 text-xs">来源：${result.source === 'remote' ? '远端 AI + 本地定额库' : '本地定额匹配'}。请勾选需要的项目并填写工程量。</div></div>
      ${rows.length ? `<div class="max-h-[480px] overflow-auto rounded border border-slate-200"><table class="w-full min-w-[820px] text-sm"><thead class="sticky top-0 bg-slate-50 text-left text-xs text-slate-500"><tr><th class="p-2 w-12">选择</th><th class="p-2">清单名称</th><th class="p-2">项目特征</th><th class="p-2 w-20">单位</th><th class="p-2 w-28 text-right">工程量</th><th class="p-2 w-28 text-right">参考单价</th><th class="p-2 w-44">匹配依据</th></tr></thead><tbody>${rows.map((row, index) => `<tr class="border-t"><td class="p-2"><input type="checkbox" data-ai-draft-check="${index}" ${row.apply ? 'checked' : ''} /></td><td class="p-2 font-medium text-slate-900">${esc(row.name)}</td><td class="p-2 text-xs text-slate-500">${esc(row.feature || '-')}</td><td class="p-2">${esc(row.unit || '-')}</td><td class="p-2"><input data-ai-draft-qty="${index}" type="number" min="0" step="0.001" value="0" class="h-8 w-full rounded border border-slate-300 px-2 text-right tabular-nums" aria-label="${esc(row.name)}工程量" /></td><td class="p-2 text-right tabular-nums">${money(row.unitPrice || 0)}</td><td class="p-2 text-xs text-slate-500">${esc(row.reason || '')}<span class="ml-1 badge ${confidenceBadgeClass(row.confidence)}">${confidenceLabel(row.confidence)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="rounded border border-dashed border-slate-300 p-8 text-center text-slate-500">未找到匹配草稿。请补充建设内容，或先完善本地定额库。</div>'}
      ${(result.warnings || []).length ? `<div class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">${result.warnings.map(esc).join('<br>')}</div>` : ''}
    </div>
  `, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button>${rows.length ? '<button id="aiDraftApply" class="h-9 px-4 brand-bg text-white text-sm">确认写入选中清单</button>' : ''}`);
  document.getElementById('aiDraftApply')?.addEventListener('click', async event => {
    const selected = [];
    document.querySelectorAll('[data-ai-draft-check]:checked').forEach(input => {
      const index = Number(input.dataset.aiDraftCheck);
      const row = rows[index];
      if (!row) return;
      selected.push({ code: row.code, name: row.name, feature: row.feature, unit: row.unit, qty: Number(document.querySelector(`[data-ai-draft-qty="${index}"]`)?.value || 0), factor: 1, unitPrice: row.unitPrice, quotaItemId: row.quotaId, aiDraftSource: result.source, aiDraftCreatedAt: new Date().toISOString() });
    });
    if (!selected.length) { toast('请至少勾选一条清单', 'error'); return; }
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '写入中…';
    try {
      const imported = await boqService.importLines(project.id, selected, { mode: 'append' });
      closeModal();
      toast(`已写入 ${imported.success} 条 AI 清单草稿，请复核工程量和价格`, 'success');
      render();
    } catch (error) {
      toast(error.message || '清单草稿写入失败', 'error');
      button.disabled = false;
      button.textContent = '确认写入选中清单';
    }
  });
}

async function showAiLineAssist(line, project) {
  if (!line) return;
  const result = await suggestBoqLine({
    ...line,
    name: document.getElementById('detailName')?.value || line.name,
    feature: document.getElementById('detailFeature')?.value || line.feature,
    unit: document.getElementById('detailUnit')?.value || line.unit,
    unitPrice: parseFloat(document.getElementById('detailUnitPrice')?.value) || line.unitPrice,
  }, { project });
  const rows = result.suggestions || [];
  openModal('AI 补全清单明细', `
    <div class="space-y-4 text-sm">
      <div class="rounded border border-teal-200 bg-teal-50 p-3 text-teal-900">
        <div class="font-medium">${esc(result.summary)}</div>
        <div class="mt-1 text-xs opacity-80">AI 只生成建议，勾选后才会应用到当前清单行。</div>
      </div>
      <div class="overflow-hidden rounded border border-slate-200 bg-white">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-left text-xs text-slate-500"><tr><th class="py-2 px-3 w-10">应用</th><th class="px-3">字段</th><th class="px-3">当前值</th><th class="px-3">AI 建议</th><th class="px-3">依据</th></tr></thead>
          <tbody>
            ${rows.map((row, index) => `<tr class="border-t">
              <td class="py-2 px-3"><input type="checkbox" data-ai-line="${index}" ${row.apply ? 'checked' : ''} /></td>
              <td class="px-3 font-medium">${fieldLabel(row.field)}</td>
              <td class="px-3 text-slate-500 truncate max-w-[180px]">${esc(displayValue(row.currentValue))}</td>
              <td class="px-3 text-slate-800 truncate max-w-[260px]">${esc(displayValue(row.suggestedValue))}<span class="ml-2 badge ${confidenceBadgeClass(row.confidence)}">${confidenceLabel(row.confidence)}</span></td>
              <td class="px-3 text-xs text-slate-500">${esc(row.reason || '')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${result.warnings?.length ? `<div class="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">${result.warnings.map(esc).join('<br>')}</div>` : ''}
    </div>
  `, `
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
    <button id="aiLineApply" class="px-3 py-1.5 text-sm brand-bg text-white rounded">应用到清单行</button>
  `);
  document.getElementById('aiLineApply').onclick = async () => {
    const patch = {};
    document.querySelectorAll('[data-ai-line]:checked').forEach(input => {
      const row = rows[Number(input.dataset.aiLine)];
      if (!row) return;
      if (row.field === 'feature') patch.feature = row.suggestedValue;
      if (row.field === 'unit') patch.unit = row.suggestedValue;
      if (row.field === 'unitPrice') patch.unitPrice = Number(row.suggestedValue || 0);
      if (row.field === 'quotaId') patch.quotaItemId = row.suggestedValue;
    });
    if (!Object.keys(patch).length) {
      toast('请选择要应用的建议', 'error');
      return;
    }
    await boqService.update(line.id, patch);
    closeModal();
    toast('AI 建议已应用，请复核后保存版本', 'success');
    render();
  };
}

async function showAiMissingPrices(projectId) {
  const lines = await boqService.listByProject(projectId);
  const result = await suggestMissingPrices(lines);
  const rows = result.suggestions || [];
  if (!rows.length) {
    toast('当前项目没有缺单价清单', 'success');
    return;
  }
  const before = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const delta = rows.reduce((sum, row) => {
    const line = lines.find(item => item.id === row.lineId);
    return sum + calculatePreviewAmount(line, row.suggestedPrice);
  }, 0);
  openModal('AI 补缺价', `
    <div class="space-y-4 text-sm">
      <div class="grid grid-cols-3 gap-2">
        ${versionSummary('缺价清单', rows.length)}
        ${versionSummary('当前总造价', money(before))}
        ${versionSummary('应用后增量', money(delta))}
      </div>
      <div class="rounded border border-slate-200 bg-white max-h-[52vh] overflow-auto scroll-thin">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-left text-xs text-slate-500 sticky top-0"><tr><th class="py-2 px-3 w-10">应用</th><th class="px-3">清单</th><th class="px-3 w-20">单位</th><th class="px-3 text-right w-28">建议单价</th><th class="px-3">来源</th><th class="px-3">依据</th></tr></thead>
          <tbody>
            ${rows.map((row, index) => `<tr class="border-t">
              <td class="py-2 px-3"><input type="checkbox" data-ai-price="${index}" ${row.apply ? 'checked' : ''} /></td>
              <td class="px-3 font-medium">${esc(row.lineName)}</td>
              <td class="px-3">${esc(row.unit || '-')}</td>
              <td class="px-3 text-right tabular-nums">${money(row.suggestedPrice)}</td>
              <td class="px-3">${esc(row.sourceLabel)} <span class="ml-2 badge ${confidenceBadgeClass(row.confidence)}">${confidenceLabel(row.confidence)}</span></td>
              <td class="px-3 text-xs text-slate-500">${esc(row.reason)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${result.warnings?.length ? `<div class="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">${result.warnings.map(esc).join('<br>')}</div>` : ''}
    </div>
  `, `
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
    <button id="aiPriceApply" class="px-3 py-1.5 text-sm brand-bg text-white rounded">应用选中建议</button>
  `);
  document.getElementById('aiPriceApply').onclick = async () => {
    const selected = Array.from(document.querySelectorAll('[data-ai-price]:checked')).map(input => rows[Number(input.dataset.aiPrice)]).filter(Boolean);
    if (!selected.length) {
      toast('请选择要应用的补价建议', 'error');
      return;
    }
    for (const row of selected) {
      await boqService.update(row.lineId, { unit: row.unit, unitPrice: Number(row.suggestedPrice || 0) });
    }
    closeModal();
    toast(`已应用 ${selected.length} 条 AI 补价建议`, 'success');
    render();
  };
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
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>`);

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
            : money(it.priceTotal)}
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

async function pickBoqLibrary() {
  const items = (await boqLibraryRepo.all()).filter(item => item.status !== 'inactive');
  openModal('从清单库选择', `
    <input id="pickLibraryKw" placeholder="搜索清单编码 / 名称 / 项目特征…" class="w-full border rounded px-3 py-2 mb-3" />
    <div class="max-h-[60vh] overflow-auto scroll-thin border rounded"><table class="w-full text-sm"><thead class="bg-gray-50 sticky top-0"><tr class="text-left text-gray-500"><th class="py-2 px-2">编码</th><th class="px-2">清单名称</th><th class="px-2">项目特征</th><th class="px-2 w-14">单位</th><th class="px-2 w-20 text-center">关联定额</th><th class="px-2 w-12"></th></tr></thead><tbody id="pickLibraryBody"></tbody></table></div>
  `, `<button onclick="window.__modalClose()" class="px-3 py-1.5 text-sm border rounded">取消</button>`);
  const renderChoices = (keyword = '') => {
    const kw = keyword.toLowerCase();
    const visible = items.filter(item => !kw || `${item.code} ${item.name} ${item.feature}`.toLowerCase().includes(kw)).slice(0, 300);
    document.getElementById('pickLibraryBody').innerHTML = visible.map(item => `<tr class="border-b hover:bg-gray-50"><td class="py-1.5 px-2 text-xs text-teal-700">${esc(item.code || '-')}</td><td class="px-2">${esc(item.name)}</td><td class="px-2 text-gray-500 truncate" title="${esc(item.feature || '')}">${esc((item.feature || '').slice(0, 40))}</td><td class="px-2">${esc(item.unit || '')}</td><td class="px-2 text-center">${(item.quotaItemIds || []).length || '-'}</td><td class="px-2 text-right"><button class="text-teal-700 hover:underline text-xs" data-pick-library="${item.id}">选</button></td></tr>`).join('') || `<tr><td colspan="6" class="py-6 text-center text-gray-400">无匹配</td></tr>`;
    document.querySelectorAll('[data-pick-library]').forEach(button => button.onclick = async () => {
      try {
        const line = await boqLibraryService.applyToProject(button.dataset.pickLibrary, window.__app.state.currentProjectId);
        closeModal();
        boqState.activeId = line.id;
        toast('已从清单库加入项目', 'success');
        render();
      } catch (err) { toast(err.message || '加入失败', 'error'); }
    });
  };
  document.getElementById('pickLibraryKw').oninput = event => renderChoices(event.target.value);
  renderChoices();
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
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
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
      <div>
        <div class="mb-2 text-xs font-medium text-slate-500">版本说明模板</div>
        <div class="flex flex-wrap gap-2">
          ${['初版', '调价版', '报审版', '最终版'].map(t => `<button data-ver-template="${t}" class="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs hover:bg-slate-50">${t}</button>`).join('')}
          <button id="verAiSummary" class="rounded border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs text-teal-700 hover:bg-teal-100 inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[15px]">auto_awesome</span>AI 生成版本说明
          </button>
        </div>
      </div>
      <label class="block">版本名称
        <input id="ver_name" class="mt-1 w-full border rounded px-2 py-1.5" value="${esc(name)}" />
      </label>
      <label class="block">备注
        <textarea id="ver_note" rows="3" class="mt-1 w-full border rounded px-2 py-1.5" placeholder="例如：调整设备单价后提交业主"></textarea>
      </label>
      <div class="text-xs text-gray-500">版本保存为不可变快照；后续修改当前清单不会影响已保存版本。</div>
    </div>
  `, `
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
    <button id="ver_save" class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存版本</button>
  `);
  document.querySelectorAll('[data-ver-template]').forEach(btn => btn.onclick = () => {
    const label = btn.dataset.verTemplate;
    document.getElementById('ver_name').value = `${label} · ${defaultVersionName().replace('报价版本 ', '')}`;
    document.getElementById('ver_note').value = {
      初版: '初步编制完成，作为后续调整基准。',
      调价版: '根据最新单价、系数或工程量调整生成。',
      报审版: '用于提交审核，请重点复核缺价和异常项。',
      最终版: '最终报价版本，导出前保留快照。',
    }[label] || '';
  });
  document.getElementById('verAiSummary').onclick = async () => {
    const result = await suggestVersionSummary(projectId);
    (result.suggestions || []).forEach(item => {
      if (item.field === 'name') document.getElementById('ver_name').value = item.suggestedValue || '';
      if (item.field === 'note') document.getElementById('ver_note').value = item.suggestedValue || '';
    });
    toast(result.summary || '已生成版本说明', 'success');
  };
  document.getElementById('ver_save').onclick = async () => {
    const version = await versionService.createFromCurrent(projectId, {
      name: document.getElementById('ver_name').value,
      note: document.getElementById('ver_note').value,
    });
    closeModal();
    toast(`已保存版本：${version.name}，${version.lineCount} 条，${money(version.totalCost)}`, 'success');
    await render();
    openModal('报价版本已保存', `
      <div class="space-y-3 text-sm text-slate-700">
        <div class="rounded border border-slate-200 bg-white p-3">
          <div class="font-semibold text-slate-900">${esc(version.name)}</div>
          <div class="mt-1 text-xs text-slate-500">${version.lineCount} 条清单 · ${money(version.totalCost)} · 缺单价 ${version.missingPriceCount || 0}</div>
        </div>
        <div class="rounded border border-teal-200 bg-teal-50 p-3 text-xs leading-5 text-teal-800">
          可以趁判断还新鲜，把本次报价异常、关键判断和适用边界沉淀成经验卡。
        </div>
      </div>
    `, `
      <button id="verReviewNow" class="px-3 py-1.5 text-sm brand-bg text-white rounded">生成报价复盘</button>
      <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">稍后</button>
    `);
    document.getElementById('verReviewNow').onclick = () => openReview({ projectId, versionId: version.id, sourceType: 'version_saved' });
  };
}

async function manageVersions(projectId) {
  const versions = await versionService.listByProject(projectId);
  openModal('报价版本管理', `
    <div class="space-y-3 text-sm">
      <div class="flex items-center gap-2">
        <select id="ver_left" class="border rounded px-2 py-1.5 flex-1">
          <option value="">选择对比版本 A</option>
          ${versions.map(v => `<option value="${v.id}">${esc(v.name)} · ${money(v.totalCost)}</option>`).join('')}
        </select>
        <select id="ver_right" class="border rounded px-2 py-1.5 flex-1">
          <option value="">选择对比版本 B</option>
          ${versions.map(v => `<option value="${v.id}">${esc(v.name)} · ${money(v.totalCost)}</option>`).join('')}
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
                <td class="px-2 text-right tabular-nums">${money(v.totalCost || 0)}</td>
                <td class="px-2 text-right tabular-nums">${v.lineCount || 0}</td>
                <td class="px-2 text-right tabular-nums">${v.missingPriceCount ? `<span class="badge badge-yellow">${v.missingPriceCount}</span>` : '0'}</td>
                <td class="px-2 text-gray-500 truncate" title="${esc(v.note || '')}">${esc(v.note || '-')}</td>
                <td class="px-2 text-right whitespace-nowrap">
                  <button class="text-teal-700 hover:underline text-xs" data-view-ver="${v.id}">查看</button>
                  <button class="text-emerald-700 hover:underline text-xs ml-2" data-review-ver="${v.id}">复盘</button>
                  <button class="text-blue-700 hover:underline text-xs ml-2" data-restore-ver="${v.id}">恢复</button>
                  <button class="text-red-600 hover:underline text-xs ml-2" data-del-ver="${v.id}">删除</button>
                </td>
              </tr>
            `).join('') || `<tr><td colspan="7" class="py-10 text-center text-gray-400">还没有报价版本。点击「保存版本」创建第一个快照。</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">关闭</button>`);

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
  document.querySelectorAll('[data-review-ver]').forEach(btn => btn.onclick = () => {
    openReview({ projectId, versionId: btn.dataset.reviewVer, sourceType: 'version_saved' });
  });
  document.querySelectorAll('[data-restore-ver]').forEach(btn => btn.onclick = async () => {
    const version = await versionService.get(btn.dataset.restoreVer);
    if (!version) return;
    if (!confirm(`恢复「${version.name}」会覆盖当前项目清单，但不会删除任何历史版本。确定恢复？`)) return;
    const result = await versionService.restore(version.id);
    closeModal();
    toast(`已恢复 ${result.restoredCount} 条清单，当前总价 ${money(result.totalCost)}${result.backup ? '；已自动备份恢复前工作稿' : ''}`, 'success');
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
        ${versionSummary('总价', money(version.totalCost || 0))}
        ${versionSummary('清单条数', version.lineCount || 0)}
        ${versionSummary('缺单价', version.missingPriceCount || 0)}
        ${versionSummary('创建时间', formatTime(version.createdAt))}
      </div>
      ${version.note ? `<div class="text-gray-600 border rounded p-2 bg-gray-50">${esc(version.note)}</div>` : ''}
      ${renderLinesTable(version.lines || [])}
    </div>
  `, `
    <button id="ver_back" class="px-3 py-1.5 text-sm border rounded">返回版本管理</button>
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>
  `);
  document.getElementById('ver_back').onclick = () => manageVersions(projectId);
}

function showVersionDiff(diff, projectId) {
  openModal(`版本对比：${diff.left.name} → ${diff.right.name}`, `
    <div class="space-y-4 text-sm">
      <div class="grid grid-cols-4 gap-2">
        ${versionSummary('版本 A', money(diff.left.totalCost || 0))}
        ${versionSummary('版本 B', money(diff.right.totalCost || 0))}
        ${versionSummary('价差', `${diff.totalDelta >= 0 ? '+' : ''}${money(diff.totalDelta)}`)}
        ${versionSummary('变化项', diff.added.length + diff.removed.length + diff.modified.length)}
      </div>
      <div>
        <div class="font-medium mb-1">分类汇总差异</div>
        <div class="grid grid-cols-2 gap-2">
          ${diff.categorySummary.map(row => `<div class="rounded border border-slate-200 bg-white p-3">
            <div class="font-medium text-slate-800">${esc(row.label)}</div>
            <div class="mt-1 text-xs text-slate-500">${money(row.leftAmount)} → ${money(row.rightAmount)}</div>
            <div class="mt-1 tabular-nums font-semibold ${row.delta >= 0 ? 'text-red-600' : 'text-teal-700'}">${row.delta >= 0 ? '+' : ''}${money(row.delta)}</div>
          </div>`).join('') || '<div class="text-slate-400">无分类差异</div>'}
        </div>
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
    <button id="ver_diff_export" class="px-3 py-1.5 text-sm border rounded text-teal-700 border-teal-300">导出对比报告</button>
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>
  `);
  document.getElementById('ver_diff_back').onclick = () => manageVersions(projectId);
  document.getElementById('ver_diff_export').onclick = () => exportDiffReport(diff);
}

async function showQuoteAudit(projectId) {
  const auditView = await loadQuoteAuditViewModel(projectId, {
    audit: id => boqService.audit(id),
    review: reviewQuote,
  });
  openModal('报价审查报告', renderQuoteAuditViewModel(auditView), `
    <button id="auditMissing" class="px-3 py-1.5 text-sm border rounded text-amber-700 border-amber-300">定位缺单价</button>
    <button id="auditReview" class="px-3 py-1.5 text-sm border rounded text-emerald-700 border-emerald-300">沉淀风险判断</button>
    <button id="auditSaveVersion" class="px-3 py-1.5 text-sm border rounded text-teal-700 border-teal-300">保存报审版</button>
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">关闭</button>
  `);
  document.getElementById('auditMissing').onclick = () => {
    boqState.riskStatus = 'missingPrice';
    closeModal();
    render();
  };
  document.getElementById('auditReview').onclick = () => openReview({ projectId, sourceType: 'quote_audit' });
  document.getElementById('auditSaveVersion').onclick = () => {
    closeModal();
    saveVersion(projectId);
  };
}

function fieldLabel(field) {
  return ({ feature: '项目特征', unit: '单位', unitPrice: '综合单价', quotaId: '关联定额', priceNote: '价格来源说明' })[field] || field;
}

function displayValue(value) {
  if (value == null || value === '') return '未填写';
  if (typeof value === 'number') return String(value);
  return String(value);
}

function confidenceLabel(value) {
  return ({ high: '高', medium: '中', low: '低' })[value] || '中';
}

function confidenceBadgeClass(value) {
  return value === 'high' ? 'badge-green' : value === 'low' ? 'badge-yellow' : 'badge-gray';
}

function calculatePreviewAmount(line, suggestedPrice) {
  if (!line) return 0;
  return calculateAmount(line.qty, suggestedPrice, line.factor || 1);
}

function exportDiffReport(diff) {
  const blob = new Blob([exportVersionDiffText(diff)], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `报价版本对比-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
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
            <td class="px-2 text-right tabular-nums">${hasMissingPrice(line.unitPrice) ? '<span class="badge badge-yellow">缺单价</span>' : money(line.unitPrice)}</td>
            <td class="px-2 text-right tabular-nums">${fmtNumber(line.factor)}</td>
            <td class="px-2 text-right tabular-nums">${money(line.amount || 0)}</td>
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
  return `${line.name || '未命名'}｜${fmtNumber(line.qty)} ${line.unit || ''} × ${money(line.unitPrice || 0)} × ${fmtNumber(line.factor)} = ${money(line.amount || 0)}`;
}

function formatTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}
