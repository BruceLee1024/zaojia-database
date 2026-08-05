// 统一表格导入向导：五类目标共用文件、数据区、层级映射、预览和写入流程。
import { parseImportFile } from '../data/excel.js?v=6.8';
import { buildHeaderTree, classifyImportRow, detectImportRegions } from '../data/importEngine.js?v=6.8';
import { buildImportColumnMapping } from '../services/importMappingService.js?v=6.8';
import { getImportSchema } from '../services/importSchemaService.js?v=6.8';
import { recognizeImportColumns } from '../services/aiImportRecognitionService.js?v=6.8';
import { analyzeImport, commitImport } from '../services/importWorkflowService.js?v=6.8';
import { listMappingTemplates, markMappingTemplateUsed, saveMappingTemplate } from '../services/importMappingTemplateService.js?v=6.8';
import { projectRepo } from '../data/repository.js?v=6.8';
import { esc, toast } from '../utils/dom.js?v=6.8';

const TARGETS = {
  'boq_quota_bundle': { label: '清单及定额组合', back: 'boq-library' },
  project_boq: { label: '项目工程量清单', back: 'importer' },
  boq_library: { label: '我的清单库', back: 'boq-library' },
  quota: { label: '常用定额', back: 'quota' },
  material: { label: '材料库', back: 'materials' },
  equipment: { label: '设备库', back: 'equipment' },
};

const state = {
  targetType: 'project_boq', projectId: '', routeSignature: '', step: 'upload', busy: false,
  fileName: '', workbook: null, regions: [], selectedRegionIds: new Set(),
  mappingByRegion: {}, fieldMetaBySignature: {}, fixedByRegion: {}, aiStatusBySignature: {},
  templateBySignature: {}, templateNameBySignature: {}, templateScopeBySignature: {},
  csvEncoding: '', csvDelimiter: '',
  amountRule: 'calculated', importMode: 'append', updateExisting: true, issueOnly: false, issueSeverity: '', preview: null, report: null,
};

export function normalizeWizardStep(step, { recognition, hasSheet } = {}) {
  if (step === 'confirm' && (!recognition || !hasSheet)) return hasSheet ? 'sheet' : 'upload';
  return step;
}

export async function render(workspace = document.getElementById('workspace')) {
  const params = window.__app?.state?.routeParams || {};
  const targetType = TARGETS[params.targetType] ? params.targetType : 'project_boq';
  const requestedProjectId = params.projectId || window.__app?.state?.currentProjectId || '';
  const signature = `${targetType}:${requestedProjectId}`;
  if (state.routeSignature !== signature) resetState(targetType, requestedProjectId, signature);
  if (targetType === 'project_boq' && !state.projectId) state.projectId = (await projectRepo.all())[0]?.id || '';
  expose(workspace);
  await paint(workspace);
}

function resetState(targetType, projectId, routeSignature) {
  Object.assign(state, {
    targetType, projectId, routeSignature, step: 'upload', busy: false, fileName: '', workbook: null, regions: [],
    selectedRegionIds: new Set(), mappingByRegion: {}, fieldMetaBySignature: {}, fixedByRegion: {}, aiStatusBySignature: {},
    templateBySignature: {}, templateNameBySignature: {}, templateScopeBySignature: {},
    csvEncoding: '', csvDelimiter: '',
    amountRule: 'calculated', importMode: 'append', updateExisting: targetType !== 'boq_quota_bundle', issueOnly: false, issueSeverity: '', preview: null, report: null,
  });
}

function expose(workspace) {
  window.__aiImport = {
    cancel: () => window.__app.go(TARGETS[state.targetType].back),
    setTarget: value => window.__app.go('ai-import', { targetType: value, projectId: state.projectId }),
    chooseFile: file => chooseFile(workspace, file),
    setCsvEncoding: value => { state.csvEncoding = value; },
    setCsvDelimiter: value => { state.csvDelimiter = value; },
    toggleRegion: (id, checked) => { checked ? state.selectedRegionIds.add(id) : state.selectedRegionIds.delete(id); paint(workspace); },
    toggleHidden: checked => { state.regions.filter(region => region.hidden).forEach(region => checked ? state.selectedRegionIds.add(region.id) : state.selectedRegionIds.delete(region.id)); paint(workspace); },
    adjustRegion: id => adjustRegion(workspace, id),
    prepareMapping: () => prepareMapping(workspace),
    setMapping: (signature, key, value) => setGroupMapping(workspace, signature, key, value),
    setFixed: (signature, key, value) => setGroupFixed(workspace, signature, key, value),
    applyTemplate: (signature, templateId) => applyTemplate(workspace, signature, templateId),
    setTemplateName: (signature, value) => { state.templateNameBySignature[signature] = value; },
    setTemplateScope: (signature, value) => { state.templateScopeBySignature[signature] = value; paint(workspace); },
    saveTemplate: signature => saveTemplate(workspace, signature),
    setAmountRule: value => { state.amountRule = value; paint(workspace); },
    setProject: value => { state.projectId = value; paint(workspace); },
    setImportMode: value => { state.importMode = value; paint(workspace); },
    setUpdateExisting: value => { state.updateExisting = value; },
    setIssueOnly: value => { state.issueOnly = value; paint(workspace); },
    setIssueSeverity: value => { state.issueSeverity = value; paint(workspace); },
    buildPreview: () => buildPreview(workspace),
    commit: () => commit(workspace),
    back: () => { state.step = state.step === 'mapping' ? 'regions' : state.step === 'preview' ? 'mapping' : 'upload'; paint(workspace); },
  };
}

async function paint(workspace) {
  const target = TARGETS[state.targetType];
  const projects = state.targetType === 'project_boq' ? await projectRepo.all() : [];
  workspace.innerHTML = `<div class="page-frame min-h-full p-5">
    <header class="mb-5 flex items-start gap-3"><button onclick="window.__aiImport.cancel()" class="mt-0.5 h-9 w-9 border border-slate-300 bg-white" aria-label="返回"><span class="material-symbols-outlined">arrow_back</span></button><div><h1 class="text-xl font-semibold text-slate-950">导入${esc(target.label)}</h1><p class="mt-1 text-sm text-slate-500">支持 Excel / CSV、多工作表、多数据区及 1–6 层合并表头。写入前始终需要确认预览。</p></div></header>
    ${stepper()}
    ${state.step === 'upload' ? uploadPanel(projects) : state.step === 'regions' ? regionsPanel() : state.step === 'mapping' ? mappingPanel(projects) : state.step === 'preview' ? previewPanel(projects) : resultPanel()}
  </div>`;
  bindUpload(workspace);
}

function stepper() {
  const steps = [['upload', '上传'], ['regions', '数据区'], ['mapping', '字段映射'], ['preview', '质量预览'], ['result', '导入报告']];
  const active = Math.max(0, steps.findIndex(([key]) => key === state.step));
  return `<ol class="mb-5 flex flex-wrap items-center gap-2 text-xs" aria-label="导入步骤">${steps.map(([key, label], index) => `<li class="flex items-center gap-2 ${index <= active ? 'font-medium text-teal-700' : 'text-slate-400'}"><span class="flex h-6 w-6 items-center justify-center rounded-full border ${index <= active ? 'border-teal-500 bg-teal-50' : 'border-slate-300'}">${index + 1}</span>${label}${index < steps.length - 1 ? '<span class="mx-1 h-px w-8 bg-slate-200"></span>' : ''}</li>`).join('')}</ol>`;
}

function uploadPanel(projects) {
  return `<section class="rounded-lg border border-slate-200 bg-white p-6"><h2 class="font-semibold text-slate-900">选择数据文件</h2><p class="mt-1 text-sm text-slate-500">支持 .xlsx、.xls、.csv；CSV 会自动尝试 UTF-8 和 GB18030。</p><div class="mt-4 flex flex-wrap gap-3">${targetPicker()}${state.targetType === 'project_boq' ? projectPicker(projects) : ''}</div><div class="mt-4 flex flex-wrap gap-3 text-sm"><label>CSV 编码<select onchange="window.__aiImport.setCsvEncoding(this.value)" class="ml-2 h-9 border border-slate-300 bg-white px-2"><option value="">自动识别</option><option value="utf-8">UTF-8</option><option value="gb18030">GBK / GB18030</option></select></label><label>CSV 分隔符<select onchange="window.__aiImport.setCsvDelimiter(this.value)" class="ml-2 h-9 border border-slate-300 bg-white px-2"><option value="">自动识别</option><option value=",">逗号</option><option value="tab">制表符</option><option value=";">分号</option></select></label></div><label id="unifiedImportDrop" class="mt-5 flex min-h-48 cursor-pointer flex-col items-center justify-center border-2 border-dashed border-slate-300 bg-slate-50 px-6 text-center hover:border-teal-400 hover:bg-teal-50/30"><span class="material-symbols-outlined text-4xl text-teal-700">upload_file</span><span class="mt-3 font-medium text-slate-800">选择或拖入表格</span><span class="mt-1 text-xs text-slate-500">文件先在浏览器本地解析；AI 只接收表头路径和有限样本</span><input id="unifiedImportFile" type="file" accept=".xlsx,.xls,.csv" class="hidden"></label></section>`;
}

function regionsPanel() {
  const selected = state.selectedRegionIds.size;
  return `<section class="rounded-lg border border-slate-200 bg-white overflow-hidden"><div class="border-b border-slate-200 p-5"><div class="flex flex-wrap items-start gap-3"><div><h2 class="font-semibold text-slate-900">选择要导入的数据区</h2><p class="mt-1 text-sm text-slate-500">${esc(state.fileName)} · 发现 ${state.regions.length} 个候选数据区，已选 ${selected} 个。</p></div><label class="ml-auto text-xs text-slate-600"><input type="checkbox" onchange="window.__aiImport.toggleHidden(this.checked)"> 包含隐藏工作表</label></div>${(state.workbook?.warnings || []).length ? warningBox(state.workbook.warnings) : ''}</div><div class="divide-y divide-slate-100">${state.regions.map(regionCard).join('') || '<div class="p-10 text-center text-slate-400">没有发现可用数据区</div>'}</div><footer class="flex justify-between border-t border-slate-200 bg-slate-50 p-4"><button onclick="window.__aiImport.back()" class="h-9 px-3 border border-slate-300 bg-white text-sm">重新选文件</button><button onclick="window.__aiImport.prepareMapping()" ${selected && !state.busy ? '' : 'disabled'} class="h-9 px-4 brand-bg text-white text-sm disabled:opacity-40">${state.busy ? 'AI 与本地规则分析中…' : '继续字段映射'}</button></footer></section>`;
}

function regionCard(region) {
  const checked = state.selectedRegionIds.has(region.id);
  const pathPreview = region.columns.slice(0, 6).map(column => column.displayName).join('、');
  return `<article class="p-4 ${checked ? 'bg-teal-50/30' : ''}"><div class="flex items-start gap-3"><input type="checkbox" class="mt-1" ${checked ? 'checked' : ''} onchange="window.__aiImport.toggleRegion(${inlineArg(region.id)}, this.checked)" aria-label="选择${esc(region.sheetName)}"><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="font-medium text-slate-900">${esc(region.sheetName)}${region.title ? ` · ${esc(region.title)}` : ''}</h3>${region.hidden ? '<span class="badge badge-gray">隐藏表</span>' : ''}<span class="badge ${region.confidence === 'high' || region.confidence === 'manual' ? 'badge-green' : 'badge-yellow'}">${region.confidence === 'manual' ? '人工确认' : `${region.confidence === 'high' ? '高' : region.confidence === 'medium' ? '中' : '低'}置信`}</span></div><p class="mt-1 text-xs text-slate-500">表头第 ${region.headerStart + 1}–${region.headerEnd + 1} 行 · 数据 ${region.rows.length} 行 · 自动跳过 ${region.skippedRows.length} 行</p><p class="mt-2 text-xs text-slate-600">列路径：${esc(pathPreview)}${region.columns.length > 6 ? '…' : ''}</p><div class="mt-3 flex flex-wrap items-end gap-2 text-xs"><label>表头起始行<input id="regionStart-${safeId(region.id)}" type="number" min="1" value="${region.headerStart + 1}" class="ml-1 h-8 w-20 border border-slate-300 px-2"></label><label>结束行<input id="regionEnd-${safeId(region.id)}" type="number" min="1" max="${region.headerStart + 6}" value="${region.headerEnd + 1}" class="ml-1 h-8 w-20 border border-slate-300 px-2"></label><button onclick="window.__aiImport.adjustRegion(${inlineArg(region.id)})" class="h-8 px-3 border border-slate-300 bg-white">重新识别</button></div>${region.warnings?.length ? warningBox(region.warnings) : ''}</div></div></article>`;
}

function mappingPanel(projects) {
  const groups = groupSelectedRegions();
  return `<section class="space-y-4"><div class="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">AI 默认对低置信字段提供建议；模型不可用时会自动保留本地映射。来源列使用完整路径，同名“单价”不会互相覆盖。</div>${groups.map(mappingGroup).join('')}<footer class="sticky bottom-0 flex justify-between border border-slate-200 bg-white p-4"><button onclick="window.__aiImport.back()" class="h-9 px-3 border border-slate-300 bg-white text-sm">返回数据区</button><button onclick="window.__aiImport.buildPreview()" class="h-9 px-4 brand-bg text-white text-sm">生成质量预览</button></footer></section>`;
}

function mappingGroup(group) {
  const representative = group.regions[0];
  const schema = getImportSchema(state.targetType);
  const mapping = state.mappingByRegion[representative.id] || {};
  const fixed = state.fixedByRegion[representative.id] || {};
  const ai = state.aiStatusBySignature[group.signature];
  const fields = schema.fields.map(field => {
    const source = mapping[field.key] || '';
    const meta = state.fieldMetaBySignature[group.signature]?.[field.key] || {};
    const column = representative.columns.find(item => item.id === (source || meta.candidateSource));
    const sample = column ? representative.rows.find(row => String(row.values[column.id] ?? '').trim())?.values[column.id] : fixed[field.key];
    const status = source ? '已映射' : Object.prototype.hasOwnProperty.call(fixed, field.key) ? '固定值' : meta.candidateSource ? `建议确认（${confidenceLabel(meta.confidence)}）` : field.required ? '待补充' : '不导入';
    const statusTone = source || Object.prototype.hasOwnProperty.call(fixed, field.key) ? 'text-teal-700' : meta.candidateSource || field.required ? 'text-amber-700' : 'text-slate-400';
    const control = mappingControl(group.signature, field, representative.columns, source, fixed, meta);
    return { field, sample: esc(sample == null || sample === '' ? '-' : String(sample).slice(0, 80)), status, statusTone, control };
  });
  const desktopRows = fields.map(item => `<tr class="border-t border-slate-100"><td class="p-3 font-medium text-slate-800">${esc(item.field.label)}${item.field.required ? '<span class="text-red-600"> *</span>' : ''}</td><td class="p-3">${item.control}</td><td class="p-3 text-slate-600">${item.sample}</td><td class="p-3 text-xs ${item.statusTone}">${item.status}</td></tr>`).join('');
  const mobileCards = fields.map(item => `<section class="border-t border-slate-100 p-4"><div class="flex items-center justify-between gap-2"><h3 class="font-medium text-slate-800">${esc(item.field.label)}${item.field.required ? '<span class="text-red-600"> *</span>' : ''}</h3><span class="text-xs ${item.statusTone}">${item.status}</span></div><div class="mt-3">${item.control}</div><p class="mt-2 truncate text-xs text-slate-500">样本：${item.sample}</p></section>`).join('');
  return `<article class="rounded-lg border border-slate-200 bg-white overflow-hidden"><header class="border-b border-slate-200 p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="font-semibold text-slate-900">${esc(representative.sheetName)}${group.regions.length > 1 ? ` 等 ${group.regions.length} 个同结构数据区` : ''}</h2><p class="mt-1 text-xs ${ai?.degraded ? 'text-amber-700' : 'text-slate-500'}">${esc(ai?.degraded ? ai.degradationReason : ai?.summary || '本地规则已完成映射')}</p></div>${templateControls(group)}</div></header><div class="md:hidden">${mobileCards}</div><div class="hidden overflow-auto md:block"><table class="w-full min-w-[780px] text-sm"><thead class="bg-slate-50 text-left text-xs text-slate-500"><tr><th class="p-3">系统字段</th><th class="p-3">Excel 完整列路径</th><th class="p-3">样本</th><th class="p-3">状态</th></tr></thead><tbody>${desktopRows}</tbody></table></div></article>`;
}

function templateControls(group) {
  const templates = listMappingTemplates({ projectId: state.projectId }).filter(template => template.targetType === state.targetType);
  const signature = group.signature;
  const scope = state.templateScopeBySignature[signature] || 'global';
  const name = state.templateNameBySignature[signature] || '';
  const selected = state.templateBySignature[signature] || '';
  const options = templates.map(template => `<option value="${esc(template.id)}" ${selected === template.id ? 'selected' : ''}>${esc(template.name)}${template.scope === 'project' ? '（项目）' : ''}</option>`).join('');
  return `<div class="w-full space-y-2 text-xs sm:w-auto"><label class="block text-slate-600">应用模板 <select onchange="window.__aiImport.applyTemplate(${inlineArg(signature)},this.value)" class="ml-1 h-8 max-w-52 border border-slate-300 bg-white px-2"><option value="">选择已保存模板</option>${options}</select></label><div class="flex flex-wrap gap-1"><input value="${esc(name)}" oninput="window.__aiImport.setTemplateName(${inlineArg(signature)},this.value)" class="h-8 min-w-36 border border-slate-300 px-2" placeholder="模板名称"><select onchange="window.__aiImport.setTemplateScope(${inlineArg(signature)},this.value)" class="h-8 border border-slate-300 bg-white px-2"><option value="global" ${scope === 'global' ? 'selected' : ''}>全局</option>${state.projectId ? `<option value="project" ${scope === 'project' ? 'selected' : ''}>当前项目</option>` : ''}</select><button onclick="window.__aiImport.saveTemplate(${inlineArg(signature)})" class="h-8 border border-teal-300 bg-teal-50 px-2 text-teal-800">保存映射</button></div></div>`;
}

function mappingControl(signature, field, columns, source, fixed, meta = {}) {
  const hasFixed = Object.prototype.hasOwnProperty.call(fixed, field.key);
  const candidate = !source && meta.candidateSource ? columns.find(item => item.id === meta.candidateSource) : null;
  return `<div><div class="flex flex-col gap-2 sm:flex-row"><select onchange="window.__aiImport.setMapping(${inlineArg(signature)},${inlineArg(field.key)},this.value)" class="h-9 min-w-0 flex-1 border border-slate-300 bg-white px-2"><option value="">不导入</option><option value="__fixed__" ${hasFixed ? 'selected' : ''}>固定值</option>${columns.map(item => `<option value="${esc(item.id)}" ${source === item.id ? 'selected' : ''}>${esc(item.displayName)}${item.unitHint ? ` (${esc(item.unitHint)})` : ''}</option>`).join('')}</select>${hasFixed ? `<input value="${esc(fixed[field.key])}" oninput="window.__aiImport.setFixed(${inlineArg(signature)},${inlineArg(field.key)},this.value)" class="h-9 min-w-0 flex-1 border border-slate-300 px-2" placeholder="固定值">` : ''}</div>${candidate ? `<p class="mt-1 text-xs text-amber-700">候选：${esc(candidate.displayName)}，需要人工确认</p>` : ''}</div>`;
}

function confidenceLabel(value) { return value === 'high' ? '高' : value === 'medium' ? '中' : value === 'low' ? '低' : '未知'; }

function previewPanel(projects) {
  const preview = state.preview;
  if (!preview) return '<div class="p-10 text-center text-slate-400">请先生成预览</div>';
  const rows = preview.rows.filter(row => (!state.issueOnly || row.issues.length) && (!state.issueSeverity || row.issues.some(issue => issue.severity === state.issueSeverity))).slice(0, 100);
  return `<section class="rounded-lg border border-slate-200 bg-white overflow-hidden"><header class="border-b border-slate-200 p-5"><h2 class="font-semibold text-slate-900">质量预览</h2><div class="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-6">${metric('数据区', preview.counts.regions)}${metric('读取明细', preview.counts.total)}${metric('可导入', preview.counts.valid, 'teal')}${metric('无效', preview.counts.invalid, 'red')}${metric('自动跳过', preview.counts.skipped)}${metric('警告', preview.counts.warnings, 'amber')}</div><div class="mt-3 flex flex-wrap items-center gap-3 text-xs"><label><input type="checkbox" ${state.issueOnly ? 'checked' : ''} onchange="window.__aiImport.setIssueOnly(this.checked)"> 只看问题行</label><label>问题级别<select onchange="window.__aiImport.setIssueSeverity(this.value)" class="ml-2 h-8 border border-slate-300 bg-white px-2"><option value="">全部</option><option value="error" ${state.issueSeverity === 'error' ? 'selected' : ''}>错误</option><option value="warning" ${state.issueSeverity === 'warning' ? 'selected' : ''}>警告</option></select></label><button onclick="window.__aiImport.back()" class="text-teal-700 hover:underline">返回修改映射</button><span class="text-slate-400">当前显示 ${rows.length} 行</span></div>${state.targetType === 'boq_quota_bundle' ? '<div class="mt-3 rounded border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-800">清单行作为父项；后续定额行将写入定额库，并通过独立关系记录挂到该清单。相同定额可以被其他清单继续引用。</div>' : ''}${preview.issues.length ? warningBox(preview.issues.slice(0, 20).map(issue => `${issue.sheetName} 第 ${issue.sourceRowNumber} 行：${issue.message}`)) : ''}</header><div class="max-h-[480px] overflow-auto"><table class="w-full min-w-[760px] text-xs"><thead class="sticky top-0 bg-slate-50 text-left text-slate-500"><tr><th class="p-2">来源</th><th class="p-2">名称</th><th class="p-2">单位</th><th class="p-2 text-right">数量/默认量</th><th class="p-2 text-right">单价</th><th class="p-2">检查</th></tr></thead><tbody>${previewRowsHtml(rows)}</tbody></table></div><footer class="border-t border-slate-200 bg-slate-50 p-4"><div class="grid gap-4 lg:grid-cols-[1fr_auto]">${commitOptions(projects)}<div class="flex items-end gap-2"><button onclick="window.__aiImport.back()" class="h-9 px-3 border border-slate-300 bg-white text-sm">返回映射</button><button onclick="window.__aiImport.commit()" ${preview.counts.valid && !state.busy ? '' : 'disabled'} class="h-9 px-4 brand-bg text-white text-sm disabled:opacity-40">${state.busy ? '导入中…' : `确认导入 ${preview.counts.valid} 行`}</button></div></div></footer></section>`;
}

function previewRowsHtml(rows) {
  return rows.map(row => {
    const bundle = state.targetType === 'boq_quota_bundle';
    const child = bundle && row.data.rowKind === 'quota';
    const badge = bundle ? `<span class="badge ${child ? 'badge-yellow' : 'badge-blue'}">${child ? '定额' : '清单'}</span>` : '';
    return `<tr class="border-t ${row.importable ? child ? 'bg-amber-50/30' : '' : 'bg-red-50/50'}"><td class="p-2 text-slate-500">${esc(row.sheetName)}:${row.sourceRowNumber}</td><td class="p-2 font-medium text-slate-800"><div class="flex items-center gap-2 ${child ? 'pl-5' : ''}">${child ? '<span class="text-slate-300">└</span>' : ''}${badge}<span>${esc(row.data.code || '')}${row.data.code ? ' · ' : ''}${esc(row.data.name || '-')}</span></div></td><td class="p-2">${esc(row.data.unit || '-')}</td><td class="p-2 text-right">${esc(row.data.qty ?? row.data.defaultQty ?? '-')}</td><td class="p-2 text-right ${Number(row.data.unitPrice ?? row.data.priceTotal ?? 0) < 0 ? 'text-amber-700 font-semibold' : ''}">${esc(row.data.unitPrice ?? row.data.priceTotal ?? '-')}</td><td class="p-2 ${row.issues.some(issue => issue.severity === 'error') ? 'text-red-700' : row.issues.length ? 'text-amber-700' : 'text-teal-700'}">${esc(row.issues.map(issue => issue.message).join('；') || (child ? '关联上方最近清单' : '父清单'))}</td></tr>`;
  }).join('');
}

function resultPanel() {
  const report = state.report;
  return `<section class="rounded-lg border ${report?.warnings?.length ? 'border-amber-200 bg-amber-50' : 'border-teal-200 bg-teal-50'} p-6"><span class="material-symbols-outlined text-4xl ${report?.warnings?.length ? 'text-amber-700' : 'text-teal-700'}">${report?.warnings?.length ? 'warning' : 'check_circle'}</span><h2 class="mt-2 text-lg font-semibold text-slate-950">${report?.warnings?.length ? '导入完成，但有后处理警告' : '导入已完成'}</h2><p class="mt-2 text-sm text-slate-700">${esc(report?.sourceName || state.fileName)} · 尝试写入 ${report?.counts?.attempted || 0} 行，实际写入 ${report?.counts?.committed || 0} 行，未写入 ${report?.counts?.notWritten || 0} 行。</p><div class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">${metric('新增', report?.counts?.added)}${metric('更新', report?.counts?.updated)}${metric('重复/跳过', report?.counts?.duplicate)}${metric('冲突/失败', report?.counts?.conflict, report?.counts?.conflict ? 'red' : 'slate')}</div>${report?.warnings?.length ? warningBox(report.warnings) : ''}<button onclick="window.__aiImport.cancel()" class="mt-5 h-9 px-4 bg-teal-700 text-white text-sm">返回${esc(TARGETS[state.targetType].label)}</button></section>`;
}

function bindUpload(workspace) {
  const input = workspace.querySelector('#unifiedImportFile');
  const zone = workspace.querySelector('#unifiedImportDrop');
  if (!input || !zone) return;
  input.onchange = () => chooseFile(workspace, input.files?.[0]);
  zone.ondragover = event => { event.preventDefault(); zone.classList.add('border-teal-500'); };
  zone.ondragleave = () => zone.classList.remove('border-teal-500');
  zone.ondrop = event => { event.preventDefault(); zone.classList.remove('border-teal-500'); chooseFile(workspace, event.dataTransfer?.files?.[0]); };
}

async function chooseFile(workspace, file) {
  if (!file) return;
  state.busy = true; await paint(workspace);
  try {
    state.workbook = await parseImportFile(file, { csvEncoding: state.csvEncoding, csvDelimiter: state.csvDelimiter });
    state.fileName = file.name;
    state.regions = detectImportRegions(state.workbook, { schema: getImportSchema(state.targetType) });
    state.selectedRegionIds = new Set(state.regions.filter(region => !region.hidden && region.rows.length && region.confidence !== 'low').map(region => region.id));
    state.step = 'regions';
    if (!state.regions.length) toast('未自动发现数据区，请检查文件表头', 'error');
  } catch (error) { toast(error.message || '文件解析失败', 'error'); }
  finally { state.busy = false; await paint(workspace); }
}

function adjustRegion(workspace, id) {
  const index = state.regions.findIndex(region => region.id === id);
  if (index < 0) return;
  const current = state.regions[index];
  const start = Math.max(0, Number(document.getElementById(`regionStart-${safeId(id)}`)?.value || 1) - 1);
  const end = Math.min(current.matrix.length - 1, Math.max(start, Number(document.getElementById(`regionEnd-${safeId(id)}`)?.value || start + 1) - 1));
  if (end - start + 1 > 6) return toast('表头最多选择 6 行', 'error');
  const header = buildHeaderTree({ sheetName: current.sheetName, regionId: current.id, matrix: current.matrix, merges: current.merges, headerStart: start, headerEnd: end });
  const rows = [];
  const skippedRows = [];
  for (let rowIndex = end + 1; rowIndex <= current.dataEnd; rowIndex += 1) {
    const raw = current.matrix[rowIndex] || [];
    const kind = classifyImportRow(raw, header.columns);
    const row = { sourceRow: rowIndex, sourceRowNumber: rowIndex + 1, kind, raw, values: Object.fromEntries(header.columns.map(column => [column.id, raw[column.columnIndex] ?? ''])) };
    (kind === 'detail' ? rows : skippedRows).push(row);
  }
  state.regions[index] = { ...current, headerStart: start, headerEnd: end, dataStart: end + 1, columns: header.columns, rows, skippedRows, title: header.title, warnings: header.warnings, signature: header.columns.map(column => column.normalizedPath.join('>')).join('|'), confidence: 'manual', manualRequired: false };
  state.selectedRegionIds.add(current.id);
  toast('已按手动表头范围重新识别', 'success');
  paint(workspace);
}

async function prepareMapping(workspace) {
  if (!state.selectedRegionIds.size) return;
  if (selectedRegions().some(region => region.confidence === 'low')) return toast('低置信数据区必须先手动确认表头起止行', 'error');
  state.busy = true; await paint(workspace);
  try {
    const groups = groupSelectedRegions();
    for (const group of groups) {
      const representative = group.regions[0];
      const local = buildImportColumnMapping(representative.columns, representative.rows, state.targetType);
      const recognized = await recognizeImportColumns({ targetType: state.targetType, signature: group.signature, columns: representative.columns, rows: representative.rows }, { localResult: local });
      state.aiStatusBySignature[group.signature] = recognized;
      group.regions.forEach(region => {
        state.mappingByRegion[region.id] = translateMapping(recognized.mapping || local.mapping, representative.columns, region.columns);
        state.fixedByRegion[region.id] ||= {};
      });
      state.fieldMetaBySignature[group.signature] = recognized.fields || local.fields;
    }
    state.step = 'mapping';
  } finally { state.busy = false; await paint(workspace); }
}

function applyTemplate(workspace, signature, templateId) {
  if (!templateId) return;
  const group = groupSelectedRegions().find(item => item.signature === signature);
  const template = listMappingTemplates({ projectId: state.projectId }).find(item => item.id === templateId && item.targetType === state.targetType);
  if (!group || !template) return toast('未找到可用映射模板', 'error');
  group.regions.forEach(region => {
    const applied = applyHierarchicalTemplate(template, region.columns);
    state.mappingByRegion[region.id] = applied.mapping;
    state.fixedByRegion[region.id] = applied.fixedValues;
  });
  state.amountRule = template.amountRule || state.amountRule;
  state.templateBySignature[signature] = template.id;
  markMappingTemplateUsed(template.id);
  toast(`已应用模板“${template.name}”，请在预览前确认必填项`, 'success');
  paint(workspace);
}

function saveTemplate(workspace, signature) {
  const group = groupSelectedRegions().find(item => item.signature === signature);
  const name = String(state.templateNameBySignature[signature] || '').trim();
  if (!group || !name) return toast('请输入模板名称', 'error');
  const representative = group.regions[0];
  const mapping = state.mappingByRegion[representative.id] || {};
  const fixedValues = state.fixedByRegion[representative.id] || {};
  const columnPaths = Object.fromEntries(Object.entries(mapping).flatMap(([key, columnId]) => {
    const column = representative.columns.find(item => item.id === columnId);
    return column ? [[key, column.normalizedPath.join('>')]] : [];
  }));
  try {
    const template = saveMappingTemplate({
      name, scope: state.templateScopeBySignature[signature] || 'global', projectId: state.projectId,
      targetType: state.targetType, mapping: Object.fromEntries(Object.entries(mapping).map(([key, id]) => {
        const column = representative.columns.find(item => item.id === id);
        return [key, column?.displayName || ''];
      })), columnPaths, fixedValues, amountRule: state.amountRule,
      headerFingerprint: { version: 2, signature, columnCount: representative.columns.length },
    });
    state.templateBySignature[signature] = template.id;
    state.templateNameBySignature[signature] = '';
    toast(`已保存映射模板“${template.name}”`, 'success');
    paint(workspace);
  } catch (error) { toast(error.message || '保存模板失败', 'error'); }
}

export function applyHierarchicalTemplate(template = {}, columns = []) {
  const mapping = {};
  const savedPaths = template.columnPaths || {};
  Object.entries(template.mapping || {}).forEach(([key, savedLabel]) => {
    const savedPath = savedPaths[key];
    const exact = savedPath && columns.find(column => column.normalizedPath.join('>') === savedPath);
    const normalized = normalizeTemplateLabel(savedLabel);
    const labelMatches = columns.filter(column => normalizeTemplateLabel(column.displayName) === normalized || normalizeTemplateLabel(column.leafName) === normalized);
    const column = exact || (labelMatches.length === 1 ? labelMatches[0] : null);
    mapping[key] = column?.id || '';
  });
  return { mapping, fixedValues: { ...(template.fixedValues || {}) } };
}

function normalizeTemplateLabel(value) {
  return String(value || '').toLowerCase().replace(/[\s\r\n　()（）\[\]【】_\-/]/g, '');
}

function setGroupMapping(workspace, signature, key, value) {
  const group = groupSelectedRegions().find(item => item.signature === signature);
  if (!group) return;
  const representative = group.regions[0];
  group.regions.forEach(region => {
    state.mappingByRegion[region.id] ||= {};
    state.fixedByRegion[region.id] ||= {};
    if (value === '__fixed__') { delete state.mappingByRegion[region.id][key]; state.fixedByRegion[region.id][key] = ''; }
    else {
      delete state.fixedByRegion[region.id][key];
      state.mappingByRegion[region.id][key] = value ? translateColumnId(value, representative.columns, region.columns) : '';
    }
  });
  paint(workspace);
}

function setGroupFixed(workspace, signature, key, value) {
  const group = groupSelectedRegions().find(item => item.signature === signature);
  group?.regions.forEach(region => { state.fixedByRegion[region.id] ||= {}; state.fixedByRegion[region.id][key] = value; });
}

function buildPreview(workspace) {
  const schema = getImportSchema(state.targetType);
  const missing = [];
  for (const region of selectedRegions()) {
    schema.fields.filter(field => field.required).forEach(field => {
      if (!state.mappingByRegion[region.id]?.[field.key] && !String(state.fixedByRegion[region.id]?.[field.key] ?? '').trim()) missing.push(`${region.sheetName}：${field.label}`);
    });
  }
  if (missing.length) return toast(`请先补齐必填映射：${[...new Set(missing)].join('、')}`, 'error');
  state.preview = analyzeImport(state.regions, { targetType: state.targetType, mappings: state.mappingByRegion, fixedValues: state.fixedByRegion, amountRule: state.amountRule, selectedRegionIds: [...state.selectedRegionIds] });
  state.step = 'preview';
  paint(workspace);
}

async function commit(workspace) {
  if (!state.preview?.counts?.valid) return;
  if (state.targetType === 'project_boq' && state.importMode === 'replace' && !confirm('覆盖会删除当前项目现有清单，但不会删除已保存报价版本。确定覆盖？')) return;
  state.busy = true; await paint(workspace);
  try {
    state.report = await commitImport(state.preview, { projectId: state.projectId, mode: state.importMode, updateExisting: state.updateExisting, sourceName: state.fileName });
    saveImportHistory(state.report);
    state.step = 'result';
    toast(`导入完成：写入 ${state.report.counts.committed} 行`, 'success');
  } catch (error) { toast(`导入失败：${error.message}`, 'error'); }
  finally { state.busy = false; await paint(workspace); }
}

function commitOptions(projects) {
  if (state.targetType === 'project_boq') return `<div>${projectPicker(projects)}<div class="mt-3 text-sm"><label class="mr-4"><input type="radio" name="unifiedMode" ${state.importMode === 'append' ? 'checked' : ''} onchange="window.__aiImport.setImportMode('append')"> 追加</label><label><input type="radio" name="unifiedMode" ${state.importMode === 'replace' ? 'checked' : ''} onchange="window.__aiImport.setImportMode('replace')"> 覆盖当前清单</label></div><label class="mt-3 block text-sm">金额规则 <select onchange="window.__aiImport.setAmountRule(this.value)" class="ml-2 h-9 border border-slate-300 bg-white px-2"><option value="calculated" ${state.amountRule === 'calculated' ? 'selected' : ''}>数量 × 综合单价</option><option value="sourceAmount" ${state.amountRule === 'sourceAmount' ? 'selected' : ''}>使用源合价</option><option value="deriveUnitPrice" ${state.amountRule === 'deriveUnitPrice' ? 'selected' : ''}>合价 ÷ 数量补单价</option></select></label></div>`;
  if (state.targetType === 'boq_quota_bundle') return `<div class="text-sm text-slate-600"><div>已有清单按编码更新；本次出现的清单会以文件中的定额组合替换旧关系。</div><label class="mt-2 block"><input type="checkbox" ${state.updateExisting ? 'checked' : ''} onchange="window.__aiImport.setUpdateExisting(this.checked)"> 同步更新定额库已有价格（未勾选时仅保存关系价格快照）</label></div>`;
  if (state.targetType === 'material' || state.targetType === 'equipment') return '<label class="text-sm"><input type="checkbox" checked onchange="window.__aiImport.setUpdateExisting(this.checked)"> 更新已有同身份资源</label>';
  return '<p class="text-sm text-slate-600">将按现有领域去重规则新增或更新数据。</p>';
}

function projectPicker(projects) { return `<label class="block text-sm text-slate-700">导入项目<select onchange="window.__aiImport.setProject(this.value)" class="ml-2 h-9 min-w-56 border border-slate-300 bg-white px-2">${projects.map(project => `<option value="${project.id}" ${project.id === state.projectId ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}</select></label>`; }
function targetPicker() { return `<label class="block text-sm text-slate-700">导入目标<select onchange="window.__aiImport.setTarget(this.value)" class="ml-2 h-9 min-w-48 border border-slate-300 bg-white px-2">${Object.entries(TARGETS).map(([key, target]) => `<option value="${key}" ${key === state.targetType ? 'selected' : ''}>${esc(target.label)}</option>`).join('')}</select></label>`; }
function groupSelectedRegions() { const map = new Map(); selectedRegions().forEach(region => { const group = map.get(region.signature) || { signature: region.signature, regions: [] }; group.regions.push(region); map.set(region.signature, group); }); return [...map.values()]; }
function selectedRegions() { return state.regions.filter(region => state.selectedRegionIds.has(region.id)); }
function translateMapping(mapping, sourceColumns, targetColumns) { return Object.fromEntries(Object.entries(mapping || {}).map(([key, id]) => [key, translateColumnId(id, sourceColumns, targetColumns)])); }
function translateColumnId(id, sourceColumns, targetColumns) { const source = sourceColumns.find(column => column.id === id); if (!source) return ''; return targetColumns.find(column => column.normalizedPath.join('>') === source.normalizedPath.join('>') && column.columnIndex === source.columnIndex)?.id || targetColumns.find(column => column.normalizedPath.join('>') === source.normalizedPath.join('>'))?.id || ''; }
function metric(label, value, tone = 'slate') { const tones = { slate: 'text-slate-800', teal: 'text-teal-800', red: 'text-red-700', amber: 'text-amber-700' }; return `<div class="border border-slate-200 bg-white p-2"><div class="text-slate-500">${label}</div><div class="mt-1 text-lg font-semibold ${tones[tone]}">${Number(value || 0).toLocaleString('zh-CN')}</div></div>`; }
function warningBox(items) { return `<div class="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">${items.slice(0, 20).map(esc).join('；')}</div>`; }
function safeId(value) { return String(value).replace(/[^a-z0-9_-]/gi, '_'); }
function inlineArg(value) { return esc(JSON.stringify(String(value))); }
function saveImportHistory(report) {
  try {
    const key = 'costdb_import_history_v1';
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const history = Array.isArray(existing) ? existing : [];
    history.unshift({
      targetType: report.targetType, sourceName: report.sourceName, outcome: report.outcome,
      attempted: report.counts?.attempted || 0, committed: report.counts?.committed || 0,
      notWritten: report.counts?.notWritten || 0, importedAt: new Date().toISOString(),
    });
    localStorage.setItem(key, JSON.stringify(history.slice(0, 20)));
  } catch {
    // 本地摘要失败不影响已经完成的业务写入。
  }
}

export function getImportBlockingReasons(fields = [], fieldState = {}, { targetType, projectId } = {}) {
  const reasons = [];
  if (fields.some(field => { const value = fieldState[field.key]; return value && value.sourceType !== 'none' && !value.confirmed; })) reasons.push('请确认你修改过或识别不确定的字段');
  fields.filter(field => field.required).forEach(field => {
    const value = fieldState[field.key] || {};
    if (!value.sourceType || value.sourceType === 'none') reasons.push(`“${field.label}”是必填字段：请选择 Excel 来源列或填写固定值`);
    if (value.sourceType === 'fixed' && !String(value.fixedValue || '').trim()) reasons.push(`“${field.label}”填写了固定值，但内容为空`);
  });
  if (targetType === 'project_boq' && !projectId) reasons.push('请选择导入项目');
  const used = new Map();
  fields.forEach(field => { const value = fieldState[field.key]; if (value?.sourceType !== 'column') return; const previous = used.get(value.source); if (previous) reasons.push(`Excel 列「${value.source}」不能同时映射到多个系统字段`); used.set(value.source, field.key); });
  return [...new Set(reasons)];
}

export function splitImportedNameFeature(name, feature, { combined = false } = {}) {
  const nameText = String(name || '').replace(/\r\n?/g, '\n').trim();
  const featureText = String(feature || '').replace(/\r\n?/g, '\n').trim();
  const lines = nameText.split('\n').map(line => line.trim()).filter(Boolean);
  const same = combined || (nameText && featureText && nameText === featureText);
  return { name: lines[0] || nameText, feature: (same ? lines.slice(1).join('\n') : featureText || lines.slice(1).join('\n')).trim() };
}
