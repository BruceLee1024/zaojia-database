import { projectRepo } from '../data/repository.js?v=6.15';
import { calculateControlPriceDiscount, costEstimationService, COST_SOURCE_OPTIONS, hasCostPrice } from '../services/costEstimationService.js?v=6.15&build=20260814f';
import { costAiEstimationService } from '../services/costAiEstimationService.js?v=6.15&build=20260814f';
import { costSourceReferenceService } from '../services/costSourceReferenceService.js?v=6.15&build=20260814f';
import { exportCostEstimateExcel } from '../data/excel.js?v=6.15';
import { esc, fmtMoney, openModal, closeModal, toast, scopedDom } from '../utils/dom.js?v=6.15';

const state = { tab: 'cost', keyword: '', status: '', source: '', riskOnly: false, sort: 'risk' };

export async function render(workspace = document.getElementById('workspace')) {
  const document = scopedDom(workspace);
  const projects = await projectRepo.all();
  if (workspace.isInvalidated) return;
  const routeProjectId = window.__app.state.routeParams?.projectId;
  const project = projects.find(item => item.id === routeProjectId)
    || projects.find(item => item.id === window.__app.state.currentProjectId)
    || projects[0];
  if (!project) {
    workspace.innerHTML = emptyProjectState();
    document.getElementById('costCreateProject')?.addEventListener('click', () => window.__app.go('projects', { action: 'new' }));
    return;
  }

  window.__app.state.currentProjectId = project.id;
  const model = await costEstimationService.load(project.id);
  if (workspace.isInvalidated) return;
  const filtered = filterLines(model.lines);
  const readOnly = project.status === 'archived';
  workspace.innerHTML = pageMarkup({ ...model, projects, filtered, readOnly });
  bindEvents(document, { ...model, projects, filtered, readOnly });
}

function pageMarkup({ project, projects, lines, settings, summary, filtered, readOnly }) {
  const currency = project.currency || 'CNY';
  return `
    <div class="page-frame h-full min-h-0 flex flex-col gap-3">
      <section class="rounded-lg border border-slate-200 bg-white px-4 py-3 shrink-0">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-lg font-semibold text-slate-950">成本测算工作台</h1>
              ${readOnly ? '<span class="badge badge-gray">案例只读</span>' : '<span class="badge badge-green">工作稿</span>'}
            </div>
            <p class="mt-1 text-xs text-slate-500">以招标清单为骨架，维护内部成本价并跟踪利润与未覆价风险。</p>
          </div>
          <div class="flex-1"></div>
          <label class="h-9 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 flex items-center gap-2 lg:min-w-[300px]">
            <span class="material-symbols-outlined icon-action text-teal-700" aria-hidden="true">domain</span>
            <span class="sr-only">选择项目</span>
            <select id="costProjectSelect" class="w-full bg-transparent outline-none" aria-label="选择成本测算项目">
              ${projects.map(item => `<option value="${esc(item.id)}" ${item.id === project.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
            </select>
          </label>
          <div class="flex gap-2">
            <button id="costOpenBoq" class="h-9 px-3 border border-slate-300 bg-white text-sm text-slate-700">打开工程量清单</button>
            <button id="costExport" ${lines.length ? '' : 'disabled'} class="h-9 px-3 brand-bg text-white text-sm inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40"><span class="material-symbols-outlined icon-action" aria-hidden="true">download</span>导出测算表</button>
          </div>
        </div>
      </section>

      ${readOnly ? '<section class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">该项目已收录为案例，当前成本测算只读。若需调整，请先在“我的项目”中解锁修订。</section>' : ''}

      ${lines.length ? `${costWorkspaceTabs(lines, summary)}${costWorkspacePanel({ lines, settings, summary, filtered, readOnly, currency })}` : emptyLinesState(project, readOnly)}
    </div>
  `;
}

function costWorkspaceTabs(lines, summary) {
  const referencedCount = lines.filter(line => line.costSourceRef).length;
  const riskCount = summary.missingCount + summary.pendingCount;
  const tabs = [
    ['cost', 'payments', '成本覆价', `${summary.pricedCount}/${summary.includedCount} 项`],
    ['profit', 'trending_up', '取费利润', percent(summary.profitMargin)],
    ['risk', 'priority_high', '风险复核', riskCount ? `${riskCount} 项` : '已通过'],
    ['evidence', 'link', '依据台账', `${referencedCount} 条引用`],
  ];
  return `<nav class="rounded-lg border border-slate-200 bg-slate-50 p-1 shrink-0" aria-label="成本测算工作区">
    <div class="flex gap-1 overflow-x-auto" role="tablist">
      ${tabs.map(([value, icon, label, note]) => {
        const active = state.tab === value;
        return `<button type="button" data-cost-tab="${value}" role="tab" aria-selected="${active}" class="inline-flex min-w-[150px] flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-left transition-colors ${active ? 'border-teal-200 bg-white text-teal-800' : 'border-transparent text-slate-500 hover:bg-white hover:text-slate-800'}"><span class="material-symbols-outlined text-[18px]" aria-hidden="true">${icon}</span><span class="text-sm font-medium">${label}</span><span class="text-[11px] tabular-nums ${active ? 'text-teal-700' : 'text-slate-400'}">${note}</span></button>`;
      }).join('')}
    </div>
  </nav>`;
}

function costWorkspacePanel(context) {
  if (state.tab === 'profit') return profitPanel(context);
  if (state.tab === 'risk') return riskPanel(context);
  if (state.tab === 'evidence') return evidencePanel(context);
  return costCoveragePanel(context);
}

function costCoveragePanel({ lines, summary, filtered, readOnly, currency }) {
  return `<div role="tabpanel" aria-label="成本覆价" class="flex flex-1 min-h-0 flex-col">${costListPanel(filtered, lines, summary, currency, readOnly)}</div>`;
}

function costListPanel(filtered, lines, summary, currency, readOnly) {
  return `<section class="rounded-lg border border-slate-200 bg-white flex flex-col flex-1 min-h-[260px] overflow-hidden">
    <div class="border-b border-slate-200 bg-slate-50 px-3 py-2.5 flex flex-col gap-2 shrink-0 lg:flex-row lg:items-center">
      <div class="relative min-w-0 lg:w-72"><span class="material-symbols-outlined icon-inline absolute left-3 top-2.5 text-slate-400" aria-hidden="true">search</span><input id="costSearch" value="${esc(state.keyword)}" type="search" class="h-9 w-full rounded border border-slate-300 bg-white pl-9 pr-3 text-sm" placeholder="搜索编码、名称或特征" aria-label="搜索成本测算清单" /></div>
      <select id="costStatusFilter" class="h-9 rounded border border-slate-300 bg-white px-2 text-sm" aria-label="筛选覆价状态"><option value="">全部状态</option><option value="missing" ${state.status === 'missing' ? 'selected' : ''}>未覆价</option><option value="pending" ${state.status === 'pending' ? 'selected' : ''}>待复核</option><option value="priced" ${state.status === 'priced' ? 'selected' : ''}>已覆价</option><option value="excluded" ${state.status === 'excluded' ? 'selected' : ''}>已排除</option></select>
      <select id="costSourceFilter" class="h-9 rounded border border-slate-300 bg-white px-2 text-sm" aria-label="筛选成本来源"><option value="">全部来源</option>${COST_SOURCE_OPTIONS.map(option => `<option value="${option.value}" ${state.source === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}</select>
      <select id="costSort" class="h-9 rounded border border-slate-300 bg-white px-2 text-sm" aria-label="成本清单排序"><option value="risk" ${state.sort === 'risk' ? 'selected' : ''}>风险优先</option><option value="amount" ${state.sort === 'amount' ? 'selected' : ''}>投标金额降序</option><option value="original" ${state.sort === 'original' ? 'selected' : ''}>原清单顺序</option></select>
      <span class="text-xs text-slate-500">显示 ${filtered.length} / ${lines.length} 项</span>
      <span class="hidden h-5 border-l border-slate-300 xl:block" aria-hidden="true"></span>
      <span class="hidden text-xs text-slate-500 xl:inline">直接成本 <strong class="font-semibold tabular-nums text-slate-700">${money(summary.directCost, currency)}</strong></span><div class="flex-1"></div>
      <button data-cost-tab-jump="risk" class="h-9 px-3 border border-slate-300 bg-white text-slate-700 text-sm">查看风险项 <span class="tabular-nums">${summary.missingCount + summary.pendingCount}</span></button>
      <button id="costAiBatch" ${readOnly || !summary.missingCount ? 'disabled' : ''} class="h-9 px-3 brand-bg text-white text-sm inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40"><span class="material-symbols-outlined text-[17px]" aria-hidden="true">auto_awesome</span>AI 批量覆价</button>
      <button id="costBatchFactor" ${readOnly ? 'disabled' : ''} class="h-9 px-3 border border-teal-300 bg-teal-50 text-teal-800 text-sm disabled:opacity-40">按投标价批量折算</button>
    </div>
    ${costTable(filtered, currency, readOnly)}
  </section>`;
}

function profitPanel({ settings, summary, readOnly, currency }) {
  return `<div role="tabpanel" aria-label="取费利润" class="flex flex-1 min-h-0 flex-col gap-3 overflow-auto">
    <section class="grid grid-cols-2 gap-3 shrink-0 lg:grid-cols-5">
      ${metricCard('纳入测算投标价', money(summary.bidTotal, currency), `${summary.includedCount} 项`, 'payments', 'slate')}
      ${metricCard('预测总成本', money(summary.totalCost, currency), `直接成本 ${money(summary.directCost, currency)}`, 'receipt_long', 'blue')}
      ${metricCard('预计利润', money(summary.expectedProfit, currency), `利润率 ${percent(summary.profitMargin)}`, 'trending_up', summary.expectedProfit >= 0 ? 'teal' : 'red')}
      ${metricCard('目标成本上限', money(summary.targetCost, currency), `目标利润率 ${percent(Number(settings.targetProfitRate || 0) / 100)}`, 'flag', 'slate')}
      ${metricCard('成本余量', money(summary.costHeadroom, currency), summary.costHeadroom >= 0 ? '尚有调整空间' : '已超目标成本', 'account_balance_wallet', summary.costHeadroom >= 0 ? 'teal' : 'red')}
    </section>
    ${decisionPanel(summary, currency)}
    <section class="rounded-lg border border-slate-200 bg-white p-4 shrink-0">
      <div class="flex flex-col gap-3 xl:flex-row xl:items-end">
        <div class="min-w-[180px]"><h2 class="font-semibold text-slate-900">取费与调整</h2><p class="mt-1 text-xs text-slate-500">按当前已覆价直接成本实时计算。</p></div>
        <div class="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          ${settingInput('目标利润率', 'costTargetProfitRate', settings.targetProfitRate, '%', readOnly)}
          ${settingInput('税率', 'costTaxRate', settings.taxRate, '%', readOnly)}
          ${settingInput('措施及临设费', 'costMeasureRate', settings.measureRate, '%', readOnly)}
          ${settingInput('暂列及专业分包', 'costProvisional', settings.provisionalAmount, '', readOnly)}
          ${settingInput('其他成本', 'costOther', settings.otherAmount, '', readOnly)}
          ${settingInput('回收残值', 'costRecovery', settings.recoveryAmount, '扣减', readOnly)}
        </div>
        <button id="costSaveSettings" ${readOnly ? 'disabled' : ''} class="h-10 px-4 brand-bg text-white text-sm disabled:opacity-40">保存参数</button>
      </div>
      <div class="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-100 pt-3 text-xs text-slate-500"><span>直接成本 ${money(summary.directCost, currency)}</span><span>措施及临设 ${money(summary.measureCost, currency)}</span><span>税金 ${money(summary.taxAmount, currency)}</span><span>暂列与其他 ${money(Number(settings.provisionalAmount || 0) + Number(settings.otherAmount || 0), currency)}</span><span>排除 ${summary.excludedCount} 项 / ${money(summary.excludedBidTotal, currency)}</span></div>
    </section>
  </div>`;
}

function riskPanel({ lines, summary, readOnly, currency }) {
  const riskLines = lines.filter(line => line.costIncluded !== false && (!hasCostPrice(line) || line.costReviewStatus === 'pending' || (costBidRatio(line) ?? 0) > 0.9)).sort((a, b) => riskScore(b) - riskScore(a));
  const thinCount = riskLines.filter(line => hasCostPrice(line) && line.costReviewStatus !== 'pending' && (costBidRatio(line) ?? 0) > 0.9).length;
  return `<div role="tabpanel" aria-label="风险复核" class="flex flex-1 min-h-0 flex-col gap-3">
    ${decisionPanel(summary, currency)}
    <section class="grid grid-cols-3 gap-3 shrink-0">
      ${metricCard('未覆价', summary.missingCount, money(summary.missingBidAmount, currency), 'warning', summary.missingCount ? 'amber' : 'teal')}
      ${metricCard('待复核', summary.pendingCount, money(summary.pendingBidAmount, currency), 'rule', summary.pendingCount ? 'amber' : 'teal')}
      ${metricCard('成本偏薄或倒挂', thinCount, '直接成本占投标价超过 90%', 'trending_down', thinCount ? 'red' : 'teal')}
    </section>
    <section class="rounded-lg border border-slate-200 bg-white flex flex-col flex-1 min-h-[260px] overflow-hidden"><div class="border-b border-slate-200 bg-slate-50 px-3 py-2.5 flex items-center gap-3"><div><h2 class="text-sm font-semibold text-slate-900">高风险清单</h2><p class="mt-0.5 text-xs text-slate-500">按未覆价、待复核及成本偏薄优先排列。</p></div><div class="flex-1"></div><span class="text-xs text-slate-500">${riskLines.length} 项</span><button data-cost-tab-jump="cost" class="h-9 border border-slate-300 bg-white px-3 text-sm text-slate-700">返回全部覆价</button></div>${costTable(riskLines, currency, readOnly)}</section>
  </div>`;
}

function evidencePanel({ lines, currency, readOnly }) {
  const evidenceLines = lines.filter(line => line.costSource && line.costSource !== 'manual');
  const referencedCount = evidenceLines.filter(line => line.costSourceRef).length;
  const missingCount = evidenceLines.length - referencedCount;
  const sourceCounts = COST_SOURCE_OPTIONS.filter(option => option.value !== 'manual').map(option => [option, evidenceLines.filter(line => line.costSource === option.value).length]).filter(([, count]) => count);
  return `<div role="tabpanel" aria-label="依据台账" class="flex flex-1 min-h-0 flex-col gap-3">
    <section class="rounded-lg border ${missingCount ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'} px-4 py-3 text-sm"><div class="flex flex-wrap items-center gap-x-6 gap-y-2"><div class="font-semibold ${missingCount ? 'text-amber-900' : 'text-emerald-900'}">${missingCount ? `${missingCount} 条成本来源尚未绑定具体依据` : '已选来源均有可追溯依据'}</div><div class="text-xs text-slate-600">已引用 ${referencedCount} / ${evidenceLines.length} 条</div>${sourceCounts.map(([option, count]) => `<span class="badge badge-gray">${option.label} ${count}</span>`).join('')}<button data-cost-tab-jump="cost" class="ml-auto h-8 border border-slate-300 bg-white px-3 text-xs text-slate-700">返回成本覆价</button></div></section>
    <section class="rounded-lg border border-slate-200 bg-white flex flex-1 min-h-[260px] flex-col overflow-hidden"><div class="border-b border-slate-200 bg-slate-50 px-4 py-3"><h2 class="text-sm font-semibold text-slate-900">成本依据台账</h2><p class="mt-1 text-xs text-slate-500">集中查看企业定额、历史项目、材料设备、分包报价、经验指标、控制价下浮和折算记录。</p></div>${evidenceTable(evidenceLines, currency, readOnly)}</section>
  </div>`;
}

function evidenceTable(lines, currency, readOnly) {
  if (!lines.length) return `<div class="flex flex-1 flex-col items-center justify-center p-10 text-center"><span class="material-symbols-outlined text-[30px] text-slate-400" aria-hidden="true">link_off</span><div class="mt-2 text-sm font-medium text-slate-700">尚未形成成本依据</div><p class="mt-1 text-xs text-slate-500">在“成本覆价”中选择企业定额、历史项目、材料设备价、分包报价等来源后，这里会自动汇总。</p></div>`;
  const sorted = [...lines].sort((a, b) => Number(Boolean(a.costSourceRef)) - Number(Boolean(b.costSourceRef)));
  return `<div class="overflow-auto flex-1"><table class="w-full min-w-[980px] text-sm"><thead class="sticky top-0 bg-white text-left text-xs text-slate-500"><tr class="border-b border-slate-200"><th class="px-4 py-3">清单项</th><th class="px-3">来源类型</th><th class="px-3">引用记录</th><th class="px-3 text-right">引用单价</th><th class="px-3">日期 / 说明</th><th class="px-4 text-right">操作</th></tr></thead><tbody>${sorted.map(line => { const reference = line.costSourceRef; return `<tr class="border-b border-slate-100"><td class="px-4 py-3"><div class="font-medium text-slate-900">${esc(line.name || '未命名清单')}</div><div class="mt-1 text-xs text-slate-400">${esc(line.code || '-')}</div></td><td class="px-3 py-3"><span class="badge badge-gray">${esc(sourceLabel(line.costSource))}</span></td><td class="px-3 py-3"><div class="${reference ? 'font-medium text-slate-800' : 'text-amber-700'}">${reference ? esc(reference.label) : '待补具体依据'}</div></td><td class="px-3 py-3 text-right tabular-nums">${reference?.unitPrice != null ? money(reference.unitPrice, currency) : '-'}</td><td class="max-w-[320px] px-3 py-3 text-xs leading-5 text-slate-500">${reference ? esc([reference.date, reference.detail].filter(Boolean).join(' · ') || '-') : '已选择来源，但尚未绑定数据记录'}</td><td class="px-4 py-3 text-right"><button data-cost-source-ref="${esc(line.id)}" ${readOnly ? 'disabled' : ''} class="h-8 border ${reference ? 'border-slate-300 text-slate-700' : 'border-amber-300 bg-amber-50 text-amber-800'} bg-white px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40">${reference ? '更换依据' : '补充依据'}</button></td></tr>`; }).join('')}</tbody></table></div>`;
}

function sourceLabel(value) {
  return COST_SOURCE_OPTIONS.find(option => option.value === value)?.label || '未选择';
}

function costTable(lines, currency, readOnly) {
  if (!lines.length) return '<div class="flex-1 grid place-items-center p-10 text-sm text-slate-400">没有符合筛选条件的清单项。</div>';
  return `
    <div class="mobile-card-list overflow-auto p-3 space-y-3">${lines.map(line => mobileCostCard(line, currency, readOnly)).join('')}</div>
    <div class="mobile-table overflow-auto scroll-thin flex-1 min-h-0">
      <table class="w-full min-w-[1430px] text-sm table-fixed">
        <thead class="sticky top-0 z-10 bg-white text-left text-xs text-slate-500"><tr class="border-b border-slate-200">
          <th class="w-12 px-3 py-3 text-center">计入</th><th class="w-24 px-2">编码</th><th class="w-[280px] px-2">清单项目</th><th class="w-20 px-2 text-right">工程量</th><th class="w-28 px-2 text-right">投标单价</th><th class="w-32 px-2 text-right">投标合价</th><th class="w-32 px-2 text-right">内部成本单价</th><th class="w-32 px-2 text-right">成本合价</th><th class="w-28 px-2 text-right">成本/投标</th><th class="w-36 px-2">成本来源</th><th class="w-[280px] px-2">依据与风险备注</th>
        </tr></thead>
        <tbody>${lines.map(line => tableRow(line, currency, readOnly)).join('')}</tbody>
      </table>
    </div>`;
}

function tableRow(line, currency, readOnly) {
  const provided = hasCostPrice(line);
  const excluded = line.costIncluded === false;
  const pending = line.costReviewStatus === 'pending';
  const status = excluded ? ['已排除', 'badge-gray'] : !provided ? ['未覆价', 'badge-yellow'] : pending ? ['待复核', 'badge-yellow'] : ['已覆价', 'badge-green'];
  const ratio = costBidRatio(line);
  return `<tr class="border-b border-slate-100 align-top ${excluded ? 'bg-slate-50 text-slate-400' : ''}">
    <td class="px-3 py-3 text-center"><input data-cost-included="${esc(line.id)}" type="checkbox" ${excluded ? '' : 'checked'} ${readOnly ? 'disabled' : ''} aria-label="${excluded ? '纳入' : '排除'} ${esc(line.name)}" /></td>
    <td class="px-2 py-3 text-xs text-slate-500 break-all">${esc(line.code || '-')}</td>
    <td class="px-2 py-3"><div class="font-medium text-slate-900 ${excluded ? 'line-through' : ''}">${esc(line.name || '未命名清单')}</div><div class="mt-1 text-xs leading-5 text-slate-500 line-clamp-2">${esc(line.feature || '无项目特征')}</div><span class="mt-1 inline-flex ${status[1]} badge">${status[0]}</span></td>
    <td class="px-2 py-3 text-right tabular-nums">${number(line.qty)} <span class="text-xs text-slate-400">${esc(line.unit || '')}</span></td>
    <td class="px-2 py-3 text-right tabular-nums">${money(line.unitPrice, currency)}</td>
    <td class="px-2 py-3 text-right tabular-nums font-medium">${money(line.amount, currency)}</td>
    <td class="px-2 py-2"><input data-cost-price="${esc(line.id)}" value="${provided ? esc(line.costUnitPrice) : ''}" type="number" step="0.01" ${readOnly || excluded ? 'disabled' : ''} class="h-9 w-full rounded border ${provided ? 'border-slate-300' : 'border-amber-300 bg-amber-50'} px-2 text-right tabular-nums disabled:bg-slate-100" aria-label="${esc(line.name)}内部成本单价" placeholder="待覆价" /></td>
    <td class="px-2 py-3 text-right tabular-nums font-semibold ${provided ? 'text-slate-900' : 'text-amber-700'}">${provided ? money(line.costAmount, currency) : '待覆价'}</td>
    <td class="px-2 py-3 text-right">${ratioBadge(ratio)}</td>
    <td class="px-2 py-2"><select data-cost-source="${esc(line.id)}" ${readOnly || excluded ? 'disabled' : ''} class="h-9 w-full rounded border border-slate-300 bg-white px-2 text-xs disabled:bg-slate-100"><option value="">选择来源</option>${COST_SOURCE_OPTIONS.map(option => `<option value="${option.value}" ${line.costSource === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}</select>${costSourceReferenceControl(line, readOnly || excluded)}</td>
    <td class="px-2 py-2"><input data-cost-note="${esc(line.id)}" value="${esc(line.costNote || '')}" ${readOnly || excluded ? 'disabled' : ''} class="h-9 w-full rounded border border-slate-300 px-2 text-xs disabled:bg-slate-100" placeholder="价格依据、日期、供应商或风险" aria-label="${esc(line.name)}成本依据与风险备注" /></td>
  </tr>`;
}

function mobileCostCard(line, currency, readOnly) {
  const provided = hasCostPrice(line);
  const excluded = line.costIncluded === false;
  const ratio = costBidRatio(line);
  return `<article class="rounded-lg border ${provided ? 'border-slate-200' : 'border-amber-200'} bg-white p-3 ${excluded ? 'opacity-60' : ''}">
    <div class="flex items-start gap-3"><label class="pt-1"><input data-cost-included="${esc(line.id)}" type="checkbox" ${excluded ? '' : 'checked'} ${readOnly ? 'disabled' : ''} /><span class="sr-only">计入测算</span></label><div class="min-w-0 flex-1"><div class="font-medium text-slate-900">${esc(line.name)}</div><div class="mt-1 text-xs text-slate-500">${esc(line.code || '未编码')} · ${number(line.qty)} ${esc(line.unit || '')}</div></div><div class="text-right"><div class="text-xs text-slate-400">投标合价</div><div class="mt-1 font-medium tabular-nums">${money(line.amount, currency)}</div></div></div>
    <div class="mt-3 grid grid-cols-2 gap-2"><label class="text-xs text-slate-500">内部成本单价<input data-cost-price="${esc(line.id)}" value="${provided ? esc(line.costUnitPrice) : ''}" type="number" step="0.01" ${readOnly || excluded ? 'disabled' : ''} class="mt-1 h-10 w-full rounded border border-slate-300 px-2 text-right" placeholder="待覆价" /></label><div><label class="text-xs text-slate-500">成本来源<select data-cost-source="${esc(line.id)}" ${readOnly || excluded ? 'disabled' : ''} class="mt-1 h-10 w-full rounded border border-slate-300 bg-white px-2"><option value="">选择来源</option>${COST_SOURCE_OPTIONS.map(option => `<option value="${option.value}" ${line.costSource === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}</select></label>${costSourceReferenceControl(line, readOnly || excluded)}</div></div>
    <label class="mt-2 block text-xs text-slate-500">依据与风险备注<input data-cost-note="${esc(line.id)}" value="${esc(line.costNote || '')}" ${readOnly || excluded ? 'disabled' : ''} class="mt-1 h-10 w-full rounded border border-slate-300 px-2" placeholder="价格依据、日期、供应商或风险" /></label>
    <div class="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs"><span class="text-slate-500">成本合价</span><div class="flex items-center gap-2">${ratioBadge(ratio)}<strong class="text-sm tabular-nums ${provided ? 'text-slate-900' : 'text-amber-700'}">${provided ? money(line.costAmount, currency) : '待覆价'}</strong></div></div>
  </article>`;
}

function bindEvents(document, model) {
  document.getElementById('costProjectSelect').onchange = event => {
    window.__app.state.currentProjectId = event.target.value;
    window.__app.state.routeParams = { projectId: event.target.value };
    state.tab = 'cost';
    render();
  };
  document.getElementById('costOpenBoq').onclick = () => window.__app.go('boq', { projectId: model.project.id });
  document.getElementById('costExport').onclick = () => {
    if (model.lines.length) exportCostEstimateExcel(model.project, model.lines, model.summary);
  };
  if (!model.lines.length) {
    document.getElementById('costStartBoq')?.addEventListener('click', () => window.__app.go('boq', { projectId: model.project.id }));
    document.getElementById('costStartAi')?.addEventListener('click', () => window.__app.go('boq', { projectId: model.project.id, action: 'ai-draft' }));
    return;
  }
  document.querySelectorAll('[data-cost-tab], [data-cost-tab-jump]').forEach(button => button.onclick = () => {
    state.tab = button.dataset.costTab || button.dataset.costTabJump;
    render();
  });
  document.getElementById('costSearch')?.addEventListener('input', event => {
    state.keyword = event.target.value;
    clearTimeout(window.__costSearchTimer);
    window.__costSearchTimer = setTimeout(() => render(), 160);
  });
  document.getElementById('costStatusFilter')?.addEventListener('change', event => { state.status = event.target.value; render(); });
  document.getElementById('costSourceFilter')?.addEventListener('change', event => { state.source = event.target.value; render(); });
  document.getElementById('costSort')?.addEventListener('change', event => { state.sort = event.target.value; render(); });
  document.getElementById('costSaveSettings')?.addEventListener('click', async () => run(async () => {
    await costEstimationService.updateSettings(model.project.id, {
      targetProfitRate: document.getElementById('costTargetProfitRate').value,
      taxRate: document.getElementById('costTaxRate').value,
      measureRate: document.getElementById('costMeasureRate').value,
      provisionalAmount: document.getElementById('costProvisional').value,
      otherAmount: document.getElementById('costOther').value,
      recoveryAmount: document.getElementById('costRecovery').value,
    });
    toast('取费与调整参数已保存', 'success');
    await render();
  }));
  document.getElementById('costBatchFactor')?.addEventListener('click', () => openFactorDialog(model.project.id, model.summary.missingCount));
  document.getElementById('costAiBatch')?.addEventListener('click', event => run(async () => {
    const button = event.currentTarget;
    button.disabled = true;
    const original = button.innerHTML;
    button.innerHTML = '<span class="material-symbols-outlined text-[17px] animate-spin" aria-hidden="true">progress_activity</span>正在匹配依据';
    try { await openAiCostSuggestions(model); }
    finally { if (button.isConnected) { button.disabled = false; button.innerHTML = original; } }
  }));

  document.querySelectorAll('[data-cost-price]').forEach(input => input.onchange = event => {
    const lineId = event.target.dataset.costPrice;
    const line = model.lines.find(item => item.id === lineId) || {};
    const currentSource = currentSourceFor(document, lineId) || line.costSource || '';
    const manualOverride = currentSource === 'quote_factor';
    updateLine(lineId, {
      costUnitPrice: event.target.value,
      costReviewStatus: event.target.value === '' ? '' : 'reviewed',
      ...(!event.target.value ? {} : { costSource: manualOverride ? 'manual' : (currentSource || 'manual') }),
      ...(manualOverride ? { costNote: reviewedFactorNote(line.costNote) } : {}),
    });
  });
  document.querySelectorAll('[data-cost-source]').forEach(select => select.onchange = async event => {
    const lineId = event.target.dataset.costSource;
    const line = model.lines.find(item => item.id === lineId);
    const source = event.target.value;
    if (!line) return;
    await run(async () => {
      await costEstimationService.updateLine(lineId, { costSource: source, costSourceRef: null });
      await render();
      if (source && source !== 'manual') await openCostSourceReferenceDialog({ ...line, costSource: source, costSourceRef: null }, source, model.project);
    });
  });
  document.querySelectorAll('[data-cost-source-ref]').forEach(button => button.onclick = () => {
    const line = model.lines.find(item => item.id === button.dataset.costSourceRef);
    if (line?.costSource) openCostSourceReferenceDialog(line, line.costSource, model.project);
  });
  document.querySelectorAll('[data-cost-note]').forEach(input => input.onchange = event => updateLine(event.target.dataset.costNote, { costNote: event.target.value }));
  document.querySelectorAll('[data-cost-included]').forEach(input => input.onchange = event => updateLine(event.target.dataset.costIncluded, { costIncluded: event.target.checked }));
}

async function openAiCostSuggestions(model) {
  const result = await costAiEstimationService.suggest(model.lines);
  const rows = result.suggestions || [];
  if (!rows.length) return toast('当前没有可生成建议的未覆价清单', 'success');
  const currency = model.project.currency || 'CNY';
  openModal('AI 批量覆价建议', `<div class="space-y-3 text-sm">
    <div class="rounded border border-teal-200 bg-teal-50 px-3 py-2 text-xs leading-5 text-teal-900">AI 只从本地企业定额、历史成本、材料设备价格和投标价中生成建议，不会自动写入。确认后的项目统一标记为“待复核”。</div>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      ${aiCostSummary('建议项目', rows.length, '条')}
      ${aiCostSummary('高置信度', result.counts.high, '条')}
      ${aiCostSummary('中置信度', result.counts.medium, '条')}
      ${aiCostSummary('低置信度', result.counts.low, '条')}
    </div>
    <div class="flex flex-wrap items-center gap-2"><button id="costAiSelectReliable" class="h-8 border border-slate-300 bg-white px-3 text-xs text-slate-700">选择高/中置信度</button><button id="costAiSelectAll" class="h-8 border border-slate-300 bg-white px-3 text-xs text-slate-700">全部选择</button><button id="costAiClear" class="h-8 border border-slate-300 bg-white px-3 text-xs text-slate-700">清空选择</button><span id="costAiSelectedSummary" class="ml-auto text-xs text-slate-500"></span></div>
    <div class="max-h-[52vh] overflow-auto rounded border border-slate-200 scroll-thin"><table class="w-full min-w-[1050px] text-sm"><thead class="sticky top-0 z-10 bg-slate-50 text-left text-xs text-slate-500"><tr><th class="w-12 px-3 py-2">应用</th><th class="px-3">清单项目</th><th class="w-28 px-3 text-right">投标单价</th><th class="w-36 px-3 text-right">AI 建议成本价</th><th class="w-20 px-3">置信度</th><th class="w-60 px-3">数据来源</th><th class="px-3">建议依据</th></tr></thead><tbody>${rows.map((row, index) => `<tr class="border-t border-slate-100"><td class="px-3 py-2"><input type="checkbox" data-ai-cost-check="${index}" data-confidence="${row.confidence}" ${row.apply ? 'checked' : ''} aria-label="应用 ${esc(row.lineName)} 的 AI 成本建议" /></td><td class="px-3 py-2"><div class="font-medium text-slate-900">${esc(row.lineName)}</div><div class="mt-0.5 text-xs text-slate-400">${esc(row.unit || '无单位')}</div></td><td class="px-3 py-2 text-right tabular-nums">${money(row.bidUnitPrice, currency)}</td><td class="px-3 py-2"><input data-ai-cost-price="${index}" type="number" step="0.01" value="${esc(row.suggestedPrice)}" class="h-8 w-full rounded border border-slate-300 px-2 text-right font-medium tabular-nums" aria-label="${esc(row.lineName)}AI 建议成本价" /></td><td class="px-3 py-2"><span class="badge ${confidenceBadge(row.confidence)}">${confidenceText(row.confidence)}</span></td><td class="px-3 py-2 text-xs text-slate-700">${esc(row.sourceLabel)}</td><td class="px-3 py-2 text-xs leading-5 text-slate-500">${esc(row.reason)}</td></tr>`).join('')}</tbody></table></div>
    ${result.warnings.length ? `<div class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">${result.warnings.map(esc).join('<br>')}</div>` : ''}
  </div>`, `<button onclick="window.__modalClose()" class="h-9 border border-slate-300 bg-white px-3 text-sm">取消</button><button id="costAiApply" class="h-9 brand-bg px-4 text-sm text-white">应用选中建议</button>`);

  const checks = () => [...document.querySelectorAll('[data-ai-cost-check]')];
  const updateSummary = () => {
    const selected = checks().filter(input => input.checked);
    const amount = selected.reduce((sum, input) => {
      const index = Number(input.dataset.aiCostCheck);
      const row = rows[index];
      const line = model.lines.find(item => item.id === row?.lineId);
      const price = Number(document.querySelector(`[data-ai-cost-price="${index}"]`)?.value || 0);
      return sum + price * Number(line?.qty || 0) * Number(line?.factor || 1);
    }, 0);
    document.getElementById('costAiSelectedSummary').textContent = `已选择 ${selected.length} 条，建议直接成本约 ${money(amount, currency)}`;
  };
  checks().forEach(input => input.addEventListener('change', updateSummary));
  document.querySelectorAll('[data-ai-cost-price]').forEach(input => input.addEventListener('input', updateSummary));
  document.getElementById('costAiSelectReliable').onclick = () => { checks().forEach(input => { input.checked = input.dataset.confidence !== 'low'; }); updateSummary(); };
  document.getElementById('costAiSelectAll').onclick = () => { checks().forEach(input => { input.checked = true; }); updateSummary(); };
  document.getElementById('costAiClear').onclick = () => { checks().forEach(input => { input.checked = false; }); updateSummary(); };
  document.getElementById('costAiApply').onclick = () => run(async () => {
    const selected = checks().filter(input => input.checked).map(input => {
      const index = Number(input.dataset.aiCostCheck);
      return { ...rows[index], suggestedPrice: Number(document.querySelector(`[data-ai-cost-price="${index}"]`).value) };
    }).filter(row => Number.isFinite(row.suggestedPrice));
    if (!selected.length) return toast('请选择要应用的 AI 覆价建议', 'error');
    const count = await costEstimationService.applyAiSuggestions(model.project.id, selected);
    closeModal();
    toast(`已写入 ${count} 条 AI 成本建议，均待人工复核`, 'success');
    await render();
  });
  updateSummary();
}

function aiCostSummary(label, value, suffix) {
  return `<div class="rounded border border-slate-200 bg-white px-3 py-2"><div class="text-xs text-slate-500">${label}</div><div class="mt-1 font-semibold tabular-nums text-slate-900">${number(value)} ${suffix}</div></div>`;
}

function confidenceText(value) { return ({ high: '高', medium: '中', low: '低' })[value] || '低'; }
function confidenceBadge(value) { return value === 'high' ? 'badge-green' : value === 'medium' ? 'badge-gray' : 'badge-yellow'; }

function openFactorDialog(projectId, missingCount) {
  openModal('按投标价批量折算成本', `<div class="space-y-4 text-sm"><div class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">折算价只是快速起点，系统会将结果标记为“待复核”，不能替代材料、分包和历史成本依据。</div><label class="block">成本占投标综合单价比例<div class="mt-1 flex"><input id="costFactorPercent" type="number" min="1" max="200" step="0.1" value="85" class="h-10 min-w-0 flex-1 rounded-l border border-slate-300 px-3 text-right" /><span class="grid h-10 w-10 place-items-center rounded-r border border-l-0 border-slate-300 bg-slate-50">%</span></div></label><label class="flex items-center gap-2"><input id="costFactorOnlyMissing" type="checkbox" checked />仅填充当前 ${missingCount} 条未覆价清单</label></div>`, `<button onclick="window.__modalClose()" class="h-9 px-3 border border-slate-300 bg-white text-sm">取消</button><button id="costConfirmFactor" class="h-9 px-4 brand-bg text-white text-sm">应用折算</button>`);
  document.getElementById('costConfirmFactor').onclick = () => run(async () => {
    const ratio = Number(document.getElementById('costFactorPercent').value) / 100;
    const onlyMissing = document.getElementById('costFactorOnlyMissing').checked;
    const count = await costEstimationService.applyQuoteFactor(projectId, ratio, { onlyMissing });
    closeModal();
    toast(`已生成 ${count} 条待复核成本价`, 'success');
    await render();
  });
}

async function updateLine(id, patch) {
  await run(async () => { await costEstimationService.updateLine(id, patch); await render(); });
}

async function run(action) {
  try { await action(); }
  catch (error) { toast(error.message || '操作失败', 'error'); }
}

function currentSourceFor(document, lineId) {
  return [...document.querySelectorAll('[data-cost-source]')].find(element => element.dataset.costSource === lineId)?.value || '';
}

function reviewedFactorNote(note) {
  const original = String(note || '').replace(/[，,]?待复核/g, '').trim();
  return original ? `已人工复核；原${original}` : '已人工复核投标价折算结果';
}

function filterLines(lines) {
  const keyword = state.keyword.trim().toLowerCase();
  const filtered = lines.filter(line => {
    if (keyword && !`${line.code || ''} ${line.name || ''} ${line.feature || ''}`.toLowerCase().includes(keyword)) return false;
    if (state.source && line.costSource !== state.source) return false;
    if (state.status === 'excluded' && line.costIncluded !== false) return false;
    if (state.status === 'missing' && (line.costIncluded === false || hasCostPrice(line))) return false;
    if (state.status === 'pending' && (line.costIncluded === false || line.costReviewStatus !== 'pending')) return false;
    if (state.status === 'priced' && (line.costIncluded === false || !hasCostPrice(line) || line.costReviewStatus === 'pending')) return false;
    if (state.riskOnly && (line.costIncluded === false || (hasCostPrice(line) && line.costReviewStatus !== 'pending'))) return false;
    return true;
  });
  if (state.sort === 'original') return filtered;
  if (state.sort === 'amount') return filtered.sort((a, b) => Math.abs(Number(b.amount || 0)) - Math.abs(Number(a.amount || 0)));
  return filtered.sort((a, b) => riskScore(b) - riskScore(a));
}

function riskScore(line) {
  if (line.costIncluded === false) return -1;
  const statusWeight = !hasCostPrice(line) ? 3 : line.costReviewStatus === 'pending' ? 2 : 0;
  return statusWeight * 1e15 + Math.abs(Number(line.amount || 0));
}

function decisionPanel(summary, currency) {
  const targetRate = Number(summary.settings?.targetProfitRate || 0) / 100;
  if (!summary.decisionReady) {
    return `<section role="status" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shrink-0"><div class="flex flex-col gap-2 sm:flex-row sm:items-center"><div class="flex items-center gap-2 font-semibold"><span class="material-symbols-outlined icon-inline" aria-hidden="true">priority_high</span>当前不建议定稿</div><div class="text-amber-800">${summary.missingCount} 项未覆价、${summary.pendingCount} 项待复核，共影响 ${money(summary.riskBidAmount, currency)} 投标金额。请先处理高金额风险项。</div><div class="sm:ml-auto shrink-0 text-xs">目标利润率 ${percent(targetRate)}</div></div></section>`;
  }
  const passed = summary.costHeadroom >= 0;
  return `<section role="status" class="rounded-lg border ${passed ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'} px-4 py-3 text-sm shrink-0"><div class="flex flex-col gap-2 sm:flex-row sm:items-center"><div class="flex items-center gap-2 font-semibold"><span class="material-symbols-outlined icon-inline" aria-hidden="true">${passed ? 'check_circle' : 'error'}</span>${passed ? '已达到目标利润' : '未达到目标利润'}</div><div>目标成本上限 ${money(summary.targetCost, currency)}，${passed ? '尚有成本余量' : '已超出'} ${money(Math.abs(summary.costHeadroom), currency)}。</div><div class="sm:ml-auto shrink-0 text-xs">保持 ${percent(targetRate)} 利润率的最低报价 ${money(summary.minimumBidForTarget, currency)}</div></div></section>`;
}

function costBidRatio(line) {
  if (!hasCostPrice(line) || Number(line.amount || 0) <= 0) return null;
  const costAmount = line.costAmount === null || line.costAmount === undefined
    ? Number(line.qty || 0) * Number(line.factor || 1) * Number(line.costUnitPrice || 0)
    : Number(line.costAmount || 0);
  return costAmount / Number(line.amount);
}

function ratioBadge(ratio) {
  if (ratio === null || !Number.isFinite(ratio)) return '<span class="text-xs text-slate-400">-</span>';
  const label = percent(ratio);
  if (ratio > 1) return `<span class="badge badge-red" title="内部成本高于投标合价">倒挂 ${label}</span>`;
  if (ratio > 0.9) return `<span class="badge badge-yellow" title="未考虑其他取费前，直接成本已超过投标合价的 90%">偏薄 ${label}</span>`;
  return `<span class="text-xs tabular-nums text-slate-600">${label}</span>`;
}

function costSourceReferenceControl(line, disabled) {
  if (!line.costSource || line.costSource === 'manual') return '';
  const reference = line.costSourceRef;
  return `<button type="button" data-cost-source-ref="${esc(line.id)}" ${disabled ? 'disabled' : ''} title="${esc(reference?.detail || '选择可追溯的数据依据')}" class="mt-1 block w-full truncate text-left text-[11px] ${reference ? 'text-teal-700 hover:underline' : 'text-amber-700 hover:underline'} disabled:text-slate-400">${reference ? `已引用 · ${esc(reference.label)}` : '选择具体依据'}</button>`;
}

async function openCostSourceReferenceDialog(line, source, project) {
  if (source === 'subcontract') return openSubcontractReferenceDialog(line);
  if (source === 'control_price_discount') return openControlPriceDiscountDialog(line, project);
  if (source === 'quote_factor') return openSingleFactorReferenceDialog(line);
  const references = await costSourceReferenceService.list(line, source);
  const sourceLabel = COST_SOURCE_OPTIONS.find(option => option.value === source)?.label || '成本来源';
  const referenceTip = source === 'enterprise_quota'
    ? '从“我的定额库”引用企业定额，并保留定额编号、版本及人工/材料/设备等价格组成。只有单位一致且定额已有有效单价时，才允许直接带入成本单价。'
    : '引用会保留数据记录、日期和价格口径。只有单位一致时，系统才允许直接带入成本单价。';
  openModal(`选择${sourceLabel}依据`, `<div class="space-y-3 text-sm">
    <div class="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">${referenceTip}</div>
    ${references.length ? `${source === 'enterprise_quota' ? '<label class="relative block"><span class="material-symbols-outlined absolute left-3 top-2.5 text-[18px] text-slate-400">search</span><input id="costQuotaReferenceSearch" class="h-10 w-full rounded border border-slate-300 pl-9 pr-3 text-sm" placeholder="搜索定额编码、名称、分类或版本" /></label>' : ''}<div class="max-h-[500px] space-y-2 overflow-auto pr-1">${references.map((reference, index) => `<article data-cost-ref-card data-cost-ref-search="${esc(`${reference.label} ${reference.detail}`.toLowerCase())}" class="rounded-lg border border-slate-200 bg-white p-3"><div class="flex items-start gap-3"><div class="min-w-0 flex-1"><div class="font-medium text-slate-900">${esc(reference.label)}</div><div class="mt-1 text-xs leading-5 text-slate-500">${esc(reference.detail)}</div>${reference.unitPrice != null ? `<div class="mt-2 font-semibold tabular-nums text-slate-900">¥${Number(reference.unitPrice).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}<span class="ml-1 text-xs font-normal text-slate-400">/单位</span></div>` : ''}</div><div class="flex shrink-0 flex-col gap-2"><button data-cost-ref-index="${index}" data-cost-ref-mode="cite" class="h-8 border border-slate-300 bg-white px-3 text-xs text-slate-700">仅引用</button>${reference.canApplyPrice ? `<button data-cost-ref-index="${index}" data-cost-ref-mode="apply" class="h-8 brand-bg px-3 text-xs text-white">引用并带价</button>` : ''}</div></div></article>`).join('')}</div>` : `<div class="rounded-lg border border-dashed border-slate-300 p-8 text-center"><span class="material-symbols-outlined text-[28px] text-slate-400">link_off</span><div class="mt-2 font-medium text-slate-700">没有找到匹配数据</div><p class="mt-1 text-xs text-slate-500">可先在对应资料库中补充数据，或选择“手工测算”并在备注中记录依据。</p>${source === 'enterprise_quota' ? '<button id="costOpenQuotaLibrary" class="mt-4 h-9 border border-teal-300 bg-teal-50 px-4 text-xs font-medium text-teal-800">打开我的定额库</button>' : ''}</div>`}
  </div>`, `<button onclick="window.__modalClose()" class="h-9 border border-slate-300 bg-white px-3 text-sm">取消</button>`);
  document.getElementById('costQuotaReferenceSearch')?.addEventListener('input', event => {
    const keyword = event.target.value.trim().toLowerCase();
    document.querySelectorAll('[data-cost-ref-card]').forEach(card => card.classList.toggle('hidden', keyword && !card.dataset.costRefSearch.includes(keyword)));
  });
  document.getElementById('costOpenQuotaLibrary')?.addEventListener('click', () => {
    closeModal();
    window.__app.go('quota');
  });
  document.querySelectorAll('[data-cost-ref-index]').forEach(button => button.onclick = async () => {
    const reference = references[Number(button.dataset.costRefIndex)];
    await applyCostReference(line, source, reference, button.dataset.costRefMode === 'apply');
  });
}

async function applyCostReference(line, source, reference, applyPrice) {
  if (!reference) return;
  const citation = `引用：${reference.label}${reference.detail ? `（${reference.detail}）` : ''}`;
  const patch = {
    costSource: source,
    costSourceRef: { ...reference, type: source, linkedAt: new Date().toISOString() },
    costNote: mergeCitation(line.costNote, citation),
    ...(applyPrice && reference.canApplyPrice ? { costUnitPrice: reference.unitPrice, costReviewStatus: 'pending' } : {}),
  };
  await run(async () => {
    await costEstimationService.updateLine(line.id, patch);
    closeModal();
    toast(applyPrice && reference.canApplyPrice ? '已引用数据并带入建议成本价，请复核' : '已保存数据引用', 'success');
    await render();
  });
}

function openSubcontractReferenceDialog(line) {
  openModal('记录分包报价依据', `<div class="grid gap-3 text-sm sm:grid-cols-2"><label>报价单位 *<input id="costRefSupplier" class="mt-1 h-10 w-full rounded border border-slate-300 px-3" /></label><label>报价日期 *<input id="costRefDate" type="date" value="${new Date().toISOString().slice(0, 10)}" class="mt-1 h-10 w-full rounded border border-slate-300 px-3" /></label><label>报价编号<input id="costRefCode" class="mt-1 h-10 w-full rounded border border-slate-300 px-3" /></label><label>分包综合单价 *<input id="costRefPrice" type="number" min="0" step="0.01" class="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-right" /></label><label class="sm:col-span-2">补充说明<input id="costRefDetail" class="mt-1 h-10 w-full rounded border border-slate-300 px-3" placeholder="报价范围、税费口径或排除项" /></label></div>`, `<button onclick="window.__modalClose()" class="h-9 border border-slate-300 bg-white px-3 text-sm">取消</button><button id="costRefSaveSubcontract" class="h-9 brand-bg px-4 text-sm text-white">保存并带入单价</button>`);
  document.getElementById('costRefSaveSubcontract').onclick = async () => {
    const supplier = document.getElementById('costRefSupplier').value.trim();
    const date = document.getElementById('costRefDate').value;
    const code = document.getElementById('costRefCode').value.trim();
    const price = Number(document.getElementById('costRefPrice').value);
    const detail = document.getElementById('costRefDetail').value.trim();
    if (!supplier || !date || !Number.isFinite(price) || price < 0) return toast('请完整填写报价单位、日期和有效单价', 'error');
    await applyCostReference(line, 'subcontract', { id: `subcontract:${code || supplier}:${date}`, sourceId: code, label: `${supplier}${code ? ` · ${code}` : ''}`, detail: `${date}${detail ? ` · ${detail}` : ''}`, unitPrice: price, canApplyPrice: true, date }, true);
  };
}

function openSingleFactorReferenceDialog(line) {
  openModal('按投标价折算本项成本', `<div class="space-y-3 text-sm"><div class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">折算价只是快速起点，会标记为“待复核”。</div><label>成本占投标综合单价比例<div class="mt-1 flex"><input id="costRefFactor" type="number" min="1" max="200" step="0.1" value="85" class="h-10 min-w-0 flex-1 rounded-l border border-slate-300 px-3 text-right" /><span class="grid h-10 w-10 place-items-center rounded-r border border-l-0 border-slate-300 bg-slate-50">%</span></div></label><div class="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">投标单价 ${money(line.unitPrice, 'CNY')}</div></div>`, `<button onclick="window.__modalClose()" class="h-9 border border-slate-300 bg-white px-3 text-sm">取消</button><button id="costRefApplyFactor" class="h-9 brand-bg px-4 text-sm text-white">应用折算</button>`);
  document.getElementById('costRefApplyFactor').onclick = async () => {
    const percentValue = Number(document.getElementById('costRefFactor').value);
    if (!Number.isFinite(percentValue) || percentValue <= 0 || percentValue > 200) return toast('折算比例必须大于 0 且不超过 200%', 'error');
    const unitPrice = Number(line.unitPrice || 0) * percentValue / 100;
    await applyCostReference(line, 'quote_factor', { id: `quote-factor:${line.id}:${percentValue}`, sourceId: line.id, label: `投标单价 × ${percentValue}%`, detail: `${money(line.unitPrice, 'CNY')} × ${percentValue}%`, unitPrice, canApplyPrice: true, date: new Date().toISOString() }, true);
  };
}

function openControlPriceDiscountDialog(line, project = {}) {
  const currency = project.currency || 'CNY';
  const initialPrice = Number.isFinite(Number(line.controlUnitPrice)) ? Number(line.controlUnitPrice) : '';
  openModal('按控制价下浮测算本项成本', `<div class="space-y-4 text-sm">
    <div class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">请录入招标控制综合单价。下浮结果只作为快速起算价，会标记为“待复核”。</div>
    <div class="grid gap-3 sm:grid-cols-2">
      <label>控制综合单价 *<input id="costRefControlPrice" type="number" min="0" step="0.01" value="${esc(initialPrice)}" class="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-right tabular-nums" placeholder="输入控制价单价" /></label>
      <label>下浮率 *<div class="mt-1 flex"><input id="costRefDiscountRate" type="number" min="0" max="99.99" step="0.1" value="10" class="h-10 min-w-0 flex-1 rounded-l border border-slate-300 px-3 text-right tabular-nums" /><span class="grid h-10 w-10 place-items-center rounded-r border border-l-0 border-slate-300 bg-slate-50">%</span></div></label>
      <label class="sm:col-span-2">价格口径<select id="costRefControlBasis" class="mt-1 h-10 w-full rounded border border-slate-300 bg-white px-3"><option value="与项目报价口径一致">与项目报价口径一致</option><option value="含税控制价">含税控制价</option><option value="不含税控制价">不含税控制价</option></select></label>
    </div>
    <div class="rounded border border-slate-200 bg-slate-50 px-3 py-3">
      <div class="text-xs text-slate-500">计算结果</div>
      <div id="costRefDiscountResult" class="mt-1 text-lg font-semibold tabular-nums text-slate-900">请输入控制综合单价</div>
      <div id="costRefDiscountFormula" class="mt-1 text-xs text-slate-500">内部成本单价 = 控制综合单价 ×（1 - 下浮率）</div>
    </div>
  </div>`, `<button onclick="window.__modalClose()" class="h-9 border border-slate-300 bg-white px-3 text-sm">取消</button><button id="costRefApplyDiscount" class="h-9 brand-bg px-4 text-sm text-white">应用下浮价</button>`);

  const priceInput = document.getElementById('costRefControlPrice');
  const rateInput = document.getElementById('costRefDiscountRate');
  const updatePreview = () => {
    const price = Number(priceInput.value);
    const rate = Number(rateInput.value);
    const result = document.getElementById('costRefDiscountResult');
    const formula = document.getElementById('costRefDiscountFormula');
    try {
      const unitPrice = calculateControlPriceDiscount(priceInput.value === '' ? NaN : price, rateInput.value === '' ? NaN : rate);
      result.textContent = money(unitPrice, currency);
      formula.textContent = `${money(price, currency)} ×（1 - ${rate}%）= ${money(unitPrice, currency)}`;
      result.className = 'mt-1 text-lg font-semibold tabular-nums text-slate-900';
    } catch {
      result.textContent = '请完整填写有效的控制价和下浮率';
      result.className = 'mt-1 text-sm font-medium text-amber-700';
      formula.textContent = '内部成本单价 = 控制综合单价 ×（1 - 下浮率）';
    }
  };
  priceInput.addEventListener('input', updatePreview);
  rateInput.addEventListener('input', updatePreview);
  updatePreview();

  document.getElementById('costRefApplyDiscount').onclick = async () => {
    const controlUnitPrice = Number(priceInput.value);
    const discountRate = Number(rateInput.value);
    const priceBasis = document.getElementById('costRefControlBasis').value;
    let unitPrice;
    try {
      unitPrice = calculateControlPriceDiscount(priceInput.value === '' ? NaN : controlUnitPrice, rateInput.value === '' ? NaN : discountRate);
    } catch (error) {
      return toast(error.message, 'error');
    }
    await applyCostReference(line, 'control_price_discount', {
      id: `control-price-discount:${line.id}:${controlUnitPrice}:${discountRate}`,
      sourceId: line.id,
      label: `控制价下浮 ${discountRate}%`,
      detail: `${priceBasis} · ${money(controlUnitPrice, currency)} ×（1 - ${discountRate}%）`,
      baseUnitPrice: controlUnitPrice,
      rate: discountRate,
      priceBasis,
      unitPrice,
      canApplyPrice: true,
      date: new Date().toISOString(),
    }, true);
  };
}

function mergeCitation(note, citation) {
  const current = String(note || '').trim().replace(/(?:^|\s*)引用：[^\n]*/g, '').trim();
  return [citation, current].filter(Boolean).join('\n');
}

function metricCard(label, value, note, icon, tone) {
  const tones = { teal: 'icon-surface-teal', blue: 'icon-surface-blue', amber: 'icon-surface-amber', red: 'icon-surface-red', slate: 'icon-surface-slate' };
  return `<article class="rounded-lg border border-slate-200 bg-white p-4 min-w-0"><div class="flex items-start gap-3"><span class="icon-surface ${tones[tone] || tones.slate} hidden sm:grid"><span class="material-symbols-outlined icon-kpi" aria-hidden="true">${icon}</span></span><div class="min-w-0 flex-1"><div class="text-xs text-slate-500">${label}</div><div class="mt-1 truncate text-sm font-semibold tabular-nums text-slate-950 sm:text-lg" title="${esc(value)}">${value}</div><div class="mt-1 truncate text-xs text-slate-500">${note}</div></div></div></article>`;
}

function settingInput(label, id, value, suffix, disabled) {
  return `<label class="text-xs text-slate-500">${label}<div class="mt-1 flex"><input id="${id}" type="number" min="0" step="0.01" value="${esc(value)}" ${disabled ? 'disabled' : ''} class="h-10 min-w-0 flex-1 rounded-l border border-slate-300 px-2 text-right tabular-nums disabled:bg-slate-100" />${suffix ? `<span class="grid h-10 min-w-10 place-items-center rounded-r border border-l-0 border-slate-300 bg-slate-50 px-2 text-xs">${suffix}</span>` : '<span class="grid h-10 w-8 place-items-center rounded-r border border-l-0 border-slate-300 bg-slate-50 text-xs">元</span>'}</div></label>`;
}

function emptyProjectState() {
  return `<div class="page-frame h-full grid place-items-center"><section class="max-w-lg rounded-lg border border-slate-200 bg-white p-10 text-center"><span class="material-symbols-outlined icon-empty text-slate-400" aria-hidden="true">calculate</span><h1 class="mt-3 text-lg font-semibold text-slate-900">先建立一个项目</h1><p class="mt-2 text-sm text-slate-500">成本测算以项目工程量清单为基础。新建项目并导入清单后即可开始覆价。</p><button id="costCreateProject" class="mt-5 h-10 px-4 brand-bg text-white text-sm">新建项目</button></section></div>`;
}

function emptyLinesState(project, readOnly) {
  const steps = [
    ['1', '编制招标清单', '导入已有文件，或由 AI 从本地定额库生成草稿。'],
    ['2', '维护内部成本', '按企业定额、历史项目、材料设备价和分包报价逐项覆价。'],
    ['3', '复核利润与风险', '检查未覆价、成本倒挂和目标利润是否达标。'],
  ];
  return `<section class="flex flex-1 min-h-[420px] overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div class="grid w-full lg:grid-cols-[minmax(0,1fr)_430px]">
      <div class="flex items-center justify-center p-8 sm:p-12">
        <div class="max-w-xl text-center lg:text-left">
          <div class="mx-auto grid h-14 w-14 place-items-center rounded-lg bg-teal-50 text-teal-700 lg:mx-0">
            <span class="material-symbols-outlined text-[28px]" aria-hidden="true">format_list_bulleted_add</span>
          </div>
          <p class="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-teal-700">测算准备 · 0/3</p>
          <h2 class="mt-2 text-2xl font-semibold text-slate-950">先建立工程量清单</h2>
          <p class="mt-3 text-sm leading-6 text-slate-500">“${esc(project.name)}”尚无可用的招标清单。成本测算会以清单为骨架，再进行内部覆价和利润复核。</p>
          <div class="mt-6 flex flex-wrap justify-center gap-2 lg:justify-start">
            <button id="costStartAi" ${readOnly ? 'disabled' : ''} class="inline-flex h-10 items-center gap-2 px-4 brand-bg text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"><span class="material-symbols-outlined text-[18px]" aria-hidden="true">auto_awesome</span>AI 生成清单草稿</button>
            <button id="costStartBoq" class="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"><span class="material-symbols-outlined text-[18px] text-teal-700" aria-hidden="true">list_alt</span>打开清单工作台</button>
          </div>
          <p class="mt-4 text-xs text-slate-400">AI 只生成待确认草稿，预览确认后才写入项目。</p>
        </div>
      </div>
      <aside class="border-t border-slate-200 bg-slate-50/70 p-6 sm:p-8 lg:border-l lg:border-t-0">
        <div class="text-sm font-semibold text-slate-900">成本测算流程</div>
        <div class="mt-5 space-y-3">
          ${steps.map(([index, title, note], stepIndex) => `<div class="rounded-lg border ${stepIndex === 0 ? 'border-teal-200 bg-white shadow-sm' : 'border-slate-200 bg-white/70'} p-4"><div class="flex gap-3"><span class="grid h-7 w-7 shrink-0 place-items-center rounded-full ${stepIndex === 0 ? 'bg-teal-700 text-white' : 'bg-slate-200 text-slate-600'} text-xs font-semibold">${index}</span><div><div class="text-sm font-medium text-slate-900">${title}</div><p class="mt-1 text-xs leading-5 text-slate-500">${note}</p></div></div></div>`).join('')}
        </div>
      </aside>
    </div>
  </section>`;
}

function money(value, currency) { return fmtMoney(Number(value || 0), currency); }
function percent(value) { return `${(Number(value || 0) * 100).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`; }
function number(value) { return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 3 }); }
