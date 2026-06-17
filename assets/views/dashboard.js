// 视图：仪表盘
import { quotaRepo, projectRepo, boqRepo, versionRepo } from '../data/repository.js?v=3.9';
import { dataEngineService } from '../services/dataEngineService.js?v=3.9';
import { experienceService } from '../services/experienceService.js?v=3.9';
import { fmt, fmtMoney, esc } from '../utils/dom.js';
import { hasMissingPrice } from '../utils/costing.js?v=3.9';
import { categoryGuess } from '../utils/stats.js';

const chartState = {
  trend: null,
  composition: null,
};

export async function render() {
  const [quota, projects, boq, versions, engine, experience] = await Promise.all([
    quotaRepo.all(),
    projectRepo.all(),
    boqRepo.all(),
    versionRepo.all(),
    dataEngineService.dashboard(),
    experienceService.dashboard(),
  ]);
  const stats = buildDashboardStats({ quota, projects, boq, versions, engine, experience });

  document.getElementById('workspace').innerHTML = `
    <div class="min-h-full flex flex-col gap-3">
      <section class="grid grid-cols-2 xl:grid-cols-6 gap-3">
        ${metricCard('累计造价', fmtMoney(stats.totalCost), '', `归档 ${fmtMoney(stats.archivedCost)}`, 'payments', 'teal')}
        ${metricCard('归档造价', fmtMoney(stats.archivedCost), '', `${stats.archived.length} 个归档项目`, 'inventory_2')}
        ${metricCard('本月项目', stats.monthProjects.length, '个', `本月归档 ${stats.monthArchived.length} 个`, 'calendar_month')}
        ${metricCard('报价中', stats.doing.length, '个', `${stats.archived.length} 个已归档`, 'pending_actions')}
        ${metricCard('未保存版本', stats.noVersionProjects.length, '个', '有清单但无报价快照', 'history', stats.noVersionProjects.length ? 'amber' : 'teal')}
        ${metricCard('健康风险', stats.riskTotal, '处', `完整度 ${stats.priceCompleteness}%`, 'health_and_safety', stats.riskTotal ? 'amber' : 'teal')}
      </section>

      ${experienceCommandCenter(stats)}

      <section class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-3 flex-1 min-h-0">
        <div class="min-w-0 flex flex-col gap-3">
          <div class="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_360px] gap-3">
            <section class="card p-0 overflow-hidden min-h-[300px] flex flex-col">
              ${panelHeader('经营与报价趋势', '按归档月份查看造价、项目数和平均单项目造价。', stats.archivedTrend.windowText)}
              <div class="p-3 border-b border-slate-200 grid grid-cols-2 md:grid-cols-4 gap-2">
                ${trendMetric('近 6 月归档造价', compactMoney(stats.archivedTrend.totalCost), `${stats.archivedTrend.activeMonths} 个活跃月份`)}
                ${trendMetric('归档项目数', stats.archivedTrend.totalProjects, '个')}
                ${trendMetric('活跃月均造价', compactMoney(stats.archivedTrend.activeAvgCost), `环比 ${stats.archivedTrend.costGrowthText}`)}
                ${trendMetric('单项目均价', compactMoney(stats.archivedTrend.avgProjectCost), `${stats.archivedTrend.totalProjects || 0} 个样本`)}
              </div>
                <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_220px] flex-1 min-h-0">
                  <div class="p-4 h-full min-h-0 flex items-stretch">
                  ${stats.archivedTrend.hasAnyInWindow ? '<canvas id="costChart" class="w-full h-full"></canvas>' : emptyBlock('近 6 个月无归档项目，新增归档后自动展示')}
                  </div>
                ${trendSidePanel(stats.archivedTrend)}
              </div>
            </section>

            <section class="card p-0 overflow-hidden min-h-[300px]">
              ${panelHeader('项目组合', '类型、状态和样本结构，帮助判断业务是否偏科。')}
              <div class="grid grid-cols-[160px_minmax(0,1fr)] gap-3 p-4">
                <div class="h-[156px]">${stats.projects.length ? '<canvas id="typeChart"></canvas>' : emptyBlock('暂无项目')}</div>
                <div class="space-y-3 min-w-0">
                  ${compositionSummary(stats)}
                </div>
              </div>
              <div class="px-4 pb-4">
                ${statusDistribution(stats)}
              </div>
            </section>
          </div>

          <div class="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_360px] gap-3">
            <section class="card p-0 overflow-hidden min-h-[260px] flex flex-col">
              <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <div class="font-semibold text-slate-800">管理动作</div>
                  <div class="mt-1 text-xs text-slate-500">风险、版本、样本和经验沉淀的下一步。</div>
                </div>
                <span class="badge ${stats.nextActions.length ? 'badge-yellow' : 'badge-green'}">${stats.nextActions.length || '完成'}</span>
              </div>
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-2 p-3">
                ${stats.nextActions.length ? stats.nextActions.slice(0, 6).map(actionCard).join('') : emptyActionState()}
              </div>
            </section>

            <section class="card p-0 overflow-hidden min-h-[260px] flex flex-col">
              ${panelHeader('TOP 分类造价', '按清单名称推断分类，辅助判断成本集中度。')}
              <div class="p-3 space-y-3 overflow-auto scroll-thin flex-1 min-h-0">
                ${stats.categoryCost.length ? stats.categoryCost.slice(0, 7).map(c => categoryBar(c, stats.categoryCost[0].amount || 1)).join('') : emptyBlock('添加清单后展示分类造价')}
              </div>
            </section>
          </div>

          <section class="card p-0 overflow-hidden min-h-[220px]">
            <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div>
                <div class="font-semibold text-slate-800">项目经营明细</div>
                <div class="mt-1 text-xs text-slate-500">最近项目、造价和报价快照状态。</div>
              </div>
              <button onclick="window.__app.go('projects')" class="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">项目管理</button>
            </div>
            <div class="overflow-auto scroll-thin">
              <table class="w-full text-sm">
                <thead class="bg-slate-50 sticky top-0"><tr class="text-left text-slate-500 border-b border-slate-200">
                  <th class="py-2 px-4">项目名称</th>
                  <th class="px-3">类型</th>
                  <th class="px-3">状态</th>
                  <th class="px-3 text-right">清单</th>
                  <th class="px-3 text-right">缺价</th>
                  <th class="px-3 text-right">版本</th>
                  <th class="px-3 text-right">总造价</th>
                  <th class="px-4 text-right">操作</th>
                </tr></thead>
                <tbody>
                  ${stats.projectRows.length ? stats.projectRows.slice(0, 6).map(projectRow).join('') : `<tr><td colspan="8" class="py-10 text-center text-slate-400">还没有项目，先去 <button class="text-teal-700 underline" onclick="window.__app.go('projects')">新建项目</button></td></tr>`}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside class="min-w-0 flex flex-col gap-3">
          <section class="card p-0 overflow-hidden">
            ${panelHeader('经营健康雷达', '负责人每天需要确认的三类健康度。')}
            <div class="p-3 space-y-3">
              ${healthGroup('报价完整度', [
                ['缺单价', stats.missingPriceCount, '处', stats.missingPriceCount ? 'amber' : 'teal'],
                ['0 工程量', stats.zeroQty.length, '条', stats.zeroQty.length ? 'amber' : 'teal'],
                ['系数异常', stats.factorRisk.length, '条', stats.factorRisk.length ? 'amber' : 'teal'],
                ['未匹配定额', stats.unmatchedQuota.length, '条', stats.unmatchedQuota.length ? 'amber' : 'teal'],
              ])}
              ${healthGroup('数据资产健康', [
                ['正式事实', engine.facts.length, '条', 'teal'],
                ['候选样本', engine.candidates.length, '条', engine.candidates.length ? 'amber' : 'slate'],
                ['低可信报告', engine.lowQuality, '份', engine.lowQuality ? 'amber' : 'teal'],
                ['指标健康分', engine.qualityScore || 0, '分', (engine.qualityScore || 0) >= 80 ? 'teal' : 'amber'],
              ])}
              ${healthGroup('经验资产', [
                ['经验卡', experience.confirmedCards.length, '张', 'teal'],
                ['待确认复盘', experience.pendingSessions.length, '个', experience.pendingSessions.length ? 'amber' : 'teal'],
                ['过期经验', experience.expiredCards.length, '张', experience.expiredCards.length ? 'amber' : 'teal'],
              ])}
            </div>
          </section>

          <section class="card p-0 overflow-hidden flex flex-col min-h-[260px]">
            <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div>
                <div class="font-semibold text-slate-800">待处理风险</div>
                <div class="mt-1 text-xs text-slate-500">优先补齐综合单价，再保存版本或导出报价。</div>
              </div>
              <span class="badge ${stats.riskTotal ? 'badge-yellow' : 'badge-green'}">${stats.priceRiskRate}%</span>
            </div>
            <div class="p-3 space-y-2 flex-1 min-h-0 overflow-auto scroll-thin">
              ${riskItems(stats)}
            </div>
          </section>

          <section class="card p-0 overflow-hidden">
            ${panelHeader('最近报价版本', '关键调整后保留版本，便于复盘和回退。')}
            <div class="p-3 space-y-2 max-h-[190px] overflow-auto scroll-thin">
              ${stats.recentVersions.length ? stats.recentVersions.map(v => versionItem(v, projects)).join('') : emptyBlock('保存报价版本后展示')}
            </div>
          </section>
        </aside>
      </section>
    </div>
  `;

  drawCharts(stats);
}

function buildDashboardStats({ quota, projects, boq, versions, engine, experience }) {
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
  };
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
      title: '归档样本',
      desc: backfillNeeded ? `${backfillNeeded} 个归档项目待接入指标样本` : `${projects.filter(p => p.status !== 'archived').length} 个项目仍在报价中`,
      view: 'projects',
      icon: 'inventory_2',
      tone: 'slate',
    });
  }
  if (experience.pendingSessions.length) {
    actions.push({
      title: '确认复盘经验',
      desc: `${experience.pendingSessions.length} 个复盘草稿待确认入库`,
      view: 'experience',
      icon: 'psychology_alt',
      tone: 'amber',
    });
  } else if (archived.length && !experience.confirmedCards.length) {
    actions.push({
      title: '沉淀报价经验',
      desc: '已有归档样本，建议沉淀第一张经验卡',
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

function metricCard(label, value, unit, note, icon, tone = 'slate') {
  const toneCls = toneClass(tone);
  return `<div class="card p-3">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="text-xs text-slate-500 truncate">${label}</div>
        <div class="mt-1 text-xl font-semibold tabular-nums text-slate-900 truncate">${value}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
      </div>
      <div class="h-8 w-8 rounded border ${toneCls} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[18px]">${icon}</span>
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
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_520px]">
        <div class="p-4 flex items-start gap-3 min-w-0">
          <div class="h-11 w-11 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[24px]">psychology_alt</span>
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <div class="font-semibold text-slate-900">AI 经验萃取智能体</div>
              <span class="badge ${tone === 'amber' ? 'badge-yellow' : 'badge-green'}">${healthText}</span>
            </div>
            <div class="mt-1 text-sm leading-6 text-slate-600">从报价审查、版本调整、项目归档里生成 AI 追问，把判断沉淀为带证据链、适用边界和复核状态的知识卡。</div>
            <div class="mt-3 flex flex-wrap gap-2">
              ${experiencePill('AI 追问', '按项目上下文生成', 'psychology_alt', 'teal')}
              ${experiencePill('用户确认', '草稿确认后入库', pending ? 'pending_actions' : 'task_alt', pending ? 'amber' : 'teal')}
              ${experiencePill('知识引用', '进入 AI 查询上下文', 'link', confirmed ? 'teal' : 'slate')}
            </div>
          </div>
        </div>

        <div class="border-t xl:border-t-0 xl:border-l border-slate-200 bg-slate-50/70 p-3">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${experienceMetric('经验卡', confirmed, '张', '可检索复用', 'teal')}
            ${experienceMetric('待确认', pending, '个', pending ? '建议现在入库' : '无积压', pending ? 'amber' : 'teal')}
            ${experienceMetric('需复核', review, '张', review ? '需要维护' : '状态健康', review ? 'amber' : 'teal')}
            ${experienceMetric('过期', expired, '张', expired ? '需更新边界' : '有效', expired ? 'amber' : 'teal')}
          </div>
          <div class="mt-3 flex items-center justify-between gap-2">
            <button onclick="window.__app.go('experience')" class="inline-flex items-center gap-1.5 px-3 py-2 text-sm brand-bg text-white rounded">
              <span class="material-symbols-outlined text-[18px]">database_search</span>
              打开知识库
            </button>
            <button onclick="window.__app.go('experience')" class="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">
              <span class="material-symbols-outlined text-[18px]">${pending ? 'fact_check' : 'add_task'}</span>
              ${pending ? '确认入库' : '发起复盘'}
            </button>
          </div>
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
    ${miniLine('归档占比', stats.projects.length ? `${Math.round(stats.archived.length / stats.projects.length * 100)}%` : '-', stats.archived.length ? 'teal' : 'amber')}
  `;
}

function statusDistribution(stats) {
  const items = [
    { label: '报价中', value: stats.doing.length, tone: 'amber' },
    { label: '已归档', value: stats.archived.length, tone: 'teal' },
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
  return `<div class="lg:col-span-2 rounded border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">当前暂无紧急动作，可以继续归档样本或沉淀报价经验。</div>`;
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

function drawCharts(stats) {
  if (stats.archivedTrend?.hasAnyInWindow) {
    const trendCanvas = document.getElementById('costChart');
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
              label: '归档造价',
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
          layout: { padding: { top: 6, right: 8, bottom: 0, left: 0 } },
          plugins: {
            legend: {
              position: 'bottom',
              labels: { boxWidth: 8, usePointStyle: true, padding: 14, color: '#64748b', font: { size: 11 } },
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
    const typeCanvas = document.getElementById('typeChart');
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
    return `<div class="border-t lg:border-t-0 lg:border-l border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-400 flex items-center justify-center">等待归档数据形成趋势</div>`;
  }
  const latest = trend.latestPoint || {};
  const peak = trend.peakPoint || latest;
  return `<div class="border-t lg:border-t-0 lg:border-l border-slate-200 bg-slate-50/70 p-3">
    <div class="text-xs font-semibold text-slate-700">趋势解读</div>
    <div class="mt-3 divide-y divide-slate-200">
      ${trendInsightRow('最新归档月', latest.label || '-', `${compactMoney(latest.cost || 0)} · ${fmt(latest.count || 0)} 个`, 'teal')}
      ${trendInsightRow('峰值月份', peak.label || '-', `${compactMoney(peak.cost || 0)} · ${fmt(peak.count || 0)} 个`, 'slate')}
      ${trendInsightRow('造价环比', trend.costGrowthText, trend.costGrowth === null ? '上月无归档' : '较上一月', trend.costGrowth > 0 ? 'amber' : 'teal')}
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
  return s === 'archived' ? '<span class="badge badge-green">已归档</span>'
       : s === 'doing'    ? '<span class="badge badge-yellow">进行中</span>'
       : '<span class="badge badge-gray">未开始</span>';
}
