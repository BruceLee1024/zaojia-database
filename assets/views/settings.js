// 视图：设置
import { getAIConfig, setAIConfig, listProviders, getProviderDefaults } from '../services/aiService.js?v=3.9';
import { testAIConnection } from '../services/aiAssistService.js?v=1.0';
import { dataEngineService } from '../services/dataEngineService.js?v=3.9';
import { experienceService } from '../services/experienceService.js?v=3.9';
import { quotaRepo, projectRepo, boqRepo, versionRepo, indicatorRepo, dataFactRepo, dataCandidateRepo, dataJobRepo, dataQualityReportRepo, experienceSessionRepo, experienceCardRepo } from '../data/repository.js?v=3.9';
import { activateLocalFolderStorage, getStorageStatus, reconnectLocalFolderStorage, switchToBrowserStorage, syncBrowserCacheToLocalFolder } from '../data/storage.js?v=1.0';
import { ensureDemoData } from '../data/demo.js?v=3.9';
import { esc, toast, fmt } from '../utils/dom.js';

export async function render() {
  const cfg = getAIConfig();
  const providers = listProviders();
  const [engine, experience, storageStatus] = await Promise.all([dataEngineService.dashboard(), experienceService.dashboard(), getStorageStatus()]);
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
            <button id="btnTest" class="px-3 py-1.5 text-sm border rounded">测试 AI 连接</button>
          </div>
        </div>
      </div>

      <div class="card p-4">
        <div class="font-semibold mb-2">备份与恢复</div>
        <div class="space-y-3 text-sm">
          <div class="flex gap-2 flex-wrap">
            <button id="btnImport" class="px-3 py-1.5 text-sm border rounded">导入 JSON 备份</button>
            <button id="btnExport" class="px-3 py-1.5 text-sm border rounded">导出 JSON 备份</button>
            <button id="btnDemo" class="px-3 py-1.5 text-sm border rounded text-amber-700 border-amber-300">加载演示数据</button>
          </div>
          <div class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            备份文件用于跨电脑迁移或临时留档；AI Key 仅保存在浏览器 localStorage，不会写入本地数据文件夹。
          </div>
          <div class="text-xs text-gray-500 leading-relaxed">
            备份文件包含定额、项目、清单、报价版本、经验卡和指标样本，属于商业敏感数据，请按企业资料妥善保存。
          </div>
          <div class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
            <div class="font-semibold text-red-800">危险操作</div>
            <div class="mt-1 text-xs leading-5 text-red-700">以下操作会覆盖或删除业务数据。执行前建议先导出 JSON 备份。</div>
            <div class="mt-3 flex gap-2 flex-wrap">
            <button id="btnDemoReset" class="px-3 py-1.5 text-sm border rounded text-amber-700 border-amber-300">重置演示数据</button>
            <button id="btnClear" class="px-3 py-1.5 text-sm border rounded text-red-600 border-red-300">清空全部</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card p-4 col-span-2">
        <div class="flex items-start gap-3">
          <div class="h-10 w-10 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[22px]">folder_managed</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-semibold">本地数据文件夹</div>
            <div class="mt-1 text-xs leading-5 text-slate-500">选择电脑上的文件夹后，定额、项目、清单、版本、指标和经验卡会按业务表保存为 JSON 文件；浏览器 IndexedDB 只保留授权和镜像缓存。</div>
          </div>
          <span class="badge ${storageStatus.mode === 'folder' ? 'badge-green' : 'badge-gray'}">${storageStatus.mode === 'folder' ? '文件夹模式' : '浏览器模式'}</span>
        </div>
        <div class="mt-4 grid grid-cols-4 gap-3">
          ${storageMetric('浏览器支持', storageStatus.supported ? '支持' : '不支持', storageStatus.supported ? 'Chrome / Edge 可用' : '请使用 Chrome 或 Edge')}
          ${storageMetric('当前目录', storageStatus.directoryName || '-', storageStatus.hasHandle ? '已保存授权句柄' : '尚未选择文件夹')}
          ${storageMetric('授权状态', permissionLabel(storageStatus.permission), storageStatus.connected ? '可读写 JSON 文件' : '需要重新授权或选择')}
          ${storageMetric('待同步', storageStatus.pendingSync ? '有' : '无', storageStatus.pendingSync ? '重连后建议同步浏览器缓存' : '文件夹与镜像缓存正常')}
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <button id="btnFolderActivate" class="px-3 py-1.5 text-sm brand-bg text-white rounded" ${storageStatus.supported ? '' : 'disabled'}>选择文件夹并迁移当前数据</button>
          <button id="btnFolderReconnect" class="px-3 py-1.5 text-sm border rounded" ${storageStatus.hasHandle ? '' : 'disabled'}>重新授权文件夹</button>
          <button id="btnFolderSync" class="px-3 py-1.5 text-sm border rounded text-teal-700 border-teal-300" ${storageStatus.hasHandle ? '' : 'disabled'}>同步浏览器缓存到文件夹</button>
          <button id="btnBrowserStorage" class="px-3 py-1.5 text-sm border rounded text-slate-700">切回浏览器存储</button>
        </div>
        <div class="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
          文件夹内会生成 <span class="font-data">manifest.json</span>、<span class="font-data">stores/*.json</span> 和 <span class="font-data">backups/*.json</span>。如果浏览器要求重新授权，期间修改会先进入 IndexedDB 镜像，授权后可手动同步回文件夹。
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
        <div class="mt-4 grid grid-cols-4 gap-3">
          ${engineMetric('正式事实', engine.facts.length, '条')}
          ${engineMetric('候选样本', engine.candidates.length, '条')}
          ${engineMetric('质量报告', engine.reports.length, '份')}
          ${engineMetric('健康分', engine.qualityScore || 0, '分')}
        </div>
        <div class="mt-3 grid grid-cols-4 gap-3">
          ${engineMetric('低可信报告', engine.lowQuality, '份')}
          ${engineMetric('经验卡', experience.confirmedCards.length, '张')}
          ${engineMetric('待确认复盘', experience.pendingSessions.length, '个')}
          ${engineMetric('过期经验', experience.expiredCards.length, '张')}
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
          <li>项目价格完整、工程量可信并保存报价版本后，再归档进入正式指标库。</li>
          <li>「指标分析」查看同类型项目造价区间，支持下钻到分项占比。</li>
          <li>点击右上角「AI 助手」，随时用自然语言查询指标 / 推荐定额。</li>
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
    const result = await testAIConnection();
    toast(result.summary, result.confidence === 'high' ? 'success' : 'error');
  };
  document.getElementById('btnImport').onclick = () => importAll();
  document.getElementById('btnExport').onclick = () => exportAll();
  document.getElementById('btnFolderActivate').onclick = async () => {
    try {
      await activateLocalFolderStorage(collectBusinessData);
      toast('已切换为本地文件夹存储', 'success');
      location.reload();
    } catch (err) {
      toast(folderErrorMessage(err) || '选择文件夹失败', 'error');
    }
  };
  document.getElementById('btnFolderReconnect').onclick = async () => {
    try {
      await reconnectLocalFolderStorage();
      toast('本地文件夹已重新授权', 'success');
      location.reload();
    } catch (err) {
      toast(folderErrorMessage(err) || '重新授权失败', 'error');
    }
  };
  document.getElementById('btnFolderSync').onclick = async () => {
    if (!confirm('将当前浏览器镜像缓存写入已授权文件夹，并在文件夹内生成同步前备份。继续？')) return;
    try {
      await syncBrowserCacheToLocalFolder(await collectBusinessData());
      toast('浏览器缓存已同步到本地文件夹', 'success');
      location.reload();
    } catch (err) {
      toast(folderErrorMessage(err) || '同步失败', 'error');
    }
  };
  document.getElementById('btnBrowserStorage').onclick = async () => {
    if (!confirm('切回浏览器存储后，后续修改只写入 IndexedDB，不再写入本地文件夹。已写入文件夹的数据不会删除。继续？')) return;
    await switchToBrowserStorage();
    toast('已切回浏览器存储', 'success');
    location.reload();
  };
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
    if (!confirm('将加载内置演示数据：定额库 + 3 个示例项目 + 报价版本 + 指标样本。已有业务数据不会被覆盖。')) return;
    const result = await ensureDemoData();
    if (!result.loaded) {
      toast('当前已有业务数据；如需重新体验，请使用「重置演示数据」。', 'success');
      return;
    }
    toast('演示数据已加载', 'success');
    window.__app.go('dashboard');
  };
  document.getElementById('btnDemoReset').onclick = async () => {
    if (!confirm('将先清空当前业务数据，再重新加载演示数据。此操作不可撤销，确定继续？')) return;
    await ensureDemoData({ force: true });
    toast('演示数据已重置', 'success');
    window.__app.go('dashboard');
  };
  document.getElementById('btnClear').onclick = async () => {
    const typed = prompt('此操作会清空所有定额、项目、清单、报价版本、经验卡和指标；不会删除 AI 配置。请输入“清空全部”确认。');
    if (typed !== '清空全部') return;
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

function storageMetric(label, value, hint) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-xs text-slate-500">${esc(label)}</div>
    <div class="mt-1 text-base font-semibold text-slate-900">${esc(value)}</div>
    <div class="mt-1 text-[11px] leading-4 text-slate-500">${esc(hint)}</div>
  </div>`;
}

function permissionLabel(permission) {
  return {
    granted: '已授权',
    prompt: '待授权',
    denied: '已拒绝',
    missing: '未选择',
  }[permission] || permission || '-';
}

function folderErrorMessage(err) {
  if (err?.name === 'AbortError' || /aborted/i.test(err?.message || '')) return '已取消或未完成文件夹授权，请重新点击按钮并在弹窗中选择文件夹。';
  return err?.message || '';
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
    if (!confirm('导入 JSON 备份会覆盖当前定额、项目、清单、报价版本、经验卡、指标和 AI 配置。建议先导出当前备份。确定导入？')) return;
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
    await experienceSessionRepo.replaceAll(data.experience_sessions || []);
    await experienceCardRepo.replaceAll(data.experience_cards || []);
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
    experienceSessionRepo.replaceAll([]),
    experienceCardRepo.replaceAll([]),
  ]);
}

async function exportAll() {
  const data = {
    ...(await collectBusinessData()),
    ai_config:   JSON.parse(localStorage.getItem('ai_config') || 'null'),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `造价数据库备份-${Date.now()}.json`;
  a.click();
}

async function collectBusinessData() {
  return {
    quota_items: await quotaRepo.all(),
    projects:    await projectRepo.all(),
    project_boq: await boqRepo.all(),
    boq_versions: await versionRepo.all(),
    indicators:  await indicatorRepo.all(),
    data_facts: await dataFactRepo.all(),
    data_candidates: await dataCandidateRepo.all(),
    data_jobs: await dataJobRepo.all(),
    data_quality_reports: await dataQualityReportRepo.all(),
    experience_sessions: await experienceSessionRepo.all(),
    experience_cards: await experienceCardRepo.all(),
  };
}
