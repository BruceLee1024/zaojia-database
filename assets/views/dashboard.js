// 视图：仪表盘
import { quotaRepo, projectRepo, boqRepo } from '../data/repository.js?v=2.8';
import { fmt, fmtMoney, esc } from '../utils/dom.js';
import { hasMissingPrice } from '../utils/costing.js?v=2.8';
import { categoryGuess } from '../utils/stats.js';

export async function render() {
  const [quota, projects, boq] = await Promise.all([quotaRepo.all(), projectRepo.all(), boqRepo.all()]);
  const archived = projects.filter(p => p.status === 'archived');
  const doing = projects.filter(p => p.status !== 'archived');
  const totalCost = projects.reduce((s, p) => s + Number(p.totalCost || 0), 0);
  const archivedCost = archived.reduce((s, p) => s + Number(p.totalCost || 0), 0);
  const missingQuota = quota.filter(q => hasMissingPrice(q.priceTotal));
  const missingBoq = boq.filter(b => hasMissingPrice(b.unitPrice));
  const missingPriceCount = missingQuota.length + missingBoq.length;
  const categoryCost = categoryBreakdown(boq);
  const recentProjects = projects.slice(-6).reverse();
  const recentRiskLines = missingBoq.slice(0, 5);

  document.getElementById('workspace').innerHTML = `
    <div class="h-full min-h-0 flex flex-col gap-3">
      <section class="grid grid-cols-4 gap-3">
        ${metricCard('项目总数', projects.length, '个', `${archived.length} 个已归档，${doing.length} 个进行中`, 'folder_managed')}
        ${metricCard('累计造价', fmtMoney(totalCost), '', `归档项目 ${fmtMoney(archivedCost)}`, 'payments')}
        ${metricCard('清单条目', boq.length, '条', `${quota.length} 条定额可选`, 'list_alt')}
        ${metricCard('缺单价风险', missingPriceCount, '处', missingPriceCount ? '需优先处理，避免报价漏算' : '暂无缺价风险', 'warning', missingPriceCount ? 'amber' : 'teal')}
      </section>

      <section class="grid grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] gap-3 min-h-[300px]">
        <div class="card p-0 overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div>
              <div class="font-semibold text-slate-800">经营与报价趋势</div>
              <div class="text-xs text-slate-500 mt-1">按归档月份汇总项目造价，辅助判断近期报价规模。</div>
            </div>
            <span class="badge badge-gray">仅归档项目</span>
          </div>
          <div class="p-4 h-[250px]">
            ${archived.length ? '<canvas id="costChart"></canvas>' : emptyBlock('归档项目后展示造价趋势')}
          </div>
        </div>

        <div class="card p-0 overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200">
            <div class="font-semibold text-slate-800">项目类型分布</div>
            <div class="text-xs text-slate-500 mt-1">用于快速识别当前样本结构。</div>
          </div>
          <div class="p-4 h-[250px]">
            ${projects.length ? '<canvas id="typeChart"></canvas>' : emptyBlock('新建项目后展示类型分布')}
          </div>
        </div>
      </section>

      <section class="grid grid-cols-[minmax(0,1fr)_380px] gap-3 flex-1 min-h-0">
        <div class="card p-0 overflow-hidden flex flex-col min-h-0">
          <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div>
              <div class="font-semibold text-slate-800">最近项目</div>
              <div class="text-xs text-slate-500 mt-1">从这里快速进入清单、归档后的项目会参与指标分析。</div>
            </div>
            <button onclick="window.__app.go('projects')" class="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">项目管理</button>
          </div>
          <div class="overflow-auto scroll-thin flex-1 min-h-0">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 sticky top-0"><tr class="text-left text-slate-500 border-b border-slate-200">
                <th class="py-2 px-4">项目名称</th>
                <th class="px-3">类型</th>
                <th class="px-3">规模</th>
                <th class="px-3">状态</th>
                <th class="px-3 text-right">总造价</th>
                <th class="px-4 text-right">操作</th>
              </tr></thead>
              <tbody>
                ${recentProjects.map(p => projectRow(p)).join('') || `<tr><td colspan="6" class="py-10 text-center text-slate-400">还没有项目，先去 <a class="text-teal-700 underline" onclick="window.__app.go('projects')">新建项目</a></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <div class="flex flex-col gap-3 min-h-0">
          <div class="card p-0 overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-200">
              <div class="font-semibold text-slate-800">待处理风险</div>
              <div class="text-xs text-slate-500 mt-1">优先补齐综合单价，再保存版本或导出报价。</div>
            </div>
            <div class="p-3 space-y-2 max-h-[210px] overflow-auto scroll-thin">
              ${riskItems(recentRiskLines, missingQuota)}
            </div>
          </div>

          <div class="card p-0 overflow-hidden flex-1 min-h-0">
            <div class="px-4 py-3 border-b border-slate-200">
              <div class="font-semibold text-slate-800">分类造价</div>
              <div class="text-xs text-slate-500 mt-1">按清单名称推断分类，后续可升级为显式专业分类。</div>
            </div>
            <div class="p-3 space-y-3 overflow-auto scroll-thin">
              ${categoryCost.length ? categoryCost.slice(0, 6).map(c => categoryBar(c, categoryCost[0].amount || 1)).join('') : emptyBlock('添加清单后展示分类造价')}
            </div>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-4 gap-3">
        ${quickAction('导入定额', '维护综合单价库', 'quota', 'menu_book')}
        ${quickAction('新建项目', '建立项目档案', 'projects', 'add_box')}
        ${quickAction('编制清单', '进入报价工作台', 'boq', 'receipt_long')}
        ${quickAction('指标对标', '查看可信度和偏差', 'indicators', 'analytics')}
      </section>
    </div>
  `;

  drawCharts(archived, projects);
}

function metricCard(label, value, unit, note, icon, tone = 'slate') {
  const toneCls = tone === 'amber' ? 'text-amber-700 bg-amber-50 border-amber-200' : tone === 'teal' ? 'text-teal-700 bg-teal-50 border-teal-200' : 'text-slate-700 bg-slate-50 border-slate-200';
  return `<div class="card p-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <div class="text-xs text-slate-500">${label}</div>
        <div class="mt-2 text-2xl font-semibold tabular-nums text-slate-900">${value}<span class="ml-1 text-sm font-normal text-slate-500">${unit}</span></div>
      </div>
      <div class="h-9 w-9 rounded border ${toneCls} flex items-center justify-center">
        <span class="material-symbols-outlined text-[20px]">${icon}</span>
      </div>
    </div>
    <div class="mt-2 text-xs text-slate-500 truncate">${note}</div>
  </div>`;
}

function projectRow(p) {
  return `<tr class="border-b border-slate-100 hover:bg-slate-50">
    <td class="py-2 px-4 font-medium text-slate-800">${esc(p.name)}</td>
    <td class="px-3"><span class="badge badge-blue">${esc(p.type || '-')}</span></td>
    <td class="px-3 text-slate-600">${esc(p.scale || '-')}</td>
    <td class="px-3">${statusBadge(p.status)}</td>
    <td class="px-3 text-right tabular-nums font-medium">${fmtMoney(p.totalCost || 0)}</td>
    <td class="px-4 text-right"><button class="text-teal-700 hover:underline" onclick="window.__app.go('boq',{projectId:'${p.id}'})">打开 →</button></td>
  </tr>`;
}

function riskItems(missingBoq, missingQuota) {
  const rows = [
    ...missingBoq.map(b => ({ title: b.name || '未命名清单', desc: '项目清单缺少综合单价', action: 'boq' })),
    ...missingQuota.slice(0, Math.max(0, 5 - missingBoq.length)).map(q => ({ title: q.name || '未命名定额', desc: '定额库缺少综合单价', action: 'quota' })),
  ].slice(0, 5);
  if (!rows.length) return `<div class="py-8 text-center text-slate-400">暂无待处理价格风险</div>`;
  return rows.map(r => `<button onclick="window.__app.go('${r.action}')" class="w-full text-left rounded border border-slate-200 bg-white px-3 py-2 hover:bg-slate-50">
    <div class="font-medium text-slate-800 truncate">${esc(r.title)}</div>
    <div class="mt-1 text-xs text-amber-700">${esc(r.desc)}</div>
  </button>`).join('');
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
    <div class="mb-1 flex items-center justify-between text-xs">
      <span class="font-medium text-slate-700">${esc(item.name)}</span>
      <span class="tabular-nums text-slate-500">${fmtMoney(item.amount)}</span>
    </div>
    <div class="h-2 rounded bg-slate-100"><div class="h-2 rounded bg-teal-600" style="width:${width}%"></div></div>
  </div>`;
}

function quickAction(title, desc, view, icon) {
  return `<button onclick="window.__app.go('${view}')" class="card p-4 text-left hover:bg-slate-50">
    <div class="flex items-center gap-3">
      <div class="h-9 w-9 rounded border border-slate-200 bg-slate-50 flex items-center justify-center text-teal-700">
        <span class="material-symbols-outlined text-[20px]">${icon}</span>
      </div>
      <div>
        <div class="font-semibold text-slate-800">${title}</div>
        <div class="mt-1 text-xs text-slate-500">${desc}</div>
      </div>
    </div>
  </button>`;
}

function emptyBlock(text) {
  return `<div class="h-full min-h-[120px] flex items-center justify-center text-sm text-slate-400">${text}</div>`;
}

function drawCharts(archived, projects) {
  if (archived.length) {
    const byMonth = {};
    archived.forEach(p => {
      const k = (p.archivedAt || '').slice(0, 7) || '未归档';
      byMonth[k] = (byMonth[k] || 0) + Number(p.totalCost || 0);
    });
    const labels = Object.keys(byMonth).sort();
    const data = labels.map(l => byMonth[l]);
    new Chart(document.getElementById('costChart'), {
      type: 'bar',
      data: { labels, datasets: [{ label: '造价(元)', data, backgroundColor: '#0f766e', borderRadius: 4 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: v => '¥' + Number(v).toLocaleString('zh-CN') } } },
      },
    });
  }

  if (projects.length) {
    const typeCount = {};
    projects.forEach(p => typeCount[p.type || '未分类'] = (typeCount[p.type || '未分类'] || 0) + 1);
    new Chart(document.getElementById('typeChart'), {
      type: 'doughnut',
      data: { labels: Object.keys(typeCount), datasets: [{ data: Object.values(typeCount), backgroundColor: ['#0f766e', '#0ea5e9', '#f59e0b', '#ef4444', '#64748b', '#10b981'], borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, cutout: '62%' },
    });
  }
}

function statusBadge(s) {
  return s === 'archived' ? '<span class="badge badge-green">已归档</span>'
       : s === 'doing'    ? '<span class="badge badge-yellow">进行中</span>'
       : '<span class="badge badge-gray">未开始</span>';
}
