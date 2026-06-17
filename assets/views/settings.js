// 视图：设置
import { getAIConfig, setAIConfig, listProviders, getProviderDefaults } from '../services/aiService.js?v=3.2';
import { testConnection } from '../ai/remoteLLM.js?v=3.2';
import { dataEngineService } from '../services/dataEngineService.js?v=3.2';
import { quotaRepo, projectRepo, boqRepo, versionRepo, indicatorRepo, dataFactRepo, dataCandidateRepo, dataJobRepo, dataQualityReportRepo } from '../data/repository.js?v=3.2';
import { loadDemoData } from '../data/demo.js';
import { esc, toast, fmt } from '../utils/dom.js';

export async function render() {
  const cfg = getAIConfig();
  const providers = listProviders();
  const engine = await dataEngineService.dashboard();
  document.getElementById('workspace').innerHTML = `
    <div class="grid grid-cols-2 gap-4">
      <div class="card p-4">
        <div class="font-semibold mb-2">AI 模型配置</div>
        <div class="space-y-3 text-sm">
          <label class="block">服务商
            <select id="cfg_prov" class="mt-1 w-full border rounded px-2 py-1.5">
              ${providers.map(([k, v]) => `<option value="${k}" ${cfg.provider === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select>
          </label>
          <label class="block">Base URL
            <input id="cfg_url" class="mt-1 w-full border rounded px-2 py-1.5 tabular-nums" value="${esc(cfg.base_url)}" />
          </label>
          <label class="block">Model
            <input id="cfg_model" class="mt-1 w-full border rounded px-2 py-1.5" value="${esc(cfg.model)}" />
          </label>
          <label class="block">API Key
            <input id="cfg_key" type="password" class="mt-1 w-full border rounded px-2 py-1.5" value="${esc(cfg.api_key)}" placeholder="sk-..." />
            <span class="text-xs text-gray-400">仅保存在浏览器 localStorage</span>
          </label>
          <label class="block">系统提示词
            <textarea id="cfg_sys" rows="3" class="mt-1 w-full border rounded px-2 py-1.5">${esc(cfg.system)}</textarea>
          </label>
          <div class="flex gap-2 pt-2">
            <button id="btnSave" class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存</button>
            <button id="btnTest" class="px-3 py-1.5 text-sm border rounded">连通测试</button>
          </div>
        </div>
      </div>

      <div class="card p-4">
        <div class="font-semibold mb-2">数据管理</div>
        <div class="space-y-3 text-sm">
          <div class="flex gap-2 flex-wrap">
            <button id="btnImport" class="px-3 py-1.5 text-sm border rounded">导入 JSON 备份</button>
            <button id="btnExport" class="px-3 py-1.5 text-sm border rounded">导出 JSON 备份</button>
            <button id="btnDemo" class="px-3 py-1.5 text-sm border rounded text-amber-700 border-amber-300">加载演示数据</button>
            <button id="btnDemoReset" class="px-3 py-1.5 text-sm border rounded text-amber-700 border-amber-300">重置演示数据</button>
            <button id="btnClear" class="px-3 py-1.5 text-sm border rounded text-red-600 border-red-300">清空全部</button>
          </div>
          <div class="text-xs text-gray-500 leading-relaxed">
            所有业务数据保存在浏览器 IndexedDB；AI Key 仅保存在本机 localStorage。<br>• 备份：导出 JSON 文件，可在另一台机器导入还原，请按商业敏感数据妥善保存。<br>• 导入备份会覆盖当前定额、项目、清单、报价版本与指标。<br>• 演示数据：3 个项目（产品水池/预处理车间/变电站）+ 现有定额库，自动入库用于体验。
          </div>
        </div>
      </div>

      <div class="card p-4 col-span-2">
        <div class="flex items-center gap-3">
          <div>
            <div class="font-semibold">数据引擎</div>
            <div class="mt-1 text-xs text-slate-500">管理自动沉淀、质量扫描和指标重建。候选样本默认不参与指标统计。</div>
          </div>
          <div class="flex-1"></div>
          <button id="btnEngineRun" class="px-3 py-1.5 text-sm border rounded text-teal-700 border-teal-300">运行流水线</button>
          <button id="btnEngineBackfill" class="px-3 py-1.5 text-sm border rounded">回填归档项目</button>
          <button id="btnEngineScan" class="px-3 py-1.5 text-sm border rounded">数据质量扫描</button>
          <button id="btnEngineRebuild" class="px-3 py-1.5 text-sm brand-bg text-white rounded">重建指标</button>
          <button id="btnEngineClearCandidates" class="px-3 py-1.5 text-sm border rounded text-amber-700 border-amber-300">清理候选</button>
        </div>
        <div class="mt-4 grid grid-cols-5 gap-3">
          ${engineMetric('正式事实', engine.facts.length, '条')}
          ${engineMetric('候选样本', engine.candidates.length, '条')}
          ${engineMetric('质量报告', engine.reports.length, '份')}
          ${engineMetric('低可信报告', engine.lowQuality, '份')}
          ${engineMetric('健康分', engine.qualityScore || 0, '分')}
        </div>
        <div class="mt-4 grid grid-cols-12 gap-3">
          <div class="col-span-7 rounded border border-slate-200 bg-white p-3">
            <div class="flex items-center justify-between">
              <div class="font-medium text-slate-800">流水线阶段</div>
              <div class="text-xs text-slate-500">${engine.backfillNeeded ? `待回填 ${engine.backfillNeeded} 个归档项目` : '归档项目已接入样本池'}</div>
            </div>
            <div class="mt-3 grid grid-cols-5 gap-2">
              ${pipelineStages(engine.stageSummary)}
            </div>
          </div>
          <div class="col-span-5 rounded border border-slate-200 bg-slate-50 p-3">
            <div class="font-medium text-slate-800">最近质量建议</div>
            <div class="mt-2 space-y-1 text-xs text-slate-600">
              ${engine.lastReport ? (engine.lastReport.recommendations || []).map(r => `<div>${esc(r)}</div>`).join('') : '<div>暂无质量报告，运行流水线后会生成建议。</div>'}
            </div>
            <div class="mt-3 flex flex-wrap gap-1.5">
              ${Object.entries(engine.sourceSummary || {}).map(([k, v]) => `<span class="badge badge-gray">${esc(k)} ${fmt(v)}</span>`).join('') || '<span class="badge badge-gray">暂无来源</span>'}
            </div>
          </div>
        </div>
        <div class="mt-4 border rounded overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-left text-slate-500"><tr><th class="py-2 px-3">最近任务</th><th class="px-2">来源</th><th class="px-2">状态</th><th class="px-2 text-right">质量分</th><th class="px-2 text-right">事实/候选</th><th class="px-3 text-right">时间</th></tr></thead>
            <tbody>
              ${engine.jobs.length ? engine.jobs.map(job => `<tr class="border-t border-slate-100">
                <td class="py-2 px-3 font-medium">${esc(job.type)}</td>
                <td class="px-2 text-slate-500">${esc(job.sourceType || '')}</td>
                <td class="px-2"><span class="badge ${job.status === 'success' ? 'badge-green' : 'badge-gray'}">${esc(job.status || '-')}</span></td>
                <td class="px-2 text-right tabular-nums">${job.qualityScore == null ? '-' : fmt(job.qualityScore)}</td>
                <td class="px-2 text-right tabular-nums">${fmt(job.factCount || job.candidateCount || 0)}</td>
                <td class="px-3 text-right text-slate-500 tabular-nums">${esc(formatTime(job.updatedAt || job.createdAt))}</td>
              </tr>`).join('') : `<tr><td colspan="6" class="py-8 text-center text-slate-400">暂无数据引擎任务。导入清单、保存版本或归档项目后会自动生成。</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card p-4 col-span-2">
        <div class="font-semibold mb-2">使用说明</div>
        <ol class="list-decimal pl-5 text-sm space-y-1 text-gray-700">
          <li>首次使用：点「加载演示数据」快速体验，或点「导入 Excel」上传你自己的定额库。</li>
          <li>新建项目 → 进入「工程量清单」→ 点「+ 添加清单」选择定额 → 填工程量 → 自动算价。</li>
          <li>项目完工后，编辑项目把状态改为「已归档」，指标库会自动重算。</li>
          <li>「指标分析」查看同类型项目造价区间，支持下钻到分项占比。</li>
          <li>点击右上角「AI 助手」或左侧菜单，随时用自然语言查询指标 / 推荐定额。</li>
          <li>导出 Excel 报价单按你的现有格式：序号/编码/项目名称/项目特征/单位/工程量/综合单价/合价。</li>
        </ol>
      </div>
    </div>
  `;
  document.getElementById('cfg_prov').onchange = e => {
    const p = getProviderDefaults(e.target.value);
    if (p) { document.getElementById('cfg_url').value = p.base_url; document.getElementById('cfg_model').value = p.model; }
  };
  document.getElementById('btnSave').onclick = () => {
    setAIConfig({
      provider: document.getElementById('cfg_prov').value,
      base_url: document.getElementById('cfg_url').value.trim(),
      model: document.getElementById('cfg_model').value.trim(),
      api_key: document.getElementById('cfg_key').value.trim(),
      system: document.getElementById('cfg_sys').value.trim(),
    });
    toast('已保存', 'success');
  };
  document.getElementById('btnTest').onclick = async () => {
    document.getElementById('btnSave').click();
    try { await testConnection(); toast('✅ 连通成功', 'success'); }
    catch (e) { toast('❌ ' + e.message, 'error'); }
  };
  document.getElementById('btnImport').onclick = () => importAll();
  document.getElementById('btnExport').onclick = () => exportAll();
  document.getElementById('btnEngineRun').onclick = async () => {
    const result = await dataEngineService.runPipeline();
    toast(`流水线完成：健康分 ${result.report.qualityScore}`, result.report.qualityLevel === '低可信' ? 'error' : 'success');
    render();
  };
  document.getElementById('btnEngineBackfill').onclick = async () => {
    const result = await dataEngineService.backfillArchivedProjects();
    toast(`已回填 ${result.count} 个归档项目`, 'success');
    render();
  };
  document.getElementById('btnEngineScan').onclick = async () => {
    const report = await dataEngineService.analyzeQuality({});
    toast(`扫描完成：${report.totalLines} 条清单，${report.qualityLevel}`, report.qualityLevel === '低可信' ? 'error' : 'success');
    render();
  };
  document.getElementById('btnEngineRebuild').onclick = async () => {
    await dataEngineService.rebuildIndicators();
    toast('指标已基于正式事实重建', 'success');
    render();
  };
  document.getElementById('btnEngineClearCandidates').onclick = async () => {
    if (!confirm('清理全部候选样本？正式事实、项目和清单不会被删除。')) return;
    await dataEngineService.clearCandidates();
    toast('候选样本已清理', 'success');
    render();
  };
  document.getElementById('btnDemo').onclick = async () => {
    if (!confirm('将加载演示数据：现有定额库 + 3 个示例项目。已有同名数据可能被追加或更新。')) return;
    await loadDemoData();
    toast('演示数据已加载', 'success');
    window.__app.go('dashboard');
  };
  document.getElementById('btnDemoReset').onclick = async () => {
    if (!confirm('将先清空当前业务数据，再重新加载演示数据。此操作不可撤销，确定继续？')) return;
    await clearBusinessData();
    await loadDemoData();
    toast('演示数据已重置', 'success');
    window.__app.go('dashboard');
  };
  document.getElementById('btnClear').onclick = async () => {
    if (!confirm('清空所有定额、项目、清单、报价版本和指标？建议先导出 JSON 备份。')) return;
    await clearBusinessData();
    location.reload();
  };
}

function engineMetric(label, value, unit) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-lg font-semibold tabular-nums text-slate-900">${fmt(value)}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
  </div>`;
}

function pipelineStages(summary = {}) {
  return ['采集', '标准化', '质量检查', '沉淀入库', '指标重建'].map(stage => `
    <div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <div class="text-xs text-slate-500">${stage}</div>
      <div class="mt-1 text-base font-semibold tabular-nums text-slate-900">${fmt(summary[stage] || 0)}<span class="ml-1 text-xs font-normal text-slate-500">次</span></div>
    </div>
  `).join('');
}

function formatTime(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}

async function importAll() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('导入 JSON 备份会覆盖当前定额、项目、清单、报价版本、指标和 AI 配置。建议先导出当前备份。确定导入？')) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      toast('导入失败：JSON 文件无法解析', 'error');
      return;
    }
    if (data.quota_items) await quotaRepo.replaceAll(data.quota_items);
    if (data.projects)    await projectRepo.replaceAll(data.projects);
    if (data.project_boq) await boqRepo.replaceAll(data.project_boq);
    await versionRepo.replaceAll(data.boq_versions || []);
    if (data.indicators)  await indicatorRepo.replaceAll(data.indicators);
    await dataFactRepo.replaceAll(data.data_facts || []);
    await dataCandidateRepo.replaceAll(data.data_candidates || []);
    await dataJobRepo.replaceAll(data.data_jobs || []);
    await dataQualityReportRepo.replaceAll(data.data_quality_reports || []);
    if (data.ai_config) setAIConfig(data.ai_config);
    toast('导入完成', 'success');
    location.reload();
  };
  input.click();
}

async function clearBusinessData() {
  await Promise.all([
    quotaRepo.replaceAll([]),
    projectRepo.replaceAll([]),
    boqRepo.replaceAll([]),
    versionRepo.replaceAll([]),
    indicatorRepo.replaceAll([]),
    dataFactRepo.replaceAll([]),
    dataCandidateRepo.replaceAll([]),
    dataJobRepo.replaceAll([]),
    dataQualityReportRepo.replaceAll([]),
  ]);
}

async function exportAll() {
  const data = {
    quota_items: await quotaRepo.all(),
    projects:    await projectRepo.all(),
    project_boq: await boqRepo.all(),
    boq_versions: await versionRepo.all(),
    indicators:  await indicatorRepo.all(),
    data_facts: await dataFactRepo.all(),
    data_candidates: await dataCandidateRepo.all(),
    data_jobs: await dataJobRepo.all(),
    data_quality_reports: await dataQualityReportRepo.all(),
    ai_config:   JSON.parse(localStorage.getItem('ai_config') || 'null'),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `造价数据库备份-${Date.now()}.json`;
  a.click();
}
