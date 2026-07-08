// 视图：项目管理
import { projectService } from '../services/projectService.js?v=3.9';
import { indicatorService } from '../services/indicatorService.js?v=3.9';
import { boqRepo, versionRepo } from '../data/repository.js?v=3.9';
import { fmtMoney, esc, openModal, closeModal, toast } from '../utils/dom.js';
import { hasMissingPrice } from '../utils/costing.js?v=3.9';
import { openReview } from './experience.js?v=4.4';

const TYPES = ['水厂', '泵站', '管网', '变电站', '水池', '车间', '其他'];
const SCALES = ['小型', '中型', '大型', '特大型'];
const projectState = { status: '', type: '', risk: '', version: '' };

export async function render() {
  const [projects, allBoq, versions] = await Promise.all([projectService.list(), boqRepo.all(), versionRepo.all()]);
  const visibleProjects = projects.filter(p => {
    const lines = allBoq.filter(b => b.projectId === p.id);
    const hasRisk = lines.some(b => hasMissingPrice(b.unitPrice));
    const hasVersion = versions.some(v => v.projectId === p.id);
    if (projectState.status && p.status !== projectState.status) return false;
    if (projectState.type && p.type !== projectState.type) return false;
    if (projectState.risk === 'missing' && !hasRisk) return false;
    if (projectState.risk === 'ok' && hasRisk) return false;
    if (projectState.version === 'has' && !hasVersion) return false;
    if (projectState.version === 'none' && hasVersion) return false;
    return true;
  });
  const archivedCount = projects.filter(p => p.status === 'archived').length;
  const totalCost = projects.reduce((s, p) => s + Number(p.totalCost || 0), 0);
  const missingCount = allBoq.filter(b => hasMissingPrice(b.unitPrice)).length;
  document.getElementById('workspace').innerHTML = `
    <div class="card p-4 mb-3">
      <div class="flex items-center gap-3">
        <div>
          <div class="text-base font-semibold text-slate-800">项目档案</div>
          <div class="mt-1 text-xs text-slate-500">管理项目基础信息、清单入口和归档状态。</div>
        </div>
        <div class="flex-1"></div>
        <button id="btnNew" class="px-3 py-1.5 text-sm brand-bg text-white">+ 新建项目</button>
      </div>
      <div class="mt-4 grid grid-cols-4 gap-3">
        ${summaryTile('项目总数', projects.length, '个')}
        ${summaryTile('已归档', archivedCount, '个')}
        ${summaryTile('缺单价风险', missingCount, '处', missingCount ? 'text-amber-700' : '')}
        ${summaryTile('累计造价', fmtMoney(totalCost), '')}
      </div>
      <div class="mt-4 flex items-center gap-2 text-sm">
        <select id="pf_status_filter" class="h-9 rounded border border-slate-300 bg-white px-2">
          <option value="">全部状态</option>
          <option value="doing" ${projectState.status === 'doing' ? 'selected' : ''}>进行中</option>
          <option value="archived" ${projectState.status === 'archived' ? 'selected' : ''}>已归档</option>
        </select>
        <select id="pf_type_filter" class="h-9 rounded border border-slate-300 bg-white px-2">
          <option value="">全部类型</option>
          ${TYPES.map(t => `<option value="${t}" ${projectState.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <select id="pf_risk_filter" class="h-9 rounded border border-slate-300 bg-white px-2">
          <option value="">全部风险</option>
          <option value="missing" ${projectState.risk === 'missing' ? 'selected' : ''}>有缺价风险</option>
          <option value="ok" ${projectState.risk === 'ok' ? 'selected' : ''}>价格完整</option>
        </select>
        <select id="pf_version_filter" class="h-9 rounded border border-slate-300 bg-white px-2">
          <option value="">全部版本</option>
          <option value="has" ${projectState.version === 'has' ? 'selected' : ''}>已有版本</option>
          <option value="none" ${projectState.version === 'none' ? 'selected' : ''}>未保存版本</option>
        </select>
        <div class="flex-1"></div>
        <span class="text-xs text-slate-500">显示 ${visibleProjects.length} / ${projects.length} 个项目</span>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-3">
      ${visibleProjects.length ? visibleProjects.map(p => card(p, allBoq.filter(b => b.projectId === p.id), versions.filter(v => v.projectId === p.id))).join('') : `<div class="col-span-3 card p-10 text-center text-gray-400">${projects.length ? '没有符合筛选条件的项目。' : '还没有项目，点右上角「+ 新建项目」开始建立项目档案。'}</div>`}
    </div>
  `;
  document.getElementById('btnNew').onclick = () => editForm({ id: '', name: '', type: '水厂', scale: '', dailyCapacity: '', area: '', structure: '', process: '', status: 'doing' });
  ['status', 'type', 'risk', 'version'].forEach(key => {
    const el = document.getElementById(`pf_${key}_filter`);
    if (el) el.onchange = () => { projectState[key] = el.value; render(); };
  });
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => {
    const p = await projectService.get(b.dataset.edit);
    if (p) editForm(p);
  });
  document.querySelectorAll('[data-archive]').forEach(b => b.onclick = async () => {
    const p = await projectService.get(b.dataset.archive);
    if (p?.status !== 'archived' && !confirm('归档会把当前项目清单写入数据引擎样本池，并用于后续指标统计。确定归档？')) return;
    const updated = await projectService.archive(b.dataset.archive);
    toast('已更新，数据引擎已同步');
    render();
    if (updated?.status === 'archived') openReview({ projectId: updated.id, sourceType: 'project_archive' });
  });
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    window.__app.go('boq', { projectId: b.dataset.open });
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('删除项目会同时删除该项目下所有清单，确定？')) return;
    await projectService.remove(b.dataset.del);
    render();
    toast('已删除');
  });
}

function summaryTile(label, value, unit, cls = '') {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-lg font-semibold tabular-nums text-slate-900 ${cls}">${value}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
  </div>`;
}

function card(p, lines = [], versions = []) {
  const missing = lines.filter(b => hasMissingPrice(b.unitPrice)).length;
  const priced = lines.length - missing;
  const completion = lines.length ? Math.round(priced / lines.length * 100) : 0;
  const unitCost = p.area ? Number(p.totalCost || 0) / Number(p.area) : 0;
  const waterCost = p.dailyCapacity ? Number(p.totalCost || 0) / (Number(p.dailyCapacity) * 10000) : 0;
  const next = nextAction(p, lines, versions);
  return `<div class="card p-0 overflow-hidden flex flex-col min-h-[280px]">
    <div class="p-4 border-b border-slate-200 bg-white">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-semibold leading-5 text-slate-900 truncate" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <span>${esc(p.type || '未分类')}</span>
            <span class="text-slate-300">/</span>
            <span>${esc(p.scale || '不分规模')}</span>
          </div>
        </div>
        ${statusBadge(p.status)}
      </div>
      <div class="mt-4 flex items-end justify-between gap-3">
        <div>
          <div class="text-xs text-slate-500">项目总造价</div>
          <div class="mt-1 text-2xl font-semibold tabular-nums text-teal-700">${fmtMoney(p.totalCost || 0)}</div>
        </div>
        <div class="text-right text-xs text-slate-500">
          <div>${lines.length} 条清单</div>
          <div class="${missing ? 'text-amber-700' : 'text-slate-500'}">${missing ? `缺单价 ${missing}` : '价格完整'}</div>
        </div>
      </div>
    </div>

    <div class="p-4 flex-1 bg-slate-50/60">
      <div class="grid grid-cols-2 gap-2 text-sm">
        ${miniMetric('日处理量', p.dailyCapacity ? `${esc(p.dailyCapacity)} 万m³/d` : '-')}
        ${miniMetric('建筑面积', p.area ? `${esc(p.area)} ㎡` : '-')}
        ${miniMetric('单方造价', p.area ? `${fmt(unitCost)} 元/㎡` : '-')}
        ${miniMetric('单水造价', p.dailyCapacity ? `${fmt(waterCost)} 元/(m³·d)` : '-')}
      </div>
      <div class="mt-4">
        <div class="mb-1 flex items-center justify-between text-xs">
          <span class="text-slate-500">价格完整度</span>
          <span class="tabular-nums ${missing ? 'text-amber-700' : 'text-teal-700'}">${completion}%</span>
        </div>
        <div class="h-2 rounded bg-slate-200 overflow-hidden">
          <div class="h-2 rounded ${missing ? 'bg-amber-500' : 'bg-teal-600'}" style="width:${completion}%"></div>
        </div>
      </div>
      <div class="mt-4 flex items-center gap-2 text-xs text-slate-500">
        <span class="badge badge-gray">${esc(p.structure || '未填结构')}</span>
        <span class="badge badge-gray">${esc(p.process || '未填工艺')}</span>
      </div>
      <button data-open="${p.id}" class="mt-4 w-full rounded border ${next.cls} px-3 py-2 text-left text-xs hover:bg-white">
        <div class="font-medium">${esc(next.title)}</div>
        <div class="mt-1 opacity-80">${esc(next.desc)}</div>
      </button>
    </div>

    <div class="px-4 py-3 border-t border-slate-200 bg-white flex items-center gap-2">
      <button data-open="${p.id}" class="px-2.5 py-1.5 text-xs rounded border border-teal-600 text-teal-700 hover:bg-teal-50">打开清单</button>
      <button data-edit="${p.id}" class="px-2.5 py-1.5 text-xs rounded border border-slate-300 hover:bg-slate-50">编辑</button>
      <button data-archive="${p.id}" class="px-2.5 py-1.5 text-xs rounded border border-slate-300 hover:bg-slate-50">${p.status === 'archived' ? '取消归档' : '归档'}</button>
      <div class="flex-1"></div>
      <button data-del="${p.id}" class="px-2.5 py-1.5 text-xs rounded border text-red-600 border-red-300 hover:bg-red-50">删除</button>
    </div>
  </div>`;
}

function nextAction(p, lines, versions) {
  const missing = lines.filter(b => hasMissingPrice(b.unitPrice)).length;
  if (missing) return { title: `下一步：补齐 ${missing} 条缺单价`, desc: '价格完整后再保存版本或导出报价。', cls: 'border-amber-200 bg-amber-50 text-amber-800' };
  if (lines.length && !versions.length) return { title: '下一步：保存报价版本', desc: '为当前报价创建可回退快照。', cls: 'border-teal-200 bg-teal-50 text-teal-800' };
  if (p.status !== 'archived' && lines.length) return { title: '下一步：归档进入指标库', desc: '归档后会沉淀为正式指标样本。', cls: 'border-slate-200 bg-white text-slate-700' };
  return { title: '下一步：查看指标对标', desc: '用历史样本解释造价合理性。', cls: 'border-slate-200 bg-white text-slate-700' };
}

function miniMetric(label, value) {
  return `<div class="rounded border border-slate-200 bg-white px-3 py-2">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-sm font-medium tabular-nums text-slate-800 truncate">${value}</div>
  </div>`;
}

function statusBadge(s) {
  return s === 'archived' ? '<span class="badge badge-green">已归档</span>'
       : s === 'doing'    ? '<span class="badge badge-yellow">进行中</span>'
       : '<span class="badge badge-gray">未开始</span>';
}

function editForm(p) {
  openModal((p.name ? '编辑' : '新建') + ' 项目', `
    <div class="space-y-4 text-sm text-slate-700">
      <section class="bg-white border border-slate-200 rounded-xl p-4">
        <div class="mb-3 flex items-center justify-between">
          <div>
            <div class="font-semibold text-slate-800">基础信息</div>
            <div class="mt-1 text-xs text-slate-500">用于项目档案、工程量清单和报价版本识别。</div>
          </div>
          ${statusBadge(p.status)}
        </div>
        <div class="grid grid-cols-4 gap-3">
          <label class="col-span-4 block text-xs font-medium text-slate-500">项目名称 <span class="text-red-500">*</span>
            <input id="pf_name" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-800" value="${esc(p.name)}" placeholder="例如：产品水池 / 预处理车间" />
          </label>
          <label class="col-span-2 block text-xs font-medium text-slate-500">项目类型
            <select id="pf_type" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm">${TYPES.map(t => `<option ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
          </label>
          <label class="col-span-2 block text-xs font-medium text-slate-500">状态
            <select id="pf_status" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm"><option value="doing" ${p.status === 'doing' ? 'selected' : ''}>进行中</option><option value="archived" ${p.status === 'archived' ? 'selected' : ''}>已归档</option></select>
          </label>
        </div>
      </section>

      <section class="bg-white border border-slate-200 rounded-xl p-4">
        <div class="mb-3">
          <div class="font-semibold text-slate-800">规模参数</div>
          <div class="mt-1 text-xs text-slate-500">用于计算单方造价、单水造价和历史指标对标。</div>
        </div>
        <div class="grid grid-cols-4 gap-3">
          <label class="block text-xs font-medium text-slate-500">规模等级
            <select id="pf_scale" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm"><option value="">不分规模</option>${SCALES.map(s => `<option ${p.scale === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          </label>
          <label class="block text-xs font-medium text-slate-500">日处理量（万m³/d）
            <input id="pf_daily" type="number" step="0.01" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-right tabular-nums" value="${esc(p.dailyCapacity || '')}" />
          </label>
          <label class="block text-xs font-medium text-slate-500">建筑面积（㎡）
            <input id="pf_area" type="number" step="0.01" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-right tabular-nums" value="${esc(p.area || '')}" />
          </label>
          <label class="block text-xs font-medium text-slate-500">当前总造价
            <input readonly tabindex="-1" class="mt-1 h-9 w-full rounded border border-slate-300 bg-slate-50 px-2 text-sm text-right font-medium tabular-nums text-slate-700" value="${fmtMoney(p.totalCost || 0)}" />
          </label>
        </div>
      </section>

      <section class="bg-white border border-slate-200 rounded-xl p-4">
        <div class="mb-3">
          <div class="font-semibold text-slate-800">指标口径</div>
          <div class="mt-1 text-xs text-slate-500">这些字段会影响指标分桶和项目对标，请尽量填写。</div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="block text-xs font-medium text-slate-500">结构形式
            <input id="pf_struct" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm" placeholder="钢筋砼 / 砖混 / 钢结构" value="${esc(p.structure || '')}" />
          </label>
          <label class="block text-xs font-medium text-slate-500">工艺类型
            <input id="pf_proc" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm" placeholder="AAO / MBR / SBR" value="${esc(p.process || '')}" />
          </label>
        </div>
      </section>
    </div>
  `, `
    <button onclick="document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border border-slate-300 bg-white text-slate-700 rounded hover:bg-slate-50">取消</button>
    <button id="pf_save" class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存项目</button>
  `);
  document.getElementById('pf_save').onclick = async () => {
    const obj = {
      id: p.id || null,
      name: document.getElementById('pf_name').value.trim(),
      type: document.getElementById('pf_type').value,
      scale: document.getElementById('pf_scale').value,
      dailyCapacity: document.getElementById('pf_daily').value,
      area: document.getElementById('pf_area').value,
      structure: document.getElementById('pf_struct').value,
      process: document.getElementById('pf_proc').value,
      status: document.getElementById('pf_status').value,
    };
    if (!obj.name) {
      toast('请填写项目名称', 'error');
      return;
    }
    await projectService.save(obj);
    if (obj.status === 'archived') await indicatorService.recompute();
    closeModal();
    toast('已保存', 'success');
    render();
  };
}
