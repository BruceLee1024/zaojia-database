// AI 自由格式清单导入向导。标准表头自动采用，模型仅补充模糊映射建议。
import { readWorkbookSummary } from '../data/excel.js?v=6.2';
import { recognizeBoqImport, getRecognitionFields } from '../services/aiImportRecognitionService.js?v=6.2';
import { boqService } from '../services/boqService.js?v=6.2';
import { boqLibraryService } from '../services/boqLibraryService.js?v=6.2';
import { projectRepo } from '../data/repository.js?v=6.2';
import { dataEngineService } from '../services/dataEngineService.js?v=6.2';
import { calculateAmount, hasMissingPrice } from '../utils/costing.js?v=6.2';
import { categoryGuess } from '../utils/stats.js?v=6.2';
import { normalizeImportHeader } from '../services/importMappingService.js?v=6.2';
import { esc, toast } from '../utils/dom.js?v=6.2';

const state = {
  targetType: 'project_boq', projectId: '', fileName: '', sheets: [], sheetIndex: -1,
  step: 'upload', recognition: null, fieldState: {}, combinedMapping: null, amountRule: 'calculated', importMode: 'append', busy: false, routeSignature: '',
};

export function normalizeWizardStep(step, { recognition, hasSheet } = {}) {
  if (step === 'confirm' && (!recognition || !hasSheet)) return hasSheet ? 'sheet' : 'upload';
  return step;
}

export async function render(workspace = document.getElementById('workspace')) {
  const params = window.__app.state.routeParams || {};
  const targetType = params.targetType === 'boq_library' ? 'boq_library' : 'project_boq';
  const requestedProjectId = params.projectId || window.__app.state.currentProjectId || '';
  const routeSignature = `${targetType}:${requestedProjectId}`;
  if (state.routeSignature !== routeSignature) {
    Object.assign(state, {
      targetType, projectId: requestedProjectId, fileName: '', sheets: [], sheetIndex: -1,
      step: 'upload', recognition: null, fieldState: {}, combinedMapping: null, amountRule: 'calculated', importMode: 'append', busy: false, routeSignature,
    });
  } else {
    state.targetType = targetType;
    state.projectId = requestedProjectId || state.projectId;
  }
  if (state.targetType === 'project_boq' && !state.projectId) {
    const projects = await projectRepo.all();
    state.projectId = projects[0]?.id || '';
  }
  state.step = normalizeWizardStep(state.step, { recognition: state.recognition, hasSheet: Boolean(currentSheet()) });
  expose(workspace);
  await paint(workspace);
}

function expose(workspace) {
  window.__aiImport = {
    chooseFile: file => chooseFile(workspace, file),
    selectSheet: index => selectSheet(workspace, index),
    runRecognition: () => runRecognition(workspace),
    setSource: (key, source) => setSource(workspace, key, source),
    setFixedValue,
    confirmField: (key, confirmed) => confirmField(workspace, key, confirmed),
    confirmCombinedMapping: confirmed => confirmCombinedMapping(workspace, confirmed),
    disableCombinedMapping: () => disableCombinedMapping(workspace),
    setAmountRule: rule => setAmountRule(workspace, rule),
    setProject: value => { state.projectId = value; paint(workspace); },
    setImportMode: value => { state.importMode = value; paint(workspace); },
    back: () => { state.step = state.step === 'confirm' ? 'sheet' : 'upload'; paint(workspace); },
    save: () => importConfirmed(workspace),
    goSettings: () => window.__app.go('settings', { section: 'ai' }),
    cancel: () => window.__app.go(state.targetType === 'boq_library' ? 'boq-library' : 'importer'),
  };
}

async function paint(workspace) {
  const title = state.targetType === 'boq_library' ? 'AI 导入我的清单库' : 'AI 导入项目工程量清单';
  const projectOptions = state.targetType === 'project_boq' ? await projectRepo.all() : [];
  workspace.innerHTML = `
    <div class="page-frame min-h-full p-5">
      <div class="mb-5 flex items-start gap-3"><button onclick="window.__aiImport.cancel()" class="mt-0.5 h-9 w-9 border border-slate-300 bg-white text-slate-600" title="返回"><span class="material-symbols-outlined">arrow_back</span></button><div><h1 class="text-xl font-semibold text-slate-900">${title}</h1><p class="mt-1 text-sm text-slate-500">上传任意常见 Excel，AI 只识别字段结构；逐字段确认后才会写入本机数据。</p></div></div>
      <div class="mb-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">发送给已配置 AI 服务的内容仅包括：工作表名称、表头和前 50 行样本；不会发送整份文件或本机项目资料。</div>
      ${stepper()}
      ${state.step === 'upload' ? uploadPanel(projectOptions) : state.step === 'sheet' ? sheetPanel() : confirmPanel(projectOptions)}
    </div>`;
  bindUpload(workspace);
}

function stepper() {
  const labels = [['upload', '1. 上传文件'], ['sheet', '2. 选择工作表'], ['confirm', '3. 确认字段并导入']];
  const order = { upload: 0, sheet: 1, confirm: 2 };
  return `<div class="mb-5 flex items-center gap-2 text-sm">${labels.map(([key, label], index) => `<div class="flex items-center gap-2 ${order[state.step] >= index ? 'text-teal-700 font-medium' : 'text-slate-400'}"><span class="h-6 w-6 rounded-full border flex items-center justify-center text-xs ${order[state.step] >= index ? 'border-teal-500 bg-teal-50' : 'border-slate-300'}">${index + 1}</span>${label}${index < labels.length - 1 ? '<span class="mx-2 h-px w-12 bg-slate-200"></span>' : ''}</div>`).join('')}</div>`;
}

function uploadPanel(projects) {
  const target = state.targetType === 'boq_library' ? '标准清单库条目' : '当前项目工程量清单';
  return `<section class="rounded-lg border border-slate-200 bg-white p-6"><h2 class="text-base font-semibold text-slate-900">上传 Excel</h2><p class="mt-2 text-sm text-slate-500">导入目标：${target}。支持 .xlsx、.xls；请在下一步选择实际清单所在的工作表。</p>${state.targetType === 'project_boq' ? projectPicker(projects) : ''}<label id="aiImportDrop" class="mt-5 flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-6 text-center hover:border-teal-400 hover:bg-teal-50/30"><span class="material-symbols-outlined text-4xl text-teal-700">upload_file</span><span class="mt-3 font-medium text-slate-800">选择或拖入 Excel 文件</span><span class="mt-1 text-xs text-slate-500">文件先在浏览器本地解析</span><input id="aiImportFile" type="file" accept=".xlsx,.xls" class="hidden" /></label></section>`;
}

function sheetPanel() {
  return `<section class="rounded-lg border border-slate-200 bg-white p-5"><div class="flex items-center"><div><h2 class="font-semibold text-slate-900">选择要识别的工作表</h2><p class="mt-1 text-sm text-slate-500">${esc(state.fileName)} · 请选择包含清单表头和数据的工作表。</p></div><button onclick="window.__aiImport.back()" class="ml-auto h-9 px-3 text-sm border border-slate-300 bg-white">重新选择文件</button></div><div class="mt-5 grid gap-3">${state.sheets.map((sheet, index) => `<label class="cursor-pointer rounded-lg border p-4 ${state.sheetIndex === index ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white'}"><div class="flex items-center gap-3"><input type="radio" name="aiSheet" value="${index}" ${state.sheetIndex === index ? 'checked' : ''} onchange="window.__aiImport.selectSheet(this.value)" /><div class="min-w-0 flex-1"><div class="font-medium text-slate-900">${esc(sheet.name)}</div><div class="mt-1 text-xs text-slate-500">${sheet.rowCount} 行 · ${sheet.headers.length ? `识别到 ${sheet.headers.length} 列：${esc(sheet.headers.slice(0, 6).join('、'))}` : '未识别候选表头'}</div></div></div>${combinedColumnNotice(sheet)}${sheet.previewRows.length ? `<div class="mt-3 overflow-auto rounded border border-slate-200"><table class="w-full text-xs"><thead class="bg-slate-50"><tr>${sheet.headers.slice(0, 6).map(header => `<th class="p-2 text-left">${esc(header)}</th>`).join('')}</tr></thead><tbody>${sheet.previewRows.slice(0, 2).map(row => `<tr class="border-t">${sheet.headers.slice(0, 6).map(header => `<td class="whitespace-pre-line p-2 align-top text-slate-600">${esc(row[header])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}</label>`).join('')}</div><div class="mt-5 flex justify-end"><button onclick="window.__aiImport.runRecognition()" ${state.sheetIndex < 0 || state.busy ? 'disabled' : ''} class="h-10 px-4 text-sm brand-bg text-white disabled:opacity-50">${state.busy ? 'AI 识别中…' : '开始 AI 识别'}</button></div></section>`;
}

function combinedColumnNotice(sheet) {
  const combinedHeader = sheet.headers.find(header => normalizeImportHeader(header) === '项目名称项目特征');
  if (!combinedHeader) return '';
  return `<div class="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"><strong>检测到合并来源列「${esc(combinedHeader)}」。</strong>这不是把相邻两列拼错：原工作表在同一列中提供名称和特征。若单元格内以换行分隔，导入时会取第一行作为“清单名称”、其余内容作为“项目特征”；预览已保留换行。若原单元格没有换行，请在下一步手动确认，不会自动猜测拆分位置。</div>`;
}

function confirmPanel(projects) {
  const fields = getRecognitionFields(state.targetType);
  const selected = currentSheet();
  if (!state.recognition || !selected) return incompleteRecognitionPanel();
  const regularFields = fields.filter(field => !isCombinedField(field.key));
  const confirmedCount = fields.filter(field => state.fieldState[field.key]?.confirmed).length;
  const blockingReasons = getImportBlockingReasons(fields, state.fieldState, { targetType: state.targetType, projectId: state.projectId });
  const valid = blockingReasons.length === 0;
  return `<section class="rounded-lg border border-slate-200 bg-white overflow-hidden"><div class="p-5 border-b border-slate-200"><div class="flex items-start gap-3"><div><h2 class="font-semibold text-slate-900">确认“系统字段 ← Excel 列”的对应关系</h2><p class="mt-1 text-sm text-slate-500">系统会先自动采用标准表头和高置信度匹配；只有你改过或识别不确定的字段才需要确认。</p></div><button onclick="window.__aiImport.back()" class="ml-auto h-9 px-3 text-sm border border-slate-300 bg-white">返回工作表</button></div>${mappingGuide()}${combinedMappingPanel()}${recognitionBasisPanel(selected)}${state.recognition.warnings?.length ? `<div class="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">${state.recognition.warnings.map(esc).join('；')}</div>` : ''}</div><div class="overflow-auto"><table class="w-full min-w-[960px] text-sm"><thead class="bg-slate-50 text-left text-slate-500"><tr><th class="p-3">① 系统字段（要保存什么）</th><th class="p-3">② Excel 来源列（从哪列取值）</th><th class="p-3">③ 该列样本值</th><th class="p-3">AI / 规则为什么这样建议</th><th class="p-3 w-24 text-center">④ 状态</th></tr></thead><tbody>${regularFields.map(field => fieldRow(field, selected)).join('')}</tbody></table></div><div class="border-t border-slate-200 bg-slate-50 p-5"><div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-5"><div>${state.targetType === 'project_boq' ? projectPicker(projects) + importModePicker() + amountRulePicker() : '<div class="text-sm text-slate-600">将按编码优先、名称 + 特征 + 单位兜底规则更新或新增清单库条目。</div>'}<div class="mt-3 text-xs ${valid ? 'text-teal-700' : 'text-amber-700'}">已采用 ${confirmedCount} / ${fields.length} 个字段。${valid ? '可以导入。' : `还不能导入：${esc(blockingReasons.join('；'))}`}</div></div><div class="flex items-end justify-end gap-2"><button onclick="window.__aiImport.cancel()" class="h-10 px-4 text-sm border border-slate-300 bg-white">取消</button><button onclick="window.__aiImport.save()" ${valid || state.busy ? '' : 'disabled'} class="h-10 px-4 text-sm brand-bg text-white disabled:opacity-50">${state.busy ? '导入中…' : state.targetType === 'boq_library' ? '确认导入清单库' : '确认导入项目清单'}</button></div></div></div></section>`;
}

function isCombinedField(key) { return state.combinedMapping?.status === 'ready' && (key === 'name' || key === 'feature'); }

function combinedMappingPanel() {
  const mapping = state.combinedMapping;
  if (!mapping) return '';
  if (mapping.status !== 'ready') return `<div class="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950"><strong>合并列无法安全拆分。</strong>「${esc(mapping.source)}」的样本中有 ${mapping.sampleCount - mapping.validSampleCount} 行没有换行后的项目特征。系统不会猜测文本边界；请在下方手动只映射“清单名称”，或返回工作表选择正确的独立列。</div>`;
  return `<div class="mt-4 rounded-md border border-teal-300 bg-teal-50 p-4 text-sm text-teal-950"><div class="flex items-start gap-3"><div><div class="font-semibold">已自动识别“名称 + 特征”合并列</div><div class="mt-1 text-xs text-teal-800">来源列：Excel「${esc(mapping.source)}」 · 拆分规则：首行 → 清单名称；其余非空行 → 项目特征。</div></div><button onclick="window.__aiImport.disableCombinedMapping()" class="ml-auto h-8 shrink-0 border border-teal-300 bg-white px-2 text-xs text-teal-900">改为手动映射</button></div><div class="mt-3 grid gap-2">${mapping.preview.map((item, index) => `<div class="rounded border border-teal-200 bg-white px-3 py-2 text-xs"><span class="mr-2 text-teal-700">样本 ${index + 1}</span><strong>${esc(item.name)}</strong><span class="mx-2 text-teal-500">→</span><span class="whitespace-pre-line text-slate-700">${esc(item.feature)}</span></div>`).join('')}</div><div class="mt-3 text-xs font-medium text-teal-800">已自动采用；如拆分结果不符合原表，可改为手动映射。</div></div>`;
}

function mappingGuide() {
  return `<div class="mt-4 rounded-md border border-teal-200 bg-teal-50 p-3 text-xs text-teal-950"><div class="flex flex-wrap items-center gap-x-2 gap-y-1"><strong>怎么看这张表：</strong><span>系统字段「清单名称」</span><span class="font-semibold text-teal-700">←</span><span>Excel 来源列「项目名称」</span><span class="text-teal-700">表示把 Excel 每一行的“项目名称”写入清单库的“清单名称”。</span></div><div class="mt-1 text-teal-800">系统会先按标准表头自动匹配并直接采用；只有没有标准列或置信度不足时，才需要在中间下拉框修改并确认。没有对应数据的可选字段会自动设为“不导入”。带 <span class="text-red-600">*</span> 的字段仍必须有来源列或固定值。</div></div>`;
}

function incompleteRecognitionPanel() {
  return `<section class="rounded-lg border border-amber-200 bg-amber-50 p-6"><h2 class="font-semibold text-amber-900">尚未完成 AI 识别</h2><p class="mt-2 text-sm text-amber-800">请先选择工作表并运行 AI 识别。AI 建议只会基于该工作表的列名和前 50 行样本生成。</p><button onclick="window.__aiImport.back()" class="mt-4 h-9 px-3 text-sm border border-amber-300 bg-white text-amber-900">返回选择工作表</button></section>`;
}

function recognitionBasisPanel(sheet) {
  const analysis = state.recognition.analysis || {};
  const headers = analysis.headers?.length ? analysis.headers : sheet.headers;
  const sampleRowCount = analysis.sampleRowCount ?? Math.min(sheet.rows.length, 50);
  return `<div class="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-950"><div class="font-semibold">AI 的建议依据</div><div class="mt-1">已分析工作表「${esc(analysis.sheetName || sheet.name)}」的 ${analysis.headerCount || headers.length} 个列名和 ${sampleRowCount} 行样本（最多 50 行）。建议来自你在“AI 设置”中配置的模型对列名和样本值的判断，不会读取清单库、定额库或其他项目资料。</div>${state.recognition.sheetUnderstanding ? `<div class="mt-1">表格理解：${esc(state.recognition.sheetUnderstanding)}</div>` : ''}<div class="mt-1 text-blue-800">已传入列：${esc(headers.slice(0, 12).join('、'))}${headers.length > 12 ? ' 等' : ''}</div></div>`;
}

function fieldRow(field, sheet) {
  const value = state.fieldState[field.key] || emptyField(field);
  const sample = value.sourceType === 'column' ? sheet?.rows?.find(row => String(row[value.source] ?? '').trim() !== '')?.[value.source] : value.fixedValue;
  const options = ['<option value="">不导入（没有对应列）</option>', '<option value="__fixed__">固定值（每行相同）</option>'].concat((sheet?.headers || []).map(header => `<option value="${esc(header)}">Excel 列：${esc(header)}</option>`)).join('');
  const selected = value.sourceType === 'fixed' ? '__fixed__' : value.sourceType === 'column' ? value.source : '';
  const noMatch = value.sourceType === 'none';
  const alternatives = value.alternatives?.length ? `<div class="mt-1 text-xs text-slate-500">候选列：${esc(value.alternatives.join('、'))}</div>` : '';
  const status = noMatch
    ? field.required
      ? '<span class="text-xs text-amber-700">请选择来源</span>'
      : '<span class="text-xs text-slate-500">不导入</span>'
    : value.autoMatched
      ? '<span class="inline-flex rounded-full bg-teal-100 px-2 py-1 text-xs font-medium text-teal-800">已自动匹配</span>'
      : value.confirmed
        ? '<span class="inline-flex rounded-full bg-teal-100 px-2 py-1 text-xs font-medium text-teal-800">已确认</span>'
        : `<label class="inline-flex cursor-pointer items-center gap-1 text-xs text-amber-800"><input type="checkbox" onchange="window.__aiImport.confirmField('${field.key}', this.checked)" />确认</label>`;
  return `<tr class="border-t border-slate-100 ${value.confirmed ? 'bg-teal-50/30' : ''}"><td class="p-3"><div class="font-medium text-slate-800">${field.label}${field.required ? '<span class="ml-1 text-red-500">*</span>' : ''}</div></td><td class="p-3"><select onchange="window.__aiImport.setSource('${field.key}', this.value)" class="h-9 min-w-56 rounded border border-slate-300 bg-white px-2 text-sm">${options.replace(`value="${esc(selected)}"`, `value="${esc(selected)}" selected`)}</select>${value.sourceType === 'fixed' ? `<input value="${esc(value.fixedValue)}" oninput="window.__aiImport.setFixedValue('${field.key}', this.value)" placeholder="输入固定值" class="ml-2 h-9 w-40 rounded border border-slate-300 px-2 text-sm" />` : ''}</td><td class="p-3 text-slate-600">${esc(noMatch ? '没有可用来源列' : sample == null ? '-' : String(sample).slice(0, 80))}</td><td class="p-3"><span class="text-xs ${value.confidence === 'high' ? 'text-teal-700' : value.confidence === 'medium' ? 'text-amber-700' : 'text-slate-500'}">${value.confidence === 'high' ? '高' : value.confidence === 'medium' ? '中' : '低'}置信度</span><div class="mt-1 text-xs text-slate-500">${esc(value.reason || (noMatch ? '未匹配到来源列，请手动选择、设为固定值或不导入' : 'AI 识别建议'))}</div>${alternatives}</td><td class="p-3 text-center">${status}</td></tr>`;
}

function projectPicker(projects) { return `<label class="mt-4 block text-sm text-slate-700">导入项目<select onchange="window.__aiImport.setProject(this.value)" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2">${projects.map(project => `<option value="${project.id}" ${project.id === state.projectId ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}</select></label>`; }
function importModePicker() { return `<div class="mt-4 text-sm"><div class="mb-1 text-slate-700">导入方式</div><label class="mr-4"><input type="radio" name="aiImportMode" ${state.importMode === 'append' ? 'checked' : ''} onchange="window.__aiImport.setImportMode('append')" /> 追加</label><label><input type="radio" name="aiImportMode" ${state.importMode === 'replace' ? 'checked' : ''} onchange="window.__aiImport.setImportMode('replace')" /> 覆盖当前清单</label></div>`; }
function amountRulePicker() { return `<label class="mt-4 block text-sm text-slate-700">金额规则<select onchange="window.__aiImport.setAmountRule(this.value)" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2"><option value="calculated" ${state.amountRule === 'calculated' ? 'selected' : ''}>数量 × 综合单价</option><option value="sourceAmount" ${state.amountRule === 'sourceAmount' ? 'selected' : ''}>使用 Excel 合价</option><option value="deriveUnitPrice" ${state.amountRule === 'deriveUnitPrice' ? 'selected' : ''}>合价 ÷ 数量补单价</option></select></label>`; }

function bindUpload(workspace) {
  const input = workspace.querySelector('#aiImportFile'); const zone = workspace.querySelector('#aiImportDrop');
  if (!input || !zone) return;
  input.onchange = () => chooseFile(workspace, input.files?.[0]);
  zone.ondragover = event => { event.preventDefault(); zone.classList.add('border-teal-500'); };
  zone.ondragleave = () => zone.classList.remove('border-teal-500');
  zone.ondrop = event => { event.preventDefault(); zone.classList.remove('border-teal-500'); chooseFile(workspace, event.dataTransfer?.files?.[0]); };
}

async function chooseFile(workspace, file) {
  if (!file) return;
  if (!/\.(xlsx|xls)$/i.test(file.name)) return toast('请选择 .xlsx 或 .xls 文件', 'error');
  try { state.fileName = file.name; state.sheets = await readWorkbookSummary(file); state.sheetIndex = -1; state.recognition = null; state.fieldState = {}; state.combinedMapping = null; state.step = 'sheet'; await paint(workspace); }
  catch (error) { toast(`文件解析失败：${error.message}`, 'error'); }
}

function selectSheet(workspace, index) { state.sheetIndex = Number(index); paint(workspace); }
async function runRecognition(workspace) {
  const sheet = currentSheet(); if (!sheet?.headers?.length || !sheet.rows.length) return toast('请选择含有可用表头和数据的工作表', 'error');
  state.busy = true; await paint(workspace);
  try {
    state.recognition = await recognizeBoqImport({ targetType: state.targetType, sheetName: sheet.name, headers: sheet.headers, sampleRows: sheet.rows });
    state.fieldState = state.recognition.fields;
    state.combinedMapping = createCombinedMapping(sheet.combinedNameFeature);
    if (state.combinedMapping?.status === 'ready') applyCombinedFieldState(state.combinedMapping);
    if (state.combinedMapping?.status === 'invalid') clearUnsafeCombinedSuggestions(state.combinedMapping.source);
    state.amountRule = state.recognition.amountRule;
    state.step = 'confirm';
  }
  catch (error) { toast(error.message || 'AI 识别失败，请重试', 'error'); }
  finally { state.busy = false; await paint(workspace); }
}

function setSource(workspace, key, source) { const field = state.fieldState[key]; if (!field) return; state.fieldState[key] = { ...field, sourceType: source === '__fixed__' ? 'fixed' : source ? 'column' : 'none', source: source && source !== '__fixed__' ? source : '', fixedValue: source === '__fixed__' ? field.fixedValue : '', confirmed: false, autoMatched: false }; paint(workspace); }
function setFixedValue(key, fixedValue) { state.fieldState[key] = { ...state.fieldState[key], fixedValue, confirmed: false, autoMatched: false }; }
function confirmField(workspace, key, confirmed) { state.fieldState[key] = { ...state.fieldState[key], confirmed }; paint(workspace); }
function createCombinedMapping(meta) { return meta ? { ...meta, confirmed: meta.status === 'ready', autoMatched: meta.status === 'ready' } : null; }
function applyCombinedFieldState(mapping) {
  ['name', 'feature'].forEach(key => {
    const field = state.fieldState[key];
    if (!field) return;
    state.fieldState[key] = { ...field, sourceType: 'combined', source: mapping.source, fixedValue: '', transform: mapping.strategy, confidence: 'high', reason: '系统根据合并表头和换行样本识别为“名称 + 特征”列', confirmed: true, autoMatched: true };
  });
}
function clearUnsafeCombinedSuggestions(source) {
  ['name', 'feature'].forEach(key => {
    const field = state.fieldState[key];
    if (field?.source === source) state.fieldState[key] = { ...field, sourceType: 'none', source: '', fixedValue: '', confirmed: false, reason: '合并列没有稳定换行结构，需手动选择来源列' };
  });
}
function confirmCombinedMapping(workspace, confirmed) {
  if (state.combinedMapping?.status !== 'ready') return;
  state.combinedMapping.confirmed = confirmed;
  ['name', 'feature'].forEach(key => { state.fieldState[key] = { ...state.fieldState[key], confirmed }; });
  paint(workspace);
}
function disableCombinedMapping(workspace) {
  if (!state.combinedMapping) return;
  ['name', 'feature'].forEach(key => {
    const field = state.fieldState[key];
    state.fieldState[key] = { ...field, sourceType: 'none', source: '', fixedValue: '', transform: '', confirmed: false, confidence: 'low', reason: '请手动选择独立来源列，或将项目特征设为不导入' };
  });
  state.combinedMapping = null;
  paint(workspace);
}
function setAmountRule(workspace, amountRule) { state.amountRule = amountRule; paint(workspace); }
function emptyField(def) { return { key: def.key, label: def.label, required: Boolean(def.required), sourceType: 'none', source: '', fixedValue: '', confidence: 'low', reason: '未识别', confirmed: false }; }
function currentSheet() { return state.sheets[state.sheetIndex] || null; }

export function getImportBlockingReasons(fields = [], fieldState = {}, { targetType, projectId } = {}) {
  const reasons = [];
  if (fields.some(field => {
    const value = fieldState[field.key];
    return value && value.sourceType !== 'none' && !value.confirmed;
  })) reasons.push('请确认你修改过或识别不确定的字段');
  fields.filter(field => field.required).forEach(field => {
    const value = fieldState[field.key] || {};
    if (!value.sourceType || value.sourceType === 'none') reasons.push(`“${field.label}”是必填字段：请选择 Excel 来源列或填写固定值`);
    if (value.sourceType === 'fixed' && !String(value.fixedValue || '').trim()) reasons.push(`“${field.label}”填写了固定值，但内容为空`);
  });
  if (targetType === 'project_boq' && !projectId) reasons.push('请选择导入项目');
  const used = new Map();
  for (const field of fields) {
    const value = fieldState[field.key];
    if (value?.sourceType !== 'column') continue;
    const previous = used.get(value.source);
    const sharedNameFeature = (previous === 'name' || previous === 'feature') && (field.key === 'name' || field.key === 'feature') && normalizeImportHeader(value.source) === '项目名称项目特征';
    if (previous && !sharedNameFeature) reasons.push(`Excel 列“${value.source}”不能同时映射到多个系统字段`);
    used.set(value.source, field.key);
  }
  return [...new Set(reasons)];
}

function canImport() {
  return getImportBlockingReasons(getRecognitionFields(state.targetType), state.fieldState, { targetType: state.targetType, projectId: state.projectId }).length === 0;
}

function mappedValue(row, key) { const field = state.fieldState[key]; return field?.sourceType === 'column' || field?.sourceType === 'combined' ? row[field.source] : field?.sourceType === 'fixed' ? field.fixedValue : ''; }
function mappedNameFeature(row) { return splitImportedNameFeature(mappedValue(row, 'name'), mappedValue(row, 'feature'), { combined: state.fieldState.name?.sourceType === 'combined' && state.fieldState.feature?.sourceType === 'combined' }); }
export function splitImportedNameFeature(name, feature, { combined = false } = {}) {
  const nameText = String(name || '').replace(/\r\n?/g, '\n').trim();
  const featureText = String(feature || '').replace(/\r\n?/g, '\n').trim();
  const lines = nameText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const usesSameCombinedColumn = combined || (nameText && featureText && nameText === featureText);
  return {
    name: lines[0] || nameText,
    feature: (usesSameCombinedColumn ? lines.slice(1).join('\n') : featureText || lines.slice(1).join('\n')).trim(),
  };
}

async function importConfirmed(workspace) {
  if (!canImport()) return toast('请完成所有字段确认并补齐必填字段', 'error');
  const rows = currentSheet().rows;
  state.busy = true; await paint(workspace);
  try {
    if (state.targetType === 'boq_library') {
      const result = await boqLibraryService.importRows(rows.map(row => { const split = mappedNameFeature(row); return { major: mappedValue(row, 'major'), code: mappedValue(row, 'code'), name: split.name, feature: split.feature, unit: mappedValue(row, 'unit'), defaultQty: Number(mappedValue(row, 'defaultQty')) || 0, scope: mappedValue(row, 'scope'), structureGroup: mappedValue(row, 'structureGroup'), quotaRefs: mappedValue(row, 'quotaRefs'), source: mappedValue(row, 'source'), version: mappedValue(row, 'version'), note: mappedValue(row, 'note') }; }));
      toast(`清单库导入完成：新增 ${result.added} 条，更新 ${result.updated} 条`, 'success'); window.__app.go('boq-library'); return;
    }
    if (state.importMode === 'replace' && !confirm('覆盖会删除当前项目现有清单，但不会删除已保存报价版本。确定覆盖？')) return;
    const lines = rows.map(row => { const split = mappedNameFeature(row); const qty = Number(mappedValue(row, 'qty')) || 0; const sourcePrice = Number(mappedValue(row, 'unitPrice')) || 0; const sourceAmount = Number(mappedValue(row, 'amount')) || 0; const unitPrice = state.amountRule === 'deriveUnitPrice' && !sourcePrice && qty > 0 ? sourceAmount / qty : sourcePrice; return { code: mappedValue(row, 'code'), name: split.name, feature: split.feature, unit: mappedValue(row, 'unit'), qty, factor: 1, unitPrice, amount: state.amountRule === 'sourceAmount' && sourceAmount > 0 ? sourceAmount : calculateAmount(qty, unitPrice, 1), priceMissing: hasMissingPrice(unitPrice), process: mappedValue(row, 'process'), structureGroup: mappedValue(row, 'costCategory') || categoryGuess(split.name) }; }).filter(row => row.name && row.unit && row.qty > 0);
    if (!lines.length) throw new Error('没有可导入的有效清单行');
    const result = await boqService.importLines(state.projectId, lines, { mode: state.importMode });
    await dataEngineService.ingestBOQ(state.projectId, { sourceType: 'ai_excel_import', sourceId: state.fileName });
    if (workspace.isInvalidated) return;
    window.__app.state.currentProjectId = state.projectId;
    toast(`项目清单导入完成：成功 ${result.success} 条，缺单价 ${result.missingPrice} 条`, 'success');
    window.__app.go('boq', { projectId: state.projectId, imported: true });
  } catch (error) { toast(`导入失败：${error.message}`, 'error'); }
  finally { state.busy = false; }
}
