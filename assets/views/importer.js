// 视图：Excel 导入工作台
import { projectService } from '../services/projectService.js?v=6.4';
import { boqService } from '../services/boqService.js?v=6.4';
import { dataEngineService } from '../services/dataEngineService.js?v=6.4';
import { quotaService } from '../services/quotaService.js?v=6.4';
import { suggestImportMapping, suggestImportRepairs, suggestQuotaBatchCleanup } from '../services/aiAssistService.js?v=6.4';
import { quotaRepo } from '../data/repository.js?v=6.4';
import { parseExcel, exportQuotaTemplate } from '../data/excel.js?v=6.4';
import { getStorageStatus } from '../data/storage.js?v=6.4';
import { IMPORT_FIELD_DEFS, applyMappingTemplate, buildImportMapping, createHeaderFingerprint, matchMappingTemplate, resolveImportPricing } from '../services/importMappingService.js?v=6.4';
import { createMappingTemplate, deleteMappingTemplate, duplicateMappingTemplate, getMappingTemplate, listMappingTemplates, markMappingTemplateUsed, saveMappingTemplate } from '../services/importMappingTemplateService.js?v=6.4';
import { esc, fmtMoney, openModal, closeModal, toast } from '../utils/dom.js?v=6.4';
import { hasMissingPrice } from '../utils/costing.js?v=6.4';
import { categoryGuess } from '../utils/stats.js?v=6.4';

const PREVIEW_PAGE_SIZES = [20, 50, 100];

const SAMPLE_ROWS = [
  { 序号: 1, 项目名称: '土方开挖（基坑）', 项目特征: '挖土深度 ≤3m，含支撑', 计量单位: 'm³', 工程数量: '125.600', 综合单价: '86.35', 工艺段: '生化池', 费用分类: '土建工程' },
  { 序号: 2, 项目名称: '土方回填', 项目特征: '分层回填，夯实系数0.93', 计量单位: 'm³', 工程数量: '98.400', 综合单价: '', 工艺段: '生化池', 费用分类: '土建工程' },
  { 序号: 3, 项目名称: 'C30混凝土垫层', 项目特征: '厚100mm', 计量单位: 'm³', 工程数量: '6.850', 综合单价: '', 工艺段: '生化池', 费用分类: '土建工程' },
  { 序号: 4, 项目名称: '钢筋制作安装', 项目特征: 'HPB300 φ12以内', 计量单位: 't', 工程数量: '2.350', 综合单价: '5420', 工艺段: '生化池', 费用分类: '钢筋工程' },
  { 序号: 5, 项目名称: '模板安装拆除', 项目特征: '组合钢模板', 计量单位: '', 工程数量: '', 综合单价: '42.80', 工艺段: '生化池', 费用分类: '模板工程' },
  { 序号: 6, 项目名称: '曝气管道 DN200', 项目特征: 'UPVC 管，承插连接', 计量单位: 'm', 工程数量: '86', 综合单价: '125.60', 工艺段: '生化池', 费用分类: '安装工程' },
  { 序号: 7, 项目名称: '不锈钢格栅', 项目特征: '304不锈钢，栅隙10mm', 计量单位: '套', 工程数量: '12', 综合单价: '3850', 工艺段: '格栅间', 费用分类: '设备购置' },
  { 序号: 8, 项目名称: '污泥泵（潜水）', 项目特征: 'Q=25m³/h，H=15m', 计量单位: '台', 工程数量: '2', 综合单价: '', 工艺段: '污泥泵房', 费用分类: '设备购置' },
  { 序号: 9, 项目名称: '电缆敷设', 项目特征: 'YJV-1kV-4×16', 计量单位: 'm', 工程数量: '320', 综合单价: '23.50', 工艺段: '污泥泵房', 费用分类: '安装工程' },
];

const state = {
  mode: 'hub',
  projects: [],
  storageStatus: { mode: 'browser', directoryName: '' },
  projectId: '',
  fileName: '',
  fileSize: 0,
  rawRows: [],
  headers: [],
  mapping: {},
  mappingMeta: {},
  mappingSources: {},
  fixedValues: {},
  amountRule: 'calculated',
  templates: [],
  templateRecommendation: null,
  activeTemplateId: '',
  draftAvailable: false,
  activeIssueTab: 'errors',
  previewOnlyIssues: false,
  keyword: '',
  previewPage: 1,
  previewPageSize: 50,
  selectedRows: new Set(),
  importMode: 'append',
  hubSelectedType: 'boq',
  hubImportResult: null,
};

export async function render(workspace = document.getElementById('workspace')) {
  const params = window.__app?.state?.routeParams || {};
  [state.projects, state.storageStatus] = await Promise.all([
    projectService.list(),
    getStorageStatus(),
  ]);
  if (!state.projectId && state.projects.length) {
    state.projectId = params.projectId || window.__app?.state?.currentProjectId || state.projects[0].id;
  }
  refreshTemplates();
  state.draftAvailable = Boolean(readDraft());
  if (params.mode === 'boq') state.mode = 'boq';
  if (params.mode === 'hub') state.mode = 'hub';
  if (params.importResult) {
    state.hubImportResult = normalizeHubImportResult(params.importResult);
    if (state.hubImportResult.projectId) state.projectId = state.hubImportResult.projectId;
  }
  else if (!Object.keys(params).length || params.mode === 'hub') state.hubImportResult = null;
  exposeImporterActions(workspace);
  if (params.action === 'quota') {
    window.__app.state.routeParams = {};
    setTimeout(() => importQuotaExcel(), 0);
  }
  if (state.mode === 'boq' && !state.projects.length) {
    state.mode = 'hub';
    toast('导入清单前需要先建立项目档案。');
    window.__app.go('projects', { action: 'new', returnTo: 'importer' });
    return;
  }
  if (state.mode === 'boq') {
    if (!state.rawRows.length) loadSample();
    paint(workspace);
    return;
  }
  renderHub(workspace);
}

function exposeImporterActions(workspace) {
  window.__importer = {
    showHub: () => {
      state.mode = 'hub';
      renderHub(workspace);
    },
    startBOQImport: () => {
      if (!state.projects.length) {
        toast('导入清单前需要先建立项目档案。');
        window.__app.go('projects', { action: 'new', returnTo: 'importer' });
        return;
      }
      window.__app.go('ai-import', { targetType: 'project_boq', projectId: state.projectId || state.projects[0].id });
    },
    importQuotaExcel,
    goBackup: () => {
      toast('JSON 备份导入仍在「数据与备份」中执行。');
      window.__app.go('settings');
    },
    goVersions: () => {
      toast('历史报价版本来自工程量清单里的「保存报价版本」。');
      if (state.projectId) window.__app.go('boq', { projectId: state.projectId });
      else window.__app.go('boq');
    },
    importMaterials: () => window.__app.go('ai-import', { targetType: 'material' }),
    importEquipment: () => window.__app.go('ai-import', { targetType: 'equipment' }),
    importBoqLibrary: () => window.__app.go('ai-import', { targetType: 'boq_library' }),
    selectHubType: type => {
      if (!['boq', 'boq_library', 'quota', 'material', 'equipment'].includes(type)) return;
      state.hubSelectedType = type;
      renderHub(workspace);
    },
    continueHubImport: () => {
      const actionByType = {
        boq: 'startBOQImport',
        boq_library: 'importBoqLibrary',
        quota: 'importQuotaExcel',
        material: 'importMaterials',
        equipment: 'importEquipment',
      };
      window.__importer[actionByType[state.hubSelectedType]]?.();
    },
    dismissHubImportResult: () => {
      state.hubImportResult = null;
      renderHub(workspace);
    },
    openImportedBoq: () => {
      const projectId = state.hubImportResult?.projectId || state.projectId;
      if (projectId) window.__app.go('boq', { projectId });
    },
    pickFile: () => pickFile(workspace),
    handleFile: file => handleFile(file, workspace),
    setProject: id => {
      state.projectId = id;
      window.__app.state.currentProjectId = id;
      refreshTemplates();
      paint();
    },
    setMapping: (key, value) => {
      state.mapping[key] = value;
      state.mappingSources[key] = { type: value ? 'column' : 'none', value };
      if (!value) delete state.fixedValues[key];
      state.mappingMeta[key] = {
        ...(state.mappingMeta[key] || {}),
        source: value,
        candidateSource: value,
        confidence: value ? 'manual' : 'none',
        status: value ? 'confirmed' : 'missing',
        reason: value ? '已由你手动确认来源列' : '未选择来源列',
      };
      state.selectedRows.clear();
      state.previewPage = 1;
      paint();
    },
    setMappingMode: (key, type) => {
      if (type === 'fixed' && !canUseFixedValue(key)) return;
      state.mappingSources[key] = { type, value: type === 'column' ? (state.mapping[key] || '') : '' };
      if (type !== 'column') state.mapping[key] = '';
      if (type !== 'fixed') delete state.fixedValues[key];
      state.mappingMeta[key] = {
        ...(state.mappingMeta[key] || {}),
        status: type === 'fixed' ? 'fixed' : 'missing',
        reason: type === 'fixed' ? '将使用固定填充值' : '未选择来源列',
      };
      paint();
    },
    setFixedValue: (key, value) => {
      state.mappingSources[key] = { type: 'fixed', value };
      state.fixedValues[key] = value;
      state.mapping[key] = '';
      state.mappingMeta[key] = { ...(state.mappingMeta[key] || {}), status: 'fixed', reason: value ? '将使用固定填充值' : '请输入固定值' };
      state.previewPage = 1;
      paint();
    },
    setAmountRule: value => {
      state.amountRule = ['calculated', 'sourceAmount', 'deriveUnitPrice'].includes(value) ? value : 'calculated';
      paint();
    },
    autoMap: () => {
      applyMappingResult(buildImportMapping(state.headers, state.rawRows));
      state.activeTemplateId = '';
      state.previewPage = 1;
      toast(mappingToastMessage('已自动确认字段'), 'success');
      paint();
    },
    aiMap: async () => {
      const result = await suggestImportMapping(state.headers, state.rawRows.slice(0, 10));
      applyMappingResult(result);
      state.previewPage = 1;
      toast(result.summary || 'AI 已识别字段映射', 'success');
      paint();
    },
    clearMapping: () => {
      state.mapping = {};
      state.mappingMeta = {};
      state.mappingSources = {};
      state.fixedValues = {};
      state.amountRule = 'calculated';
      state.activeTemplateId = '';
      state.previewPage = 1;
      paint();
    },
    setIssueTab: tab => {
      state.activeIssueTab = tab;
      paint();
    },
    setPreviewIssues: checked => {
      state.previewOnlyIssues = checked;
      state.previewPage = 1;
      paint();
    },
    setKeyword: value => {
      state.keyword = value;
      state.previewPage = 1;
      paint();
    },
    setPreviewPage: page => {
      state.previewPage = Math.max(1, Number(page) || 1);
      paint();
    },
    setPreviewPageSize: size => {
      state.previewPageSize = PREVIEW_PAGE_SIZES.includes(Number(size)) ? Number(size) : 50;
      state.previewPage = 1;
      paint();
    },
    useCandidate: key => {
      const candidate = state.mappingMeta[key]?.candidateSource;
      if (!candidate) return;
      state.mapping[key] = candidate;
      state.mappingSources[key] = { type: 'column', value: candidate };
      state.mappingMeta[key] = {
        ...state.mappingMeta[key],
        source: candidate,
        confidence: 'manual',
        status: 'confirmed',
        reason: '已由你确认候选来源列',
      };
      state.previewPage = 1;
      paint();
    },
    setMode: mode => {
      state.importMode = mode;
      paint();
    },
    toggleRow: index => {
      const n = Number(index);
      if (state.selectedRows.has(n)) state.selectedRows.delete(n);
      else state.selectedRows.add(n);
      paint();
    },
    saveDraft,
    restoreDraft,
    showTemplateMenu,
    showTemplateManager,
    showSaveTemplate,
    saveTemplateForm,
    updateActiveTemplate,
    applyTemplate,
    deleteTemplate,
    duplicateTemplate,
    confirmImport,
    repairMissingPrice: () => {
      state.rawRows = state.rawRows.map(row => {
        const src = state.mapping.unitPrice;
        if (!src || !hasMissingPrice(row[src])) return row;
        return { ...row, [src]: '' };
      });
      toast('缺单价条目已保留为待询价状态');
      paint();
    },
    repairUnitFromPrevious,
    mapUnknownCategory,
    mergeDuplicateRows,
    downloadTemplate: exportQuotaTemplate,
    goBOQ: () => {
      if (state.projectId) window.__app.go('boq', { projectId: state.projectId });
    },
  };
}

export function normalizeHubImportResult(result = {}) {
  return {
    projectId: String(result.projectId || ''),
    success: Math.max(0, Number(result.success) || 0),
    missingPrice: Math.max(0, Number(result.missingPrice) || 0),
    total: Math.max(0, Number(result.total) || 0),
    sourceName: String(result.sourceName || '项目工程量清单'),
  };
}

function renderHub(workspace = document.getElementById('workspace')) {
  const projectCount = state.projects.length;
  const usingFolder = state.storageStatus.mode === 'folder';
  const storageLabel = usingFolder ? '本地文件夹' : '浏览器本地库';
  const storageDetail = usingFolder
    ? `当前数据同步到“${state.storageStatus.directoryName || '已选文件夹'}”，并保留浏览器镜像。`
    : '当前数据保存在此浏览器的 IndexedDB 中。';
  const activeProject = state.projects.find(project => project.id === state.projectId);
  const importComplete = Boolean(state.hubImportResult);
  workspace.innerHTML = `
    <div class="page-frame min-h-full pb-5">
      <header class="flex flex-col gap-3 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div class="flex items-center gap-2 text-xs font-medium text-teal-700">
            <span class="material-symbols-outlined icon-inline">account_tree</span>
            数据导入流程
          </div>
          <h1 class="mt-2 text-2xl font-semibold tracking-tight text-slate-950">导入资料</h1>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-500">按步骤导入项目清单、清单库、定额、材料或设备数据。每份文件先经过字段识别与质检，确认后才会写入本地资料库。</p>
        </div>
        <div class="flex items-center gap-2 text-xs text-slate-500" aria-label="存储状态">
          <span class="pulse-dot" aria-hidden="true"></span>
          <span>数据保存在${esc(storageLabel)}</span>
          <button type="button" onclick="window.__importer.goBackup()" class="ml-1 font-medium text-teal-700 hover:underline">备份与恢复</button>
        </div>
      </header>

      <section class="mt-5 rounded-xl border border-slate-200 bg-white" aria-labelledby="import-flow-title">
        <h2 id="import-flow-title" class="sr-only">导入步骤</h2>
        <ol class="grid grid-cols-1 divide-y divide-slate-200 md:grid-cols-4 md:divide-x md:divide-y-0">
          ${hubStep('1', '选择数据类型', '确认要导入的资料', !importComplete, importComplete)}
          ${hubStep('2', '上传文件', '选择 Excel 或 CSV 文件', false, importComplete)}
          ${hubStep('3', '数据质检', '识别字段并生成报告', false, importComplete)}
          ${hubStep('4', '确认写入', '确认后保存到本地库', false, importComplete)}
        </ol>
      </section>

      ${importComplete ? hubImportResultBanner(activeProject) : ''}

      <div class="${importComplete ? 'mt-4' : 'mt-5'} grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <main class="min-w-0 space-y-5">
          <section class="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="import-type-title">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 id="import-type-title" class="text-base font-semibold text-slate-900">第 1 步：选择数据类型</h2>
                <p class="mt-1 text-sm text-slate-500">选择后进入对应的上传与预检流程。不同类型会使用适合它的字段规则和模板。</p>
              </div>
              <button type="button" onclick="window.__importer.downloadTemplate()" class="inline-flex items-center gap-1.5 text-sm font-medium text-teal-700 hover:underline">
                <span class="material-symbols-outlined icon-inline">download</span>
                下载定额 Excel 模板
              </button>
            </div>
            <div class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
              ${hubTypeCard({ type: 'boq', icon: 'list_alt', title: '工程量清单', desc: '导入项目清单、分部分项与计价信息。', meta: activeProject ? `目标项目：${activeProject.name}` : '需先选择或建立目标项目', tone: 'teal' })}
              ${hubTypeCard({ type: 'boq_library', icon: 'format_list_bulleted', title: '清单库', desc: '导入可跨项目复用的标准清单。', meta: '支持编码优先和复合身份去重', tone: 'blue' })}
              ${hubTypeCard({ type: 'quota', icon: 'menu_book', title: '常用定额', desc: '导入定额项目及其综合单价、消耗量和特征。', meta: '支持 Excel 模板与字段映射', tone: 'blue' })}
              ${hubTypeCard({ type: 'material', icon: 'category', title: '材料库', desc: '导入材料编码、规格、品牌和价格历史。', meta: '按编码优先，预览后再写入', tone: 'slate' })}
              ${hubTypeCard({ type: 'equipment', icon: 'precision_manufacturing', title: '设备库', desc: '导入设备参数、购置价与安装价口径。', meta: '支持设备购置与综合安装价', tone: 'slate' })}
            </div>
            ${hubUploadPanel()}
          </section>

          <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(310px,.85fr)]">
            <section class="rounded-xl border border-slate-200 bg-white" aria-labelledby="recent-import-title">
              <div class="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <div><h2 id="recent-import-title" class="font-semibold text-slate-900">最近导入记录</h2><p class="mt-1 text-xs text-slate-500">仅记录当前浏览器最近完成的导入摘要。</p></div>
              </div>
              <div class="divide-y divide-slate-100">
                ${hubRecentImports()}
              </div>
            </section>
            <section class="rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="quality-context-title">
              <div class="flex items-center justify-between"><h2 id="quality-context-title" class="font-semibold text-slate-900">本次导入质检概览</h2><span class="text-xs text-slate-500">未开始</span></div>
              <div class="mt-4 grid grid-cols-4 overflow-hidden rounded-lg border border-slate-200 text-center text-xs"><div class="border-r border-slate-200 p-3"><b class="block text-base text-slate-800">—</b>预计记录数</div><div class="border-r border-slate-200 p-3"><b class="block text-base text-slate-800">—</b>通过</div><div class="border-r border-slate-200 p-3"><b class="block text-base text-slate-800">—</b>部分通过</div><div class="p-3"><b class="block text-base text-slate-800">—</b>未通过</div></div>
              <ul class="mt-4 space-y-2 text-xs leading-5 text-slate-600">${hubCheck('check_circle', '必填字段与数据格式')}${hubCheck('check_circle', '编码、单位与重复项')}${hubCheck('check_circle', '价格口径与缺失价格')}</ul>
            </section>
          </div>
        </main>

        <aside class="space-y-4">
          <section class="rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="project-context-title">
            <div class="flex items-center justify-between gap-3">
              <h2 id="project-context-title" class="font-semibold text-slate-900">当前项目</h2>
              <button type="button" onclick="window.__app.go('projects')" class="text-xs font-medium text-teal-700 hover:underline">切换项目</button>
            </div>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex items-start justify-between gap-3"><dt class="text-slate-500">项目名称</dt><dd class="max-w-[170px] text-right font-medium text-slate-800">${esc(activeProject?.name || '尚未选择项目')}</dd></div>
              <div class="flex items-start justify-between gap-3"><dt class="text-slate-500">可导入清单</dt><dd class="text-right font-medium text-slate-800">${projectCount ? '可以' : '先新建项目'}</dd></div>
              <div class="flex items-start justify-between gap-3"><dt class="text-slate-500">当前存储</dt><dd class="text-right font-medium text-slate-800">${esc(storageLabel)}</dd></div>
            </dl>
          </section>

          <section class="rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="storage-context-title">
            <h2 id="storage-context-title" class="font-semibold text-slate-900">数据保存位置</h2>
            <dl class="mt-4 space-y-3 text-sm"><div class="flex justify-between gap-3"><dt class="text-slate-500">保存方式</dt><dd class="text-right font-medium text-slate-800">${esc(storageLabel)}</dd></div><div class="flex justify-between gap-3"><dt class="text-slate-500">存储引擎</dt><dd class="font-medium text-slate-800">IndexedDB</dd></div></dl>
            <button type="button" onclick="window.__importer.goBackup()" class="mt-4 text-xs font-medium text-teal-700 hover:underline">管理存储与备份</button>
          </section>

          <section class="rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="template-context-title">
            <h2 id="template-context-title" class="font-semibold text-slate-900">模板与说明</h2>
            <div class="mt-3 space-y-2 text-sm"><button type="button" onclick="window.__importer.downloadTemplate()" class="flex items-center gap-2 text-teal-700 hover:underline"><span class="material-symbols-outlined icon-inline">description</span>下载定额 Excel 模板</button><button type="button" onclick="window.__importer.importBoqLibrary()" class="flex items-center gap-2 text-teal-700 hover:underline"><span class="material-symbols-outlined icon-inline">description</span>导入清单库</button><button type="button" onclick="window.__importer.importMaterials()" class="flex items-center gap-2 text-teal-700 hover:underline"><span class="material-symbols-outlined icon-inline">description</span>导入材料库模板</button><button type="button" onclick="window.__importer.importEquipment()" class="flex items-center gap-2 text-teal-700 hover:underline"><span class="material-symbols-outlined icon-inline">description</span>导入设备库模板</button></div>
          </section>

          <section class="rounded-xl border border-amber-200 bg-amber-50/60 p-4" aria-label="备份提醒">
            <div class="flex gap-2 text-sm font-medium text-amber-900"><span class="material-symbols-outlined icon-inline">info</span> 导入前提醒</div>
            <p class="mt-2 text-xs leading-5 text-amber-800">恢复 JSON 或 ZIP 备份会替换当前资料。更换设备前，请先在「数据与备份」中导出完整备份。</p>
          </section>
        </aside>
      </div>
    </div>
  `;
}

function hubStep(number, title, desc, active = false, complete = false) {
  return `<li class="flex items-center gap-3 px-5 py-4 ${active ? 'bg-teal-50/70' : ''}">
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${active || complete ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-600'} text-sm font-semibold">${complete ? '<span class="material-symbols-outlined icon-inline">check</span>' : number}</span>
    <span><span class="block text-sm font-semibold ${active || complete ? 'text-teal-800' : 'text-slate-800'}">${title}</span><span class="mt-0.5 block text-xs text-slate-500">${desc}</span></span>
  </li>`;
}

function hubImportResultBanner(activeProject) {
  const result = state.hubImportResult;
  const projectName = activeProject?.name || '当前项目';
  return `<section class="mt-4 rounded-xl border border-teal-200 bg-teal-50/70 px-5 py-4" role="status" aria-live="polite">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex gap-3"><span class="material-symbols-outlined icon-page text-teal-700">task_alt</span><div><h2 class="font-semibold text-teal-950">清单已导入，先完成复核再进入报价编制</h2><p class="mt-1 text-sm text-teal-900/80">${esc(result.sourceName)}已写入“${esc(projectName)}”：成功 ${result.success} 条${result.missingPrice ? `，其中 ${result.missingPrice} 条缺少单价` : ''}。请先核对质检结果和缺价条目。</p></div></div>
      <div class="flex shrink-0 gap-2"><button type="button" onclick="window.__importer.dismissHubImportResult()" class="h-9 px-3 text-sm border border-teal-300 bg-white text-teal-800 hover:bg-teal-50">留在导入中心</button><button type="button" onclick="window.__importer.openImportedBoq()" class="h-9 px-3 text-sm brand-bg text-white">进入报价编制</button></div>
    </div>
  </section>`;
}

function hubTypeCard({ type, icon, title, desc, meta, tone }) {
  const tones = {
    teal: 'border-teal-200 bg-teal-50 text-teal-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
  };
  const selected = state.hubSelectedType === type;
  return `<button type="button" onclick="window.__importer.selectHubType('${type}')" aria-pressed="${selected}" class="min-h-[130px] rounded-lg border p-4 text-left transition-colors ${selected ? 'border-teal-500 bg-teal-50/60 ring-1 ring-teal-100' : 'border-slate-200 bg-white hover:border-teal-300'}">
    <span class="flex items-start justify-between gap-3"><span class="icon-surface ${tones[tone] || tones.slate}"><span class="material-symbols-outlined icon-kpi">${icon}</span></span>${selected ? '<span class="material-symbols-outlined icon-inline text-teal-700">check_circle</span>' : ''}</span>
    <span class="mt-3 block text-base font-semibold text-slate-900">${esc(title)}</span>
    <span class="mt-1 block text-xs leading-5 text-slate-500">${esc(desc)}</span>
    <span class="mt-2 block text-xs text-slate-500">${esc(meta)}</span>
  </button>`;
}

function hubUploadPanel() {
  const copyByType = {
    boq: ['工程量清单', 'Excel / CSV', '开始清单导入'],
    boq_library: ['清单库', 'Excel / CSV', '开始清单库导入'],
    quota: ['常用定额', 'Excel / CSV', '开始定额导入'],
    material: ['材料库', 'Excel / CSV', '开始材料导入'],
    equipment: ['设备库', 'Excel / CSV', '开始设备导入'],
  };
  const [type, formats, action] = copyByType[state.hubSelectedType] || copyByType.boq;
  return `<section class="mt-4 border-t border-slate-200 pt-4" aria-labelledby="upload-file-title">
    <div class="flex items-center justify-between gap-3"><h3 id="upload-file-title" class="text-sm font-semibold text-slate-800">第 2 步：上传 ${type} 文件</h3><span class="text-xs text-slate-500">支持 ${formats}，单文件不超过 200MB</span></div>
    <button type="button" onclick="window.__importer.continueHubImport()" class="mt-3 flex min-h-[92px] w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-4 text-center hover:border-teal-400 hover:bg-teal-50/40">
      <span class="material-symbols-outlined icon-page text-teal-600">cloud_upload</span><span class="mt-2 text-sm font-semibold text-slate-800">将文件拖拽到此处，或 <span class="text-teal-700">点击上传</span></span><span class="mt-1 text-xs text-slate-500">${esc(action)}后将自动进入字段识别与数据质检</span>
    </button>
    <div class="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500"><span class="flex items-center gap-1.5"><span class="material-symbols-outlined icon-inline text-blue-600">info</span>建议先下载模板填写数据，确保字段规范。</span><button type="button" onclick="window.__importer.downloadTemplate()" class="font-medium text-teal-700 hover:underline">下载 Excel 模板</button></div>
  </section>`;
}

function hubRecentRow(icon, fileName, type, count, status, badgeClass) {
  return `<div class="flex items-center gap-3 px-5 py-3">
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50 text-slate-600"><span class="material-symbols-outlined icon-inline">${icon}</span></span>
    <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium text-slate-800">${esc(fileName)}</div><div class="mt-0.5 text-xs text-slate-500">${esc(type)} · ${esc(count)}</div></div>
    <span class="badge ${badgeClass}">${esc(status)}</span>
  </div>`;
}

function hubRecentImports() {
  const meta = {
    project_boq: ['list_alt', '项目清单'], boq_library: ['format_list_bulleted', '清单库'], quota: ['menu_book', '常用定额'],
    material: ['category', '材料库'], equipment: ['precision_manufacturing', '设备库'],
  };
  let records = [];
  try { records = JSON.parse(localStorage.getItem('costdb_import_history_v1') || '[]'); } catch { records = []; }
  if (!Array.isArray(records) || !records.length) return '<div class="px-5 py-8 text-center text-sm text-slate-400">暂无真实导入记录</div>';
  return records.slice(0, 5).map(record => {
    const [icon, label] = meta[record.targetType] || ['upload_file', '数据'];
    const warning = record.outcome === 'success_with_warnings' || Number(record.notWritten || 0) > 0;
    return hubRecentRow(icon, record.sourceName || '未命名文件', label, `${Number(record.committed || 0).toLocaleString('zh-CN')} 条写入`, warning ? '有警告' : '已完成', warning ? 'badge-yellow' : 'badge-green');
  }).join('');
}

function hubCheck(icon, text) {
  return `<li class="flex items-center gap-2"><span class="material-symbols-outlined icon-inline text-emerald-600">${icon}</span>${esc(text)}</li>`;
}

function paint(workspace = document.getElementById('workspace')) {
  const project = currentProject();
  const mappedRows = getMappedRows();
  const quality = analyzeRows(mappedRows);
  const filteredRows = filterPreviewRows(mappedRows, quality);
  const hasUploaded = Boolean(state.fileName);

  workspace.innerHTML = `
    <div class="page-frame h-[calc(100dvh-112px)] min-h-[620px] flex flex-col">
      <div class="mb-3 flex items-center gap-3">
        <button onclick="window.__importer.showHub()" class="h-10 w-10 border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 flex items-center justify-center" title="返回导入中心" aria-label="返回导入中心">
          <span class="material-symbols-outlined text-[20px]">arrow_back</span>
        </button>
        <div>
          <div class="text-lg font-semibold text-slate-900">当前任务：导入项目清单</div>
          <div class="mt-0.5 text-xs text-slate-500">把 Excel 清单整理成可编辑的项目清单，先检查，再保存到当前项目。</div>
        </div>
        <div class="flex-1"></div>
        <label class="h-10 min-w-[260px] rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
          <span class="material-symbols-outlined text-[18px] text-blue-600">domain</span>
          <select class="w-full bg-transparent outline-none" onchange="window.__importer.setProject(this.value)">
            ${state.projects.map(p => `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>
        <button onclick="window.__importer.saveDraft()" class="h-10 px-4 text-sm border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[18px]">save</span>保存草稿
        </button>
        <button onclick="window.__importer.confirmImport()" class="h-10 px-4 text-sm brand-bg text-white flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[18px]">download_done</span>保存到项目
        </button>
      </div>

      <div class="grid grid-cols-[minmax(0,1fr)_350px] gap-4 flex-1 min-h-0">
        <section class="min-w-0 min-h-0 flex flex-col gap-3">
          ${uploadZone(hasUploaded)}
          ${fileSummary(hasUploaded, mappedRows.length)}
          ${mappingGrid()}
          ${previewTable(filteredRows, quality)}
        </section>
        <aside class="min-w-0 border-l border-slate-200 pl-4">
          ${qualityPanel(quality, project)}
        </aside>
      </div>
    </div>
  `;
  bindUploadEvents(workspace);
}

function uploadZone(hasUploaded) {
  return `
    <div id="importDropZone" class="shrink-0 rounded-lg border border-dashed ${hasUploaded ? 'border-teal-300 bg-teal-50/40' : 'border-blue-300 bg-white'} px-5 py-4">
      <input id="importFileInput" type="file" accept=".xlsx,.xls" class="hidden" />
      <button onclick="window.__importer.pickFile()" class="w-full flex items-center justify-center gap-4 text-left">
          <span class="h-11 w-11 rounded-lg border border-blue-200 bg-blue-50 text-blue-600 flex items-center justify-center">
          <span class="material-symbols-outlined text-[28px]">upload_file</span>
        </span>
        <span>
          <span class="block font-semibold text-slate-900">${hasUploaded ? '重新选择 Excel 文件' : '点击或拖拽 Excel 文件到此处上传'}</span>
          <span class="mt-1 block text-xs text-slate-500">支持 .xlsx / .xls，建议单文件不超过 200MB。上传后先做字段映射与质量检查。</span>
        </span>
      </button>
    </div>
  `;
}

function fileSummary(hasUploaded, count) {
  const size = state.fileSize ? `${(state.fileSize / 1024 / 1024).toFixed(2)} MB` : '示例数据';
  return `
    <div class="shrink-0 rounded-lg border border-slate-200 bg-white p-3">
      <div class="grid grid-cols-[minmax(220px,1.5fr)_repeat(4,minmax(100px,0.7fr))] items-center divide-x divide-slate-200">
        <div class="min-w-0 pr-4 flex items-center gap-3">
          <span class="h-11 w-11 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 flex items-center justify-center">
            <span class="material-symbols-outlined text-[26px]">csv</span>
          </span>
          <div class="min-w-0">
            <div class="font-semibold text-slate-900 truncate">${esc(state.fileName || '污水厂清单_2026.xlsx')}</div>
            <div class="mt-1 flex items-center gap-2 text-xs text-slate-500">
              <span class="badge ${hasUploaded ? 'badge-green' : 'badge-yellow'}">${hasUploaded ? '已解析' : '示例预览'}</span>
              <span>${size}</span>
            </div>
          </div>
        </div>
        ${summaryCell(count.toLocaleString('zh-CN'), '总行数')}
        ${summaryCell(state.headers.length, '总列数')}
        ${summaryCell('清单明细', 'Sheet')}
        <div class="pl-4 text-right">
          <button onclick="window.__importer.pickFile()" class="text-sm font-medium text-teal-700 hover:underline">重新解析</button>
        </div>
      </div>
    </div>
  `;
}

function summaryCell(value, label) {
  return `<div class="px-4">
    <div class="text-base font-semibold tabular-nums text-slate-900">${value}</div>
    <div class="mt-1 text-xs text-slate-500">${label}</div>
  </div>`;
}

function mappingGrid() {
  const recommendation = state.templateRecommendation;
  return `
    <section class="shrink-0 rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200 flex items-center gap-3">
        <div>
          <div class="font-semibold text-slate-900">字段映射</div>
          <div class="mt-1 text-xs text-slate-500">系统已按常见表头自动匹配；可保存为模板、使用固定值或手动调整来源列。</div>
        </div>
        <div class="flex-1"></div>
        <button onclick="window.__importer.showTemplateMenu()" class="px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 border border-slate-300 bg-white inline-flex items-center gap-1"><span class="material-symbols-outlined text-[15px]">bookmark</span>模板</button>
        <button onclick="window.__importer.showSaveTemplate()" class="px-2.5 py-1.5 text-xs text-teal-700 hover:bg-teal-50 border border-teal-200 bg-white">另存模板</button>
        ${state.activeTemplateId ? '<button onclick="window.__importer.updateActiveTemplate()" class="px-2.5 py-1.5 text-xs text-teal-700 hover:bg-teal-50 border border-teal-200 bg-white">更新当前模板</button>' : ''}
        <button onclick="window.__importer.aiMap()" class="px-2.5 py-1.5 text-xs text-teal-700 hover:bg-teal-50 border border-teal-200 bg-teal-50 inline-flex items-center gap-1">
          <span class="material-symbols-outlined text-[15px]">auto_awesome</span>AI 识别字段
        </button>
        <button onclick="window.__importer.autoMap()" class="px-2.5 py-1.5 text-xs text-teal-700 hover:bg-teal-50 border border-teal-200 bg-white">自动映射</button>
        <button onclick="window.__importer.clearMapping()" class="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 border border-slate-200 bg-white">清空映射</button>
        ${state.draftAvailable ? '<button onclick="window.__importer.restoreDraft()" class="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 border border-slate-200 bg-white">恢复草稿</button>' : ''}
      </div>
      ${recommendation ? templateRecommendationCard(recommendation) : ''}
      <div class="px-4 py-2 border-b border-slate-100 bg-slate-50 flex items-center gap-3 text-xs text-slate-600">
        <span class="font-medium text-slate-700">金额规则</span>
        <select onchange="window.__importer.setAmountRule(this.value)" class="h-7 rounded border border-slate-300 bg-white px-2 text-xs">
          <option value="calculated" ${state.amountRule === 'calculated' ? 'selected' : ''}>数量 × 综合单价</option>
          <option value="sourceAmount" ${state.amountRule === 'sourceAmount' ? 'selected' : ''}>优先使用 Excel 合价</option>
          <option value="deriveUnitPrice" ${state.amountRule === 'deriveUnitPrice' ? 'selected' : ''}>合价 ÷ 数量补单价</option>
        </select>
        <span class="text-slate-400">当前规则会同步用于预览与保存。</span>
      </div>
      <div class="max-h-[220px] overflow-auto scroll-thin">
        <table class="w-full min-w-[760px] table-fixed text-sm">
          <colgroup>
            <col class="w-[30%]" />
            <col class="w-[22%]" />
            <col class="w-[34%]" />
            <col class="w-[14%]" />
          </colgroup>
          <thead class="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500">
            <tr class="text-left">
              <th class="px-3 py-2 whitespace-nowrap">Excel 列名（来源）</th>
              <th class="px-3 whitespace-nowrap">系统字段</th>
              <th class="px-3 whitespace-nowrap">识别示例</th>
              <th class="px-3 whitespace-nowrap">状态</th>
            </tr>
          </thead>
          <tbody>
            ${IMPORT_FIELD_DEFS.map(def => mappingRow(def)).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function mappingRow(def) {
  const source = state.mapping[def.key] || '';
  const mappingSource = state.mappingSources[def.key] || { type: source ? 'column' : 'none', value: source };
  const isFixed = mappingSource.type === 'fixed';
  const sample = isFixed ? (state.fixedValues[def.key] || '') : source ? firstNonEmpty(state.rawRows, source) : '';
  const meta = state.mappingMeta[def.key] || { status: source ? 'confirmed' : 'missing', reason: source ? '已确认来源列' : '未找到可识别的来源列' };
  const status = mappingStatus(meta);
  return `
    <tr class="border-t border-slate-100">
      <td class="py-2 px-3">
        <div class="flex gap-1.5">
          <select class="h-8 w-24 rounded border border-slate-300 bg-white px-1.5 text-xs" onchange="window.__importer.setMappingMode('${def.key}', this.value)">
            <option value="column" ${mappingSource.type === 'column' ? 'selected' : ''}>Excel 列</option>
            ${canUseFixedValue(def.key) ? `<option value="fixed" ${mappingSource.type === 'fixed' ? 'selected' : ''}>固定值</option>` : ''}
            <option value="none" ${mappingSource.type === 'none' ? 'selected' : ''}>不映射</option>
          </select>
          ${isFixed ? `<input value="${esc(state.fixedValues[def.key] || '')}" oninput="window.__importer.setFixedValue('${def.key}', this.value)" placeholder="输入固定值" class="h-8 min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 text-sm" />` : mappingSource.type === 'none' ? '<div class="h-8 flex-1 rounded border border-dashed border-slate-200 px-2 flex items-center text-xs text-slate-400">不参与导入</div>' : `<select class="h-8 min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 text-sm" onchange="window.__importer.setMapping('${def.key}', this.value)"><option value="">请选择列</option>${state.headers.map(h => `<option value="${esc(h)}" ${source === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`}
        </div>
      </td>
      <td class="px-3 font-medium text-slate-800">
        ${esc(def.label)} ${def.required ? '<span class="text-red-500">*</span>' : ''}
      </td>
      <td class="px-3 text-slate-600"><div class="truncate" title="${esc(sample || '-')}">${esc(sample || '-')}</div></td>
      <td class="px-3">
        <div class="whitespace-nowrap">${status.badge}</div>
        <div class="mt-1 truncate text-[11px] text-slate-500" title="${esc(meta.reason || '')}">${esc(meta.reason || '')}</div>
        ${!source && meta.candidateSource ? `<button onclick="window.__importer.useCandidate('${def.key}')" class="mt-1 text-[11px] font-medium text-teal-700 hover:underline">使用候选列</button>` : ''}
      </td>
    </tr>
  `;
}

function mappingStatus(meta) {
  if (meta.status === 'template') return { badge: '<span class="badge badge-blue">模板应用</span>' };
  if (meta.status === 'fixed') return { badge: '<span class="badge badge-blue">固定值</span>' };
  if (meta.status === 'template-missing') return { badge: '<span class="badge badge-red">模板列缺失</span>' };
  if (meta.status === 'confirmed') return { badge: '<span class="badge badge-green">已确认</span>' };
  if (meta.status === 'needs-review') return { badge: '<span class="badge badge-yellow">待确认</span>' };
  return { badge: '<span class="badge badge-gray">未找到</span>' };
}

function templateRecommendationCard(recommendation) {
  const template = getMappingTemplate(recommendation.templateId);
  if (!template) return '';
  const detail = recommendation.missingSources.length ? `缺少：${recommendation.missingSources.join('、')}` : '所有模板列均可用';
  return `<div class="mx-4 mt-3 rounded border border-teal-200 bg-teal-50 px-3 py-2 flex items-center gap-3 text-xs">
    <span class="material-symbols-outlined text-teal-700 text-[18px]">tips_and_updates</span>
    <div class="min-w-0 flex-1"><span class="font-semibold text-teal-900">推荐模板：${esc(template.name)}</span><span class="ml-2 text-teal-800">匹配 ${recommendation.score}% · ${recommendation.matchedFields.length} 个字段</span><div class="mt-0.5 truncate text-teal-800/80">${esc(detail)}</div></div>
    <button onclick="window.__importer.applyTemplate('${template.id}')" class="px-2.5 py-1.5 border border-teal-300 bg-white text-teal-800 hover:bg-teal-100">应用模板</button>
  </div>`;
}

function previewTable(rows, quality) {
  const total = getMappedRows().length;
  const pageCount = Math.max(1, Math.ceil(rows.length / state.previewPageSize));
  const page = Math.min(state.previewPage, pageCount);
  const pageStart = (page - 1) * state.previewPageSize;
  const pageRows = rows.slice(pageStart, pageStart + state.previewPageSize);
  const firstRow = rows.length ? pageStart + 1 : 0;
  const lastRow = pageStart + pageRows.length;
  return `
    <section class="rounded-lg border border-slate-200 bg-white overflow-hidden flex-1 min-h-[260px] flex flex-col">
      <div class="px-4 py-3 border-b border-slate-200 flex items-center gap-3 shrink-0">
        <div>
          <div class="font-semibold text-slate-900">数据预览</div>
          <div class="mt-1 text-xs text-slate-500">共 ${total.toLocaleString('zh-CN')} 行，当前筛选 ${rows.length.toLocaleString('zh-CN')} 行，已选中 ${state.selectedRows.size} 行。</div>
        </div>
        <div class="flex-1"></div>
        <label class="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" ${state.previewOnlyIssues ? 'checked' : ''} onchange="window.__importer.setPreviewIssues(this.checked)" />
          仅显示问题行
        </label>
        <div class="relative w-72">
          <input value="${esc(state.keyword)}" oninput="window.__importer.setKeyword(this.value)" placeholder="搜索清单名称 / 项目特征"
            class="h-9 w-full rounded border border-slate-300 bg-white pl-9 pr-3 text-sm" />
          <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[18px]">search</span>
        </div>
      </div>
      <div class="overflow-auto scroll-thin flex-1">
        <table class="w-full text-sm table-fixed">
          <thead>
            <tr class="text-left border-b">
              <th class="py-2 px-3 w-12">序号</th>
              <th class="px-3 w-52">清单名称</th>
              <th class="px-3">项目特征</th>
              <th class="px-3 w-16">单位</th>
              <th class="px-3 w-24 text-right">工程量</th>
              <th class="px-3 w-28 text-right">综合单价</th>
              <th class="px-3 w-28 text-right">合价</th>
              <th class="px-3 w-24">工艺段</th>
              <th class="px-3 w-28">成本分类</th>
            </tr>
          </thead>
          <tbody>
            ${pageRows.length ? pageRows.map(row => previewRow(row, quality)).join('') : `<tr><td colspan="9" class="py-10 text-center text-slate-400">没有符合条件的预览行。</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="px-4 py-3 border-t border-slate-200 bg-white flex items-center gap-2 text-xs text-slate-500 shrink-0">
        <span>显示 ${firstRow}-${lastRow} / ${rows.length.toLocaleString('zh-CN')} 行</span>
        <span class="text-slate-300">|</span>
        <span class="${quality.errorCount ? 'text-red-600' : 'text-teal-700'}">${quality.errorCount ? `需修正 ${quality.errorCount} 个问题` : '检查通过'}</span>
        <div class="flex-1"></div>
        <label class="flex items-center gap-1.5">
          <span>每页</span>
          <select onchange="window.__importer.setPreviewPageSize(this.value)" class="h-7 rounded border border-slate-300 bg-white px-1.5 text-xs">
            ${PREVIEW_PAGE_SIZES.map(size => `<option value="${size}" ${state.previewPageSize === size ? 'selected' : ''}>${size}</option>`).join('')}
          </select>
          <span>条</span>
        </label>
        <div class="flex items-center gap-1">
          <button onclick="window.__importer.setPreviewPage(${page - 1})" ${page === 1 ? 'disabled' : ''} title="上一页" aria-label="上一页" class="h-7 w-7 border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center"><span class="material-symbols-outlined text-[16px]">chevron_left</span></button>
          <span class="min-w-16 text-center tabular-nums">${page} / ${pageCount}</span>
          <button onclick="window.__importer.setPreviewPage(${page + 1})" ${page === pageCount ? 'disabled' : ''} title="下一页" aria-label="下一页" class="h-7 w-7 border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center"><span class="material-symbols-outlined text-[16px]">chevron_right</span></button>
        </div>
      </div>
    </section>
  `;
}

function previewRow(row, quality) {
  const hasIssue = quality.issueRows.has(row.index);
  const rowBg = hasIssue ? 'bg-amber-50/40' : 'hover:bg-slate-50';
  const priceMissing = quality.priceMapped && hasMissingPrice(row.unitPrice);
  return `
    <tr class="border-b border-slate-100 ${rowBg}">
      <td class="py-2 px-3 tabular-nums text-slate-500">${row.index + 1}</td>
      <td class="px-3 font-medium text-slate-800 truncate" title="${esc(row.name)}">${esc(row.name || '-')}</td>
      <td class="px-3 text-slate-600 truncate" title="${esc(row.feature)}">${esc(row.feature || '-')}</td>
      <td class="px-3 ${!row.unit ? 'bg-red-50 text-red-700' : ''}">${esc(row.unit || '缺失')}</td>
      <td class="px-3 text-right tabular-nums ${row.qty <= 0 ? 'bg-amber-50 text-amber-700' : ''}">${formatNumber(row.qty)}</td>
      <td class="px-3 text-right tabular-nums ${priceMissing ? 'bg-amber-50 text-amber-700' : !quality.priceMapped ? 'text-slate-400' : ''}">
        ${!quality.priceMapped ? '未映射' : priceMissing ? '-' : fmtMoney(row.unitPrice)}
      </td>
      <td class="px-3 text-right tabular-nums ${state.amountRule === 'sourceAmount' ? 'text-teal-700 font-medium' : 'text-slate-600'}">${fmtMoney(row.amount)}</td>
      <td class="px-3 text-slate-600 truncate">${esc(row.process || '-')}</td>
      <td class="px-3 text-slate-600 truncate">${esc(row.costCategory || categoryGuess(row.name))}</td>
    </tr>
  `;
}

function qualityPanel(quality, project) {
  const repairs = suggestImportRepairs(getMappedRows(), quality, { project }).suggestions || [];
  const errorTabLabel = quality.errorCount
    ? `错误 (${quality.errorCount})`
    : quality.priceMapped ? '错误 (0)' : '待确认 (1)';
  const tabs = [
    ['errors', errorTabLabel],
    ['warnings', `警告 (${quality.warningCount})`],
    ['suggestions', `建议 (${quality.suggestionCount})`],
  ];
  return `
    <div class="h-full flex flex-col min-h-0">
      <div class="shrink-0">
        <div class="font-semibold text-slate-900">导入检查</div>
        <div class="mt-2 grid grid-cols-3 gap-2">
          ${metricBox('识别行', quality.total, '')}
          ${metricBox('可保存', quality.importable, 'text-teal-700')}
          ${metricBox('质量分', `${quality.score}`, quality.score >= 80 ? 'text-teal-700' : 'text-amber-700')}
        </div>
        <div class="mt-4 flex border-b border-slate-200">
          ${tabs.map(([key, label]) => `<button onclick="window.__importer.setIssueTab('${key}')" class="px-4 py-2 text-sm border-b-2 ${state.activeIssueTab === key ? 'border-teal-600 text-teal-700 font-semibold' : 'border-transparent text-slate-500'}">${label}</button>`).join('')}
        </div>
        <div class="mt-3 text-xs text-slate-500">共 <span class="text-red-600 font-semibold">${quality.errorCount + quality.warningCount}</span> 条问题，涉及 ${quality.issueRows.size} 行。</div>
      </div>

      <div class="mt-3 flex-1 min-h-0 overflow-auto scroll-thin space-y-3 pr-1">
        ${issueCards(quality)}
        ${repairs.length ? `<div class="rounded-lg border border-teal-200 bg-teal-50 p-3">
          <div class="flex items-center gap-2 font-medium text-teal-900">
            <span class="material-symbols-outlined text-[17px]">auto_awesome</span>AI 修复建议
          </div>
          <div class="mt-2 space-y-2 text-xs text-teal-900">
            ${repairs.slice(0, 8).map(item => `<div class="rounded border border-teal-200 bg-white/80 px-2 py-2">
              <div class="font-medium">第 ${Number(item.rowIndex || 0) + 1} 行 · ${esc(item.type)}</div>
              <div class="mt-1 leading-5">${esc(item.suggestion)}</div>
            </div>`).join('')}
          </div>
          ${repairs.length > 8 ? `<div class="mt-2 text-xs text-teal-800/80">另有 ${repairs.length - 8} 条建议未显示。</div>` : ''}
        </div>` : ''}
      </div>

      <div class="mt-4 shrink-0 rounded-lg border border-slate-200 bg-white p-3">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[18px] text-teal-700">inventory_2</span>
          <div class="font-medium text-slate-900">保存目标</div>
        </div>
        <div class="mt-2 text-xs text-slate-500">项目：${esc(project?.name || '未选择项目')}</div>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <label class="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-xs">
            <input type="radio" name="importMode" value="append" ${state.importMode === 'append' ? 'checked' : ''} onchange="window.__importer.setMode('append')" />
            追加到当前清单
          </label>
          <label class="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-xs">
            <input type="radio" name="importMode" value="replace" ${state.importMode === 'replace' ? 'checked' : ''} onchange="window.__importer.setMode('replace')" />
            覆盖当前清单
          </label>
        </div>
        <div class="mt-3 flex gap-2">
          <button onclick="window.__importer.goBOQ()" class="flex-1 h-9 text-sm border border-slate-300 bg-white hover:bg-slate-50">打开清单</button>
          <button onclick="window.__importer.confirmImport()" class="flex-1 h-9 text-sm brand-bg text-white">保存到项目</button>
        </div>
      </div>
    </div>
  `;
}

function metricBox(label, value, cls) {
  return `<div class="rounded border border-slate-200 bg-white px-3 py-2">
    <div class="text-[11px] text-slate-500">${label}</div>
    <div class="mt-1 text-lg font-semibold tabular-nums ${cls || 'text-slate-900'}">${value}</div>
  </div>`;
}

function issueCards(quality) {
  const issues = state.activeIssueTab === 'errors' ? [
    {
      icon: 'functions',
      tone: quality.amountRuleInvalid ? 'red' : 'green',
      title: quality.amountRuleInvalid ? '金额规则缺少合价来源列' : '金额规则可用',
      desc: quality.amountRuleInvalid ? '当前规则依赖 Excel 合价列，请先映射“合价”字段，或改回数量乘单价。' : `当前使用：${amountRuleLabel(state.amountRule)}`,
      rows: [],
      action: '',
      handler: '',
    },
    {
      icon: 'rule',
      tone: 'red',
      title: `必填字段未映射（${quality.requiredUnmapped.length}）`,
      desc: '名称、单位和工程量必须绑定 Excel 列后才能保存。',
      rows: [],
      action: '',
      handler: '',
    },
    {
      icon: 'link_off',
      tone: 'red',
      title: `模板列缺失（${quality.templateMissing.length}）`,
      desc: quality.templateMissing.length ? quality.templateMissing.map(item => item.label || item.key).join('、') : '当前模板引用的列都存在。',
      rows: [],
      action: '',
      handler: '',
    },
    {
      icon: quality.priceMapped ? 'error' : 'info',
      tone: quality.priceMapped ? 'red' : 'amber',
      title: priceIssueTitle(quality),
      desc: priceIssueDescription(quality),
      rows: quality.missingPrice,
      action: quality.priceMapped ? '批量设为待询价' : '',
      handler: quality.priceMapped ? 'repairMissingPrice' : '',
    },
    {
      icon: 'error',
      tone: 'red',
      title: `单位缺失（${quality.missingUnit.length}）`,
      desc: '存在单位为空或无法识别的行，会影响指标口径。',
      rows: quality.missingUnit,
      action: '使用上一行单位',
      handler: 'repairUnitFromPrevious',
    },
  ] : state.activeIssueTab === 'warnings' ? [
    {
      icon: 'warning',
      tone: 'amber',
      title: `无法识别分类（${quality.unknownCategory.length}）`,
      desc: '成本分类无法稳定匹配到系统分类，建议先归到其他分类。',
      rows: quality.unknownCategory,
      action: '映射到其他分类',
      handler: 'mapUnknownCategory',
    },
    {
      icon: 'warning',
      tone: 'amber',
      title: `工程量为 0（${quality.zeroQty.length}）`,
      desc: '工程量为空或为 0 的行会导致合价为 0。',
      rows: quality.zeroQty,
      action: '仅保留预警',
      handler: '',
    },
    {
      icon: 'warning',
      tone: 'amber',
      title: `合价不一致（${quality.amountMismatch.length}）`,
      desc: 'Excel 合价与工程量乘综合单价存在大于 0.01 的差异，系统不会自动改写原数据。',
      rows: quality.amountMismatch,
      action: '',
      handler: '',
    },
  ] : [
    {
      icon: 'tips_and_updates',
      tone: 'blue',
      title: `重复清单项（${quality.duplicates.length}）`,
      desc: '存在重复的清单名称及项目特征，可合并后再保存。',
      rows: quality.duplicates,
      action: '合并重复项',
      handler: 'mergeDuplicateRows',
    },
    {
      icon: 'check_circle',
      tone: 'green',
      title: `已通过检查项（${quality.passCount}）`,
      desc: '这些行已具备保存所需的名称、单位、工程量字段。',
      rows: [],
      action: '',
      handler: '',
    },
  ];

  return issues.map(issueCard).join('');
}

function priceIssueTitle(quality) {
  if (quality.priceMapped) return `缺单价（${quality.missingPrice.length}）`;
  return quality.priceField.status === 'needs-review' ? '单价列待确认' : '未识别单价列';
}

function priceIssueDescription(quality) {
  if (quality.priceMapped) return '存在综合单价为空或非数字的行，保存后将按 0 计价。';
  if (quality.priceField.status === 'needs-review') return `检测到候选列“${quality.priceField.candidateSource}”，因置信度不足未自动使用，请在字段映射区确认。`;
  return '源文件中未找到可识别的综合单价列。若文件本身没有报价，可继续保存并在后续补价。';
}

function issueCard(issue) {
  const colors = {
    red: 'border-red-200 bg-red-50/40 text-red-700',
    amber: 'border-amber-200 bg-amber-50/40 text-amber-700',
    blue: 'border-blue-200 bg-blue-50/40 text-blue-700',
    green: 'border-emerald-200 bg-emerald-50/40 text-emerald-700',
  };
  const rows = issue.rows.slice(0, 4);
  return `
    <div class="rounded-lg border ${colors[issue.tone] || colors.blue} bg-white overflow-hidden">
      <div class="px-3 py-3 flex items-start gap-2">
        <span class="material-symbols-outlined text-[18px] mt-0.5">${issue.icon}</span>
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-slate-900">${esc(issue.title)}</div>
          <div class="mt-1 text-xs text-slate-500">${esc(issue.desc)}</div>
          ${rows.length ? `<div class="mt-3 space-y-1 text-xs text-slate-600">${rows.map(r => `<div>第 ${r.index + 1} 行　${esc(r.name || '未命名清单')}</div>`).join('')}<div>...</div></div>` : ''}
          ${issue.action ? `<div class="mt-3 text-right"><button onclick="${issue.handler ? `window.__importer.${issue.handler}()` : ''}" class="px-3 py-1.5 text-xs rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">${esc(issue.action)}</button></div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function bindUploadEvents(workspace = document.getElementById('workspace')) {
  const input = workspace.querySelector('#importFileInput');
  const dropZone = workspace.querySelector('#importDropZone');
  if (!input || !dropZone) return;
  input.onchange = () => handleFile(input.files?.[0], workspace);
  dropZone.ondragover = e => {
    e.preventDefault();
    dropZone.classList.add('ring-2', 'ring-blue-300');
  };
  dropZone.ondragleave = () => dropZone.classList.remove('ring-2', 'ring-blue-300');
  dropZone.ondrop = e => {
    e.preventDefault();
    dropZone.classList.remove('ring-2', 'ring-blue-300');
    handleFile(e.dataTransfer?.files?.[0], workspace);
  };
}

function pickFile(workspace = document.getElementById('workspace')) {
  workspace.querySelector('#importFileInput')?.click();
}

async function handleFile(file, workspace = document.getElementById('workspace')) {
  if (!file) return;
  try {
    const rows = await parseExcel(file);
    if (!rows.length) {
      toast('文件为空或第一个工作表没有可读取的数据', 'error');
      return;
    }
    state.fileName = file.name;
    state.fileSize = file.size || 0;
    state.rawRows = rows;
    state.headers = Object.keys(rows[0] || {});
    applyMappingResult(buildImportMapping(state.headers, state.rawRows));
    refreshTemplateRecommendation();
    state.selectedRows.clear();
    state.previewPage = 1;
    toast(`已解析 ${rows.length} 行，${mappingToastMessage('自动确认')}`, 'success');
    paint(workspace);
  } catch (err) {
    console.error(err);
    toast(`解析失败：${err.message}`, 'error');
  }
}

async function importQuotaExcel() {
  await window.__app.go('ai-import', { targetType: 'quota' });
}

function showQuotaImportResult(result) {
  openModal('常用定额导入结果', `
    <div class="grid grid-cols-4 gap-2 text-sm mb-4">
      ${importResultBox('总行数', result.total)}
      ${importResultBox('成功', result.success)}
      ${importResultBox('失败', result.failed)}
      ${importResultBox('缺单价', result.missingPrice)}
    </div>
    <div class="text-sm text-slate-600 mb-3">新增 ${result.added} 条，更新 ${result.updated} 条，跳转到我的定额库后可继续筛选缺单价或加入项目清单。</div>
    ${(result.warnings || []).length ? `
      <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 max-h-56 overflow-auto scroll-thin">
        <div class="font-medium text-amber-900 mb-1">需要注意</div>
        <ul class="list-disc pl-5 text-sm text-amber-800 space-y-1">
          ${result.warnings.slice(0, 30).map(w => `<li>${esc(w)}</li>`).join('')}
        </ul>
        ${result.warnings.length > 30 ? `<div class="text-xs text-amber-700 mt-2">仅显示前 30 条提示。</div>` : ''}
      </div>
    ` : '<div class="text-sm text-slate-500">未发现导入警告。</div>'}
  `, `
    <button id="quotaAiClean" class="px-3 py-1.5 text-sm border border-teal-300 text-teal-700 rounded">AI 清洗导入定额</button>
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm brand-bg text-white rounded">知道了</button>
  `);
  document.getElementById('quotaAiClean').onclick = showQuotaBatchCleanup;
}

async function showQuotaBatchCleanup() {
  const result = await suggestQuotaBatchCleanup(await quotaRepo.all());
  const rows = result.suggestions || [];
  openModal('AI 清洗定额库', `
    <div class="space-y-4 text-sm">
      <div class="rounded border border-teal-200 bg-teal-50 p-3 text-teal-900">${esc(result.summary)}</div>
      <div class="max-h-[52vh] overflow-auto scroll-thin rounded border border-slate-200 bg-white">
        <table class="w-full text-xs">
          <thead class="sticky top-0 bg-slate-50 text-left text-slate-500"><tr><th class="py-2 px-2 w-10">应用</th><th class="px-2">名称</th><th class="px-2">分类</th><th class="px-2">单位</th><th class="px-2">特征/规则</th></tr></thead>
          <tbody>
            ${rows.map((row, index) => `<tr class="border-t">
              <td class="py-2 px-2"><input type="checkbox" data-quota-clean="${index}" ${row.apply ? 'checked' : ''} /></td>
              <td class="px-2 font-medium">${esc(row.name || '')}</td>
              <td class="px-2">${esc(row.category || '')}</td>
              <td class="px-2">${esc(row.unit || '')}</td>
              <td class="px-2 text-slate-500">${esc(row.feature || row.rule || '')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `, `
    <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border rounded">取消</button>
    <button id="quotaCleanApply" class="px-3 py-1.5 text-sm brand-bg text-white rounded">应用选中清洗</button>
  `);
  document.getElementById('quotaCleanApply').onclick = async () => {
    const selected = Array.from(document.querySelectorAll('[data-quota-clean]:checked')).map(input => rows[Number(input.dataset.quotaClean)]).filter(Boolean);
    for (const row of selected) {
      await quotaRepo.update(row.id, {
        category: row.category,
        unit: row.unit,
        tags: row.tags,
        feature: row.feature,
        work: row.work,
        rule: row.rule,
      });
    }
    closeModal();
    toast(`已清洗 ${selected.length} 条定额`, 'success');
    window.__app.go('quota');
  };
}

function importResultBox(label, value) {
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="text-xs text-slate-500">${esc(label)}</div>
    <div class="mt-1 text-xl font-semibold tabular-nums text-slate-900">${esc(value)}</div>
  </div>`;
}

function loadSample() {
  state.fileName = '';
  state.fileSize = 0;
  state.rawRows = SAMPLE_ROWS;
  state.headers = Object.keys(SAMPLE_ROWS[0]);
  applyMappingResult(buildImportMapping(state.headers, state.rawRows));
  refreshTemplateRecommendation();
  state.previewPage = 1;
}

function applyMappingResult(result) {
  state.mapping = result.mapping || {};
  state.mappingMeta = result.fields || {};
  state.mappingSources = Object.fromEntries(Object.entries(state.mapping).map(([key, value]) => [key, { type: value ? 'column' : 'none', value: value || '' }]));
  state.fixedValues = { ...(result.fixedValues || {}) };
  Object.keys(state.fixedValues).forEach(key => {
    state.mappingSources[key] = { type: 'fixed', value: state.fixedValues[key] };
    state.mappingMeta[key] = { ...(state.mappingMeta[key] || {}), status: 'fixed', reason: '将使用固定填充值' };
  });
  state.amountRule = result.amountRule || 'calculated';
}

function mappingToastMessage(prefix) {
  const fields = Object.values(state.mappingMeta);
  const confirmed = fields.filter(field => field.status === 'confirmed').length;
  const pending = fields.filter(field => field.status === 'needs-review').length;
  return `${prefix} ${confirmed} 项${pending ? `，${pending} 项待确认` : ''}`;
}

function getMappedRows() {
  return state.rawRows.map((row, index) => {
    const rawName = mappedValue(row, 'name');
    const rawFeature = mappedValue(row, 'feature');
    const split = splitNameFeature(rawName, rawFeature);
    const qty = parseNumber(mappedValue(row, 'qty'));
    const sourceUnitPrice = parseNumber(mappedValue(row, 'unitPrice'));
    const sourceAmount = parseNumber(mappedValue(row, 'amount'));
    const pricing = resolveImportPricing({ qty, unitPrice: sourceUnitPrice, amount: sourceAmount, amountRule: state.amountRule });
    return {
      index,
      source: row,
      name: split.name,
      feature: split.feature,
      unit: mappedValue(row, 'unit'),
      qty: pricing.qty,
      unitPrice: pricing.unitPrice,
      sourceAmount: pricing.sourceAmount,
      calculatedAmount: pricing.calculatedAmount,
      amount: pricing.amount,
      process: mappedValue(row, 'process'),
      costCategory: mappedValue(row, 'costCategory'),
    };
  });
}

function analyzeRows(rows) {
  const missingName = rows.filter(row => !row.name);
  const missingUnit = rows.filter(row => row.name && !row.unit);
  const priceField = state.mappingMeta.unitPrice || {};
  const amountField = state.mappingMeta.amount || {};
  const priceMapped = Boolean(state.mapping.unitPrice);
  const amountMapped = Boolean(state.mapping.amount);
  const amountRuleInvalid = (state.amountRule === 'sourceAmount' || state.amountRule === 'deriveUnitPrice') && !amountMapped;
  const missingPrice = priceMapped ? rows.filter(row => row.name && hasMissingPrice(row.unitPrice)) : [];
  const zeroQty = rows.filter(row => row.name && !(row.qty > 0));
  const unknownCategory = rows.filter(row => row.name && !row.costCategory && categoryGuess(row.name) === '其他');
  const requiredUnmapped = IMPORT_FIELD_DEFS.filter(def => def.required && !hasMappedValue(def.key));
  const templateMissing = Object.values(state.mappingMeta).filter(field => field.status === 'template-missing');
  const amountMismatch = rows.filter(row => row.name && row.sourceAmount > 0 && row.qty > 0 && row.unitPrice > 0 && Math.abs(row.sourceAmount - row.calculatedAmount) > 0.01);
  const derivablePrice = state.amountRule === 'deriveUnitPrice'
    ? rows.filter(row => row.name && row.sourceAmount > 0 && row.qty > 0 && !parseNumber(mappedValue(row.source, 'unitPrice')))
    : [];
  const seen = new Map();
  const duplicates = [];
  rows.forEach(row => {
    if (!row.name) return;
    const key = `${row.name}|${(row.feature || '').slice(0, 30)}`;
    if (seen.has(key)) duplicates.push(row);
    else seen.set(key, row.index);
  });
  const issueRows = new Set([...missingName, ...missingUnit, ...missingPrice, ...zeroQty, ...unknownCategory, ...duplicates].map(r => r.index));
  const errorCount = missingName.length + missingUnit.length + missingPrice.length + requiredUnmapped.length + templateMissing.length + (amountRuleInvalid ? 1 : 0);
  const warningCount = zeroQty.length + unknownCategory.length + amountMismatch.length;
  const suggestionCount = duplicates.length;
  const importable = rows.filter(row => row.name && row.unit && row.qty > 0).length;
  const score = rows.length ? Math.max(35, Math.round(100 - ((errorCount * 2 + warningCount + suggestionCount * 0.5) / rows.length) * 100)) : 0;
  return {
    total: rows.length,
    importable,
    score,
    missingName,
    missingUnit,
    missingPrice,
    priceField,
    priceMapped,
    amountField,
    amountMapped,
    amountRuleInvalid,
    requiredUnmapped,
    templateMissing,
    amountMismatch,
    derivablePrice,
    zeroQty,
    unknownCategory,
    duplicates,
    issueRows,
    errorCount,
    warningCount,
    suggestionCount,
    passCount: Math.max(0, rows.length - issueRows.size),
  };
}

function filterPreviewRows(rows, quality) {
  let next = rows;
  if (state.previewOnlyIssues) next = next.filter(row => quality.issueRows.has(row.index));
  const kw = state.keyword.trim().toLowerCase();
  if (kw) {
    next = next.filter(row => `${row.name} ${row.feature} ${row.process} ${row.costCategory}`.toLowerCase().includes(kw));
  }
  return next;
}

async function confirmImport() {
  if (!state.projectId) {
    toast('请先选择项目', 'error');
    return;
  }
  const quality = analyzeRows(getMappedRows());
  if (quality.requiredUnmapped.length) {
    toast(`请先完成必填字段映射：${quality.requiredUnmapped.map(field => field.label).join('、')}`, 'error');
    return;
  }
  if (quality.templateMissing.length) {
    toast('模板存在缺失来源列，请重新选择对应 Excel 列后再保存', 'error');
    return;
  }
  if (quality.amountRuleInvalid) {
    toast('当前金额规则需要先映射合价列', 'error');
    return;
  }
  const rows = getMappedRows()
    .filter(row => row.name && row.unit && row.qty > 0)
    .map(row => ({
      projectId: state.projectId,
      code: '',
      name: row.name,
      feature: row.feature,
      unit: row.unit,
      qty: row.qty,
      factor: 1,
      unitPrice: row.unitPrice,
      amount: row.amount,
      priceMissing: hasMissingPrice(row.unitPrice),
      structureGroup: row.costCategory || categoryGuess(row.name),
    }));
  if (!rows.length) {
    toast('没有可保存的清单行', 'error');
    return;
  }
  if (!state.fileName && !confirm('当前显示的是示例预览数据。确认后会保存到所选项目清单，仅建议用于体验流程。确定保存？')) return;
  if (state.importMode === 'replace' && !confirm('覆盖会删除当前项目现有清单，但不会删除已保存的报价版本。确定覆盖？')) return;
  try {
    const result = await boqService.importLines(state.projectId, rows, { mode: state.importMode });
    const engine = await dataEngineService.ingestBOQ(state.projectId, {
      sourceType: 'excel_import_workbench',
      sourceId: state.fileName || '示例预览数据',
    });
    toast(`已保存 ${result.success} 条，新增 ${engine.candidates.length} 条待检查记录`, 'success');
    window.__app.state.currentProjectId = state.projectId;
    window.__app.go('importer', {
      mode: 'hub',
      importResult: {
        projectId: state.projectId,
        success: result.success,
        missingPrice: result.missingPrice,
        total: rows.length,
        sourceName: state.fileName || '项目工程量清单',
      },
    });
  } catch (err) {
    console.error(err);
    toast(`保存失败：${err.message}`, 'error');
  }
}

function saveDraft() {
  const payload = {
    projectId: state.projectId,
    fileName: state.fileName,
    fileSize: state.fileSize,
    rawRows: state.rawRows,
    headers: state.headers,
    mapping: state.mapping,
    mappingMeta: state.mappingMeta,
    mappingSources: state.mappingSources,
    fixedValues: state.fixedValues,
    amountRule: state.amountRule,
    activeTemplateId: state.activeTemplateId,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem('importer_draft', JSON.stringify(payload));
  state.draftAvailable = true;
  toast('导入草稿已保存到本机', 'success');
}

function restoreDraft() {
  const draft = readDraft();
  if (!draft?.rawRows?.length) {
    toast('没有可恢复的导入草稿');
    return;
  }
  state.projectId = draft.projectId || state.projectId;
  state.fileName = draft.fileName || '';
  state.fileSize = draft.fileSize || 0;
  state.rawRows = draft.rawRows;
  state.headers = draft.headers?.length ? draft.headers : Object.keys(draft.rawRows[0] || {});
  state.mapping = draft.mapping || {};
  state.mappingMeta = draft.mappingMeta || {};
  state.mappingSources = draft.mappingSources || Object.fromEntries(Object.entries(state.mapping).map(([key, value]) => [key, { type: value ? 'column' : 'none', value: value || '' }]));
  state.fixedValues = draft.fixedValues || {};
  state.amountRule = draft.amountRule || 'calculated';
  state.activeTemplateId = draft.activeTemplateId || '';
  state.previewPage = 1;
  refreshTemplates();
  refreshTemplateRecommendation();
  toast('已恢复本机导入草稿', 'success');
  paint();
}

function refreshTemplates() {
  state.templates = listMappingTemplates({ projectId: state.projectId });
}

function refreshTemplateRecommendation() {
  if (!state.headers.length) {
    state.templateRecommendation = null;
    return;
  }
  const matches = state.templates
    .map(template => ({ ...matchMappingTemplate(template, state.headers), templateId: template.id }))
    .filter(match => match.status === 'recommended')
    .sort((a, b) => b.score - a.score);
  state.templateRecommendation = matches[0] || null;
}

function showTemplateMenu() {
  refreshTemplates();
  const templates = state.templates;
  openModal('字段映射模板', `
    <div class="space-y-3 text-sm">
      <div class="rounded border border-teal-200 bg-teal-50 px-3 py-2 text-teal-900">模板仅保存在当前浏览器本地；应用前会核对当前 Excel 表头，不会静默覆盖映射。</div>
      ${templates.length ? `<div class="space-y-2">${templates.map(template => {
        const match = state.headers.length ? matchMappingTemplate(template, state.headers) : null;
        return `<div class="rounded border border-slate-200 bg-white px-3 py-3 flex items-center gap-3"><div class="min-w-0 flex-1"><div class="font-medium text-slate-900">${esc(template.name)} <span class="ml-1 text-xs font-normal text-slate-500">${template.scope === 'project' ? '项目专属' : '全局'}</span></div><div class="mt-1 text-xs text-slate-500">${match ? `当前文件匹配 ${match.score}%` : '选择 Excel 后可计算匹配率'} · ${amountRuleLabel(template.amountRule)}</div></div><button onclick="window.__importer.applyTemplate('${template.id}')" class="px-3 py-1.5 border border-teal-300 text-teal-700 hover:bg-teal-50">应用</button></div>`;
      }).join('')}</div>` : '<div class="py-5 text-center text-slate-500">还没有映射模板。完成一次映射后，可将其保存为全局或项目专属模板。</div>'}
    </div>
  `, `<button onclick="window.__importer.showTemplateManager()" class="px-3 py-1.5 text-sm border border-slate-300 bg-white">管理模板</button><button onclick="window.__importer.showSaveTemplate()" class="px-3 py-1.5 text-sm brand-bg text-white">另存当前映射</button>`);
}

function showSaveTemplate(templateId = '') {
  const existing = templateId ? getMappingTemplate(templateId) : null;
  const template = existing || buildCurrentTemplate();
  openModal(existing ? '编辑字段映射模板' : '另存字段映射模板', `
    <div class="space-y-4 text-sm">
      <label class="block"><span class="block mb-1 text-slate-600">模板名称</span><input id="mappingTemplateName" value="${esc(template.name || '')}" placeholder="例如：设计院工程量清单" class="h-9 w-full rounded border border-slate-300 px-3" /></label>
      <div class="grid grid-cols-2 gap-3">
        <label class="rounded border border-slate-200 p-3"><input type="radio" name="mappingTemplateScope" value="global" ${template.scope !== 'project' ? 'checked' : ''} /> 全局模板<div class="mt-1 text-xs text-slate-500">所有项目均可使用</div></label>
        <label class="rounded border border-slate-200 p-3"><input type="radio" name="mappingTemplateScope" value="project" ${template.scope === 'project' ? 'checked' : ''} /> 项目专属<div class="mt-1 text-xs text-slate-500">仅当前项目可见</div></label>
      </div>
      <label class="block"><span class="block mb-1 text-slate-600">金额规则</span><select id="mappingTemplateAmountRule" class="h-9 w-full rounded border border-slate-300 px-3"><option value="calculated" ${template.amountRule === 'calculated' ? 'selected' : ''}>数量 × 综合单价</option><option value="sourceAmount" ${template.amountRule === 'sourceAmount' ? 'selected' : ''}>优先使用 Excel 合价</option><option value="deriveUnitPrice" ${template.amountRule === 'deriveUnitPrice' ? 'selected' : ''}>合价 ÷ 数量补单价</option></select></label>
      <div class="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">将保存 ${Object.values(template.mapping || {}).filter(Boolean).length} 个来源列，以及 ${Object.values(template.fixedValues || {}).filter(Boolean).length} 个固定值。模板不保存 Excel 明细数据。</div>
    </div>
  `, `<button onclick="window.__modalClose()" class="px-3 py-1.5 text-sm border border-slate-300 bg-white">取消</button><button onclick="window.__importer.saveTemplateForm('${template.id || ''}')" class="px-3 py-1.5 text-sm brand-bg text-white">保存模板</button>`);
}

function saveTemplateForm(templateId = '') {
  const name = document.getElementById('mappingTemplateName')?.value?.trim();
  const scope = document.querySelector('input[name="mappingTemplateScope"]:checked')?.value || 'global';
  const amountRule = document.getElementById('mappingTemplateAmountRule')?.value || 'calculated';
  try {
    const existing = templateId ? getMappingTemplate(templateId) : null;
    const current = existing || buildCurrentTemplate();
    const saved = saveMappingTemplate({
      ...(existing || {}), ...current, id: templateId || undefined, name, scope,
      projectId: scope === 'project' ? state.projectId : '', amountRule,
    });
    state.activeTemplateId = saved.id;
    refreshTemplates();
    refreshTemplateRecommendation();
    closeModal();
    toast('字段映射模板已保存到本机', 'success');
    paint();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function showTemplateManager() {
  refreshTemplates();
  const groups = [
    ['全局模板', state.templates.filter(template => template.scope === 'global')],
    ['当前项目模板', state.templates.filter(template => template.scope === 'project')],
  ];
  openModal('管理字段映射模板', `<div class="space-y-5 text-sm">${groups.map(([title, templates]) => `<section><div class="mb-2 font-semibold text-slate-800">${title}</div>${templates.length ? `<div class="space-y-2">${templates.map(template => `<div class="rounded border border-slate-200 bg-white px-3 py-2 flex items-center gap-2"><div class="min-w-0 flex-1"><div class="font-medium">${esc(template.name)}</div><div class="mt-1 text-xs text-slate-500">${amountRuleLabel(template.amountRule)} · 最近使用 ${template.lastUsedAt ? new Date(template.lastUsedAt).toLocaleDateString('zh-CN') : '未使用'}</div></div><button onclick="window.__importer.showSaveTemplate('${template.id}')" class="text-xs text-slate-700 hover:underline">编辑</button><button onclick="window.__importer.duplicateTemplate('${template.id}')" class="text-xs text-slate-700 hover:underline">复制</button><button onclick="window.__importer.deleteTemplate('${template.id}')" class="text-xs text-red-600 hover:underline">删除</button></div>`).join('')}</div>` : '<div class="rounded border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">暂无模板</div>'}</section>`).join('')}</div>`, `<button onclick="window.__importer.showSaveTemplate()" class="px-3 py-1.5 text-sm brand-bg text-white">新建模板</button>`);
}

function applyTemplate(id) {
  const template = getMappingTemplate(id);
  if (!template) {
    toast('模板不存在或已删除', 'error');
    return;
  }
  if (!state.headers.length) {
    toast('请先选择 Excel 文件，再应用模板', 'error');
    return;
  }
  applyMappingResult(applyMappingTemplate(template, state.headers, state.rawRows));
  state.activeTemplateId = id;
  markMappingTemplateUsed(id);
  refreshTemplates();
  state.templateRecommendation = null;
  state.previewPage = 1;
  closeModal();
  toast(`已应用模板“${template.name}”，请确认待确认字段`, 'success');
  paint();
}

function updateActiveTemplate() {
  const template = getMappingTemplate(state.activeTemplateId);
  if (!template) {
    state.activeTemplateId = '';
    toast('当前模板已不存在，请另存为新模板', 'error');
    paint();
    return;
  }
  try {
    saveMappingTemplate({ ...template, ...buildCurrentTemplate(), id: template.id, name: template.name, scope: template.scope, projectId: template.projectId });
    refreshTemplates();
    refreshTemplateRecommendation();
    toast(`已更新模板“${template.name}”`, 'success');
    paint();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function deleteTemplate(id) {
  const template = getMappingTemplate(id);
  if (!template || !confirm(`删除模板“${template.name}”？已保存的数据不会受影响。`)) return;
  deleteMappingTemplate(id);
  if (state.activeTemplateId === id) state.activeTemplateId = '';
  refreshTemplates();
  refreshTemplateRecommendation();
  showTemplateManager();
  toast('模板已删除', 'success');
}

function duplicateTemplate(id) {
  const copy = duplicateMappingTemplate(id);
  showSaveTemplateWithTemplate(copy);
}

function showSaveTemplateWithTemplate(template) {
  openModal('复制字段映射模板', `<div class="space-y-4 text-sm"><label class="block"><span class="block mb-1 text-slate-600">模板名称</span><input id="mappingTemplateName" value="${esc(template.name)}" class="h-9 w-full rounded border border-slate-300 px-3" /></label><label class="block"><span class="block mb-1 text-slate-600">金额规则</span><select id="mappingTemplateAmountRule" class="h-9 w-full rounded border border-slate-300 px-3"><option value="calculated" ${template.amountRule === 'calculated' ? 'selected' : ''}>数量 × 综合单价</option><option value="sourceAmount" ${template.amountRule === 'sourceAmount' ? 'selected' : ''}>优先使用 Excel 合价</option><option value="deriveUnitPrice" ${template.amountRule === 'deriveUnitPrice' ? 'selected' : ''}>合价 ÷ 数量补单价</option></select></label><input type="hidden" id="mappingTemplateCopy" value="${esc(JSON.stringify(template))}" /></div>`, `<button onclick="window.__modalClose()" class="px-3 py-1.5 text-sm border border-slate-300 bg-white">取消</button><button onclick="window.__importer.saveTemplateFormFromCopy()" class="px-3 py-1.5 text-sm brand-bg text-white">保存副本</button>`);
  window.__importer.saveTemplateFormFromCopy = () => {
    try {
      const payload = JSON.parse(document.getElementById('mappingTemplateCopy')?.value || '{}');
      const scope = payload.scope === 'project' ? 'project' : 'global';
      saveMappingTemplate({ ...payload, id: undefined, name: document.getElementById('mappingTemplateName')?.value?.trim(), scope, projectId: scope === 'project' ? state.projectId : '', amountRule: document.getElementById('mappingTemplateAmountRule')?.value });
      refreshTemplates();
      closeModal();
      toast('模板副本已保存', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
}

function buildCurrentTemplate() {
  const mapping = {};
  Object.entries(state.mappingSources).forEach(([key, source]) => {
    if (source.type === 'column' && state.mapping[key]) mapping[key] = state.mapping[key];
  });
  return createMappingTemplate({
    scope: 'global',
    mapping,
    fixedValues: state.fixedValues,
    amountRule: state.amountRule,
    headerFingerprint: createHeaderFingerprint(state.headers),
  });
}

function amountRuleLabel(rule) {
  return rule === 'sourceAmount' ? '优先使用 Excel 合价' : rule === 'deriveUnitPrice' ? '合价 ÷ 数量补单价' : '数量 × 综合单价';
}

function repairUnitFromPrevious() {
  const src = state.mapping.unit;
  if (!src) return;
  let previous = '';
  state.rawRows = state.rawRows.map(row => {
    const current = valueOf(row, src);
    if (current) {
      previous = current;
      return row;
    }
    if (!previous) return row;
    return { ...row, [src]: previous };
  });
  toast('已用上一行单位补齐可识别空值', 'success');
  paint();
}

function mapUnknownCategory() {
  const src = state.mapping.costCategory;
  if (!src) {
    state.headers = [...state.headers, '成本分类'];
    state.mapping.costCategory = '成本分类';
  }
  const target = state.mapping.costCategory;
  state.rawRows = state.rawRows.map(row => ({ ...row, [target]: row[target] || '其他分类' }));
  toast('未识别分类已暂映射为其他分类', 'success');
  paint();
}

function mergeDuplicateRows() {
  const rows = getMappedRows();
  const seen = new Set();
  state.rawRows = rows
    .filter(row => {
      const key = `${row.name}|${(row.feature || '').slice(0, 30)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(row => row.source);
  toast('已移除重复清单项，保留首条记录', 'success');
  paint();
}

function currentProject() {
  return state.projects.find(p => p.id === state.projectId) || null;
}

function valueOf(row, key) {
  if (!key) return '';
  const value = row[key];
  return value === undefined || value === null ? '' : String(value).trim();
}

function mappedValue(row, key) {
  const source = state.mappingSources[key];
  if (source?.type === 'fixed') return String(state.fixedValues[key] ?? source.value ?? '').trim();
  if (source?.type === 'none') return '';
  return valueOf(row, state.mapping[key] || source?.value);
}

function hasMappedValue(key) {
  const source = state.mappingSources[key];
  if (source?.type === 'fixed') return Boolean(state.fixedValues[key] || source.value);
  return Boolean(state.mapping[key] || source?.value);
}

function canUseFixedValue(key) {
  return key === 'process' || key === 'costCategory';
}

function readDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem('importer_draft') || 'null');
    return draft && typeof draft === 'object' ? draft : null;
  } catch {
    return null;
  }
}

function firstNonEmpty(rows, key) {
  const hit = rows.find(row => valueOf(row, key));
  return hit ? valueOf(hit, key) : '';
}

function splitNameFeature(rawName, rawFeature) {
  const text = String(rawName || '').trim();
  if (!text) return { name: '', feature: String(rawFeature || '').trim() };
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (lines.length > 1 && !rawFeature) {
    return { name: lines[0], feature: lines.slice(1).join('\n') };
  }
  return { name: text, feature: String(rawFeature || '').trim() };
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  const cleaned = String(value).replace(/[,，¥￥\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(value) {
  if (!(value > 0)) return '-';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}
