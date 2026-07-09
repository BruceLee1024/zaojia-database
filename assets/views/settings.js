// 视图：设置
import { getAIConfig, setAIConfig, listProviders, getProviderDefaults } from '../services/aiService.js?v=3.9';
import { testAIConnection } from '../services/aiAssistService.js?v=1.0';
import { dataEngineService } from '../services/dataEngineService.js?v=3.9';
import { experienceService } from '../services/experienceService.js?v=3.9';
import { quotaRepo, projectRepo, boqRepo, versionRepo, indicatorRepo, dataFactRepo, dataCandidateRepo, dataJobRepo, dataQualityReportRepo, experienceSessionRepo, experienceCardRepo } from '../data/repository.js?v=3.9';
import { activateLocalFolderStorage, getStorageStatus, reconnectLocalFolderStorage, switchToBrowserStorage, syncBrowserCacheToLocalFolder } from '../data/storage.js?v=1.0';
import { ensureDemoData } from '../data/demo.js?v=3.9';
import { esc, toast, fmt } from '../utils/dom.js';

const SETTINGS_TABS = [
  { id: 'storage', label: '存储设置', icon: 'folder_managed', desc: '本地数据' },
  { id: 'ai', label: 'AI 模型配置', icon: 'smart_toy', desc: '智能问答' },
  { id: 'engine', label: '数据引擎', icon: 'monitoring', desc: '沉淀指标' },
  { id: 'backup', label: '备份与恢复', icon: 'cloud_upload', desc: '迁移留档' },
  { id: 'danger', label: '危险操作', icon: 'warning', desc: '谨慎维护' },
];

let activeSettingsTab = 'storage';

export async function render() {
  const cfg = getAIConfig();
  const providers = listProviders();
  const [engine, experience, storageStatus, storageEstimate] = await Promise.all([
    dataEngineService.dashboard(),
    experienceService.dashboard(),
    getStorageStatus(),
    getBrowserStorageEstimate(),
  ]);
  const ctx = { cfg, providers, engine, experience, storageStatus, storageEstimate };
  document.getElementById('workspace').innerHTML = `
    <div class="max-w-[1680px] mx-auto space-y-4">
      ${settingsTabs()}
      ${renderActiveTab(ctx)}
    </div>
  `;
  bindSettingsEvents();
  bindTabEvents();
}

export async function triggerExportBackup() {
  await exportAll();
}

function settingsTabs() {
  return `
    <section class="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div class="grid grid-cols-5 divide-x divide-slate-200">
        ${SETTINGS_TABS.map(tab => {
          const active = activeSettingsTab === tab.id;
          const danger = tab.id === 'danger';
          return `
            <button data-settings-tab="${tab.id}" class="relative min-h-[74px] px-5 py-4 text-left flex items-center justify-center gap-3 ${active ? 'bg-white' : 'bg-slate-50/70 hover:bg-white'}">
              <span class="material-symbols-outlined text-[24px] ${danger ? 'text-red-500' : active ? 'text-teal-700' : 'text-slate-500'}">${tab.icon}</span>
              <span>
                <span class="block text-sm font-semibold ${active ? danger ? 'text-red-700' : 'text-teal-800' : 'text-slate-700'}">${tab.label}</span>
                <span class="mt-0.5 block text-xs text-slate-400">${tab.desc}</span>
              </span>
              ${active ? `<span class="absolute left-4 right-4 bottom-0 h-0.5 ${danger ? 'bg-red-500' : 'bg-teal-700'}"></span>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderActiveTab(ctx) {
  return {
    storage: renderStorageTab,
    ai: renderAiTab,
    engine: renderEngineTab,
    backup: renderBackupTab,
    danger: renderDangerTab,
  }[activeSettingsTab](ctx);
}

function renderStorageTab(ctx) {
  const { storageStatus, storageEstimate, cfg, engine } = ctx;
  const folderLabel = storageStatus.directoryName ? `已选择：${storageStatus.directoryName}` : '尚未选择文件夹';
  return `
    <div class="grid grid-cols-12 gap-4">
      <aside class="col-span-12 xl:col-span-2 rounded-lg border border-slate-200 bg-white p-4 space-y-5">
        ${storageRailGroup('storage', '存储模式', [
          ['当前模式', storageStatus.mode === 'folder' ? '本地文件夹存储' : '本地浏览器存储', storageStatus.mode === 'folder' ? 'badge-green' : 'badge-gray'],
          ['存储引擎', storageStatus.mode === 'folder' ? 'JSON 文件 + IndexedDB 镜像' : 'IndexedDB', 'badge-blue'],
          ['可用空间', storageEstimate.label, 'badge-gray'],
        ])}
        ${storageRailGroup('verified_user', '文件夹授权', [
          ['授权状态', permissionLabel(storageStatus.permission), storageStatus.connected ? 'badge-green' : 'badge-yellow'],
          ['授权路径', storageStatus.directoryName || '未选择', 'badge-gray'],
        ])}
        ${storageRailGroup('sync', '最近同步', [
          ['同步状态', storageStatus.pendingSync ? '待同步' : '同步正常', storageStatus.pendingSync ? 'badge-yellow' : 'badge-green'],
          ['镜像缓存', '浏览器 IndexedDB', 'badge-gray'],
        ])}
      </aside>

      <main class="col-span-12 xl:col-span-7 rounded-lg border border-slate-200 bg-white p-5">
        <div class="flex items-start gap-3">
          <div class="h-10 w-10 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[22px]">folder_open</span>
          </div>
          <div class="min-w-0 flex-1">
            <h2 class="text-base font-semibold text-slate-900">本地数据文件夹</h2>
            <p class="mt-1 text-xs leading-5 text-slate-500">以下文件夹用于保存本地业务数据，包含定额、项目、清单、报价版本、指标和经验卡 JSON 文件。</p>
          </div>
        </div>

        <div class="mt-5 space-y-4">
          <div>
            <label class="text-xs font-medium text-slate-500">文件夹路径</label>
            <div class="mt-2 flex gap-2">
              <div class="min-h-10 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-data text-slate-700 flex items-center">${esc(folderLabel)}</div>
              <button class="h-10 w-10 rounded-lg border border-slate-300 bg-white text-slate-500 flex items-center justify-center" title="浏览器不会暴露完整系统路径" aria-label="路径说明">
                <span class="material-symbols-outlined text-[18px]">info</span>
              </button>
            </div>
          </div>

          <section class="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
            <div class="text-sm font-semibold text-slate-800">JSON 文件健康检查</div>
            <div class="mt-3 grid grid-cols-4 divide-x divide-slate-200 rounded-lg border border-slate-200 bg-white">
              ${fileCheck('manifest.json', storageStatus.mode === 'folder' ? '正常' : '待生成', storageStatus.mode === 'folder')}
              ${fileCheck('stores/*.json', storageStatus.mode === 'folder' ? '正常' : '待生成', storageStatus.mode === 'folder')}
              ${fileCheck('backups/*.json', storageStatus.mode === 'folder' ? '正常' : '待生成', storageStatus.mode === 'folder')}
              ${fileCheck('索引文件', storageStatus.pendingSync ? '待同步' : '正常', !storageStatus.pendingSync)}
            </div>
          </section>

          <section class="rounded-lg border border-slate-200 bg-white">
            <div class="h-11 px-3 border-b border-slate-200 flex items-center justify-between">
              <div class="text-sm font-semibold text-slate-800">目录结构（预览）</div>
              <div class="flex gap-2">
                <button class="h-8 px-2.5 text-xs rounded border border-slate-300 bg-white text-slate-600">刷新</button>
                <button class="h-8 px-2.5 text-xs rounded border border-slate-300 bg-white text-slate-600">展开全部</button>
              </div>
            </div>
            <div class="p-4 text-sm font-data text-slate-600">
              ${directoryTree(storageStatus)}
            </div>
          </section>

          <div class="flex flex-wrap gap-2">
            <button id="btnFolderActivate" class="h-10 px-4 text-sm brand-bg text-white rounded-lg inline-flex items-center gap-1.5" ${storageStatus.supported ? '' : 'disabled'}>
              <span class="material-symbols-outlined text-[17px]">folder_open</span>选择文件夹
            </button>
            <button id="btnFolderReconnect" class="h-10 px-4 text-sm rounded-lg border border-slate-300 bg-white text-slate-700 inline-flex items-center gap-1.5" ${storageStatus.hasHandle ? '' : 'disabled'}>
              <span class="material-symbols-outlined text-[17px]">verified_user</span>重新授权
            </button>
            <button id="btnFolderSync" class="h-10 px-4 text-sm rounded-lg border border-teal-300 bg-white text-teal-700 inline-flex items-center gap-1.5" ${storageStatus.hasHandle ? '' : 'disabled'}>
              <span class="material-symbols-outlined text-[17px]">sync</span>同步到文件夹
            </button>
            <button id="btnBrowserStorage" class="h-10 px-4 text-sm rounded-lg border border-slate-300 bg-white text-slate-700 inline-flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[17px]">database</span>切换浏览器存储
            </button>
          </div>
        </div>
      </main>

      <aside class="col-span-12 xl:col-span-3 rounded-lg border border-slate-200 bg-white p-5 space-y-5">
        ${inspectorBlock('浏览器支持', 'Chrome / Edge（推荐）', storageStatus.supported ? '支持完整文件夹读写能力。' : '当前浏览器不支持本地文件夹授权。', storageStatus.supported ? 'check_circle' : 'error', storageStatus.supported ? 'text-teal-700' : 'text-red-600')}
        ${inspectorBlock('权限说明', '授权仅在当前浏览器生效', '若更换浏览器或清除站点数据，需要重新授权并同步数据。', 'info', 'text-slate-500')}
        <section class="border-t border-slate-200 pt-5">
          <div class="flex items-start gap-2">
            <span class="material-symbols-outlined text-[19px] text-slate-500">history</span>
            <div class="min-w-0">
              <div class="font-semibold text-slate-800">最新备份</div>
              <div class="mt-3 text-xs leading-5 text-slate-500">本地文件夹模式下，自动备份保存在 <span class="font-data">backups/</span>。浏览器不会暴露备份文件的完整路径。</div>
              <button id="btnExport" class="mt-3 h-9 px-3 text-sm rounded-lg border border-teal-300 bg-white text-teal-700">导出 JSON 备份</button>
            </div>
          </div>
        </section>
        <section class="border-t border-slate-200 pt-5">
          <div class="flex items-start gap-2">
            <span class="material-symbols-outlined text-[19px] text-slate-500">restore</span>
            <div class="min-w-0">
              <div class="font-semibold text-slate-800">恢复点（最近）</div>
              <div class="mt-3 space-y-2 text-xs text-slate-500">
                ${restorePoint('initial-migration', storageStatus.mode === 'folder')}
                ${restorePoint('manual-sync', storageStatus.hasHandle)}
                ${restorePoint('JSON 备份导入', false)}
              </div>
              <button id="btnImport" class="mt-3 h-9 px-3 text-sm rounded-lg border border-slate-300 bg-white text-slate-700">导入备份</button>
            </div>
          </div>
        </section>
      </aside>

      <div class="col-span-12">
        ${renderSettingsSummaryCards(ctx)}
      </div>
    </div>
  `;
}

function renderAiTab({ cfg, providers }) {
  return `
    <div class="grid grid-cols-12 gap-4">
      <section class="col-span-12 xl:col-span-8 rounded-lg border border-slate-200 bg-white p-5">
        <div class="flex items-start gap-3">
          <div class="h-10 w-10 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 flex items-center justify-center">
            <span class="material-symbols-outlined text-[22px]">smart_toy</span>
          </div>
          <div>
            <h2 class="text-base font-semibold text-slate-900">AI 模型配置</h2>
            <p class="mt-1 text-xs text-slate-500">配置用于智能问答与辅助报价的 AI 模型参数。</p>
          </div>
        </div>
        <div class="mt-5 grid grid-cols-2 gap-4 text-sm">
          <label class="block">服务商
            <select id="cfg_prov" class="mt-1 w-full border rounded px-2 py-2">
              ${providers.map(([k, v]) => `<option value="${k}" ${cfg.provider === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select>
          </label>
          <label class="block">Model
            <input id="cfg_model" class="mt-1 w-full border rounded px-2 py-2" value="${esc(cfg.model)}" />
          </label>
          <label class="block col-span-2">Base URL
            <input id="cfg_url" class="mt-1 w-full border rounded px-2 py-2 tabular-nums" value="${esc(cfg.base_url)}" />
          </label>
          <label class="block col-span-2">API Key
            <input id="cfg_key" type="password" class="mt-1 w-full border rounded px-2 py-2" value="${esc(cfg.api_key)}" placeholder="sk-..." />
            <span class="text-xs text-gray-400">仅保存在浏览器 localStorage，不写入本地数据文件夹。</span>
          </label>
          <label class="block col-span-2">系统提示词
            <textarea id="cfg_sys" rows="5" class="mt-1 w-full border rounded px-2 py-2">${esc(cfg.system)}</textarea>
          </label>
        </div>
        <div class="mt-5 flex gap-2">
          <button id="btnSave" class="h-10 px-4 text-sm brand-bg text-white rounded-lg">保存配置</button>
          <button id="btnTest" class="h-10 px-4 text-sm border border-teal-300 text-teal-700 bg-white rounded-lg">测试 AI 连接</button>
        </div>
      </section>
      <aside class="col-span-12 xl:col-span-4 rounded-lg border border-slate-200 bg-white p-5">
        <div class="font-semibold text-slate-900">当前连接摘要</div>
        <div class="mt-4 space-y-3 text-sm">
          ${summaryRow('服务商', cfg.provider || '-')}
          ${summaryRow('模型', cfg.model || '-')}
          ${summaryRow('接口地址', cfg.base_url || '-')}
          ${summaryRow('密钥状态', cfg.api_key ? '已填写' : '未填写')}
        </div>
        <div class="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">AI 配置属于敏感信息，只保存在当前浏览器，不随业务数据备份到本地文件夹。</div>
      </aside>
    </div>
  `;
}

function renderEngineTab({ engine, experience }) {
  return `
    <section class="rounded-lg border border-slate-200 bg-white p-5">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center">
          <span class="material-symbols-outlined text-[22px]">monitoring</span>
        </div>
        <div>
          <h2 class="text-base font-semibold text-slate-900">数据引擎</h2>
          <p class="mt-1 text-xs text-slate-500">管理自动沉淀、质量扫描和指标重建。候选样本默认不参与指标统计。</p>
        </div>
        <div class="flex-1"></div>
        <button id="btnEngineRun" class="h-10 px-4 text-sm rounded-lg border border-teal-300 bg-white text-teal-700">运行流水线</button>
        <button id="btnEngineBackfill" class="h-10 px-4 text-sm rounded-lg border border-slate-300 bg-white">回填归档项目</button>
        <button id="btnEngineScan" class="h-10 px-4 text-sm rounded-lg border border-slate-300 bg-white">数据质量扫描</button>
        <button id="btnEngineRebuild" class="h-10 px-4 text-sm brand-bg text-white rounded-lg">重建指标</button>
      </div>
      <div class="mt-5 grid grid-cols-6 gap-3">
        ${engineMetric('正式事实', engine.facts.length, '条')}
        ${engineMetric('候选样本', engine.candidates.length, '条')}
        ${engineMetric('质量报告', engine.reports.length, '份')}
        ${engineMetric('健康分', engine.qualityScore || 0, '分')}
        ${engineMetric('经验卡', experience.confirmedCards.length, '张')}
        ${engineMetric('待确认复盘', experience.pendingSessions.length, '个')}
      </div>
      <div class="mt-5 grid grid-cols-12 gap-4">
        <div class="col-span-12 xl:col-span-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div class="font-medium text-slate-800">流水线阶段</div>
          <div class="mt-4 grid grid-cols-5 gap-2">${pipelineStages(engine.stageSummary)}</div>
        </div>
        <div class="col-span-12 xl:col-span-7 rounded-lg border border-slate-200 bg-white overflow-hidden">
          ${jobsTable(engine)}
        </div>
      </div>
    </section>
  `;
}

function renderBackupTab() {
  return `
    <section class="rounded-lg border border-slate-200 bg-white p-5">
      <div class="flex items-start gap-3">
        <div class="h-10 w-10 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 flex items-center justify-center">
          <span class="material-symbols-outlined text-[22px]">cloud_upload</span>
        </div>
        <div>
          <h2 class="text-base font-semibold text-slate-900">备份与恢复</h2>
          <p class="mt-1 text-xs text-slate-500">用于跨电脑迁移、临时留档或从 JSON 备份恢复业务数据。</p>
        </div>
      </div>
      <div class="mt-5 grid grid-cols-3 gap-4">
        ${backupAction('导入 JSON 备份', '导入会覆盖当前定额、项目、清单、版本、指标和 AI 配置。', 'upload_file', 'btnImport')}
        ${backupAction('导出 JSON 备份', '导出当前业务数据，适合迁移或交接前留档。', 'download', 'btnExport')}
        ${backupAction('加载演示数据', '已有业务数据不会被覆盖，用于快速体验系统流程。', 'database', 'btnDemo')}
      </div>
      <div class="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">备份文件包含商业敏感数据，请按企业资料妥善保存。AI Key 仅保存在浏览器 localStorage。</div>
    </section>
  `;
}

function renderDangerTab() {
  return `
    <section class="rounded-lg border border-red-200 bg-red-50/70 p-5">
      <div class="flex items-start gap-3">
        <div class="h-10 w-10 rounded-lg border border-red-200 bg-white text-red-600 flex items-center justify-center">
          <span class="material-symbols-outlined text-[22px]">warning</span>
        </div>
        <div>
          <h2 class="text-base font-semibold text-red-800">危险操作区</h2>
          <p class="mt-1 text-xs text-red-700">以下操作不可逆，请确认已完成备份后再执行。</p>
        </div>
      </div>
      <div class="mt-5 grid grid-cols-3 gap-4">
        ${dangerAction('重置演示数据', '清空当前业务数据后重新加载内置演示数据。', 'restart_alt', 'btnDemoReset')}
        ${dangerAction('清理候选样本', '删除候选样本，不影响正式事实、项目和清单。', 'mop', 'btnEngineClearCandidates')}
        ${dangerAction('清空全部数据', '清空定额、项目、清单、版本、经验卡和指标。', 'delete_forever', 'btnClear')}
      </div>
    </section>
  `;
}

function renderSettingsSummaryCards({ cfg, engine }) {
  return `
    <div class="grid grid-cols-2 gap-4">
      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[20px] text-blue-700">smart_toy</span>
            <div class="font-semibold text-slate-900">AI 模型（当前）</div>
          </div>
          <button data-settings-tab="ai" class="h-8 px-3 text-xs rounded border border-slate-300 bg-white">配置</button>
        </div>
        <div class="mt-4 grid grid-cols-4 gap-3 text-sm">
          ${summaryMetric('服务商', cfg.provider || '-')}
          ${summaryMetric('模型', cfg.model || '-')}
          ${summaryMetric('状态', cfg.api_key ? '已配置' : '未配置')}
          ${summaryMetric('密钥', cfg.api_key ? '已填写' : '空')}
        </div>
      </section>
      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[20px] text-teal-700">monitoring</span>
            <div class="font-semibold text-slate-900">数据引擎</div>
          </div>
          <button data-settings-tab="engine" class="h-8 px-3 text-xs rounded border border-slate-300 bg-white">引擎设置</button>
        </div>
        <div class="mt-4 grid grid-cols-5 gap-3 text-sm">
          ${summaryMetric('运行状态', '运行中')}
          ${summaryMetric('任务队列', engine.jobs.filter(j => j.status !== 'success').length)}
          ${summaryMetric('平均延迟', '0 s')}
          ${summaryMetric('索引完整性', '100%')}
          ${summaryMetric('本次启动', engine.jobs[0]?.updatedAt ? formatTime(engine.jobs[0].updatedAt).slice(0, 10) : '-')}
        </div>
      </section>
    </div>
  `;
}

function bindSettingsEvents() {
  const on = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.onclick = handler;
  };
  const provider = document.getElementById('cfg_prov');
  if (provider) {
    provider.onchange = e => {
      const p = getProviderDefaults(e.target.value);
      if (p) {
        document.getElementById('cfg_url').value = p.base_url;
        document.getElementById('cfg_model').value = p.model;
      }
    };
  }
  on('btnSave', saveAIConfig);
  on('btnTest', testAI);
  on('btnImport', importAll);
  on('btnExport', exportAll);
  on('btnFolderActivate', activateFolder);
  on('btnFolderReconnect', reconnectFolder);
  on('btnFolderSync', syncFolder);
  on('btnBrowserStorage', useBrowserStorage);
  on('btnEngineRun', runEngine);
  on('btnEngineBackfill', backfillEngine);
  on('btnEngineScan', scanEngine);
  on('btnEngineRebuild', rebuildEngine);
  on('btnEngineClearCandidates', clearCandidates);
  on('btnDemo', loadDemo);
  on('btnDemoReset', resetDemo);
  on('btnClear', clearAll);
}

function bindTabEvents() {
  document.querySelectorAll('[data-settings-tab]').forEach(btn => {
    btn.onclick = () => {
      activeSettingsTab = btn.dataset.settingsTab;
      render();
    };
  });
}

function saveAIConfig() {
  setAIConfig({
    provider: document.getElementById('cfg_prov').value,
    base_url: document.getElementById('cfg_url').value.trim(),
    model: document.getElementById('cfg_model').value.trim(),
    api_key: document.getElementById('cfg_key').value.trim(),
    system: document.getElementById('cfg_sys').value.trim(),
  });
  toast('已保存', 'success');
}

async function testAI() {
  saveAIConfig();
  const result = await testAIConnection();
  toast(result.summary, result.confidence === 'high' ? 'success' : 'error');
}

async function activateFolder() {
  try {
    await activateLocalFolderStorage(collectBusinessData);
    toast('已切换为本地文件夹存储', 'success');
    location.reload();
  } catch (err) {
    toast(folderErrorMessage(err) || '选择文件夹失败', 'error');
  }
}

async function reconnectFolder() {
  try {
    await reconnectLocalFolderStorage();
    toast('本地文件夹已重新授权', 'success');
    location.reload();
  } catch (err) {
    toast(folderErrorMessage(err) || '重新授权失败', 'error');
  }
}

async function syncFolder() {
  if (!confirm('将当前浏览器镜像缓存写入已授权文件夹，并在文件夹内生成同步前备份。继续？')) return;
  try {
    await syncBrowserCacheToLocalFolder(await collectBusinessData());
    toast('浏览器缓存已同步到本地文件夹', 'success');
    location.reload();
  } catch (err) {
    toast(folderErrorMessage(err) || '同步失败', 'error');
  }
}

async function useBrowserStorage() {
  if (!confirm('切回浏览器存储后，后续修改只写入 IndexedDB，不再写入本地文件夹。已写入文件夹的数据不会删除。继续？')) return;
  await switchToBrowserStorage();
  toast('已切回浏览器存储', 'success');
  location.reload();
}

async function runEngine() {
  const result = await dataEngineService.runPipeline();
  toast(`流水线完成：健康分 ${result.report.qualityScore}`, result.report.qualityLevel === '低可信' ? 'error' : 'success');
  render();
}

async function backfillEngine() {
  const result = await dataEngineService.backfillArchivedProjects();
  toast(`已回填 ${result.count} 个归档项目`, 'success');
  render();
}

async function scanEngine() {
  const report = await dataEngineService.analyzeQuality({});
  toast(`扫描完成：${report.totalLines} 条清单，${report.qualityLevel}`, report.qualityLevel === '低可信' ? 'error' : 'success');
  render();
}

async function rebuildEngine() {
  await dataEngineService.rebuildIndicators();
  toast('指标已基于正式事实重建', 'success');
  render();
}

async function clearCandidates() {
  if (!confirm('清理全部候选样本？正式事实、项目和清单不会被删除。')) return;
  await dataEngineService.clearCandidates();
  toast('候选样本已清理', 'success');
  render();
}

async function loadDemo() {
  if (!confirm('将加载内置演示数据：定额库 + 3 个示例项目 + 报价版本 + 指标样本。已有业务数据不会被覆盖。')) return;
  const result = await ensureDemoData();
  if (!result.loaded) {
    toast('当前已有业务数据；如需重新体验，请使用「重置演示数据」。', 'success');
    return;
  }
  toast('演示数据已加载', 'success');
  window.__app.go('dashboard');
}

async function resetDemo() {
  if (!confirm('将先清空当前业务数据，再重新加载演示数据。此操作不可撤销，确定继续？')) return;
  await ensureDemoData({ force: true });
  toast('演示数据已重置', 'success');
  window.__app.go('dashboard');
}

async function clearAll() {
  const typed = prompt('此操作会清空所有定额、项目、清单、报价版本、经验卡和指标；不会删除 AI 配置。请输入“清空全部”确认。');
  if (typed !== '清空全部') return;
  await clearBusinessData();
  location.reload();
}

function storageRailGroup(icon, title, rows) {
  return `
    <section class="border-b border-slate-200 last:border-b-0 pb-4 last:pb-0">
      <div class="flex items-center gap-2 font-semibold text-slate-800">
        <span class="material-symbols-outlined text-[20px] text-teal-700">${icon}</span>
        <span>${title}</span>
      </div>
      <div class="mt-3 space-y-3">
        ${rows.map(([label, value, badge]) => `
          <div>
            <div class="text-xs text-slate-500">${esc(label)}</div>
            <div class="mt-1"><span class="badge ${badge}">${esc(value)}</span></div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function fileCheck(label, value, ok) {
  return `
    <div class="px-3 py-3">
      <div class="flex items-center gap-2 text-sm font-medium text-slate-700">
        <span class="material-symbols-outlined text-[18px] ${ok ? 'text-teal-700' : 'text-amber-600'}">${ok ? 'check_circle' : 'pending'}</span>
        ${esc(label)}
      </div>
      <div class="mt-1 text-xs ${ok ? 'text-teal-700' : 'text-amber-600'}">${esc(value)}</div>
    </div>
  `;
}

function directoryTree(storageStatus) {
  const root = storageStatus.directoryName || '本地数据文件夹';
  return `
    <div class="space-y-2">
      <div class="flex items-center gap-2"><span class="material-symbols-outlined text-[17px] text-slate-500">folder</span>${esc(root)}</div>
      <div class="ml-6 space-y-2 border-l border-slate-200 pl-4">
        ${treeFile('manifest.json', '应用清单')}
        <div>
          <div class="flex items-center gap-2"><span class="material-symbols-outlined text-[17px] text-slate-500">folder</span>stores</div>
          <div class="ml-6 mt-2 space-y-2 border-l border-slate-200 pl-4">
            ${treeFile('quota_items.json', '定额库')}
            ${treeFile('projects.json', '项目档案')}
            ${treeFile('project_boq.json', '工程量清单')}
            ${treeFile('boq_versions.json', '报价版本')}
            ${treeFile('...', '其他业务表')}
          </div>
        </div>
        <div class="flex items-center gap-2"><span class="material-symbols-outlined text-[17px] text-slate-500">folder</span>backups <span class="ml-auto text-xs text-slate-400">自动备份</span></div>
      </div>
    </div>
  `;
}

function treeFile(name, hint) {
  return `<div class="flex items-center gap-2"><span class="material-symbols-outlined text-[16px] text-slate-400">description</span><span>${esc(name)}</span><span class="ml-auto text-xs text-slate-400">${esc(hint)}</span></div>`;
}

function inspectorBlock(title, headline, body, icon, color) {
  return `
    <section>
      <div class="flex items-start gap-2">
        <span class="material-symbols-outlined text-[19px] ${color}">${icon}</span>
        <div class="min-w-0">
          <div class="font-semibold text-slate-800">${esc(title)}</div>
          <div class="mt-3 text-sm font-medium text-slate-700">${esc(headline)}</div>
          <div class="mt-1 text-xs leading-5 text-slate-500">${esc(body)}</div>
        </div>
      </div>
    </section>
  `;
}

function restorePoint(label, active) {
  return `<div class="flex items-center gap-2"><span class="h-3 w-3 rounded-full border ${active ? 'border-teal-600 bg-teal-600' : 'border-slate-300'}"></span><span>${esc(label)}</span></div>`;
}

function engineMetric(label, value, unit) {
  return `<div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-xs text-slate-500">${esc(label)}</div>
    <div class="mt-1 text-lg font-semibold tabular-nums text-slate-900">${fmt(value)}<span class="ml-1 text-xs font-normal text-slate-500">${esc(unit)}</span></div>
  </div>`;
}

function pipelineStages(summary = {}) {
  return ['采集', '标准化', '质量检查', '沉淀入库', '指标重建'].map(stage => `
    <div class="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div class="text-xs text-slate-500">${stage}</div>
      <div class="mt-1 text-base font-semibold tabular-nums text-slate-900">${fmt(summary[stage] || 0)}<span class="ml-1 text-xs font-normal text-slate-500">次</span></div>
    </div>
  `).join('');
}

function jobsTable(engine) {
  return `
    <table class="w-full text-sm">
      <thead class="bg-slate-50 text-left text-slate-500"><tr><th class="py-2 px-3">最近任务</th><th class="px-2">来源</th><th class="px-2">状态</th><th class="px-2 text-right">质量分</th><th class="px-3 text-right">时间</th></tr></thead>
      <tbody>
        ${engine.jobs.length ? engine.jobs.map(job => `<tr class="border-t border-slate-100">
          <td class="py-2 px-3 font-medium">${esc(job.type)}</td>
          <td class="px-2 text-slate-500">${esc(job.sourceType || '')}</td>
          <td class="px-2"><span class="badge ${job.status === 'success' ? 'badge-green' : 'badge-gray'}">${esc(job.status || '-')}</span></td>
          <td class="px-2 text-right tabular-nums">${job.qualityScore == null ? '-' : fmt(job.qualityScore)}</td>
          <td class="px-3 text-right text-slate-500 tabular-nums">${esc(formatTime(job.updatedAt || job.createdAt))}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="py-8 text-center text-slate-400">暂无数据引擎任务。</td></tr>`}
      </tbody>
    </table>
  `;
}

function backupAction(title, body, icon, id) {
  return `
    <button id="${id}" class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-left hover:bg-white">
      <span class="material-symbols-outlined text-[22px] text-teal-700">${icon}</span>
      <span class="mt-3 block font-semibold text-slate-900">${esc(title)}</span>
      <span class="mt-1 block text-xs leading-5 text-slate-500">${esc(body)}</span>
    </button>
  `;
}

function dangerAction(title, body, icon, id) {
  return `
    <button id="${id}" class="rounded-lg border border-red-200 bg-white p-4 text-left text-red-700 hover:bg-red-50">
      <span class="material-symbols-outlined text-[22px]">${icon}</span>
      <span class="mt-3 block font-semibold">${esc(title)}</span>
      <span class="mt-1 block text-xs leading-5">${esc(body)}</span>
    </button>
  `;
}

function summaryMetric(label, value) {
  return `<div class="border-l border-slate-200 pl-3 first:border-l-0 first:pl-0">
    <div class="text-xs text-slate-500">${esc(label)}</div>
    <div class="mt-1 font-semibold text-slate-900 truncate">${esc(value)}</div>
  </div>`;
}

function summaryRow(label, value) {
  return `<div class="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-b-0">
    <span class="text-slate-500">${esc(label)}</span>
    <span class="font-medium text-slate-900 text-right break-all">${esc(value)}</span>
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

function formatTime(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

async function getBrowserStorageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return { label: '浏览器未提供' };
  try {
    const estimate = await navigator.storage.estimate();
    if (!estimate.quota) return { label: '浏览器未提供' };
    const used = formatBytes(estimate.usage || 0);
    const quota = formatBytes(estimate.quota || 0);
    return { label: `${used} / ${quota}` };
  } catch {
    return { label: '浏览器未提供' };
  }
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
