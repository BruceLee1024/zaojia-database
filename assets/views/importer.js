// 视图：Excel 导入工作台
import { projectService } from '../services/projectService.js?v=3.9';
import { boqService } from '../services/boqService.js?v=3.9';
import { dataEngineService } from '../services/dataEngineService.js?v=3.9';
import { quotaService } from '../services/quotaService.js?v=3.9';
import { suggestImportMapping, suggestImportRepairs, suggestQuotaBatchCleanup } from '../services/aiAssistService.js?v=1.0';
import { quotaRepo } from '../data/repository.js?v=3.9';
import { parseExcel, exportQuotaTemplate } from '../data/excel.js?v=3.9';
import { esc, fmtMoney, openModal, closeModal, toast } from '../utils/dom.js';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=3.9';
import { categoryGuess } from '../utils/stats.js';

const FIELD_DEFS = [
  { key: 'name', label: '清单名称', required: true, aliases: ['项目名称', '清单名称', '名称', '项目名称\n项目特征', '清单名称\n项目特征'] },
  { key: 'feature', label: '项目特征', aliases: ['项目特征', '特征描述'] },
  { key: 'unit', label: '单位', required: true, aliases: ['计量单位', '单位'] },
  { key: 'qty', label: '工程量', required: true, aliases: ['工程数量', '工程量', '数量'] },
  { key: 'unitPrice', label: '综合单价', aliases: ['综合单价', '综合单价(元)', '单价'] },
  { key: 'process', label: '工艺段', aliases: ['工艺段', '区域', '单体', '部位'] },
  { key: 'costCategory', label: '成本分类', aliases: ['费用分类', '成本分类', '专业', '分类'] },
];

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
  projectId: '',
  fileName: '',
  fileSize: 0,
  rawRows: [],
  headers: [],
  mapping: {},
  activeIssueTab: 'errors',
  previewOnlyIssues: false,
  keyword: '',
  selectedRows: new Set(),
  importMode: 'append',
};

export async function render() {
  const params = window.__app?.state?.routeParams || {};
  state.projects = await projectService.list();
  if (!state.projectId && state.projects.length) {
    state.projectId = params.projectId || window.__app?.state?.currentProjectId || state.projects[0].id;
  }
  if (params.mode === 'boq') state.mode = 'boq';
  if (params.mode === 'hub') state.mode = 'hub';
  exposeImporterActions();
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
    paint();
    return;
  }
  renderHub();
}

function exposeImporterActions() {
  window.__importer = {
    showHub: () => {
      state.mode = 'hub';
      renderHub();
    },
    startBOQImport: () => {
      if (!state.projects.length) {
        toast('导入清单前需要先建立项目档案。');
        window.__app.go('projects', { action: 'new', returnTo: 'importer' });
        return;
      }
      state.mode = 'boq';
      if (!state.rawRows.length) loadSample();
      paint();
    },
    importQuotaExcel,
    goBackup: () => {
      toast('JSON 备份导入仍在「设置」的数据管理中执行。');
      window.__app.go('settings');
    },
    goVersions: () => {
      toast('历史报价版本来自工程量清单里的「保存版本」。');
      if (state.projectId) window.__app.go('boq', { projectId: state.projectId });
      else window.__app.go('boq');
    },
    pickFile,
    handleFile,
    setProject: id => {
      state.projectId = id;
      window.__app.state.currentProjectId = id;
      paint();
    },
    setMapping: (key, value) => {
      state.mapping[key] = value;
      state.selectedRows.clear();
      paint();
    },
    autoMap: () => {
      state.mapping = inferMapping(state.headers);
      toast('已按列名重新自动映射', 'success');
      paint();
    },
    aiMap: async () => {
      const result = await suggestImportMapping(state.headers, state.rawRows.slice(0, 10));
      (result.suggestions || []).forEach(item => {
        state.mapping[item.targetField] = item.sourceHeader;
      });
      toast(result.summary || 'AI 已识别字段映射', 'success');
      paint();
    },
    clearMapping: () => {
      state.mapping = {};
      paint();
    },
    setIssueTab: tab => {
      state.activeIssueTab = tab;
      paint();
    },
    setPreviewIssues: checked => {
      state.previewOnlyIssues = checked;
      paint();
    },
    setKeyword: value => {
      state.keyword = value;
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

function renderHub() {
  const projectCount = state.projects.length;
  document.getElementById('workspace').innerHTML = `
    <div class="min-h-full max-w-[1680px] mx-auto flex flex-col gap-4">
      <section class="rounded-lg border border-slate-200 bg-white p-5">
        <div class="flex flex-col lg:flex-row lg:items-end gap-4">
          <div>
            <div class="inline-flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700">
              <span class="material-symbols-outlined text-[16px]">hub</span>
              数据入口
            </div>
            <h1 class="mt-3 text-2xl font-semibold tracking-normal text-slate-950">先选择要导入的数据类型</h1>
            <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-500">定额库、项目清单、报价版本和备份文件的入库路径不同。这里先帮你选对入口，再进入对应的字段映射、质量检查或数据管理流程。</p>
          </div>
          <div class="flex-1"></div>
          <div class="grid grid-cols-3 gap-2 text-sm">
            ${hubMetric('当前项目', projectCount, '个')}
            ${hubMetric('本地存储', 'IndexedDB', '')}
            ${hubMetric('导入方式', 'Excel / JSON', '')}
          </div>
        </div>
      </section>

      <section class="grid grid-cols-1 xl:grid-cols-4 gap-3">
        ${hubCard({
          icon: 'list_alt',
          tone: 'teal',
          title: '导入项目工程量清单',
          desc: '上传项目清单 Excel，先做字段映射和质量检查，再写入当前项目清单。',
          action: state.projects.length ? '进入清单导入' : '先新建项目',
          handler: 'startBOQImport',
          note: state.projectId ? `当前目标项目：${state.projects.find(p => p.id === state.projectId)?.name || '已选择项目'}` : '导入清单需要先建立项目档案，用于绑定清单、版本和指标样本。',
        })}
        ${hubCard({
          icon: 'menu_book',
          tone: 'blue',
          title: '导入企业定额库',
          desc: '上传定额 Excel，复用定额库导入逻辑，导入后进入定额库查看价格和缺单价。',
          action: '选择定额 Excel',
          handler: 'importQuotaExcel',
          note: '支持清单名称、项目特征、单位、综合单价等字段',
        })}
        ${hubCard({
          icon: 'backup',
          tone: 'slate',
          title: '导入 JSON 备份',
          desc: '恢复整套本地数据，包括定额、项目、清单、报价版本、指标和经验卡。',
          action: '去设置导入',
          handler: 'goBackup',
          note: '备份导入会覆盖当前业务数据',
        })}
        ${hubCard({
          icon: 'history',
          tone: 'amber',
          title: '历史报价 / 版本',
          desc: '报价版本从工程量清单中保存生成，用于对比、回退和沉淀指标样本。',
          action: '打开工程量清单',
          handler: 'goVersions',
          note: '本轮暂不新增历史报价 Excel 解析器',
        })}
      </section>

      <section class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="font-semibold text-slate-900">推荐上手路径</h2>
              <p class="mt-1 text-xs text-slate-500">按这个顺序走，数据会自然进入清单、版本、指标和经验闭环。</p>
            </div>
            <button onclick="window.__importer.startBOQImport()" class="h-9 px-3 text-sm brand-bg text-white">开始导入清单</button>
          </div>
          <div class="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
            ${flowStep('1', '导入定额库', '建立企业价格基础')}
            ${flowStep('2', '新建项目', '填写规模和工艺口径')}
            ${flowStep('3', '导入清单', '预检后写入项目')}
            ${flowStep('4', '保存版本', '沉淀指标和复盘经验')}
          </div>
        </div>
        <aside class="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
          <div class="flex items-center gap-2 font-semibold text-amber-900">
            <span class="material-symbols-outlined text-[19px]">info</span>
            本地版提醒
          </div>
          <div class="mt-3 space-y-2 text-xs leading-5 text-amber-800">
            <p>所有业务数据保存在当前浏览器 IndexedDB。换电脑、清缓存或更换浏览器前，请先到设置导出 JSON 备份。</p>
            <p>Excel 导入会先预检，确认入库后才会写入项目清单或定额库。</p>
          </div>
        </aside>
      </section>
    </div>
  `;
}

function hubMetric(label, value, unit) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-[11px] text-slate-500">${label}</div>
    <div class="mt-1 font-semibold tabular-nums text-slate-900">${esc(value)}<span class="ml-1 text-[11px] font-normal text-slate-500">${esc(unit)}</span></div>
  </div>`;
}

function hubCard({ icon, tone, title, desc, action, handler, note }) {
  const tones = {
    teal: 'border-teal-200 bg-teal-50 text-teal-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
  };
  return `<article class="rounded-lg border border-slate-200 bg-white p-4 min-h-[260px] flex flex-col">
    <div class="h-11 w-11 rounded-lg border ${tones[tone] || tones.slate} flex items-center justify-center">
      <span class="material-symbols-outlined text-[23px]">${icon}</span>
    </div>
    <h2 class="mt-4 text-base font-semibold text-slate-900">${esc(title)}</h2>
    <p class="mt-2 text-sm leading-6 text-slate-500">${esc(desc)}</p>
    <div class="mt-3 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">${esc(note)}</div>
    <div class="flex-1"></div>
    <button onclick="window.__importer.${handler}()" class="mt-4 h-10 w-full text-sm ${tone === 'teal' ? 'brand-bg text-white' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}">${esc(action)}</button>
  </article>`;
}

function flowStep(num, title, desc) {
  return `<div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
    <div class="h-7 w-7 rounded-full bg-white border border-teal-200 text-teal-700 flex items-center justify-center text-xs font-semibold">${num}</div>
    <div class="mt-3 font-medium text-slate-900">${esc(title)}</div>
    <div class="mt-1 text-xs text-slate-500">${esc(desc)}</div>
  </div>`;
}

function paint() {
  const project = currentProject();
  const mappedRows = getMappedRows();
  const quality = analyzeRows(mappedRows);
  const filteredRows = filterPreviewRows(mappedRows, quality);
  const hasUploaded = Boolean(state.fileName);

  document.getElementById('workspace').innerHTML = `
    <div class="h-full min-h-[720px] flex flex-col">
      <div class="mb-3 flex items-center gap-3">
        <button onclick="window.__importer.showHub()" class="h-10 w-10 border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 flex items-center justify-center" title="返回导入中心" aria-label="返回导入中心">
          <span class="material-symbols-outlined text-[20px]">arrow_back</span>
        </button>
        <div>
          <div class="text-lg font-semibold text-slate-900">当前任务：导入项目工程量清单</div>
          <div class="mt-0.5 text-xs text-slate-500">把 Excel 清单转成结构化项目清单，先预检、再入库、再沉淀指标样本。</div>
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
          <span class="material-symbols-outlined text-[18px]">download_done</span>确认入库
        </button>
      </div>

      <div class="grid grid-cols-[minmax(0,1fr)_350px] gap-4 flex-1 min-h-0">
        <section class="min-w-0 flex flex-col gap-3">
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
  bindUploadEvents();
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
  return `
    <section class="shrink-0 rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200 flex items-center gap-3">
        <div>
          <div class="font-semibold text-slate-900">字段映射</div>
          <div class="mt-1 text-xs text-slate-500">系统已按常见表头自动匹配，可手动调整来源列。</div>
        </div>
        <div class="flex-1"></div>
        <button onclick="window.__importer.aiMap()" class="px-2.5 py-1.5 text-xs text-teal-700 hover:bg-teal-50 border border-teal-200 bg-teal-50 inline-flex items-center gap-1">
          <span class="material-symbols-outlined text-[15px]">auto_awesome</span>AI 识别字段
        </button>
        <button onclick="window.__importer.autoMap()" class="px-2.5 py-1.5 text-xs text-teal-700 hover:bg-teal-50 border border-teal-200 bg-white">自动映射</button>
        <button onclick="window.__importer.clearMapping()" class="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 border border-slate-200 bg-white">清空映射</button>
      </div>
      <div class="max-h-[220px] overflow-auto scroll-thin">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr class="text-left">
              <th class="py-2 px-3 w-[28%]">Excel 列名（源字段）</th>
              <th class="px-3 w-[25%]">系统字段（目标字段）</th>
              <th class="px-3">识别示例</th>
              <th class="px-3 w-28">匹配状态</th>
            </tr>
          </thead>
          <tbody>
            ${FIELD_DEFS.map(def => mappingRow(def)).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function mappingRow(def) {
  const source = state.mapping[def.key] || '';
  const sample = source ? firstNonEmpty(state.rawRows, source) : '';
  const ok = source && (!def.required || sample !== '');
  return `
    <tr class="border-t border-slate-100">
      <td class="py-2 px-3">
        <select class="h-8 w-full rounded border border-slate-300 bg-white px-2 text-sm" onchange="window.__importer.setMapping('${def.key}', this.value)">
          <option value="">不映射</option>
          ${state.headers.map(h => `<option value="${esc(h)}" ${source === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
        </select>
      </td>
      <td class="px-3 font-medium text-slate-800">
        ${esc(def.label)} ${def.required ? '<span class="text-red-500">*</span>' : ''}
      </td>
      <td class="px-3 text-slate-600 truncate">${esc(sample || '-')}</td>
      <td class="px-3">${ok ? '<span class="badge badge-green">已映射</span>' : '<span class="badge badge-yellow">待确认</span>'}</td>
    </tr>
  `;
}

function previewTable(rows, quality) {
  const total = getMappedRows().length;
  return `
    <section class="rounded-lg border border-slate-200 bg-white overflow-hidden flex-1 min-h-[260px] flex flex-col">
      <div class="px-4 py-3 border-b border-slate-200 flex items-center gap-3 shrink-0">
        <div>
          <div class="font-semibold text-slate-900">数据预览 <span class="text-xs font-normal text-slate-500">（前 200 行）</span></div>
          <div class="mt-1 text-xs text-slate-500">共 ${total.toLocaleString('zh-CN')} 行，当前显示 ${rows.length} 行，已选中 ${state.selectedRows.size} 行。</div>
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
              <th class="px-3 w-24">工艺段</th>
              <th class="px-3 w-28">成本分类</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.slice(0, 200).map(row => previewRow(row, quality)).join('') : `<tr><td colspan="8" class="py-10 text-center text-slate-400">没有符合条件的预览行。</td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="px-4 py-3 border-t border-slate-200 bg-white flex items-center gap-2 text-xs text-slate-500 shrink-0">
        <span>共 ${total.toLocaleString('zh-CN')} 行</span>
        <span>·</span>
        <span class="${quality.errorCount ? 'text-red-600' : 'text-teal-700'}">${quality.errorCount ? `需修正 ${quality.errorCount} 个问题` : '检查通过'}</span>
        <div class="flex-1"></div>
        <span class="rounded border border-slate-200 px-2 py-1">20 条/页</span>
        <span class="rounded border border-teal-200 bg-teal-50 px-2 py-1 text-teal-700">1</span>
        <span class="rounded border border-slate-200 px-2 py-1">2</span>
        <span class="rounded border border-slate-200 px-2 py-1">3</span>
      </div>
    </section>
  `;
}

function previewRow(row, quality) {
  const hasIssue = quality.issueRows.has(row.index);
  const rowBg = hasIssue ? 'bg-amber-50/40' : 'hover:bg-slate-50';
  return `
    <tr class="border-b border-slate-100 ${rowBg}">
      <td class="py-2 px-3 tabular-nums text-slate-500">${row.index + 1}</td>
      <td class="px-3 font-medium text-slate-800 truncate" title="${esc(row.name)}">${esc(row.name || '-')}</td>
      <td class="px-3 text-slate-600 truncate" title="${esc(row.feature)}">${esc(row.feature || '-')}</td>
      <td class="px-3 ${!row.unit ? 'bg-red-50 text-red-700' : ''}">${esc(row.unit || '缺失')}</td>
      <td class="px-3 text-right tabular-nums ${row.qty <= 0 ? 'bg-amber-50 text-amber-700' : ''}">${formatNumber(row.qty)}</td>
      <td class="px-3 text-right tabular-nums ${hasMissingPrice(row.unitPrice) ? 'bg-amber-50 text-amber-700' : ''}">
        ${hasMissingPrice(row.unitPrice) ? '-' : fmtMoney(row.unitPrice)}
      </td>
      <td class="px-3 text-slate-600 truncate">${esc(row.process || '-')}</td>
      <td class="px-3 text-slate-600 truncate">${esc(row.costCategory || categoryGuess(row.name))}</td>
    </tr>
  `;
}

function qualityPanel(quality, project) {
  const repairs = suggestImportRepairs(getMappedRows(), quality, { project }).suggestions || [];
  const tabs = [
    ['errors', `错误 (${quality.errorCount})`],
    ['warnings', `警告 (${quality.warningCount})`],
    ['suggestions', `建议 (${quality.suggestionCount})`],
  ];
  return `
    <div class="h-full flex flex-col min-h-0">
      <div class="shrink-0">
        <div class="font-semibold text-slate-900">导入检查</div>
        <div class="mt-2 grid grid-cols-3 gap-2">
          ${metricBox('识别行', quality.total, '')}
          ${metricBox('可入库', quality.importable, 'text-teal-700')}
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
          <div class="font-medium text-slate-900">入库目标</div>
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
          <button onclick="window.__importer.confirmImport()" class="flex-1 h-9 text-sm brand-bg text-white">确认入库</button>
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
      icon: 'error',
      tone: 'red',
      title: `缺单价（${quality.missingPrice.length}）`,
      desc: '存在综合单价为空或非数字的行，入库后将按 0 计价。',
      rows: quality.missingPrice,
      action: '批量设为待询价',
      handler: 'repairMissingPrice',
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
  ] : [
    {
      icon: 'tips_and_updates',
      tone: 'blue',
      title: `重复清单项（${quality.duplicates.length}）`,
      desc: '存在重复的清单名称及项目特征，可合并后再入库。',
      rows: quality.duplicates,
      action: '合并重复项',
      handler: 'mergeDuplicateRows',
    },
    {
      icon: 'check_circle',
      tone: 'green',
      title: `已通过检查项（${quality.passCount}）`,
      desc: '这些行已具备入库所需的名称、单位、工程量字段。',
      rows: [],
      action: '',
      handler: '',
    },
  ];

  return issues.map(issueCard).join('');
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

function bindUploadEvents() {
  const input = document.getElementById('importFileInput');
  const dropZone = document.getElementById('importDropZone');
  if (!input || !dropZone) return;
  input.onchange = () => handleFile(input.files?.[0]);
  dropZone.ondragover = e => {
    e.preventDefault();
    dropZone.classList.add('ring-2', 'ring-blue-300');
  };
  dropZone.ondragleave = () => dropZone.classList.remove('ring-2', 'ring-blue-300');
  dropZone.ondrop = e => {
    e.preventDefault();
    dropZone.classList.remove('ring-2', 'ring-blue-300');
    handleFile(e.dataTransfer?.files?.[0]);
  };
}

function pickFile() {
  document.getElementById('importFileInput')?.click();
}

async function handleFile(file) {
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
    state.mapping = inferMapping(state.headers);
    state.selectedRows.clear();
    toast(`已解析 ${rows.length} 行`, 'success');
    paint();
  } catch (err) {
    console.error(err);
    toast(`解析失败：${err.message}`, 'error');
  }
}

async function importQuotaExcel() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await quotaService.importFromExcel(file);
      localStorage.setItem('quota_last_import', JSON.stringify({
        fileName: file.name,
        importedAt: new Date().toISOString(),
        success: result.success,
        missingPrice: result.missingPrice,
      }));
      toast(`定额库导入完成：成功 ${result.success} 条，缺单价 ${result.missingPrice} 条`, result.failed ? 'error' : 'success');
      await window.__app.go('quota');
      showQuotaImportResult(result);
    } catch (err) {
      console.error(err);
      toast(`定额库导入失败：${err.message}`, 'error');
    }
  };
  input.click();
}

function showQuotaImportResult(result) {
  openModal('企业定额库导入结果', `
    <div class="grid grid-cols-4 gap-2 text-sm mb-4">
      ${importResultBox('总行数', result.total)}
      ${importResultBox('成功', result.success)}
      ${importResultBox('失败', result.failed)}
      ${importResultBox('缺单价', result.missingPrice)}
    </div>
    <div class="text-sm text-slate-600 mb-3">新增 ${result.added} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条。已跳转到定额库，可继续筛选缺单价或加入项目清单。</div>
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
  state.mapping = inferMapping(state.headers);
}

function inferMapping(headers) {
  const next = {};
  FIELD_DEFS.forEach(def => {
    next[def.key] = def.aliases.find(alias => headers.includes(alias)) || '';
  });
  return next;
}

function getMappedRows() {
  return state.rawRows.map((row, index) => {
    const rawName = valueOf(row, state.mapping.name);
    const rawFeature = valueOf(row, state.mapping.feature);
    const split = splitNameFeature(rawName, rawFeature);
    const qty = parseNumber(valueOf(row, state.mapping.qty));
    const unitPrice = parseNumber(valueOf(row, state.mapping.unitPrice));
    return {
      index,
      source: row,
      name: split.name,
      feature: split.feature,
      unit: valueOf(row, state.mapping.unit),
      qty,
      unitPrice,
      amount: calculateAmount(qty, unitPrice, 1),
      process: valueOf(row, state.mapping.process),
      costCategory: valueOf(row, state.mapping.costCategory),
    };
  });
}

function analyzeRows(rows) {
  const missingName = rows.filter(row => !row.name);
  const missingUnit = rows.filter(row => row.name && !row.unit);
  const missingPrice = rows.filter(row => row.name && hasMissingPrice(row.unitPrice));
  const zeroQty = rows.filter(row => row.name && !(row.qty > 0));
  const unknownCategory = rows.filter(row => row.name && !row.costCategory && categoryGuess(row.name) === '其他');
  const seen = new Map();
  const duplicates = [];
  rows.forEach(row => {
    if (!row.name) return;
    const key = `${row.name}|${(row.feature || '').slice(0, 30)}`;
    if (seen.has(key)) duplicates.push(row);
    else seen.set(key, row.index);
  });
  const issueRows = new Set([...missingName, ...missingUnit, ...missingPrice, ...zeroQty, ...unknownCategory, ...duplicates].map(r => r.index));
  const errorCount = missingName.length + missingUnit.length + missingPrice.length;
  const warningCount = zeroQty.length + unknownCategory.length;
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
  const rows = getMappedRows()
    .filter(row => row.name)
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
    toast('没有可入库的清单行', 'error');
    return;
  }
  if (!state.fileName && !confirm('当前显示的是示例预览数据。确认后会写入所选项目清单，仅建议用于体验流程。确定入库？')) return;
  if (state.importMode === 'replace' && !confirm('覆盖会删除当前项目现有清单，但不会删除已保存的报价版本。确定覆盖？')) return;
  try {
    const result = await boqService.importLines(state.projectId, rows, { mode: state.importMode });
    const engine = await dataEngineService.ingestBOQ(state.projectId, {
      sourceType: 'excel_import_workbench',
      sourceId: state.fileName || '示例预览数据',
    });
    toast(`已入库 ${result.success} 条，沉淀候选 ${engine.candidates.length} 条`, 'success');
    window.__app.state.currentProjectId = state.projectId;
    window.__app.go('boq', { projectId: state.projectId, imported: true });
  } catch (err) {
    console.error(err);
    toast(`入库失败：${err.message}`, 'error');
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
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem('importer_draft', JSON.stringify(payload));
  toast('导入草稿已保存到本机', 'success');
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
