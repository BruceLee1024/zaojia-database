const RESOURCE_ISSUES = [
  ['invalidResourceReference', '资源引用失效', '重新关联有效材料/设备，或核实保留快照的依据。'],
  ['expiredResourcePrice', '资源价格过期', '获取新价格并明确确认更新快照。'],
  ['missingResourcePriceBasis', '缺资源价格口径', '补齐出厂价、到场价或安装综合价口径。'],
  ['duplicateEquipmentInstallation', '设备安装重复计取', '核对安装综合价与安装定额的重复范围。'],
];

const BOQ_QUALITY_ISSUES = [
  ['missingFeature', '项目特征缺失', '补充材质、规格、工艺要求等可复核的项目特征。'],
  ['unitMismatch', '清单与定额单位不一致', '确认换算关系后再替换定额或调整清单单位。'],
  ['unconfirmedQuotaQuantity', '定额用量待确认', '复核单位含量/总套用量，并在定额组成中确认。'],
  ['priceDeviation', '单价偏离关联定额', '当前单价与关联定额相差 30% 以上；确认市场调整依据或修正单价。'],
];

export function buildQuoteAuditViewModel(serviceAudit = {}, aiAudit = {}) {
  const resourceBlocks = [...RESOURCE_ISSUES, ...BOQ_QUALITY_ISSUES].map(([key, title, action]) => {
    const lines = serviceAudit.issues?.[key] || [];
    return { key, title, action, lines, count: lines.length };
  });
  return {
    score: serviceAudit.score ?? aiAudit.meta?.score ?? '-',
    level: serviceAudit.level || aiAudit.meta?.level || '-',
    lineCount: serviceAudit.lines?.length ?? aiAudit.meta?.lineCount ?? 0,
    versionCount: serviceAudit.versions?.length ?? aiAudit.meta?.versionCount ?? 0,
    summary: aiAudit.summary || '报价审查已完成。',
    warnings: aiAudit.warnings || [],
    issueBlocks: [...(aiAudit.suggestions || []), ...resourceBlocks],
  };
}

export async function loadQuoteAuditViewModel(projectId, { audit, review }) {
  const [serviceAudit, aiAudit] = await Promise.all([audit(projectId), review(projectId)]);
  return buildQuoteAuditViewModel(serviceAudit, aiAudit);
}

export function renderQuoteAuditViewModel(viewModel) {
  return `<div class="space-y-4 text-sm">
    <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
      ${metric('审查结论', viewModel.level)}${metric('健康分', viewModel.score)}${metric('清单条数', viewModel.lineCount)}${metric('历史版本', viewModel.versionCount)}
    </div>
    <div class="rounded border border-teal-200 bg-teal-50 p-3 text-teal-900"><div class="font-medium">${escapeHtml(viewModel.summary)}</div><div class="mt-1 text-xs opacity-80">AI 审查只提供风险线索；正式报审前仍需人工复核。</div></div>
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">${viewModel.issueBlocks.length ? viewModel.issueBlocks.map(issueBlock).join('') : '<div class="rounded border border-slate-200 bg-white p-8 text-center text-slate-400 lg:col-span-2">暂未发现明显风险。</div>'}</div>
    <div class="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">${viewModel.warnings.length ? viewModel.warnings.map(escapeHtml).join('<br>') : '建议动作：按风险清单逐项复核，提交或导出前保存报审版。'}</div>
  </div>`;
}

function metric(label, value) {
  return `<div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="text-xs text-slate-500">${label}</div><div class="mt-1 font-semibold text-slate-900">${escapeHtml(value)}</div></div>`;
}

function issueBlock(issue) {
  return `<div class="rounded border ${issue.count ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-white'} p-3">
    <div class="flex items-center justify-between"><div class="font-medium text-slate-800">${escapeHtml(issue.title)}</div><span class="badge ${issue.count ? 'badge-yellow' : 'badge-green'}">${issue.count || 0}</span></div>
    <div class="mt-1 text-xs text-slate-500">${escapeHtml(issue.action || '')}</div>
    <div class="mt-2 max-h-24 overflow-auto scroll-thin text-xs text-slate-600">${(issue.lines || []).slice(0, 8).map(line => `<div class="truncate" title="${escapeHtml(line?.name || line?.message || '')}">• ${escapeHtml(line?.name || line?.message || '当前项目')}</div>`).join('') || '<div class="text-slate-400">未列出具体清单</div>'}</div>
  </div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}
