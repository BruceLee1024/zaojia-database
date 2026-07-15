// 应用入口：路由 + 启动
import * as dashboard from './assets/views/dashboard.js?v=6.2';
import * as importer  from './assets/views/importer.js?v=6.2';
import * as quota     from './assets/views/quota.js?v=6.2';
import * as projects  from './assets/views/projects.js?v=6.2';
import * as boq       from './assets/views/boq.js?v=6.2';
import * as indicators from './assets/views/indicators.js?v=6.2';
import * as experience from './assets/views/experience.js?v=6.2';
import * as settings  from './assets/views/settings.js?v=6.2';
import * as ai        from './assets/views/ai.js?v=6.2';
import * as resources from './assets/views/resources.js?v=6.2';
import { ensureDemoData } from './assets/data/demo.js?v=6.2';
import { searchAll, searchGroups } from './assets/services/globalSearchService.js?v=6.2';
import { smartSearch } from './assets/services/aiAssistService.js?v=6.2';
import { getStorageStatus } from './assets/data/storage.js?v=6.2';
import { openModal, closeModal, esc } from './assets/utils/dom.js?v=6.2';
import { ICONS } from './assets/utils/icons.js?v=6.2';
import { navigationItemHtml } from './assets/views/navigation.js?v=6.2';
import { createLatestCoordinator, createSerializedKeyCoordinator } from './assets/utils/requestCoordinator.js?v=6.2';

const VIEWS = [
  { id: 'dashboard',  label: '我的概览',   icon: ICONS.navigation.overview, group: '我的工作台', desc: '继续最近工作' },
  { id: 'importer',   label: '导入资料',   icon: ICONS.navigation.import, group: '我的工作台', desc: '清单、定额与备份' },
  { id: 'ai-import',  label: 'AI 导入',    icon: ICONS.resource.ai, group: '我的工作台', desc: '自由格式清单识别', hidden: true },
  { id: 'quota',      label: '我的定额库', icon: ICONS.navigation.quota, group: '我的工作台', desc: '常用价格参考' },
  { id: 'materials',  label: '我的材料库', icon: ICONS.navigation.materials, group: '我的工作台', desc: '材料主数据与价格' },
  { id: 'equipment',  label: '我的设备库', icon: ICONS.navigation.equipment, group: '我的工作台', desc: '设备选型与价格' },
  { id: 'resource-import', label: '导入材料设备', icon: ICONS.navigation.import, group: '我的工作台', desc: '预览并写入资源库', hidden: true },
  { id: 'boq-library', label: '我的清单库', icon: ICONS.navigation.boqLibrary, group: '我的工作台', desc: '通用清单复用' },
  { id: 'projects',   label: '我的项目',   icon: ICONS.navigation.projects, group: '我的工作台', desc: '项目资料与案例' },
  { id: 'boq',        label: '工程量清单', icon: ICONS.navigation.boq, group: '工作台', desc: '报价编制' },
  { id: 'indicators', label: '造价参考',   icon: ICONS.navigation.indicators, group: '工作台', desc: '案例与指标' },
  { id: 'experience', label: '复盘笔记',   icon: ICONS.navigation.experience, group: '个人积累', desc: '记录可复用经验' },
  { id: 'settings',   label: '数据与备份', icon: ICONS.navigation.settings, group: '个人积累', desc: '本地存储与维护' },
];

const state = {
  currentView: 'importer',
  currentProjectId: null,
  routeParams: {},
};

const renderers = {
  dashboard, importer, quota, projects, boq, indicators, experience, settings,
  materials: resources,
  equipment: resources,
  'resource-import': {
    render: async () => {
      const module = await import('./assets/views/resourceImport.js?v=6.2');
      return module.render();
    },
  },
  'boq-library': {
    render: async () => {
      const module = await import('./assets/views/boqLibrary.js?v=6.2');
      return module.render();
    },
  },
  'ai-import': {
    render: async () => {
      const module = await import('./assets/views/aiImportWizard.js?v=6.2');
      return module.render();
    },
  },
};
let lastSearchResults = [];
let routeGeneration = 0;
const routeCoordinator = createSerializedKeyCoordinator();
const searchCoordinator = createLatestCoordinator();

function renderNav() {
  const groups = [...new Set(VIEWS.map(v => v.group))];
  document.getElementById('nav').innerHTML = groups.map(group => `
    <div class="nav-section-title">${group}</div>
    <div class="space-y-1.5">
      ${VIEWS.filter(v => v.group === group && !v.hidden).map(v => navigationItemHtml(v, state.currentView === v.id)).join('')}
    </div>
  `).join('');
  document.querySelectorAll('[data-go]').forEach(el => el.onclick = () => go(el.dataset.go));
}

async function go(view, params = {}) {
  state.currentView = view;
  state.routeParams = params || {};
  if (view === 'boq' && params.projectId) state.currentProjectId = params.projectId;
  renderNav();
  const generation = ++routeGeneration;
  return renderWorkspace(generation);
}

async function renderWorkspace(generation = ++routeGeneration) {
  return routeCoordinator.run('workspace', async () => {
    if (generation !== routeGeneration) return false;
    const current = VIEWS.find(x => x.id === state.currentView) || VIEWS[0];
    document.getElementById('crumb').textContent = current.label || '';
    const crumbIcon = document.getElementById('crumbIcon');
    const crumbGroup = document.getElementById('crumbGroup');
    const crumbDesc = document.getElementById('crumbDesc');
    if (crumbIcon) crumbIcon.textContent = current.icon || 'dashboard';
    if (crumbGroup) crumbGroup.textContent = current.group || '';
    if (crumbDesc) crumbDesc.textContent = current.desc || '';
    const v = state.currentView;
    if (v === 'ai') return ai.open();
    ai.close();
    const r = renderers[v];
    if (!r || !r.render) return;
    try {
      await r.render();
    } catch (err) {
      if (generation !== routeGeneration) return false;
      console.error(`[render:${v}]`, err);
      renderErrorState(current, err);
    }
    return generation === routeGeneration;
  });
}

function renderErrorState(current, err) {
  const message = err?.message || String(err || '未知错误');
  document.getElementById('workspace').innerHTML = `
    <div class="min-h-full flex items-center justify-center p-6">
      <section class="max-w-xl w-full rounded-lg border border-red-200 bg-white p-6 text-center">
        <div class="mx-auto h-12 w-12 rounded-lg border border-red-200 bg-red-50 text-red-600 flex items-center justify-center">
          <span class="material-symbols-outlined icon-empty">${ICONS.status.error}</span>
        </div>
        <h1 class="mt-4 text-lg font-semibold text-slate-900">${escapeHtml(current.label || '当前页面')} 加载失败</h1>
        <p class="mt-2 text-sm leading-6 text-slate-500">页面渲染时遇到错误，已保留控制台日志，主内容不再停留在旧页面。</p>
        <div class="mt-4 rounded border border-red-100 bg-red-50 px-3 py-2 text-left text-xs font-data text-red-700 break-words">${escapeHtml(message)}</div>
        <div class="mt-5 flex justify-center gap-2">
          <button onclick="window.__app.go(window.__app.state.currentView)" class="h-9 px-4 text-sm brand-bg text-white">重试当前页</button>
          <button onclick="window.__app.go('importer')" class="h-9 px-4 text-sm border border-slate-300 bg-white text-slate-700">回到数据导入</button>
        </div>
      </section>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function exportAll() {
  import('./assets/views/settings.js?v=6.2').then(m => m.triggerExportBackup());
  go('settings');
}

async function renderStorageBadge() {
  const status = await getStorageStatus();
  const label = status.mode === 'folder'
    ? `本地文件夹${status.connected ? '' : ' · 待授权'}`
    : 'IndexedDB';
  const fullLabel = status.mode === 'folder'
    ? `数据保存在本机 · ${label}`
    : '数据保存在本机 · 浏览器存储';
  const sidebar = document.getElementById('sidebarStorageLabel');
  const footer = document.getElementById('footerStorageLabel');
  const header = document.getElementById('headerStorageLabel');
  if (sidebar) sidebar.textContent = label;
  if (footer) footer.textContent = status.mode === 'folder' ? '本地文件夹存储' : '浏览器本地存储';
  if (header) header.textContent = fullLabel;
}

async function runGlobalSearch(keyword, { openFirst = false } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return;
  return searchCoordinator.run(async () => {
    const aiSearch = await smartSearch(kw);
    return aiSearch.suggestions?.length ? aiSearch.suggestions : await searchAll(kw);
  }, async results => {
    lastSearchResults = results;
    if (openFirst && results[0]) return openSearchResult(0);
    showSearchResults(kw, results);
  });
}

async function openSearchResult(index) {
  const item = lastSearchResults[Number(index)];
  if (!item) return;
  closeModal();
  await go(item.targetView, item.params || {});
}

function showSearchResults(keyword, results) {
  const groups = searchGroups(results);
  openModal('全局搜索', `
    <div class="space-y-4 text-sm">
      <div class="rounded-lg border border-slate-200 bg-white px-3 py-2">
        <div class="text-xs text-slate-500">搜索关键词</div>
        <div class="mt-1 font-semibold text-slate-900">${esc(keyword)}</div>
      </div>
      ${groups.length ? groups.map(group => `
        <section class="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div class="border-b border-slate-100 bg-slate-50 px-3 py-2 flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px] text-teal-700">${group.meta.icon}</span>
            <span class="font-semibold text-slate-800">${group.meta.label}</span>
            <span class="ml-auto text-xs text-slate-500">${group.items.length} 条</span>
          </div>
          <div class="divide-y divide-slate-100">
            ${group.items.map(item => {
              const index = results.indexOf(item);
              return `<button data-search-result="${index}" class="w-full px-3 py-3 text-left hover:bg-teal-50/50 flex items-start gap-3">
                <span class="mt-0.5 material-symbols-outlined text-[18px] text-slate-400">${item.icon}</span>
                <span class="min-w-0 flex-1">
                  <span class="block font-medium text-slate-900 truncate">${esc(item.title)}</span>
                  <span class="mt-1 block text-xs text-slate-500 truncate">${esc(item.subtitle || '')}</span>
                  ${item.excerpt ? `<span class="mt-1 block text-xs text-slate-400 truncate">${esc(item.excerpt)}</span>` : ''}
                </span>
                <span class="text-xs text-teal-700">${esc(item.actionLabel || '打开')}</span>
              </button>`;
            }).join('')}
          </div>
        </section>
      `).join('') : `<div class="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-400">没有找到相关定额、项目、指标或经验。</div>`}
    </div>
  `, `<button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border border-slate-300 bg-white text-slate-700 rounded">关闭</button>`);
  document.querySelectorAll('[data-search-result]').forEach(btn => btn.onclick = () => openSearchResult(btn.dataset.searchResult));
}

// 全局对象：内嵌 onclick / 模块间共享
window.__app = {
  state,
  go,
  openAI: ai.open,
  closeAI: ai.close,
  sendAI: () => {
    const inp = document.getElementById('aiInput');
    const t = inp.value.trim();
    if (!t) return;
    inp.value = '';
    ai.send(t);
  },
  exportAll,
  runGlobalSearch,
  openSearchResult,
};

window.addEventListener('DOMContentLoaded', async () => {
  // 先挂载导航和启动状态，避免初始化本地示例数据时页面出现空壳。
  renderNav();
  document.getElementById('workspace').innerHTML = '<div class="min-h-full flex items-center justify-center p-8 text-sm text-slate-500">正在读取本机资料…</div>';
  try {
    await ensureDemoData();
  } catch (err) {
    // 演示数据只负责初始化示例内容，失败时不能阻断已有本地数据和主界面启动。
    console.error('[demo] 初始化示例数据失败，继续加载已有本地数据', err);
  }
  ai.close();
  renderStorageBadge();
  await renderWorkspace(++routeGeneration);

  document.getElementById('aiInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') window.__app.sendAI();
  });

  let searchTimer = null;
  document.getElementById('globalSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const kw = e.target.value.trim();
    if (!kw || kw.length < 2) return;
    searchTimer = setTimeout(() => runGlobalSearch(kw), 350);
  });
  document.getElementById('globalSearch').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const kw = e.target.value.trim();
    if (!kw) return;
    await runGlobalSearch(kw, { openFirst: true });
  });
});
