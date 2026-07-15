import { exportResourceTemplate } from '../data/excel.js?v=6.2';
import { resourceImportService } from '../services/resourceImportService.js?v=6.2';
import { esc, toast } from '../utils/dom.js?v=6.2';

const state = { resourceType: 'material', fileName: '', preview: null, report: null, busy: false };

export async function render(workspace = document.getElementById('workspace')) {
  state.resourceType = window.__app?.state?.routeParams?.resourceType === 'equipment' ? 'equipment' : 'material';
  state.fileName = '';
  state.preview = null;
  state.report = null;
  exposeActions(workspace);
  await paint(workspace);
}

function exposeActions(workspace) {
  window.__resourceImport = {
    back: () => window.__app.go(state.resourceType === 'equipment' ? 'equipment' : 'materials'),
    pick: () => workspace.querySelector('#resourceImportFile')?.click(),
    handle: async input => {
      const file = input.files?.[0];
      if (!file) return;
      state.busy = true; state.fileName = file.name; state.report = null; await paint(workspace);
      try { state.preview = await resourceImportService.preview(await resourceImportService.parse(file, state.resourceType), state.resourceType); }
      catch (error) { state.preview = null; toast(error.message || '文件解析失败', 'error'); }
      finally { state.busy = false; await paint(workspace); }
    },
    commit: async () => {
      if (!state.preview || state.preview.counts.valid === 0) return;
      state.busy = true; await paint(workspace);
      try { state.report = await resourceImportService.commit(state.preview, { updateExisting: workspace.querySelector('#resourceImportUpdate')?.checked !== false }); toast('导入已完成', 'success'); }
      catch (error) { state.report = error.report || null; toast(error.message || '导入失败', 'error'); }
      finally { state.busy = false; await paint(workspace); }
    },
    template: () => exportResourceTemplate(state.resourceType),
  };
}

async function paint(workspace) {
  const label = state.resourceType === 'equipment' ? '设备' : '材料';
  const preview = state.preview;
  workspace.innerHTML = `<div class="page-frame min-h-full flex flex-col gap-4">
    <section class="rounded-lg border border-slate-200 bg-white p-5"><div class="flex flex-col gap-3 lg:flex-row lg:items-center"><button onclick="window.__resourceImport.back()" class="h-9 w-9 border border-slate-300 bg-white" aria-label="返回${label}库"><span class="material-symbols-outlined text-[18px]">arrow_back</span></button><div><h1 class="text-xl font-semibold text-slate-950">导入${label}库</h1><p class="mt-1 text-sm text-slate-500">先预览身份匹配和数据问题，确认后一次性保存主数据与价格快照。</p></div><div class="flex-1"></div><button onclick="window.__resourceImport.template()" class="h-9 px-3 border border-slate-300 bg-white text-sm">下载${label}模板</button></div></section>
    <section class="rounded-lg border border-slate-200 bg-white p-5"><input id="resourceImportFile" class="hidden" type="file" accept=".xlsx,.xls" onchange="window.__resourceImport.handle(this)"><div class="border border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center"><span class="material-symbols-outlined text-4xl text-slate-300">upload_file</span><h2 class="mt-2 font-semibold text-slate-800">${state.fileName ? esc(state.fileName) : `选择${label} Excel`}</h2><p class="mt-1 text-xs text-slate-500">支持 .xlsx / .xls，表头需包含名称和单位。</p><button onclick="window.__resourceImport.pick()" ${state.busy ? 'disabled' : ''} class="mt-4 h-9 px-4 brand-bg text-white text-sm disabled:opacity-40">${state.busy ? '正在处理…' : '选择文件'}</button></div></section>
    ${preview ? previewMarkup(preview, label) : ''}${state.report ? reportMarkup(state.report) : ''}
  </div>`;
}

function previewMarkup(preview, label) {
  return `<section class="rounded-lg border border-slate-200 bg-white overflow-hidden"><div class="border-b border-slate-200 px-4 py-3 flex flex-wrap items-center gap-3"><div><h2 class="font-semibold text-slate-900">导入预览</h2><p class="mt-1 text-xs text-slate-500">共 ${preview.counts.total} 行，新增 ${preview.counts.create}，更新 ${preview.counts.update}，重复 ${preview.counts.duplicate}，无效 ${preview.counts.invalid}。</p></div><div class="flex-1"></div><label class="text-xs text-slate-600 flex items-center gap-2"><input id="resourceImportUpdate" type="checkbox" checked>覆盖更新已有${label}</label><button onclick="window.__resourceImport.commit()" ${state.busy || !preview.counts.valid ? 'disabled' : ''} class="h-9 px-4 brand-bg text-white text-sm disabled:opacity-40">确认导入 ${preview.counts.valid} 行</button></div><div class="overflow-auto max-h-[480px]"><table class="w-full text-sm"><thead class="bg-slate-50 text-xs text-slate-500 sticky top-0"><tr><th class="px-3 py-2 text-left">行</th><th class="px-3 text-left">处理</th><th class="px-3 text-left">编码 / 名称</th><th class="px-3 text-left">规格 / 单位</th><th class="px-3 text-right">单价</th><th class="px-3 text-left">检查</th></tr></thead><tbody class="divide-y divide-slate-100">${preview.rows.map(row => `<tr class="${row.errors.length ? 'bg-red-50/50' : ''}"><td class="px-3 py-2 text-slate-500">${row.index + 1}</td><td class="px-3">${actionBadge(row.action)}</td><td class="px-3"><span class="font-medium text-slate-900">${esc(row.resource.name || '-')}</span><span class="block text-xs text-slate-500">${esc(row.resource.code || '未编码')}</span></td><td class="px-3 text-slate-600">${esc(row.resource.specModel || '-')} · ${esc(row.resource.unit || '-')}</td><td class="px-3 text-right tabular-nums">${row.price ? Number(row.price.unitPrice).toLocaleString('zh-CN') : '-'}</td><td class="px-3 text-xs ${row.errors.length ? 'text-red-600' : 'text-slate-400'}">${esc(row.errors.join('；') || '通过')}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function reportMarkup(report) {
  const view = buildImportReportViewModel(report);
  const rows = buildImportReportRows(report);
  const tones = view.tone === 'danger'
    ? { shell: 'border-red-300 bg-red-50', title: 'text-red-900', notice: 'border-red-200 bg-white text-red-800', table: 'border-red-200', head: 'bg-red-50 text-red-800', divide: 'divide-red-100', status: 'text-red-700', button: 'bg-red-700' }
    : view.tone === 'warning'
      ? { shell: 'border-amber-300 bg-amber-50', title: 'text-amber-900', notice: 'border-amber-200 bg-white text-amber-800', table: 'border-amber-200', head: 'bg-amber-50 text-amber-800', divide: 'divide-amber-100', status: 'text-amber-700', button: 'bg-amber-700' }
      : { shell: 'border-teal-200 bg-teal-50', title: 'text-teal-900', notice: 'border-teal-200 bg-white text-teal-800', table: 'border-teal-200', head: 'bg-teal-50 text-teal-800', divide: 'divide-teal-100', status: 'text-teal-800', button: 'bg-teal-700' };
  return `<section class="rounded-lg border ${tones.shell} p-4"><h2 class="font-semibold ${tones.title}">${esc(view.title)}</h2>${view.notice ? `<div role="alert" class="mt-3 border ${tones.notice} px-3 py-2 text-sm">${esc(view.notice)}</div>` : ''}<div class="mt-3 grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">${view.metrics.map(metric => renderImportReportMetric(metric.label, metric.value, view.tone)).join('')}</div><div class="mt-4 overflow-auto max-h-64 border ${tones.table} bg-white"><table class="w-full text-xs"><thead class="sticky top-0 ${tones.head}"><tr><th class="px-3 py-2 text-left">行</th><th class="px-3 text-left">状态</th><th class="px-3 text-left">处理详情</th></tr></thead><tbody class="divide-y ${tones.divide}">${rows.map(row => `<tr><td class="px-3 py-2 tabular-nums">${row.rowNumber}</td><td class="px-3 font-medium ${row.status === 'error' || row.status === 'uncertain' ? 'text-red-600' : tones.status}">${esc(row.statusLabel)}</td><td class="px-3 text-slate-600">${esc(row.message)}</td></tr>`).join('')}</tbody></table></div><button onclick="window.__resourceImport.back()" class="mt-4 h-9 px-4 ${tones.button} text-white text-sm">返回查看${state.resourceType === 'equipment' ? '设备' : '材料'}库</button></section>`;
}

export function buildImportReportRows(report = {}) {
  return (report.rows || []).map(row => {
    const statusLabel = ({ created: '已新增', updated: '已更新', skipped: '已跳过', error: '失败', rolled_back: '已回滚', uncertain: '需人工核对' })[row.status] || '已处理';
    const priceMessage = row.priceStatus === 'created' ? '价格快照已新增' : row.priceStatus === 'skipped' ? '价格已存在，未重复写入' : '无价格快照';
    const resourceMessage = row.status === 'created' ? '主数据已新增' : row.status === 'updated' ? '主数据已更新' : row.status === 'skipped' ? '主数据已跳过' : '';
    const attemptedResource = ({ created: '主数据尝试新增', updated: '主数据尝试更新', skipped: '主数据尝试跳过' })[row.attemptedStatus] || '主数据尝试处理';
    const attemptedPrice = ({ created: '价格尝试新增', skipped: '价格尝试跳过', none: '无价格快照' })[row.attemptedPriceStatus] || '价格尝试处理';
    return {
      rowNumber: Number(row.index || 0) + 1,
      status: row.status,
      statusLabel,
      message: row.status === 'error'
        ? (row.errors || []).join('；') || '未知错误'
        : row.status === 'rolled_back'
          ? `${attemptedResource}；${attemptedPrice}；已回滚，未写入`
          : row.status === 'uncertain'
            ? `${attemptedResource}；${attemptedPrice}；写入状态不确定，需人工核对`
            : `${resourceMessage}；${priceMessage}`,
    };
  });
}

export function buildImportReportViewModel(report = {}) {
  const failed = report.outcome === 'rolled_back' || report.outcome === 'partial_recovery';
  const counts = failed ? (report.attemptedCounts || {}) : (report.counts || {});
  const prefix = failed ? '尝试' : '';
  return {
    tone: report.outcome === 'partial_recovery' ? 'danger' : report.outcome === 'rolled_back' ? 'warning' : 'success',
    title: report.outcome === 'partial_recovery' ? '导入状态不确定' : report.outcome === 'rolled_back' ? '导入已回滚' : '导入报告',
    notice: report.outcome === 'partial_recovery'
      ? '回滚未完全成功，以下仅为尝试操作，实际写入状态需人工核对。'
      : report.outcome === 'rolled_back' ? '本次尝试操作已全部回滚，未写入主数据或价格。' : '',
    metrics: [
      { label: `${prefix}新增主数据`, value: counts.resourcesCreated || 0 },
      { label: `${prefix}更新主数据`, value: counts.resourcesUpdated || 0 },
      { label: `${prefix}跳过主数据`, value: counts.resourcesSkipped || 0 },
      { label: `${prefix}新增价格`, value: counts.pricesCreated || 0 },
      { label: `${prefix}跳过价格`, value: counts.pricesSkipped || 0 },
      { label: '错误', value: counts.errors || 0 },
    ],
  };
}

function actionBadge(action) { const map = { create: ['badge-green', '新增'], update: ['badge-blue', '更新'], duplicate: ['badge-gray', '重复'], invalid: ['badge-red', '无效'] }; const [tone, label] = map[action] || map.invalid; return `<span class="badge ${tone}">${label}</span>`; }
export function renderImportReportMetric(label, value, tone = 'success') {
  const classes = tone === 'danger'
    ? ['border-red-200', 'text-red-700', 'text-red-950']
    : tone === 'warning'
      ? ['border-amber-200', 'text-amber-700', 'text-amber-950']
      : ['border-teal-200', 'text-teal-700', 'text-teal-950'];
  return `<div class="border ${classes[0]} bg-white px-3 py-2"><div class="${classes[1]}">${esc(label)}</div><div class="mt-1 text-lg font-semibold tabular-nums ${classes[2]}">${fmtMetric(value)}</div></div>`;
}

function fmtMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
