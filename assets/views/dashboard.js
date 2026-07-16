// 视图：仪表盘
import { quotaRepo, projectRepo, boqRepo, versionRepo } from '../data/repository.js?v=6.3';
import { dataEngineService } from '../services/dataEngineService.js?v=6.3';
import { experienceService } from '../services/experienceService.js?v=6.3';
import { resourceHealthService } from '../services/resourceHealthService.js?v=6.3';
import { fmt, fmtMoney, esc } from '../utils/dom.js?v=6.3';
import { hasMissingPrice } from '../utils/costing.js?v=6.3';
import { categoryGuess } from '../utils/stats.js?v=6.3';

const chartState = {
  trend: null,
  composition: null,
};

export async function render(workspace = document.getElementById('workspace')) {
  const [quota, projects, boq, versions, engine, experience, resourceHealth] = await Promise.all([
    quotaRepo.all(),
    projectRepo.all(),
    boqRepo.all(),
    versionRepo.all(),
    dataEngineService.dashboard(),
    experienceService.dashboard(),
    resourceHealthService.getHealth(),
  ]);
  const stats = buildDashboardStats({ quota, projects, boq, versions, engine, experience, resourceHealth });

  workspace.innerHTML = `
    <div class="page-frame min-h-full flex flex-col gap-3">
      ${dashboardTitle(stats)}

      ${personalStartCard(stats)}

      ${executiveSummary(stats)}

      ${resourceHealthSection(stats.resourceHealth)}

      <section class="grid grid-cols-1 2xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,.95fr)] gap-3">
        ${trendPanel(stats)}
        ${actionQueue(stats)}
      </section>

      <section class="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)_360px] gap-3">
        ${projectCompositionPanel(stats)}
        ${projectTablePanel(stats)}
        ${healthRadarPanel(stats)}
      </section>

      <section class="grid grid-cols-1 xl:grid-cols-[minmax(0,.95fr)_minmax(0,1fr)] gap-3">
        ${experienceAssetCard(stats)}
        ${recentVersionAssetCard(stats)}
      </section>
    </div>
  `;

  bindResourceHealthActions(stats.resourceHealth, workspace);
  drawCharts(stats, workspace);
}

function buildDashboardStats({ quota, projects, boq, versions, engine, experience, resourceHealth }) {
  const archived = projects.filter(p => p.status === 'archived');
  const doing = projects.filter(p => p.status !== 'archived');
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthProjects = projects.filter(p => dateKey(p.createdAt || p.updatedAt || p.archivedAt) === monthKey);
  const monthArchived = archived.filter(p => dateKey(p.archivedAt || p.updatedAt || p.createdAt) === monthKey);
  const archivedTrend = buildMonthlyTrend(archived, 6);
  const totalCost = projects.reduce((s, p) => s + Number(p.totalCost || 0), 0);
  const archivedCost = archived.reduce((s, p) => s + Number(p.totalCost || 0), 0);
  const missingQuota = quota.filter(q => hasMissingPrice(q.priceTotal));
  const missingBoq = boq.filter(b => hasMissingPrice(b.unitPrice));
  const zeroQty = boq.filter(b => !(Number(b.qty) > 0));
  const factorRisk = boq.filter(b => Number(b.factor || 1) > 1.2 || Number(b.factor || 1) < 0.8);
  const unmatchedQuota = boq.filter(b => !b.quotaItemId);
  const riskTotal = missingQuota.length + missingBoq.length + zeroQty.length + factorRisk.length + unmatchedQuota.length;
  const noVersionProjects = projects.filter(p => boq.some(b => b.projectId === p.id) && !versions.some(v => v.projectId === p.id));
  const projectRows = projects
    .map(p => {
      const lines = boq.filter(b => b.projectId === p.id);
      const projectVersions = versions.filter(v => v.projectId === p.id);
      return {
        ...p,
        lineCount: lines.length,
        missingCount: lines.filter(b => hasMissingPrice(b.unitPrice)).length,
        versionCount: projectVersions.length,
        updatedSort: p.updatedAt || p.archivedAt || p.createdAt || '',
      };
    })
    .sort((a, b) => (b.updatedSort || '').localeCompare(a.updatedSort || ''));
  const pricedItems = quota.length + boq.length - missingQuota.length - missingBoq.length;
  const priceBase = quota.length + boq.length;
  const priceCompleteness = priceBase ? Math.round(pricedItems / priceBase * 100) : 100;
  const priceRiskRate = priceBase ? Math.round((missingQuota.length + missingBoq.length) / priceBase * 100) : 0;
  const categoryCost = categoryBreakdown(boq);
  const recentVersions = versions.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 5);
  const nextActions = buildNextActions({ missingQuota, missingBoq, noVersionProjects, archived, engine, experience, projects });
  return {
    quota,
    projects,
    boq,
    versions,
    archived,
    doing,
    monthProjects,
    monthArchived,
    archivedTrend,
    totalCost,
    archivedCost,
    missingQuota,
    missingBoq,
    missingPriceCount: missingQuota.length + missingBoq.length,
    zeroQty,
    factorRisk,
    unmatchedQuota,
    riskTotal,
    noVersionProjects,
    priceCompleteness,
    priceRiskRate,
    categoryCost,
    recentVersions,
    projectRows,
    nextActions,
    engine,
    experience,
    resourceHealth,
  };
}

export function resourceHealthSection(health = emptyResourceHealth()) {
  const rows = [
    ['missingCurrentPrice', '缺少当前价', '启用中但没有可用当前价', 'price_check'],
    ['expiredCurrentPrice', '当前价已过期', '当前价或手动首选价超过有效期', 'event_busy'],
    ['missingQuoteEvidence', '报价依据缺失', '供应商报价未关联可用附件', 'attach_file_off'],
    ['pendingQuotaUpdates', '定额快照待更新', '已保存快照与当前价格或元数据不同', 'sync_problem'],
    ['inactiveResourceInUse', '停用资源仍被引用', '历史引用保留，但需要确认是否替换为可用资源', 'archive'],
    ['unsupportedCostingPrice', '历史口径待治理', '历史快照不是到场价，不会自动重算', 'price_change'],
    ['duplicateCode', '重复资源编码', '编码必须在材料与设备库中全局唯一', 'content_copy'],
    ['duplicateComposite', '重复规格身份', '相同类型、名称、规格、单位与品牌/厂家需人工合并', 'merge'],
  ];
  return `<section class="card p-0 overflow-hidden" aria-labelledby="resourceHealthTitle">
    <div class="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
      <div><h2 id="resourceHealthTitle" class="font-semibold text-slate-900">资源健康</h2><p class="mt-1 text-xs text-slate-500">材料、设备价格证据与定额快照的待处理项。</p></div>
      <div class="flex items-center gap-2 text-xs"><span class="badge ${health.summary.total ? 'badge-yellow' : 'badge-green'}">${fmt(health.summary.total)} 项</span><span class="text-slate-500">材料 ${fmt(health.summary.material)} · 设备 ${fmt(health.summary.equipment)}</span></div>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:[&>*:nth-child(n+3)]:border-t divide-slate-200">
      ${rows.map(([key, title, desc, icon]) => resourceHealthRow(key, health[key], title, desc, icon)).join('')}
    </div>
  </section>`;
}

function resourceHealthRow(key, issue, title, desc, icon) {
  const pendingQuota = key === 'pendingQuotaUpdates';
  return `<div class="p-4 lg:odd:border-r border-slate-200 flex items-start gap-3 min-w-0">
    <span class="material-symbols-outlined icon-surface ${issue.total ? 'icon-surface-amber' : 'icon-surface-teal'}">${icon}</span>
    <div class="min-w-0 flex-1"><div class="flex items-center justify-between gap-2"><h3 class="font-medium text-slate-900">${title}</h3><span class="font-semibold tabular-nums ${issue.total ? 'text-amber-700' : 'text-teal-700'}">${fmt(issue.total)}</span></div><p class="mt-1 text-xs leading-5 text-slate-500">${desc}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        ${pendingQuota ? `<button type="button" data-health-issue="${key}" data-health-type="quota" class="h-8 px-3 border border-amber-300 bg-amber-50 text-xs text-amber-800 disabled:opacity-50" ${issue.total ? '' : 'disabled'}>查看待更新定额（${fmt(issue.total)}）</button>` : `
          <button type="button" data-health-issue="${key}" data-health-type="material" class="h-8 px-3 border border-slate-300 bg-white text-xs text-slate-700 disabled:opacity-50" ${issue.material ? '' : 'disabled'}>材料 ${fmt(issue.material)}</button>
          <button type="button" data-health-issue="${key}" data-health-type="equipment" class="h-8 px-3 border border-slate-300 bg-white text-xs text-slate-700 disabled:opacity-50" ${issue.equipment ? '' : 'disabled'}>设备 ${fmt(issue.equipment)}</button>`}
      </div>
    </div>
  </div>`;
}

function bindResourceHealthActions(health, workspace = document) {
  workspace.querySelectorAll('[data-health-issue]').forEach(button => {
    button.onclick = () => {
      const issue = health[button.dataset.healthIssue];
      const type = button.dataset.healthType;
      if (type === 'quota') {
        return window.__app.go('quota', {
          selectedId: issue.quotaItemIds[0] || '',
          quotaItemIds: issue.quotaItemIds,
          healthReason: 'pending-resource-updates',
          affectedCount: issue.total,
        });
      }
      return window.__app.go(type === 'equipment' ? 'equipment' : 'materials', healthResourceRouteParams(button.dataset.healthIssue, issue, type));
    };
  });
}

export function healthResourceRouteParams(issueKey, issue = {}, type = 'material') {
  const labels = {
    missingCurrentPrice: '缺参考价',
    expiredCurrentPrice: '价格已过期',
    missingQuoteEvidence: '询价缺附件',
    inactiveResourceInUse: '停用资源被引用',
    unsupportedCostingPrice: '历史价格口径待治理',
    duplicateCode: '重复编码',
    duplicateComposite: '重复规格身份',
  };
  return {
    resourceIds: type === 'equipment' ? (issue.equipmentResourceIds || []) : (issue.materialResourceIds || []),
    healthLabel: labels[issueKey] || '资源健康',
  };
}

function emptyResourceHealth() {
  const empty = { total: 0, material: 0, equipment: 0, resourceIds: [], materialResourceIds: [], equipmentResourceIds: [], priceIds: [], usageIds: [], quotaItemIds: [] };
  return { summary: { total: 0, material: 0, equipment: 0 }, missingCurrentPrice: empty, expiredCurrentPrice: empty, missingQuoteEvidence: empty, pendingQuotaUpdates: empty, inactiveResourceInUse: empty, unsupportedCostingPrice: empty, duplicateCode: empty, duplicateComposite: empty };
}

function buildNextActions({ missingQuota, missingBoq, noVersionProjects, archived, engine, experience, projects }) {
  const actions = [];
  if (missingBoq.length || missingQuota.length) {
    actions.push({
      title: '补齐报价风险',
      desc: `${missingBoq.length} 条项目清单、${missingQuota.length} 条定额缺少综合单价`,
      view: missingBoq.length ? 'boq' : 'quota',
      icon: 'priority_high',
      tone: 'amber',
    });
  }
  if (noVersionProjects.length) {
    actions.push({
      title: '保存报价版本',
      desc: `${noVersionProjects.length} 个项目已有清单但无报价快照`,
      view: 'boq',
      projectId: noVersionProjects[0].id,
      icon: 'history',
      tone: 'teal',
    });
  }
  const backfillNeeded = engine.backfillNeeded || 0;
  if (backfillNeeded || projects.some(p => p.status !== 'archived')) {
    actions.push({
      title: '收录案例',
      desc: backfillNeeded ? `${backfillNeeded} 个已收录项目待整理为参考案例` : `${projects.filter(p => p.status !== 'archived').length} 个项目仍在报价中`,
      view: 'projects',
      icon: 'inventory_2',
      tone: 'slate',
    });
  }
  if (experience.pendingSessions.length) {
    actions.push({
      title: '确认复盘经验',
      desc: `${experience.pendingSessions.length} 个复盘草稿待确认保存`,
      view: 'experience',
      icon: 'psychology_alt',
      tone: 'amber',
    });
  } else if (archived.length && !experience.confirmedCards.length) {
    actions.push({
      title: '沉淀报价经验',
      desc: '已有收录案例，建议保存第一条复盘笔记',
      view: 'projects',
      icon: 'psychology_alt',
      tone: 'slate',
    });
  }
  if (engine.lowQuality) {
    actions.push({
      title: '复核低可信报告',
      desc: `${engine.lowQuality} 份数据质量报告需要处理`,
      view: 'settings',
      icon: 'fact_check',
      tone: 'amber',
    });
  }
  return actions;
}

function dashboardTitle(stats) {
  const now = new Date();
  const dateText = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const pendingText = stats.nextActions.length ? `${stats.nextActions.length} 项待处理动作` : '暂无紧急动作';
  return `<section class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 py-1">
    <div class="flex flex-wrap items-center gap-4">
      <h1 class="text-2xl font-semibold tracking-normal text-slate-950">我的造价概览</h1>
      <div class="text-sm text-slate-500">${dateText}</div>
      <div class="text-sm text-slate-500">资料默认保存在本机</div>
    </div>
    <div class="flex items-center gap-2 text-xs text-slate-500">
      <span class="inline-flex h-2 w-2 rounded-full bg-teal-500"></span>
      <span>${pendingText}</span>
    </div>
  </section>`;
}

function personalStartCard(stats) {
  const hasData = stats.projects.length || stats.quota.length || stats.boq.length;
  if (!hasData) return `<section class="card border-teal-200 bg-teal-50/60 p-5">
    <div class="flex flex-col lg:flex-row lg:items-center gap-4">
      <div class="min-w-0 flex-1">
        <div class="text-base font-semibold text-slate-900">还没有资料，先从这里开始</div>
        <div class="mt-1 text-sm leading-6 text-slate-600">导入一份历史清单或常用定额，也可以直接新建一个项目。你的资料默认只保存在当前浏览器。</div>
        <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-slate-600">
          <div class="rounded border border-teal-200 bg-white/70 px-2.5 py-2"><b class="text-teal-800">1.</b> 导入历史清单或常用定额</div>
          <div class="rounded border border-teal-200 bg-white/70 px-2.5 py-2"><b class="text-teal-800">2.</b> 建立项目并完成报价</div>
          <div class="rounded border border-teal-200 bg-white/70 px-2.5 py-2"><b class="text-teal-800">3.</b> 保存版本，收录案例</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 shrink-0">
        <button onclick="window.__app.go('importer')" class="h-9 px-3 text-sm brand-bg text-white rounded">导入资料</button>
        <button onclick="window.__app.go('projects',{action:'new'})" class="h-9 px-3 text-sm border border-teal-300 bg-white text-teal-700 rounded">新建项目</button>
      </div>
    </div>
  </section>`;
  const latest = stats.projectRows[0];
  return `<section class="card border-teal-100 bg-teal-50/40 p-4">
    <div class="flex flex-col lg:flex-row lg:items-center gap-4">
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold text-slate-900">继续最近工作</div>
        <div class="mt-1 text-sm text-slate-600">${latest ? `最近更新：${esc(latest.name || '未命名项目')}，可以继续处理清单或报价版本。` : '导入资料后，这里会显示最近使用的项目。'}</div>
      </div>
      <div class="flex flex-wrap gap-2 shrink-0">
        ${latest ? `<button onclick="window.__app.go('boq',{projectId:'${latest.id}'})" class="h-9 px-3 text-sm brand-bg text-white rounded">继续编辑清单</button>` : ''}
        <button onclick="window.__app.go('importer')" class="h-9 px-3 text-sm border border-teal-300 bg-white text-teal-700 rounded">导入资料</button>
        <button onclick="window.__app.go('projects',{action:'new'})" class="h-9 px-3 text-sm border border-slate-300 bg-white text-slate-700 rounded">新建项目</button>
      </div>
    </div>
  </section>`;
}

function executiveSummary(stats) {
  const archivedRatio = stats.totalCost ? Math.round(stats.archivedCost / stats.totalCost * 100) : 0;
  const healthTone = stats.riskTotal ? 'amber' : 'teal';
  const versionTone = stats.noVersionProjects.length ? 'amber' : 'teal';
  const dataScore = stats.engine.qualityScore || 0;
  const exp = stats.experience;
  return `<section class="grid grid-cols-1 2xl:grid-cols-[minmax(520px,1fr)_minmax(0,1fr)] gap-3">
    <div class="card p-4 overflow-hidden min-h-[202px]">
      <div class="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div class="font-semibold text-slate-900">项目费用概览</div>
        <span class="text-xs text-slate-500">按项目总造价汇总</span>
      </div>
      <div class="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-5">
        <div class="min-w-0">
          <div class="text-xs text-slate-500">累计造价</div>
          <div class="mt-2 text-3xl font-semibold tabular-nums text-slate-950 truncate">${fmtMoney(stats.totalCost)}</div>
          <div class="mt-2 text-xs text-slate-500">已收录案例 ${fmtMoney(stats.archivedCost)}</div>
        </div>
        <div class="min-w-0 sm:border-l sm:border-slate-200 sm:pl-4">
          <div class="text-xs text-slate-500">案例费用</div>
          <div class="mt-2 text-2xl font-semibold tabular-nums text-slate-900 truncate">${fmtMoney(stats.archivedCost)}</div>
          <div class="mt-2 text-xs text-slate-500">${fmt(stats.archived.length)} 个已收录案例</div>
        </div>
        <div class="min-w-0 sm:border-l sm:border-slate-200 sm:pl-4">
          <div class="flex items-center justify-between text-xs text-slate-500">
            <span>案例收录率</span>
            <span class="${archivedRatio >= 60 ? 'text-teal-700' : 'text-amber-700'} font-semibold">${archivedRatio}%</span>
          </div>
          <div class="mt-3 h-2 rounded-full bg-slate-100 overflow-hidden">
            <div class="h-2 rounded-full ${archivedRatio >= 60 ? 'bg-teal-600' : 'bg-amber-500'}" style="width:${Math.min(100, Math.max(0, archivedRatio))}%"></div>
          </div>
          <div class="mt-2 text-xs ${archivedRatio >= 60 ? 'text-teal-700' : 'text-slate-500'}">本月新增 ${fmt(stats.monthArchived.length)} 个案例</div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
      ${summaryKpi('本月新增项目', `${fmt(stats.monthProjects.length)} 个`, `本月收录 ${fmt(stats.monthArchived.length)} 个案例`, 'create_new_folder', stats.monthProjects.length ? 'teal' : 'slate')}
      ${summaryKpi('进行中的项目', `${fmt(stats.doing.length)} 个`, `${fmt(stats.archived.length)} 个已收录案例`, 'assignment', stats.doing.length ? 'amber' : 'teal')}
      ${summaryKpi('未保存版本', `${fmt(stats.noVersionProjects.length)} 个`, '有清单但无报价快照', 'history', versionTone)}
      ${summaryKpi('健康风险', `${fmt(stats.riskTotal)} 处`, `报价完整度 ${stats.priceCompleteness}%`, 'health_and_safety', healthTone)}
      ${summaryKpi('资料完整度', `${fmt(dataScore)} 分`, `${fmt(stats.engine.facts.length)} 个可用案例`, 'monitor_heart', dataScore >= 80 ? 'teal' : 'amber')}
      ${summaryKpi('待确认复盘', `${fmt(exp.pendingSessions.length)} 个`, exp.pendingSessions.length ? '建议保存到复盘笔记' : '暂无待处理复盘', 'menu_book', exp.pendingSessions.length ? 'amber' : 'teal')}
    </div>
  </section>`;
}

function summaryMini(label, value, note, tone = 'slate') {
  return `<div class="rounded border ${toneClass(tone)} px-3 py-2">
    <div class="text-[11px] opacity-80">${label}</div>
    <div class="mt-1 font-semibold tabular-nums truncate">${value}</div>
    <div class="mt-1 text-[11px] opacity-80 truncate">${note}</div>
  </div>`;
}

function summaryKpi(label, value, note, icon, tone = 'slate') {
  return `<div class="card p-3 min-w-0 min-h-[95px]">
    <div class="flex items-center gap-3">
      <div class="icon-surface ${toneClass(tone)}">
        <span class="material-symbols-outlined icon-kpi">${icon}</span>
      </div>
      <div class="min-w-0">
        <div class="text-xs text-slate-500 truncate">${label}</div>
        <div class="mt-1 text-xl font-semibold tabular-nums text-slate-900 truncate">${value}</div>
      </div>
    </div>
    <div class="mt-2 text-xs text-slate-500 truncate">${note}</div>
  </div>`;
}

function metricCard(label, value, unit, note, icon, tone = 'slate') {
  const toneCls = toneClass(tone);
  return `<div class="card p-3">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="text-xs text-slate-500 truncate">${label}</div>
        <div class="mt-1 text-xl font-semibold tabular-nums text-slate-900 truncate">${value}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
      </div>
      <div class="h-8 w-8 rounded border ${toneCls} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined icon-action">${icon}</span>
      </div>
    </div>
    <div class="mt-2 text-xs text-slate-500 truncate">${note}</div>
  </div>`;
}

function experienceCommandCenter(stats) {
  const exp = stats.experience;
  const pending = exp.pendingSessions.length;
  const confirmed = exp.confirmedCards.length;
  const expired = exp.expiredCards.length;
  const review = exp.reviewCards?.length || 0;
  const healthText = pending ? `${pending} 个复盘待确认` : confirmed ? '经验库可被 AI 引用' : '等待沉淀第一张经验卡';
  const tone = pending || expired || review ? 'amber' : 'teal';
  return `
    <section class="card p-0 overflow-hidden border-teal-200">
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div class="p-3 flex flex-col sm:flex-row sm:items-center gap-3 min-w-0">
          <div class="h-10 w-10 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[22px]">psychology_alt</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              <div class="font-semibold text-slate-900">AI 复盘助手</div>
              <span class="badge ${tone === 'amber' ? 'badge-yellow' : 'badge-green'}">${healthText}</span>
            </div>
            <div class="mt-1 text-sm leading-6 text-slate-600">把报价审查、版本调整和案例收录里的判断，保存为可检索、可复核的个人复盘笔记。</div>
          </div>
          <div class="flex flex-wrap sm:justify-end gap-2 shrink-0">
            <button onclick="window.__app.go('experience')" class="inline-flex items-center gap-1.5 px-3 py-2 text-sm brand-bg text-white rounded">
              <span class="material-symbols-outlined text-[18px]">database_search</span>
              复盘笔记
            </button>
            <button onclick="window.__app.go('experience')" class="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">
              <span class="material-symbols-outlined text-[18px]">${pending ? 'fact_check' : 'add_task'}</span>
              ${pending ? '确认保存' : '发起复盘'}
            </button>
          </div>
        </div>

        <div class="border-t xl:border-t-0 xl:border-l border-slate-200 bg-slate-50/70 p-3">
          <div class="grid grid-cols-2 gap-2">
            ${experienceMetric('复盘笔记', confirmed, '张', '可查阅', 'teal')}
            ${experienceMetric('待确认', pending, '个', pending ? '建议现在保存' : '无积压', pending ? 'amber' : 'teal')}
            ${experienceMetric('需复核', review, '张', review ? '需要维护' : '状态健康', review ? 'amber' : 'teal')}
            ${experienceMetric('过期', expired, '张', expired ? '需更新边界' : '有效', expired ? 'amber' : 'teal')}
          </div>
        </div>
      </div>
      <div class="border-t border-slate-200 bg-white px-3 py-2">
        <div class="flex flex-wrap gap-2">
              ${experiencePill('AI 追问', '按项目上下文生成', 'psychology_alt', 'teal')}
              ${experiencePill('用户确认', '草稿确认后保存', pending ? 'pending_actions' : 'task_alt', pending ? 'amber' : 'teal')}
              ${experiencePill('笔记引用', '进入 AI 查询上下文', 'link', confirmed ? 'teal' : 'slate')}
        </div>
      </div>
    </section>
  `;
}

function experiencePill(title, desc, icon, tone = 'slate') {
  return `<div class="inline-flex items-center gap-2 rounded border ${toneClass(tone)} bg-opacity-80 px-2.5 py-1.5">
    <span class="material-symbols-outlined text-[16px]">${icon}</span>
    <span class="text-xs font-medium">${title}</span>
    <span class="hidden md:inline text-xs opacity-80">${desc}</span>
  </div>`;
}

function experienceMetric(label, value, unit, note, tone = 'slate') {
  return `<div class="rounded border border-slate-200 bg-white px-3 py-2 min-w-0">
    <div class="text-[11px] text-slate-500 truncate">${label}</div>
    <div class="mt-1 flex items-baseline gap-1">
      <span class="text-lg font-semibold tabular-nums ${toneText(tone)}">${fmt(value)}</span>
      <span class="text-[11px] text-slate-500">${unit}</span>
    </div>
    <div class="mt-1 text-[11px] text-slate-500 truncate">${note}</div>
  </div>`;
}

function trendPanel(stats) {
  return `<section class="card p-0 overflow-hidden min-h-[410px] flex flex-col">
    <div class="px-4 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-slate-900">造价与项目趋势</div>
        <div class="mt-1 text-xs text-slate-500">按案例收录月份查看造价、项目数和单项目均价。</div>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge badge-gray">${stats.archivedTrend.windowText}</span>
      </div>
    </div>
    <div class="px-4 pt-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-xs text-slate-500">
      ${chartLegendItem('案例造价（万元）', 'bg-teal-600')}
      ${chartLegendItem('项目数（个）', 'bg-sky-600')}
      ${chartLegendItem('平均造价（万元）', 'bg-amber-500')}
    </div>
    <div class="px-5 pb-5 pt-3 flex-1 min-h-[310px]">
      ${stats.archivedTrend.hasAnyInWindow ? '<canvas id="costChart" class="w-full h-full"></canvas>' : emptyBlock('近 6 个月无收录案例，新增案例后自动展示')}
    </div>
  </section>`;
}

function chartLegendItem(label, color) {
  return `<span class="inline-flex items-center gap-2">
    <span class="h-2 w-5 rounded ${color}"></span>
    <span>${label}</span>
  </span>`;
}

function actionQueue(stats) {
  const rows = actionQueueRows(stats);
  return `<section class="card p-0 overflow-hidden min-h-[390px] flex flex-col">
    <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
      <div>
      <div class="font-semibold text-slate-900">下一步处理</div>
        <div class="mt-1 text-xs text-slate-500">按优先级处理价格、版本和个人复盘。</div>
      </div>
      <span class="badge ${rows.some(r => r.count > 0) ? 'badge-yellow' : 'badge-green'}">${rows.reduce((s, r) => s + r.count, 0)} 项</span>
    </div>
    <div class="p-3 space-y-3 flex-1">
      ${rows.map(queueActionRow).join('')}
    </div>
  </section>`;
}

function actionQueueRows(stats) {
  const backfillCount = stats.engine.backfillNeeded || 0;
  const archiveCount = backfillCount || stats.doing.length;
  return [
    {
      title: '补齐报价风险',
      desc: stats.riskTotal ? `${stats.missingPriceCount} 处缺价，${stats.factorRisk.length} 条系数异常` : '暂无需立即处理的价格风险',
      count: stats.riskTotal,
      badge: stats.riskTotal ? '高优先' : '完成',
      view: stats.missingBoq.length ? 'boq' : 'quota',
      icon: 'gpp_maybe',
      tone: stats.riskTotal ? 'amber' : 'teal',
    },
    {
      title: '保存报价版本',
      desc: stats.noVersionProjects.length ? `${stats.noVersionProjects.length} 个项目有清单但无报价快照` : '关键调整后记得保留版本',
      count: stats.noVersionProjects.length,
      badge: stats.noVersionProjects.length ? '中优先' : '完成',
      view: 'boq',
      projectId: stats.noVersionProjects[0]?.id,
      icon: 'save',
      tone: stats.noVersionProjects.length ? 'teal' : 'slate',
    },
    {
      title: '确认复盘经验',
      desc: stats.experience.pendingSessions.length ? '复盘草稿等待确认后保存' : '暂无待确认复盘',
      count: stats.experience.pendingSessions.length,
      badge: stats.experience.pendingSessions.length ? '中优先' : '完成',
      view: 'experience',
      icon: 'menu_book',
      tone: stats.experience.pendingSessions.length ? 'amber' : 'teal',
    },
    {
      title: '收录案例',
      desc: backfillCount ? `${backfillCount} 个已收录项目待整理为参考案例` : `${stats.doing.length} 个项目仍在报价中`,
      count: archiveCount,
      badge: archiveCount ? '低优先' : '完成',
      view: 'projects',
      icon: 'inventory_2',
      tone: archiveCount ? 'slate' : 'teal',
    },
  ];
}

function queueActionRow(action) {
  const params = action.projectId ? `,{projectId:'${action.projectId}'}` : '';
  const badgeClass = action.count > 0 ? (action.badge === '高优先' ? 'badge-yellow' : 'badge-gray') : 'badge-green';
  return `<button onclick="window.__app.go('${action.view}'${params})" class="w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-left hover:bg-slate-50">
    <div class="flex items-center gap-3">
      <div class="h-10 w-10 rounded-lg border ${toneClass(action.tone)} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[21px]">${action.icon}</span>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2">
          <div class="font-semibold text-slate-900 truncate">${esc(action.title)}</div>
          <span class="badge ${badgeClass} shrink-0">${action.badge}</span>
        </div>
        <div class="mt-1 text-xs leading-5 text-slate-500 truncate">${esc(action.desc)}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-sm font-semibold tabular-nums text-slate-700">${fmt(action.count)}</span>
        <span class="text-xs text-slate-500">项</span>
        <span class="material-symbols-outlined text-[18px] text-slate-400">chevron_right</span>
      </div>
    </div>
  </button>`;
}

function projectCompositionPanel(stats) {
  return `<section class="card p-0 overflow-hidden min-h-[270px]">
    ${panelHeader('项目组合', '类型、状态和样本结构，帮助判断业务是否偏科。')}
    <div class="grid grid-cols-1 sm:grid-cols-[170px_minmax(0,1fr)] gap-3 p-4">
      <div class="h-[168px]">${stats.projects.length ? '<canvas id="typeChart"></canvas>' : emptyBlock('暂无项目')}</div>
      <div class="space-y-3 min-w-0">
        ${typeLegend(stats)}
        ${compositionQuickStats(stats)}
      </div>
    </div>
  </section>`;
}

function typeLegend(stats) {
  if (!stats.projects.length) return `<div class="text-sm text-slate-400">新增项目后展示类型分布</div>`;
  const counts = Object.entries(countBy(stats.projects, p => p.type || '未分类')).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const colors = ['bg-teal-600', 'bg-sky-500', 'bg-amber-500', 'bg-slate-500'];
  return `<div class="space-y-2">
    ${counts.map(([name, count], index) => `<div class="flex items-center justify-between gap-2 text-sm">
      <span class="inline-flex items-center gap-2 min-w-0 text-slate-600">
        <span class="h-2 w-2 rounded-full ${colors[index] || 'bg-slate-400'} shrink-0"></span>
        <span class="truncate">${esc(name)}</span>
      </span>
      <span class="text-xs text-slate-500 shrink-0">${Math.round(count / stats.projects.length * 100)}%</span>
    </div>`).join('')}
  </div>`;
}

function compositionQuickStats(stats) {
  const typeCounts = countBy(stats.projects, p => p.type || '未分类');
  const top = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  const topRatio = top && stats.projects.length ? Math.round(top[1] / stats.projects.length * 100) : 0;
  const sampleNote = topRatio >= 70 ? '样本偏集中' : top ? '结构较均衡' : '暂无样本';
  return `<div class="pt-3 border-t border-slate-200 grid grid-cols-1 gap-2">
    ${flatStat('项目总量', `${fmt(stats.projects.length)} 个`, 'teal')}
    ${flatStat('样本结构', top ? `${top[0]} ${topRatio}% · ${sampleNote}` : '暂无类型样本', topRatio >= 70 ? 'amber' : 'slate')}
    ${flatStat('平均造价', stats.projects.length ? fmtMoney(stats.totalCost / stats.projects.length) : '-', 'slate')}
  </div>`;
}

function flatStat(label, value, tone = 'slate') {
  return `<div class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
    <span class="text-xs text-slate-500">${esc(label)}</span>
    <span class="text-sm font-medium truncate ${toneText(tone)}">${esc(String(value))}</span>
  </div>`;
}

function projectTablePanel(stats) {
  return `<section class="card p-0 overflow-hidden min-h-[270px]">
    <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
      <div>
        <div class="font-semibold text-slate-900">我的项目明细</div>
        <div class="mt-1 text-xs text-slate-500">最近项目、状态和总造价。</div>
      </div>
      <button onclick="window.__app.go('projects')" class="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">我的项目</button>
    </div>
    <div class="overflow-auto scroll-thin">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 sticky top-0"><tr class="text-left text-slate-500 border-b border-slate-200">
          <th class="py-2 px-4">项目名称</th>
          <th class="px-3">类型</th>
          <th class="px-3">状态</th>
          <th class="px-3 text-right">总造价</th>
          <th class="px-4 text-right">操作</th>
        </tr></thead>
        <tbody>
          ${stats.projectRows.length ? stats.projectRows.slice(0, 4).map(projectMiniRow).join('') : `<tr><td colspan="5" class="py-10 text-center text-slate-400">还没有项目，先去 <button class="text-teal-700 underline" onclick="window.__app.go('projects')">新建项目</button></td></tr>`}
        </tbody>
      </table>
    </div>
  </section>`;
}

function projectMiniRow(p) {
  return `<tr class="border-b border-slate-100 hover:bg-slate-50">
    <td class="py-3 px-4 font-medium text-slate-800">${esc(p.name)}</td>
    <td class="px-3"><span class="badge badge-blue">${esc(p.type || '-')}</span></td>
    <td class="px-3">${statusBadge(p.status)}</td>
    <td class="px-3 text-right tabular-nums font-medium">${fmtMoney(p.totalCost || 0)}</td>
    <td class="px-4 text-right"><button class="text-teal-700 hover:underline" onclick="window.__app.go('boq',{projectId:'${p.id}'})">查看</button></td>
  </tr>`;
}

function healthRadarPanel(stats) {
  const dataScore = clampPercent(stats.engine.qualityScore || 0);
  const expTotal = stats.experience.confirmedCards.length + stats.experience.pendingSessions.length + stats.experience.expiredCards.length;
  const expScore = expTotal ? Math.round(stats.experience.confirmedCards.length / expTotal * 100) : 0;
  return `<section class="card p-0 overflow-hidden min-h-[270px]">
    ${panelHeader('资料完整度', '三类需要持续确认的个人资料状态。')}
    <div class="p-4 space-y-5">
      ${healthProgressRow('报价完整度', stats.priceCompleteness, `${fmt(stats.priceCompleteness)}%`, `${fmt(stats.missingPriceCount)} 处缺价`, 'teal')}
      ${healthProgressRow('可用案例', dataScore, `${fmt(dataScore)}%`, `${fmt(stats.engine.facts.length)} 个可用案例`, dataScore >= 80 ? 'teal' : 'sky')}
      ${healthProgressRow('复盘笔记', expScore, `${fmt(expScore)}%`, `${fmt(stats.experience.confirmedCards.length)} / ${fmt(Math.max(1, expTotal))} 张已确认`, expScore >= 60 ? 'teal' : 'amber')}
    </div>
  </section>`;
}

function healthProgressRow(label, percent, value, note, tone = 'teal') {
  const color = tone === 'amber' ? 'bg-amber-500' : tone === 'sky' ? 'bg-sky-500' : 'bg-teal-600';
  return `<div>
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="font-medium text-slate-800">${label}</div>
      <div class="text-sm font-semibold tabular-nums text-slate-800">${value}</div>
    </div>
    <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
      <div class="h-2 rounded-full ${color}" style="width:${clampPercent(percent)}%"></div>
    </div>
    <div class="mt-1 text-xs text-slate-500">${note}</div>
  </div>`;
}

function experienceAssetCard(stats) {
  const exp = stats.experience;
  return `<section class="card p-4 overflow-hidden min-h-[165px]">
    <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-4 items-center">
      <div class="flex items-start gap-4 min-w-0">
        <div class="h-12 w-12 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[26px]">format_list_bulleted</span>
        </div>
        <div class="min-w-0 flex-1">
        <div class="font-semibold text-slate-900">复盘笔记</div>
          <div class="mt-1 text-xs text-slate-500">把这次报价的判断留给未来的自己。</div>
          <div class="mt-4 grid grid-cols-3 gap-3">
            ${assetMetric('经验卡', exp.confirmedCards.length, '张', '可检索复用', 'teal')}
            ${assetMetric('待确认', exp.pendingSessions.length, '个', '建议现在保存', exp.pendingSessions.length ? 'amber' : 'teal')}
            ${assetMetric('过期', exp.expiredCards.length, '张', '有效期内', exp.expiredCards.length ? 'amber' : 'slate')}
          </div>
        </div>
      </div>
      <div class="flex flex-col sm:flex-row lg:flex-col gap-2 lg:w-[150px]">
        <button onclick="window.__app.go('experience')" class="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm brand-bg text-white rounded">
          打开复盘笔记
        </button>
        <button onclick="window.__app.openAI && window.__app.openAI()" class="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded border border-slate-300 bg-white text-teal-700 hover:bg-slate-50">
          前往 AI 检索
        </button>
      </div>
    </div>
  </section>`;
}

function assetMetric(label, value, unit, note, tone = 'slate') {
  return `<div class="min-w-0 border-r last:border-r-0 border-slate-200 pr-3 last:pr-0">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-2xl font-semibold tabular-nums ${toneText(tone)}">${fmt(value)}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
    <div class="mt-1 text-xs text-slate-500 truncate">${note}</div>
  </div>`;
}

function recentVersionAssetCard(stats) {
  return `<section class="card p-0 overflow-hidden min-h-[165px]">
    <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
      <div>
        <div class="font-semibold text-slate-900">最近报价版本</div>
        <div class="mt-1 text-xs text-slate-500">关键调整后保留版本，便于复盘和回退。</div>
      </div>
      <button onclick="window.__app.go('boq')" class="text-sm text-teal-700 hover:underline">查看全部版本</button>
    </div>
    <div class="p-3 space-y-2">
      ${stats.recentVersions.length ? stats.recentVersions.slice(0, 3).map(v => versionAssetRow(v, stats.projects)).join('') : emptyBlock('保存报价版本后展示')}
    </div>
  </section>`;
}

function versionAssetRow(v, projects) {
  const p = projects.find(project => project.id === v.projectId);
  return `<button onclick="window.__app.go('boq',{projectId:'${v.projectId}'})" class="w-full flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50">
    <div class="min-w-0">
      <div class="font-medium text-slate-800 truncate">${esc(v.name || '报价版本')}</div>
      <div class="mt-1 text-xs text-slate-500 truncate">${esc(p?.name || '未知项目')}</div>
    </div>
    <div class="shrink-0 text-right">
      <div class="text-sm font-medium tabular-nums text-slate-800">${fmtMoney(v.totalCost || 0)}</div>
      <div class="mt-1 text-xs text-slate-500">${v.lineCount || 0} 条 · 缺价 ${v.missingPriceCount || 0}</div>
    </div>
  </button>`;
}

function miniStat(label, value, unit, tone = 'slate') {
  const cls = tone === 'amber' ? 'text-amber-700' : tone === 'teal' ? 'text-teal-700' : 'text-slate-900';
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-[11px] text-slate-500">${label}</div>
    <div class="mt-0.5 font-semibold tabular-nums ${cls}">${fmt(value)}<span class="ml-1 text-[11px] font-normal text-slate-500">${unit}</span></div>
  </div>`;
}

function panelHeader(title, desc, badge = '') {
  return `<div class="px-4 py-3 border-b border-slate-200 flex items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="font-semibold text-slate-800">${title}</div>
      <div class="mt-1 text-xs text-slate-500">${desc}</div>
    </div>
    ${badge ? `<span class="badge badge-gray shrink-0">${badge}</span>` : ''}
  </div>`;
}

function compositionSummary(stats) {
  const typeCounts = countBy(stats.projects, p => p.type || '未分类');
  const top = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  const topRatio = top && stats.projects.length ? Math.round(top[1] / stats.projects.length * 100) : 0;
  const sampleNote = topRatio >= 70 ? `${top[0]} 占 ${topRatio}%，样本偏集中` : top ? `${top[0]} 占比最高，为 ${topRatio}%` : '暂无类型样本';
  return `
    ${miniLine('项目总量', `${stats.projects.length} 个`, stats.projects.length ? 'teal' : 'slate')}
    ${miniLine('类型结构', sampleNote, topRatio >= 70 ? 'amber' : 'slate')}
    ${miniLine('平均造价', stats.projects.length ? fmtMoney(stats.totalCost / stats.projects.length) : '-', 'slate')}
    ${miniLine('案例收录率', stats.projects.length ? `${Math.round(stats.archived.length / stats.projects.length * 100)}%` : '-', stats.archived.length ? 'teal' : 'amber')}
  `;
}

function statusDistribution(stats) {
  const items = [
    { label: '报价中', value: stats.doing.length, tone: 'amber' },
    { label: '已收录案例', value: stats.archived.length, tone: 'teal' },
    { label: '未保存版本', value: stats.noVersionProjects.length, tone: stats.noVersionProjects.length ? 'amber' : 'slate' },
  ];
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="grid grid-cols-3 gap-2">
    ${items.map(i => `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <div class="flex items-center justify-between text-xs">
        <span class="text-slate-500">${i.label}</span>
        <span class="font-semibold tabular-nums text-slate-800">${i.value}</span>
      </div>
      <div class="mt-2 h-1.5 rounded bg-white overflow-hidden">
        <div class="h-1.5 rounded ${barTone(i.tone)}" style="width:${Math.max(4, Math.round(i.value / max * 100))}%"></div>
      </div>
    </div>`).join('')}
  </div>`;
}

function projectRow(p) {
  return `<tr class="border-b border-slate-100 hover:bg-slate-50">
    <td class="py-2.5 px-4 font-medium text-slate-800">${esc(p.name)}</td>
    <td class="px-3"><span class="badge badge-blue">${esc(p.type || '-')}</span></td>
    <td class="px-3">${statusBadge(p.status)}</td>
    <td class="px-3 text-right tabular-nums">${fmt(p.lineCount)}</td>
    <td class="px-3 text-right tabular-nums ${p.missingCount ? 'text-amber-700 font-semibold' : 'text-slate-600'}">${fmt(p.missingCount)}</td>
    <td class="px-3 text-right tabular-nums">${fmt(p.versionCount)}</td>
    <td class="px-3 text-right tabular-nums font-medium">${fmtMoney(p.totalCost || 0)}</td>
    <td class="px-4 text-right"><button class="text-teal-700 hover:underline" onclick="window.__app.go('boq',{projectId:'${p.id}'})">打开</button></td>
  </tr>`;
}

function riskItems(stats) {
  const projectName = id => stats.projects.find(p => p.id === id)?.name || '未知项目';
  const rows = [
    ...stats.missingBoq.map(b => ({ title: b.name || '未命名清单', desc: `${projectName(b.projectId)} · 项目清单缺少综合单价`, action: 'boq', projectId: b.projectId })),
    ...stats.missingQuota.map(q => ({ title: q.name || '未命名定额', desc: '定额库缺少综合单价', action: 'quota' })),
    ...stats.factorRisk.map(b => ({ title: b.name || '未命名清单', desc: `${projectName(b.projectId)} · 调整系数 ${fmt(b.factor || 1)}`, action: 'boq', projectId: b.projectId })),
  ].slice(0, 7);
  if (!rows.length) return `<div class="py-10 text-center text-slate-400">暂无待处理价格风险</div>`;
  return rows.map(r => `<button onclick="window.__app.go('${r.action}'${r.projectId ? `,{projectId:'${r.projectId}'}` : ''})" class="w-full text-left rounded border border-slate-200 bg-white px-3 py-2 hover:bg-slate-50">
    <div class="font-medium text-slate-800 truncate">${esc(r.title)}</div>
    <div class="mt-1 text-xs text-amber-700 truncate">${esc(r.desc)}</div>
  </button>`).join('');
}

function actionCard(action) {
  const params = action.projectId ? `,{projectId:'${action.projectId}'}` : '';
  return `<button onclick="window.__app.go('${action.view}'${params})" class="rounded border border-slate-200 bg-white p-3 text-left hover:bg-slate-50">
    <div class="flex items-start gap-3">
      <div class="h-8 w-8 rounded border ${toneClass(action.tone)} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[18px]">${action.icon}</span>
      </div>
      <div class="min-w-0">
        <div class="font-semibold text-slate-800 truncate">${esc(action.title)}</div>
        <div class="mt-1 text-xs leading-5 text-slate-500">${esc(action.desc)}</div>
      </div>
    </div>
  </button>`;
}

function emptyActionState() {
  return `<div class="lg:col-span-2 rounded border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">当前没有待处理事项，可以继续完善项目或记录复盘笔记。</div>`;
}

function healthGroup(title, rows) {
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="mb-2 font-medium text-slate-800">${title}</div>
    <div class="grid grid-cols-2 gap-2">
      ${rows.map(([label, value, unit, tone]) => `<div class="rounded bg-slate-50 px-2 py-2">
        <div class="text-[11px] text-slate-500">${label}</div>
        <div class="mt-1 flex items-baseline gap-1">
          <span class="font-semibold tabular-nums ${toneText(tone)}">${fmt(value)}</span>
          <span class="text-[11px] text-slate-500">${unit}</span>
        </div>
      </div>`).join('')}
    </div>
  </div>`;
}

function categoryBreakdown(boq) {
  const groups = {};
  boq.forEach(b => {
    const cat = b.majorCategory || b.category || categoryGuess(b.name);
    groups[cat] = (groups[cat] || 0) + Number(b.amount || 0);
  });
  return Object.entries(groups).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
}

function categoryBar(item, max) {
  const width = Math.max(4, Math.round((item.amount / max) * 100));
  return `<div>
    <div class="mb-1 flex items-center justify-between gap-2 text-xs">
      <span class="font-medium text-slate-700 truncate">${esc(item.name)}</span>
      <span class="tabular-nums text-slate-500 shrink-0">${fmtMoney(item.amount)}</span>
    </div>
    <div class="h-2 rounded bg-slate-100"><div class="h-2 rounded bg-teal-600" style="width:${width}%"></div></div>
  </div>`;
}

function versionItem(v, projects) {
  const p = projects.find(project => project.id === v.projectId);
  return `<button onclick="window.__app.go('boq',{projectId:'${v.projectId}'})" class="w-full rounded border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50">
    <div class="flex items-center justify-between gap-2">
      <div class="truncate font-medium text-slate-800">${esc(v.name || '报价版本')}</div>
      <div class="tabular-nums text-xs text-slate-500">${fmtMoney(v.totalCost || 0)}</div>
    </div>
    <div class="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
      <span class="truncate">${esc(p?.name || '未知项目')}</span>
      <span>${v.lineCount || 0} 条 · 缺价 ${v.missingPriceCount || 0}</span>
    </div>
  </button>`;
}

function miniLine(label, value, tone = 'slate') {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-sm font-medium ${toneText(tone)}">${esc(value)}</div>
  </div>`;
}

function emptyBlock(text) {
  return `<div class="h-full min-h-[120px] flex items-center justify-center text-sm text-slate-400">${text}</div>`;
}

function drawCharts(stats, workspace = document) {
  if (stats.archivedTrend?.hasAnyInWindow) {
    const trendCanvas = workspace.querySelector('#costChart');
    if (!trendCanvas) {
      if (chartState.trend) {
        chartState.trend.destroy();
        chartState.trend = null;
      }
    } else {
      const labels = stats.archivedTrend.labels;
      const costData = stats.archivedTrend.costs;
      const countData = stats.archivedTrend.projects;
      const avgData = stats.archivedTrend.avgLine;
      if (chartState.trend) chartState.trend.destroy();
      chartState.trend = new Chart(trendCanvas, {
        data: {
          labels: labels,
          datasets: [
            {
              type: 'bar',
              label: '案例造价',
              data: costData,
              backgroundColor: 'rgba(15, 118, 110, .86)',
              hoverBackgroundColor: '#0f766e',
              borderColor: '#0f766e',
              borderWidth: 1,
              borderRadius: { topLeft: 6, topRight: 6 },
              borderSkipped: false,
              categoryPercentage: 0.58,
              barPercentage: 0.72,
              maxBarThickness: 38,
              yAxisID: 'y',
            },
            {
              type: 'line',
              label: '项目数',
              data: countData,
              borderColor: '#0284c7',
              backgroundColor: '#0284c7',
              tension: 0.34,
              pointRadius: countData.filter(Boolean).length <= 1 ? 3.5 : 2.5,
              pointHoverRadius: 5,
              borderWidth: 2,
              yAxisID: 'y1',
            },
            {
              type: 'line',
              label: '平均造价',
              data: avgData,
              borderColor: '#f59e0b',
              backgroundColor: '#f59e0b',
              borderDash: [5, 5],
              tension: 0.3,
              pointRadius: avgData.filter(v => v != null).length <= 1 ? 3 : 2,
              pointHoverRadius: 5,
              borderWidth: 2,
              spanGaps: true,
              yAxisID: 'y',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          layout: { padding: { top: 4, right: 8, bottom: 0, left: 0 } },
          plugins: {
            legend: {
              display: false,
            },
            tooltip: {
              backgroundColor: '#0f172a',
              borderColor: 'rgba(148, 163, 184, .25)',
              borderWidth: 1,
              padding: 10,
              callbacks: {
                label: ctx => {
                  const label = ctx.dataset.label || '';
                  const value = Number(ctx.raw || 0);
                  if (label === '项目数') return `${label}: ${value} 个`;
                  return `${label}: ${fmtMoney(value)}`;
                },
              },
            },
          },
          scales: {
            x: { grid: { color: 'transparent' }, ticks: { color: '#64748b', maxRotation: 0, font: { size: 11 } } },
            y: {
              beginAtZero: true,
              suggestedMax: stats.archivedTrend.suggestedCostMax,
              ticks: { callback: v => compactMoney(v), maxTicksLimit: 5, color: '#64748b', font: { size: 11 } },
              grid: { color: '#e2e8f0' },
              border: { display: false },
            },
            y1: {
              position: 'right',
              beginAtZero: true,
              suggestedMax: stats.archivedTrend.suggestedProjectMax,
              grid: { drawOnChartArea: false },
              ticks: { precision: 0, stepSize: 1, maxTicksLimit: 4, color: '#64748b', font: { size: 11 } },
              border: { display: false },
            },
          },
        },
      });
    }
  } else if (chartState.trend) {
    chartState.trend.destroy();
    chartState.trend = null;
  }
  

  if (stats.projects.length) {
    const typeCanvas = workspace.querySelector('#typeChart');
    if (!typeCanvas) {
      if (chartState.composition) {
        chartState.composition.destroy();
        chartState.composition = null;
      }
    } else {
      if (chartState.composition) chartState.composition.destroy();
      const typeCount = countBy(stats.projects, p => p.type || '未分类');
      chartState.composition = new Chart(typeCanvas, {
        type: 'doughnut',
        data: {
          labels: Object.keys(typeCount),
          datasets: [{ data: Object.values(typeCount), backgroundColor: ['#0f766e', '#0ea5e9', '#f59e0b', '#64748b', '#10b981', '#ef4444'], borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '62%' },
      });
    }
  } else if (chartState.composition) {
    chartState.composition.destroy();
    chartState.composition = null;
  }
}

function countBy(items, pick) {
  return items.reduce((acc, item) => {
    const key = pick(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildMonthlyTrend(archived, monthWindow = 6) {
  if (!archived.length) {
    return {
      points: [],
      labels: [],
      costs: [],
      projects: [],
      avgs: [],
      avgLine: [],
      totalCost: 0,
      totalProjects: 0,
      avgCost: 0,
      avgProjects: 0,
      activeMonths: 0,
      activeAvgCost: 0,
      avgProjectCost: 0,
      latestPoint: null,
      peakPoint: null,
      suggestedCostMax: 1,
      suggestedProjectMax: 3,
      hasAnyInWindow: false,
      windowText: '近 6 个月',
      projectGrowth: null,
      projectGrowthText: '-',
      costGrowth: null,
      costGrowthText: '-',
    };
  }
  const latest = archived.reduce((m, p) => {
    const raw = p.archivedAt || p.updatedAt || p.createdAt;
    const ts = raw ? new Date(raw).getTime() : 0;
    return ts && Number.isFinite(ts) ? Math.max(m, ts) : m;
  }, 0);
  const now = new Date(latest || Date.now());
  const months = [];
  for (let i = monthWindow - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = dateKey(d.toISOString());
    const year = String(d.getFullYear()).slice(2);
    months.push({
      key,
      label: monthWindow > 12 ? `${year}-${padMonth(d.getMonth() + 1)}` : `${d.getMonth() + 1}月`,
      cost: 0,
      count: 0,
    });
  }
  const monthMap = new Map(months.map(m => [m.key, m]));
  archived.forEach(p => {
    const key = dateKey(p.archivedAt || p.updatedAt || p.createdAt);
    if (!key || !monthMap.has(key)) return;
    const slot = monthMap.get(key);
    if (!slot) return;
    slot.cost += Number(p.totalCost || 0);
    slot.count += 1;
  });
  const filled = months.map(m => ({ ...m, avg: m.count ? m.cost / m.count : 0 }));
  const active = filled.filter(v => v.count > 0 || v.cost > 0);
  const totalCost = filled.reduce((s, v) => s + v.cost, 0);
  const totalProjects = filled.reduce((s, v) => s + v.count, 0);
  const avgCost = filled.length ? totalCost / monthWindow : 0;
  const avgProjects = filled.length ? totalProjects / filled.length : 0;
  const activeAvgCost = active.length ? totalCost / active.length : 0;
  const avgProjectCost = totalProjects ? totalCost / totalProjects : 0;
  const prevProjectCount = filled.length > 1 ? filled[filled.length - 2].count : 0;
  const lastProjectCount = filled.length > 0 ? filled[filled.length - 1].count : 0;
  const prevCost = filled.length > 1 ? filled[filled.length - 2].cost : 0;
  const lastCost = filled.length > 0 ? filled[filled.length - 1].cost : 0;
  const projectGrowth = calcGrowthRate(lastProjectCount, prevProjectCount);
  const costGrowth = calcGrowthRate(lastCost, prevCost);
  const peakPoint = active.slice().sort((a, b) => b.cost - a.cost)[0] || null;
  const latestPoint = filled[filled.length - 1] || null;
  const maxCost = Math.max(...filled.map(v => v.cost), ...filled.map(v => v.avg), 1);
  const maxProjects = Math.max(...filled.map(v => v.count), 1);
  return {
    points: filled,
    labels: filled.map(v => v.label),
    costs: filled.map(v => v.cost),
    projects: filled.map(v => v.count),
    avgs: filled.map(v => v.avg),
    avgLine: filled.map(v => v.count ? v.avg : null),
    totalCost,
    totalProjects,
    avgCost,
    avgProjects,
    activeMonths: active.length,
    activeAvgCost,
    avgProjectCost,
    latestPoint,
    peakPoint,
    suggestedCostMax: maxCost * 1.18,
    suggestedProjectMax: Math.max(3, maxProjects + 1),
    hasAnyInWindow: totalProjects > 0,
    windowText: '近 6 个月',
    projectGrowth,
    projectGrowthText: projectGrowth === null ? '-' : `${projectGrowth > 0 ? '+' : ''}${projectGrowth.toFixed(1)}%`,
    costGrowth,
    costGrowthText: costGrowth === null ? '-' : `${costGrowth > 0 ? '+' : ''}${costGrowth.toFixed(1)}%`,
  };
}

function padMonth(m) {
  return String(m).padStart(2, '0');
}

function calcGrowthRate(current, previous) {
  if (!previous) {
    if (!current) return 0;
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function trendSidePanel(trend) {
  if (!trend.hasAnyInWindow) {
    return `<div class="border-t lg:border-t-0 lg:border-l border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-400 flex items-center justify-center">等待收录案例形成趋势</div>`;
  }
  const latest = trend.latestPoint || {};
  const peak = trend.peakPoint || latest;
  return `<div class="border-t lg:border-t-0 lg:border-l border-slate-200 bg-slate-50/70 p-3">
    <div class="text-xs font-semibold text-slate-700">趋势解读</div>
    <div class="mt-3 divide-y divide-slate-200">
      ${trendInsightRow('最新收录月', latest.label || '-', `${compactMoney(latest.cost || 0)} · ${fmt(latest.count || 0)} 个`, 'teal')}
      ${trendInsightRow('峰值月份', peak.label || '-', `${compactMoney(peak.cost || 0)} · ${fmt(peak.count || 0)} 个`, 'slate')}
      ${trendInsightRow('造价环比', trend.costGrowthText, trend.costGrowth === null ? '上月无案例' : '较上一月', trend.costGrowth > 0 ? 'amber' : 'teal')}
      ${trendInsightRow('样本密度', `${trend.activeMonths}/6 月`, trend.activeMonths <= 1 ? '样本偏少' : '可观察趋势', trend.activeMonths <= 1 ? 'amber' : 'teal')}
    </div>
  </div>`;
}

function trendInsightRow(label, value, note, tone = 'slate') {
  return `<div class="py-2 first:pt-0 last:pb-0">
    <div class="text-[11px] text-slate-500">${label}</div>
    <div class="mt-1 font-semibold tabular-nums ${toneText(tone)}">${esc(String(value))}</div>
    <div class="mt-0.5 text-[11px] text-slate-500">${esc(String(note || ''))}</div>
  </div>`;
}

function trendMetric(label, value, note = '') {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2 min-w-0">
    <div class="text-xs text-slate-500 truncate">${label}</div>
    <div class="mt-0.5 font-semibold text-slate-800 tabular-nums truncate">${value}</div>
    <div class="text-[11px] text-slate-500 mt-1 truncate">${note}</div>
  </div>`;
}

function compactMoney(value) {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  if (abs >= 100000000) return `¥${trimNumber(n / 100000000)}亿`;
  if (abs >= 10000) return `¥${trimNumber(n / 10000)}万`;
  return fmtMoney(n);
}

function trimNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1 });
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value || 0))));
}

function dateKey(value) {
  return value ? String(value).slice(0, 7) : '';
}

function toneClass(tone) {
  return tone === 'amber' ? 'text-amber-700 bg-amber-50 border-amber-200'
    : tone === 'teal' ? 'text-teal-700 bg-teal-50 border-teal-200'
    : 'text-slate-700 bg-slate-50 border-slate-200';
}

function toneText(tone) {
  return tone === 'amber' ? 'text-amber-700'
    : tone === 'teal' ? 'text-teal-700'
    : 'text-slate-800';
}

function barTone(tone) {
  return tone === 'amber' ? 'bg-amber-500'
    : tone === 'teal' ? 'bg-teal-600'
    : 'bg-slate-400';
}

function statusBadge(s) {
  return s === 'archived' ? '<span class="badge badge-green">已收录案例</span>'
       : s === 'doing'    ? '<span class="badge badge-yellow">进行中</span>'
       : '<span class="badge badge-gray">未开始</span>';
}
