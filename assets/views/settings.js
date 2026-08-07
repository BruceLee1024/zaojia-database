// 视图：数据与备份
import { AI_SYSTEM_PROMPT_PRESETS, getAIConfig, getAISystemPromptPreset, setAIConfig, listProviders, getProviderDefaults } from '../services/aiService.js?v=6.12';
import { generateSystemPromptDraft } from '../services/aiPromptService.js?v=6.12';
import { testAIConnection } from '../services/aiAssistService.js?v=6.12';
import { dataEngineService } from '../services/dataEngineService.js?v=6.12';
import { experienceService } from '../services/experienceService.js?v=6.12';
import { STORES, dbGetAll } from '../data/repository.js?v=6.12';
import { activateLocalFolderStorage, getStorageStatus, reconnectLocalFolderStorage, setDataProfile, storageGetAttachment, storageGetCache, storageRemoveAttachment, storageSetAttachment, storageSetStrict, switchToBrowserStorage, syncBrowserCacheToLocalFolder, withFolderMirrorSuspended } from '../data/storage.js?v=6.12';
import { clearBackupData, createLegacyJsonBackup, createZipBackup, parseLegacyJsonBackupFile, restoreLegacyJsonBackup, restoreZipBackup } from '../services/backupService.js?v=6.12';
import { ensureDemoData, removeDemoData } from '../data/demo.js?v=6.12';
import { esc, toast, fmt, scopedDom } from '../utils/dom.js?v=6.12';

const SETTINGS_TABS = [
  { id: 'storage', label: '数据保存', icon: 'folder_managed', desc: '本地数据' },
  { id: 'ai', label: 'AI 模型配置', icon: 'smart_toy', desc: '智能问答' },
  { id: 'engine', label: '数据整理', icon: 'monitoring', desc: '案例与参考' },
  { id: 'backup', label: '备份与恢复', icon: 'cloud_upload', desc: '迁移资料' },
  { id: 'danger', label: '清理操作', icon: 'warning', desc: '谨慎维护' },
];

let activeSettingsTab = 'storage';
export const BACKUP_IMPORT_ACCEPT = '.json,.zip,application/json,application/zip';

const backupAdapter = {
  getStore: dbGetAll,
  setStore: storageSetStrict,
  getAttachment: storageGetAttachment,
  setAttachment: storageSetAttachment,
  removeAttachment: storageRemoveAttachment,
  getCacheStore: storageGetCache,
  runCacheOnly: withFolderMirrorSuspended,
};

export async function render(workspace = document.getElementById('workspace')) {
  const cfg = getAIConfig();
  const providers = listProviders();
  const [engine, experience, storageStatus, storageEstimate] = await Promise.all([
    dataEngineService.dashboard(),
    experienceService.dashboard(),
    getStorageStatus(),
    getBrowserStorageEstimate(),
  ]);
  const ctx = { cfg, providers, engine, experience, storageStatus, storageEstimate };
  workspace.innerHTML = `
    <div class="page-frame space-y-4">
      ${settingsTabs()}
      ${renderActiveTab(ctx)}
    </div>
  `;
  const document = scopedDom(workspace);
  bindSettingsEvents(document);
  bindTabEvents(document);
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
          ['当前资料库', storageStatus.profile === 'demo' ? '演示资料库' : '个人资料库', storageStatus.profile === 'demo' ? 'badge-blue' : 'badge-green'],
          ['存储引擎', storageStatus.mode === 'folder' ? 'JSON 文件 + IndexedDB 镜像' : 'IndexedDB', 'badge-blue'],
          ['可用空间', storageEstimate.label, 'badge-gray'],
        ])}
        ${storageRailGroup('verified_user', '文件夹授权', [
          ['授权状态', permissionLabel(storageStatus.permission), storageStatus.connected ? 'badge-green' : 'badge-yellow'],
          ['授权路径', storageStatus.directoryName || '未选择', 'badge-gray'],
        ])}
        ${storageRailGroup('sync', '最近同步', [
          ['同步状态', storageStatus.pendingSync ? '待同步' : '同步正常', storageStatus.pendingSync ? 'badge-yellow' : 'badge-green'],
          ['上次成功', formatTime(storageStatus.syncMeta?.lastSuccessAt), 'badge-gray'],
          ['失败原因', storageStatus.syncMeta?.error || '-', storageStatus.pendingSync ? 'badge-yellow' : 'badge-gray'],
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
            <button id="btnPersonalProfile" class="h-10 px-4 text-sm rounded-lg border ${storageStatus.profile === 'personal' ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-slate-300 bg-white text-slate-700'}">个人资料库</button>
            <button id="btnDemoProfile" class="h-10 px-4 text-sm rounded-lg border ${storageStatus.profile === 'demo' ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-slate-300 bg-white text-slate-700'}">演示资料库</button>
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
        ${inspectorBlock('授权说明', '授权仅在当前浏览器生效', '若更换浏览器或清除站点数据，需要重新授权并同步数据。', 'info', 'text-slate-500')}
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
  const promptCount = (cfg.system || '').length;
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
          <section class="col-span-2 rounded-lg border border-slate-200 bg-slate-50/70 p-4" aria-labelledby="system-prompt-title">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="system-prompt-title" class="text-sm font-semibold text-slate-800">系统提示词 <span class="font-normal text-slate-400">（可自由编辑）</span></h3>
                <p id="cfg_sys_help" class="mt-1 text-xs leading-5 text-slate-500">它决定 AI 的角色、回答边界和输出方式。选择模板只会填入编辑框，保存后才会生效。</p>
              </div>
              <span class="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500"><span class="material-symbols-outlined text-[15px]">devices</span>仅保存在当前浏览器</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2" aria-label="提示词起始模板">
              <button id="btnPromptGenerateToggle" type="button" class="h-8 rounded-md border border-teal-300 bg-teal-50 px-3 text-xs font-medium text-teal-800 hover:bg-teal-100"><span class="material-symbols-outlined mr-1 text-[15px]">auto_awesome</span>AI 帮我生成</button>
              ${Object.entries(AI_SYSTEM_PROMPT_PRESETS).map(([key, preset]) => `
                <button type="button" data-ai-prompt-template="${key}" class="h-8 rounded-md border border-slate-300 bg-white px-3 text-xs text-slate-700 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800" title="${esc(preset.description)}">${esc(preset.label)}</button>
              `).join('')}
            </div>
            <section id="promptGenerator" class="hidden mt-3 rounded-lg border border-teal-200 bg-white p-3" aria-labelledby="prompt-generator-title">
              <div class="flex items-start gap-2">
                <span class="material-symbols-outlined text-[18px] text-teal-700">auto_awesome</span>
                <div class="min-w-0 flex-1">
                  <h4 id="prompt-generator-title" class="text-xs font-semibold text-slate-800">让 AI 生成提示词草案</h4>
                  <p class="mt-0.5 text-xs leading-5 text-slate-500">仅发送以下填写内容；勾选后才会附带当前编辑框中的提示词。生成结果不会自动保存。</p>
                </div>
              </div>
              <div class="mt-3 grid grid-cols-2 gap-3 text-xs">
                <label class="col-span-2 block font-medium text-slate-600">希望 AI 协助什么？<span class="text-red-500"> *</span>
                  <textarea id="promptGenScenario" rows="2" class="mt-1 w-full resize-y rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-700" placeholder="例如：污水厂投标报价复核，重点检查漏项、异常工程量和定额匹配"></textarea>
                </label>
                <label class="block font-medium text-slate-600">重点关注（可选）
                  <input id="promptGenFocus" class="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-700" placeholder="例如：风险分级、数据依据" />
                </label>
                <label class="block font-medium text-slate-600">回答风格
                  <select id="promptGenStyle" class="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-700">
                    <option value="detailed">完整分析</option><option value="concise">简洁结论</option><option value="table">对比表格优先</option>
                  </select>
                </label>
              </div>
              <label class="mt-3 flex items-start gap-2 text-xs text-slate-600"><input id="promptGenUseCurrent" type="checkbox" class="mt-0.5" />基于当前编辑框内容优化 <span class="text-slate-400">（勾选后该文本会发送给 AI）</span></label>
              <div class="mt-3 flex items-center gap-2"><button id="btnPromptGenerate" type="button" class="h-8 rounded-md bg-teal-700 px-3 text-xs text-white hover:bg-teal-800"><span class="material-symbols-outlined mr-1 text-[15px]">auto_awesome</span>生成草案</button><span id="promptGenStatus" class="text-xs text-slate-400"></span></div>
              <section id="promptDraftPanel" class="hidden mt-3 border-t border-slate-100 pt-3">
                <div class="flex items-center justify-between gap-3"><div class="text-xs font-semibold text-slate-700">生成的提示词草案</div><button id="btnPromptApplyDraft" type="button" class="h-7 rounded-md border border-teal-300 bg-white px-2 text-xs text-teal-700">应用到编辑框</button></div>
                <textarea id="promptDraft" rows="8" readonly class="mt-2 w-full resize-y rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5 font-mono text-xs leading-5 text-slate-700"></textarea>
              </section>
            </section>
            <label class="mt-3 block text-xs font-medium text-slate-600" for="cfg_sys">提示词内容</label>
            <textarea id="cfg_sys" rows="13" class="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs leading-5 text-slate-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" aria-describedby="cfg_sys_help cfg_sys_count">${esc(cfg.system)}</textarea>
            <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span id="cfg_sys_count" class="text-slate-400">${promptCount} 个字符</span>
              <button id="btnPromptReset" type="button" class="inline-flex items-center gap-1 text-slate-600 hover:text-teal-700"><span class="material-symbols-outlined text-[16px]">restart_alt</span>恢复推荐默认</button>
            </div>
          </section>
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
        <div class="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">AI 配置只保存在当前浏览器，不会随业务资料备份到本地文件夹。</div>
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
          <h2 class="text-base font-semibold text-slate-900">数据整理与指标</h2>
          <p class="mt-1 text-xs text-slate-500">查看案例整理、质量检查和参考重建。待检查记录默认不参与造价参考。</p>
        </div>
        <div class="flex-1"></div>
        <button id="btnEngineRun" class="h-10 px-4 text-sm rounded-lg border border-teal-300 bg-white text-teal-700">运行流水线</button>
        <button id="btnEngineBackfill" class="h-10 px-4 text-sm rounded-lg border border-slate-300 bg-white">整理已收录案例</button>
        <button id="btnEngineScan" class="h-10 px-4 text-sm rounded-lg border border-slate-300 bg-white">数据质量扫描</button>
        <button id="btnEngineRebuild" class="h-10 px-4 text-sm brand-bg text-white rounded-lg">重建指标</button>
      </div>
      <div class="mt-5 grid grid-cols-6 gap-3">
        ${engineMetric('可用案例', engine.facts.length, '条')}
        ${engineMetric('待检查记录', engine.candidates.length, '条')}
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
          <p class="mt-1 text-xs text-slate-500">用于跨电脑迁移、临时留档或恢复业务数据。</p>
        </div>
      </div>
      <div class="mt-5 grid grid-cols-2 xl:grid-cols-4 gap-4">
        ${backupAction('恢复备份', '接受旧 JSON 或完整 ZIP；恢复前会先校验全部内容。', 'upload_file', 'btnImport')}
        ${backupAction('导出完整 ZIP', '包含所有业务数据、校验清单和附件原文件。', 'folder_zip', 'btnExportZip')}
        ${backupAction('导出兼容 JSON', '不包含附件二进制，仅用于兼容旧版和轻量留档。', 'download', 'btnExport')}
        ${backupAction('加载演示数据', '包含项目、定额、材料、设备与价格快照；仅在资料库为空时加载。', 'database', 'btnDemo')}
      </div>
      <div class="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">ZIP 才是可完整迁移附件的备份；JSON 中只有附件元数据。备份包含敏感业务资料，请妥善保存。任何备份都不会导出或覆盖当前设备的 API Key。</div>
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
        ${dangerAction('清理演示数据', '仅删除系统示例项目、定额、材料、设备、价格及派生记录，不影响客户资料。', 'restart_alt', 'btnDemoClear')}
        ${dangerAction('清理待检查记录', '删除待检查记录，不影响可用案例、项目和清单。', 'mop', 'btnEngineClearCandidates')}
        ${dangerAction('清空全部数据', '清空所有业务记录与附件原文件。', 'delete_forever', 'btnClear')}
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
            <div class="font-semibold text-slate-900">数据整理记录</div>
          </div>
          <button data-settings-tab="engine" class="h-8 px-3 text-xs rounded border border-slate-300 bg-white">查看整理记录</button>
        </div>
        <div class="mt-4 grid grid-cols-5 gap-3 text-sm">
          ${summaryMetric('运行状态', '运行中')}
          ${summaryMetric('待处理记录', engine.jobs.filter(j => j.status !== 'success').length)}
          ${summaryMetric('平均延迟', '0 s')}
          ${summaryMetric('索引完整性', '100%')}
          ${summaryMetric('本次启动', engine.jobs[0]?.updatedAt ? formatTime(engine.jobs[0].updatedAt).slice(0, 10) : '-')}
        </div>
      </section>
    </div>
  `;
}

function bindSettingsEvents(document = globalThis.document) {
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
  const systemPrompt = document.getElementById('cfg_sys');
  if (systemPrompt) {
    systemPrompt.oninput = () => updateSystemPromptCount(document);
  }
  document.querySelectorAll('[data-ai-prompt-template]').forEach(button => {
    button.onclick = () => applySystemPromptTemplate(button.dataset.aiPromptTemplate, document);
  });
  on('btnPromptGenerateToggle', () => togglePromptGenerator(document));
  on('btnPromptGenerate', () => generatePromptDraft(document));
  on('btnPromptApplyDraft', () => applyPromptDraft(document));
  on('btnPromptReset', () => applySystemPromptTemplate('general', document));
  on('btnSave', () => saveAIConfig(document));
  on('btnTest', () => testAI(document));
  on('btnImport', importAll);
  on('btnExport', exportAll);
  on('btnExportZip', exportZip);
  on('btnFolderActivate', activateFolder);
  on('btnPersonalProfile', () => switchDataProfile('personal'));
  on('btnDemoProfile', () => switchDataProfile('demo'));
  on('btnFolderReconnect', reconnectFolder);
  on('btnFolderSync', syncFolder);
  on('btnBrowserStorage', useBrowserStorage);
  on('btnEngineRun', runEngine);
  on('btnEngineBackfill', backfillEngine);
  on('btnEngineScan', scanEngine);
  on('btnEngineRebuild', rebuildEngine);
  on('btnEngineClearCandidates', clearCandidates);
  on('btnDemo', loadDemo);
  on('btnDemoClear', clearDemo);
  on('btnClear', clearAll);
}

function bindTabEvents(document = globalThis.document) {
  document.querySelectorAll('[data-settings-tab]').forEach(btn => {
    btn.onclick = () => {
      activeSettingsTab = btn.dataset.settingsTab;
      render();
    };
  });
}

function saveAIConfig(document = globalThis.document) {
  const system = document.getElementById('cfg_sys').value.trim();
  if (!system) {
    toast('系统提示词不能为空；你可以自行编辑，或恢复推荐默认。', 'error');
    document.getElementById('cfg_sys').focus();
    return false;
  }
  setAIConfig({
    provider: document.getElementById('cfg_prov').value,
    base_url: document.getElementById('cfg_url').value.trim(),
    model: document.getElementById('cfg_model').value.trim(),
    api_key: document.getElementById('cfg_key').value.trim(),
    system,
  });
  toast('AI 配置已保存', 'success');
  return true;
}

async function testAI(document = globalThis.document) {
  if (!saveAIConfig(document)) return;
  const result = await testAIConnection();
  toast(result.summary, result.confidence === 'high' ? 'success' : 'error');
}

function updateSystemPromptCount(document = globalThis.document) {
  const prompt = document.getElementById('cfg_sys');
  const count = document.getElementById('cfg_sys_count');
  if (prompt && count) count.textContent = `${prompt.value.length} 个字符`;
}

function applySystemPromptTemplate(key, document = globalThis.document) {
  const prompt = document.getElementById('cfg_sys');
  if (!prompt) return;
  const next = getAISystemPromptPreset(key);
  const saved = getAIConfig().system || '';
  if (prompt.value.trim() && prompt.value.trim() !== saved.trim() && !confirm('替换会覆盖当前未保存的提示词修改。是否继续？')) return;
  prompt.value = next;
  updateSystemPromptCount(document);
  prompt.focus();
  toast('已填入模板；请检查或继续编辑后保存。', 'success');
}

function togglePromptGenerator(document = globalThis.document) {
  const generator = document.getElementById('promptGenerator');
  if (!generator) return;
  generator.classList.toggle('hidden');
  if (!generator.classList.contains('hidden')) document.getElementById('promptGenScenario')?.focus();
}

async function generatePromptDraft(document = globalThis.document) {
  const scenario = document.getElementById('promptGenScenario')?.value.trim();
  const focus = document.getElementById('promptGenFocus')?.value.trim();
  const responseStyle = document.getElementById('promptGenStyle')?.value;
  const includeCurrent = document.getElementById('promptGenUseCurrent')?.checked;
  const current = document.getElementById('cfg_sys')?.value.trim() || '';
  const status = document.getElementById('promptGenStatus');
  const button = document.getElementById('btnPromptGenerate');
  if (!scenario) {
    toast('请先填写希望 AI 协助的工作场景。', 'error');
    document.getElementById('promptGenScenario')?.focus();
    return;
  }
  if (!getAIConfig().api_key) {
    toast('请先填写并保存 API Key，再使用 AI 生成提示词。', 'error');
    document.getElementById('cfg_key')?.focus();
    return;
  }
  const scope = includeCurrent ? '使用场景、关注重点、回答风格和当前提示词' : '使用场景、关注重点和回答风格';
  if (!confirm(`将发送给已配置的 AI 服务：${scope}。不会发送项目、清单、定额、报价或 API Key。是否生成草案？`)) return;
  button.disabled = true;
  button.classList.add('opacity-60');
  if (status) status.textContent = '正在生成草案…';
  try {
    const draft = await generateSystemPromptDraft({ scenario, focus, responseStyle, basePrompt: includeCurrent ? current : '' });
    document.getElementById('promptDraft').value = draft;
    document.getElementById('promptDraftPanel').classList.remove('hidden');
    if (status) status.textContent = '草案已生成，请检查后应用。';
  } catch (err) {
    if (status) status.textContent = '';
    toast(err.message || '生成提示词草案失败，请重试。', 'error');
  } finally {
    button.disabled = false;
    button.classList.remove('opacity-60');
  }
}

function applyPromptDraft(document = globalThis.document) {
  const draft = document.getElementById('promptDraft')?.value.trim();
  const prompt = document.getElementById('cfg_sys');
  if (!draft || !prompt) return;
  const saved = getAIConfig().system || '';
  if (prompt.value.trim() && prompt.value.trim() !== saved.trim() && !confirm('应用草案会覆盖当前未保存的提示词修改。是否继续？')) return;
  prompt.value = draft;
  updateSystemPromptCount(document);
  prompt.focus();
  toast('草案已应用到编辑框；请检查后保存。', 'success');
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

async function switchDataProfile(profile) {
  if (!confirm(`切换到${profile === 'demo' ? '演示' : '个人'}资料库？两个资料库相互隔离，不会删除当前资料。`)) return;
  setDataProfile(profile);
  toast(`已切换到${profile === 'demo' ? '演示' : '个人'}资料库`, 'success');
  location.reload();
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
  toast(`已整理 ${result.count} 个收录案例`, 'success');
  render();
}

async function scanEngine() {
  const report = await dataEngineService.analyzeQuality({});
  toast(`扫描完成：${report.totalLines} 条清单，${report.qualityLevel}`, report.qualityLevel === '低可信' ? 'error' : 'success');
  render();
}

async function rebuildEngine() {
  await dataEngineService.rebuildIndicators();
  toast('造价参考已基于可用案例重建', 'success');
  render();
}

async function clearCandidates() {
  if (!confirm('清理全部待检查记录？可用案例、项目和清单不会被删除。')) return;
  await dataEngineService.clearCandidates();
  toast('待检查记录已清理', 'success');
  render();
}

async function loadDemo() {
  if (!confirm('将加载内置演示数据：定额库、材料设备库、3 个示例项目、价格快照、报价版本和指标样本。为避免与个人资料混用，资料库必须为空。')) return;
  const result = await ensureDemoData();
  if (!result.loaded) {
    toast('当前正式资料库不为空，演示数据未加载。请使用单独的浏览器资料库体验，或先备份并清理演示数据。', 'error');
    return;
  }
  toast('演示数据已加载', 'success');
  window.__app.go('dashboard');
}

async function clearDemo() {
  if (!confirm('仅清理系统内置演示资料及其派生记录，客户项目、定额、清单和附件不会删除。确定继续？')) return;
  try {
    const result = await removeDemoData();
    toast(result.removedProjects ? '演示数据已清理，客户资料保持不变。' : '没有检测到演示数据。', 'success');
    window.__app.go('importer');
  } catch (error) {
    toast(backupOperationErrorMessage(error, '清理演示数据'), 'error');
  }
}

async function clearAll() {
  const typed = prompt('此操作会清空所有业务数据和附件原文件；不会删除 AI 配置。请输入“清空全部”确认。');
  if (typed !== '清空全部') return;
  await runDestructiveDataAction({
    action: '清空全部数据',
    clear: clearBusinessData,
    afterClear: () => location.reload(),
    notify: toast,
  });
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
            ${treeFile('boq_library_items.json', '清单库')}
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
  return ['采集', '标准化', '质量检查', '保存记录', '参考重建'].map(stage => `
    <div class="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div class="text-xs text-slate-500">${stage}</div>
      <div class="mt-1 text-base font-semibold tabular-nums text-slate-900">${fmt(summary[stage] || 0)}<span class="ml-1 text-xs font-normal text-slate-500">次</span></div>
    </div>
  `).join('');
}

function jobsTable(engine) {
  return `
    <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-slate-500"><tr><th class="py-2 px-3">最近记录</th><th class="px-2">来源</th><th class="px-2">状态</th><th class="px-2 text-right">质量分</th><th class="px-3 text-right">时间</th></tr></thead>
      <tbody>
        ${engine.jobs.length ? engine.jobs.map(job => `<tr class="border-t border-slate-100">
          <td class="py-2 px-3 font-medium">${esc(job.type)}</td>
          <td class="px-2 text-slate-500">${esc(job.sourceType || '')}</td>
          <td class="px-2"><span class="badge ${job.status === 'success' ? 'badge-green' : 'badge-gray'}">${esc(job.status || '-')}</span></td>
          <td class="px-2 text-right tabular-nums">${job.qualityScore == null ? '-' : fmt(job.qualityScore)}</td>
          <td class="px-3 text-right text-slate-500 tabular-nums">${esc(formatTime(job.updatedAt || job.createdAt))}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="py-8 text-center text-slate-400">暂无数据整理记录。</td></tr>`}
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
  input.accept = BACKUP_IMPORT_ACCEPT;
  input.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('恢复会覆盖当前业务数据与附件；当前设备的 API Key 不会被导入或覆盖。建议先导出完整 ZIP。确定恢复？')) return;
    try {
      if (file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip') {
        await restoreZipBackup(file, backupAdapter, { currentAI: getAIConfig(), setAI: setAIConfig });
      } else {
        await restoreLegacyJsonBackup(await parseLegacyJsonBackupFile(file), backupAdapter, { currentAI: getAIConfig(), setAI: setAIConfig });
      }
    } catch (err) {
      const partial = err?.code === 'BACKUP_RECOVERY_PARTIAL' ? '（数据可能仅部分恢复，请立即停止操作并检查备份）' : '';
      toast(`导入失败：${err?.message || '备份无法解析'}${partial}`, 'error');
      return;
    }
    toast('导入完成', 'success');
    location.reload();
  };
  input.click();
}

async function clearBusinessData() {
  await clearBackupData(backupAdapter);
}

async function exportAll() {
  await runBackupExport({
    label: 'JSON 备份',
    create: async () => new Blob([JSON.stringify(await createLegacyJsonBackup(backupAdapter, getAIConfig()), null, 2)], { type: 'application/json' }),
    download: blob => downloadBackupBlob(blob, `造价数据库备份-${Date.now()}.json`),
    notify: toast,
  });
}

async function exportZip() {
  await runBackupExport({
    label: 'ZIP 备份',
    create: () => createZipBackup(backupAdapter, getAIConfig()),
    download: blob => downloadBackupBlob(blob, `造价数据库完整备份-${Date.now()}.zip`),
    notify: toast,
  });
}

export function downloadBackupBlob(blob, fileName, dependencies = {}) {
  const documentApi = dependencies.document || document;
  const urlApi = dependencies.URL || URL;
  const schedule = dependencies.schedule || (callback => setTimeout(callback, 0));
  const a = documentApi.createElement('a');
  const url = urlApi.createObjectURL(blob);
  a.href = url;
  a.download = fileName;
  a.click();
  schedule(() => urlApi.revokeObjectURL(url));
}

export function backupOperationErrorMessage(error, action) {
  if (error?.code === 'BACKUP_RECOVERY_PARTIAL' || error?.code === 'STORAGE_STRICT_RECOVERY_PARTIAL') {
    return `${action}失败：补偿未完成，数据可能仅部分恢复。请立即停止操作并检查备份。`;
  }
  if (error?.code === 'BACKUP_CLEAR_FAILED' || error?.code === 'BACKUP_RESET_FAILED' || error?.code === 'BACKUP_RESTORE_FAILED' || error?.code === 'STORAGE_STRICT_WRITE_FAILED') {
    return `${action}失败：原数据已恢复。`;
  }
  return `${action}失败：${error?.message || '未知错误'}`;
}

export async function runBackupExport({ label, create, download, notify }) {
  try {
    download(await create());
    return true;
  } catch (error) {
    notify(`${label} 导出失败：${error?.message || '备份数据无效'}`, 'error');
    return false;
  }
}

export async function runDestructiveDataAction({ action, clear, afterClear, notify }) {
  try {
    await clear();
    await afterClear();
    return true;
  } catch (error) {
    notify(backupOperationErrorMessage(error, action), 'error');
    return false;
  }
}

async function collectBusinessData() {
  return Object.fromEntries(await Promise.all(Object.values(STORES).map(async store => [store, await dbGetAll(store)])));
}
