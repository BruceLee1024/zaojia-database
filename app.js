// 应用入口：路由 + 启动
import * as dashboard from './assets/views/dashboard.js?v=6.15&build=20260814e';
import * as importer  from './assets/views/importer.js?v=6.15';
import * as quota     from './assets/views/quota.js?v=6.15&build=20260818k';
import * as projects  from './assets/views/projects.js?v=6.15&build=20260818d';
import * as boq       from './assets/views/boq.js?v=6.15';
import * as costEstimation from './assets/views/costEstimation.js?v=6.15&build=20260814f';
import * as indicators from './assets/views/indicators.js?v=6.15';
import * as experience from './assets/views/experience.js?v=6.15';
import * as settings  from './assets/views/settings.js?v=6.15';
import * as ai        from './assets/views/ai.js?v=6.15';
import * as resources from './assets/views/resources.js?v=6.15&build=20260818l';
import { searchAll, searchGroups } from './assets/services/globalSearchService.js?v=6.15';
import { smartSearch } from './assets/services/aiAssistService.js?v=6.15';
import { getStorageStatus } from './assets/data/storage.js?v=6.15';
import { openModal, closeModal, esc } from './assets/utils/dom.js?v=6.15';
import { ICONS } from './assets/utils/icons.js?v=6.15';
import { navigationItemHtml } from './assets/views/navigation.js?v=6.15&build=20260818f';
import { createLatestCoordinator, createLatestWorkspaceCoordinator, createWorkspaceRoot } from './assets/utils/requestCoordinator.js?v=6.15';

const VIEWS = [
  { id: 'dashboard',  label: '我的概览',   icon: ICONS.navigation.overview, group: '开始工作', desc: '继续最近工作' },
  { id: 'importer',   label: '导入资料',   icon: ICONS.navigation.import, group: '开始工作', desc: '清单、定额、材料和设备' },
  { id: 'ai-import',  label: 'AI 导入',    icon: ICONS.resource.ai, group: '开始工作', desc: '自由格式清单识别', hidden: true },
  { id: 'quota',      label: '我的定额库', icon: ICONS.navigation.quota, group: '资料库', desc: '常用价格参考' },
  { id: 'materials',  label: '我的材料库', icon: ICONS.navigation.materials, group: '资料库', desc: '材料主数据与价格' },
  { id: 'equipment',  label: '我的设备库', icon: ICONS.navigation.equipment, group: '资料库', desc: '设备选型与价格' },
  { id: 'resource-import', label: '导入材料设备', icon: ICONS.navigation.import, group: '资料库', desc: '预览并写入资源库', hidden: true },
  { id: 'boq-library', label: '我的清单库', icon: ICONS.navigation.boqLibrary, group: '资料库', desc: '通用清单复用' },
  { id: 'projects',   label: '我的项目',   icon: ICONS.navigation.projects, group: '项目与报价', desc: '项目资料与案例' },
  { id: 'boq',        label: '工程量清单', icon: ICONS.navigation.boq, group: '项目与报价', desc: '报价编制' },
  { id: 'cost-estimation', label: '成本测算', icon: 'payments', group: '项目与报价', desc: '内部覆价与利润' },
  { id: 'indicators', label: '造价参考',   icon: ICONS.navigation.indicators, group: '项目与报价', desc: '案例与指标' },
  { id: 'experience', label: '复盘笔记',   icon: ICONS.navigation.experience, group: '复盘与维护', desc: '记录可复用经验' },
  { id: 'settings',   label: '数据与备份', icon: ICONS.navigation.settings, group: '复盘与维护', desc: '本地存储与维护' },
];

const state = {
  currentView: 'importer',
  currentProjectId: null,
  routeParams: {},
};

const renderers = {
  dashboard, importer, quota, projects, boq, indicators, experience, settings,
  'cost-estimation': costEstimation,
  materials: resources,
  equipment: resources,
  'resource-import': {
    render: async workspace => {
      const module = await import('./assets/views/resourceImport.js?v=6.15');
      return module.render(workspace);
    },
  },
  'boq-library': {
    render: async workspace => {
      const module = await import('./assets/views/boqLibrary.js?v=6.15&build=20260818l');
      return module.render(workspace);
    },
  },
  'ai-import': {
    render: async workspace => {
      const module = await import('./assets/views/aiImportWizard.js?v=6.15&build=20260814');
      return module.render(workspace);
    },
  },
};
let lastSearchResults = [];
let routeGeneration = 0;
const routeCoordinator = createLatestWorkspaceCoordinator({
  createRoot: createDetachedWorkspace,
  commit: commitWorkspace,
  dispose: root => root.remove(),
});
const searchCoordinator = createLatestCoordinator();
const NAV_GROUP_STATE_KEY = 'cost-workbench-nav-groups';
const navGroupState = loadNavGroupState();
const TRIAL_CODE = 'C90C-01C6-54A7-34D7';
const TRIAL_UNLOCK_KEY = 'cost-workbench-trial-unlocked';
let trialGateActive = false;

function renderNav() {
  const groups = [...new Set(VIEWS.map(v => v.group))];
  document.getElementById('nav').innerHTML = groups.map(group => `
    <section class="nav-section ${isNavGroupExpanded(group) ? '' : 'is-collapsed'}">
    <button type="button" class="nav-section-toggle" data-nav-group="${escapeHtml(group)}" aria-expanded="${isNavGroupExpanded(group)}">
      <span>${escapeHtml(group)}</span>
      <span class="material-symbols-outlined nav-section-chevron" aria-hidden="true">expand_more</span>
    </button>
    <div class="nav-section-items space-y-1" ${isNavGroupExpanded(group) ? '' : 'hidden'}>
      ${VIEWS.filter(v => v.group === group && !v.hidden).map(v => navigationItemHtml(v, state.currentView === v.id)).join('')}
    </div>
    </section>
  `).join('');
  document.querySelectorAll('[data-go]').forEach(el => el.onclick = () => go(el.dataset.go));
  document.querySelectorAll('[data-nav-group]').forEach(button => button.onclick = () => toggleNavGroup(button.dataset.navGroup));
  renderMobileNav();
}

function loadNavGroupState() {
  try {
    const value = JSON.parse(localStorage.getItem(NAV_GROUP_STATE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function isNavGroupExpanded(group) {
  return navGroupState[group] !== false;
}

function toggleNavGroup(group) {
  navGroupState[group] = !isNavGroupExpanded(group);
  try { localStorage.setItem(NAV_GROUP_STATE_KEY, JSON.stringify(navGroupState)); } catch { /* 存储不可用时仅保留当前会话状态 */ }
  renderNav();
}

const MOBILE_PRIMARY_VIEWS = ['dashboard', 'importer', 'projects', 'boq'];

function renderMobileNav() {
  const root = document.getElementById('mobileBottomNav');
  const allItems = document.getElementById('mobileNavItems');
  if (!root || !allItems) return;
  const primary = VIEWS.filter(view => MOBILE_PRIMARY_VIEWS.includes(view.id));
  root.innerHTML = `${primary.map(view => mobileNavButton(view)).join('')}${mobileNavButton({ id: 'more', label: '更多', icon: 'apps' })}`;
  allItems.innerHTML = [...new Set(VIEWS.map(view => view.group))].map(group => `
    <div class="mobile-nav-sheet-group">${escapeHtml(group)}</div>
    ${VIEWS.filter(view => view.group === group && !view.hidden).map(view => `<button class="mobile-nav-sheet-item ${state.currentView === view.id ? 'active' : ''}" data-mobile-go="${view.id}"><span class="material-symbols-outlined icon-nav" aria-hidden="true">${view.icon}</span><span>${escapeHtml(view.label)}</span><span class="ml-auto text-xs text-slate-400">${escapeHtml(view.desc || '')}</span></button>`).join('')}
  `).join('');
  root.querySelectorAll('[data-mobile-go]').forEach(button => button.onclick = () => go(button.dataset.mobileGo));
  root.querySelector('[data-mobile-more]')?.addEventListener('click', openMobileNav);
  allItems.querySelectorAll('[data-mobile-go]').forEach(button => button.onclick = () => { closeMobileNav(); go(button.dataset.mobileGo); });
}

function mobileNavButton(view) {
  const isMore = view.id === 'more';
  const active = isMore ? !MOBILE_PRIMARY_VIEWS.includes(state.currentView) : state.currentView === view.id;
  return `<button class="mobile-nav-button ${active ? 'active' : ''}" ${isMore ? 'data-mobile-more' : `data-mobile-go="${view.id}"`} aria-label="${escapeHtml(view.label)}"><span class="material-symbols-outlined icon-nav" aria-hidden="true">${view.icon}</span><span>${escapeHtml(view.label)}</span></button>`;
}

function openMobileNav() {
  const sheet = document.getElementById('mobileNavSheet');
  sheet?.classList.add('open');
  sheet?.setAttribute('aria-hidden', 'false');
  document.getElementById('mobileNavClose')?.focus();
}

function closeMobileNav() {
  const sheet = document.getElementById('mobileNavSheet');
  sheet?.classList.remove('open');
  sheet?.setAttribute('aria-hidden', 'true');
}

function openMobileSearch() {
  openModal('搜索资料', '<label class="block text-sm text-slate-700">搜索定额、项目、指标或经验<input id="mobileSearchInput" type="search" placeholder="输入至少两个字" class="mt-2 h-11 w-full border px-3" aria-label="搜索定额、项目、指标或经验" /></label><div class="mt-3 text-xs text-slate-500">输入后将展示匹配资料；按 Enter 可直接打开首条结果。</div>');
  const input = document.getElementById('mobileSearchInput');
  let timer = null;
  input?.addEventListener('input', event => {
    clearTimeout(timer);
    const keyword = event.target.value.trim();
    if (keyword.length >= 2) timer = setTimeout(() => runGlobalSearch(keyword), 300);
  });
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.value.trim()) runGlobalSearch(event.target.value.trim(), { openFirst: true });
  });
}

async function go(view, params = {}) {
  state.currentView = view;
  state.routeParams = params || {};
  const currentGroup = VIEWS.find(item => item.id === view)?.group;
  if (currentGroup) {
    navGroupState[currentGroup] = true;
    try { localStorage.setItem(NAV_GROUP_STATE_KEY, JSON.stringify(navGroupState)); } catch { /* 存储不可用时仅保留当前会话状态 */ }
  }
  if ((view === 'boq' || view === 'cost-estimation') && params.projectId) state.currentProjectId = params.projectId;
  renderNav();
  const generation = ++routeGeneration;
  return renderWorkspace(generation);
}

async function renderWorkspace(generation = ++routeGeneration) {
  const current = VIEWS.find(x => x.id === state.currentView) || VIEWS[0];
  const v = state.currentView;
  return routeCoordinator.run(async workspace => {
    if (generation !== routeGeneration) return false;
    workspace.__routeMeta = current;
    if (v === 'ai') return ai.open();
    ai.close();
    const r = renderers[v];
    if (!r || !r.render) return;
    try {
      await r.render(workspace);
    } catch (err) {
      if (generation !== routeGeneration) return false;
      console.error(`[render:${v}]`, err);
      renderErrorState(current, err, workspace);
    }
    return generation === routeGeneration;
  });
}

function commitWorkspace(detachedWorkspace) {
  const workspace = document.getElementById('workspace');
  if (workspace) workspace.replaceChildren(...detachedWorkspace.childNodes);
  if (workspace) detachedWorkspace.activate(workspace);
  const current = detachedWorkspace.__routeMeta || {};
  const values = { crumb: current.label, crumbIcon: current.icon || 'dashboard', crumbGroup: current.group, crumbDesc: current.desc };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value || '';
  });
}

function createDetachedWorkspace() {
  let host = document.getElementById('workspaceStaging');
  if (!host) {
    host = document.createElement('div');
    host.id = 'workspaceStaging';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1440px;visibility:hidden;pointer-events:none;';
    document.body.prepend(host);
  }
  const workspace = document.createElement('div');
  host.prepend(workspace);
  return createWorkspaceRoot(workspace);
}

function renderErrorState(current, err, workspace = document.getElementById('workspace')) {
  const message = err?.message || String(err || '未知错误');
  workspace.innerHTML = `
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
  import('./assets/views/settings.js?v=6.15').then(m => m.triggerExportBackup());
  go('settings');
}

async function renderStorageBadge() {
  const status = await getStorageStatus();
  const label = status.mode === 'folder'
    ? `本地文件夹${status.pendingSync ? ' · 待同步' : status.connected ? '' : ' · 待授权'}`
    : '浏览器本地';
  const fullLabel = status.mode === 'folder'
    ? `数据保存在本机 · ${label}`
    : '数据保存在本机 · 浏览器存储';
  const sidebar = document.getElementById('sidebarStorageLabel');
  const sidebarProfile = document.getElementById('sidebarProfileLabel');
  const footer = document.getElementById('footerStorageLabel');
  const header = document.getElementById('headerStorageLabel');
  if (sidebar) sidebar.textContent = label;
  if (sidebarProfile) sidebarProfile.textContent = status.profile === 'demo' ? '演示资料' : '个人资料';
  if (footer) footer.textContent = status.mode === 'folder' ? '本地文件夹存储' : '浏览器本地存储';
  if (header) header.textContent = fullLabel;
  let warning = document.getElementById('storageSyncWarning');
  if (status.pendingSync && !warning) {
    warning = document.createElement('button');
    warning.id = 'storageSyncWarning'; warning.type = 'button';
    warning.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 shadow-sm';
    warning.textContent = '本地文件夹待同步：数据暂仅保存在浏览器。点击前往处理';
    warning.onclick = () => go('settings', { section: 'storage' });
    document.body.appendChild(warning);
  }
  if (!status.pendingSync) warning?.remove();
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

function trialIsUnlocked() {
  try { return localStorage.getItem(TRIAL_UNLOCK_KEY) === 'true'; } catch { return false; }
}

function showTrialCodePrompt() {
  trialGateActive = true;
  openModal('获取试用码', `
    <div class="mx-auto max-w-md text-center">
      <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-teal-700">
        <span class="material-symbols-outlined text-2xl" aria-hidden="true">key</span>
      </div>
      <h2 class="mt-4 text-lg font-semibold text-slate-950">添加作者微信，获取试用码</h2>
      <p class="mt-2 text-sm leading-6 text-slate-600">扫码添加作者「Bruce」，备注“造价数据库”，即可获取试用码并了解后续服务。</p>
      <div class="mx-auto mt-4 w-52 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <img src="../landing-assets/wechat-cybertumu.jpg" alt="Bruce 微信二维码" class="block h-full w-full object-contain" />
      </div>
      <p class="mt-3 text-xs text-slate-500">微信：Bruce</p>
      <p class="mt-2 text-xs font-medium text-teal-700">本系统永久免费使用，不收取任何费用。</p>
      <label class="mx-auto mt-5 block max-w-xs text-left">
        <span class="text-xs font-medium text-slate-600">试用码</span>
        <input id="trialCodeInput" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX-XXXX" class="mt-1 h-11 w-full border border-slate-300 bg-white px-3 text-center font-data tracking-[0.12em] uppercase outline-none focus:border-teal-600" />
      </label>
      <p id="trialCodeError" class="mt-2 min-h-5 text-xs text-red-600" role="alert"></p>
    </div>
  `, '<button id="verifyTrialCode" type="button" class="h-9 px-4 brand-bg text-sm text-white">验证并进入系统</button>');
  const modal = document.getElementById('modal');
  modal.dataset.locked = 'true';
  const closeButton = document.querySelector('#modalPanel > div:first-child button');
  if (closeButton) { closeButton.hidden = true; closeButton.disabled = true; }
  window.__modalClose = () => { if (!trialGateActive) closeModal(); };
  document.getElementById('verifyTrialCode').onclick = verifyTrialCode;
  document.getElementById('trialCodeInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') verifyTrialCode();
  });
}

async function verifyTrialCode() {
  const input = document.getElementById('trialCodeInput');
  const error = document.getElementById('trialCodeError');
  const value = String(input?.value || '').trim().toUpperCase();
  if (value !== TRIAL_CODE) {
    if (error) error.textContent = '试用码无效，请添加作者微信获取正确试用码。';
    input?.focus();
    return;
  }
  try { localStorage.setItem(TRIAL_UNLOCK_KEY, 'true'); } catch { /* 本次会话仍可继续使用 */ }
  trialGateActive = false;
  const modal = document.getElementById('modal');
  delete modal.dataset.locked;
  const closeButton = document.querySelector('#modalPanel > div:first-child button');
  if (closeButton) { closeButton.hidden = false; closeButton.disabled = false; }
  window.__modalClose = closeModal;
  closeModal();
  await renderWorkspace(++routeGeneration);
}

// 全局对象：内嵌 onclick / 模块间共享
window.__app = {
  state,
  go,
  openAI: ai.open,
  closeAI: ai.close,
  newAISession: ai.newSession,
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
  openMobileSearch,
};

document.addEventListener('keydown', event => {
  if (trialGateActive && event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

window.addEventListener('DOMContentLoaded', async () => {
  // 首次使用保持正式资料库为空；演示资料只能由用户在「备份与恢复」中主动加载。
  renderNav();
  document.getElementById('mobileNavClose')?.addEventListener('click', closeMobileNav);
  document.getElementById('mobileNavSheet')?.addEventListener('click', event => { if (event.target.id === 'mobileNavSheet') closeMobileNav(); });
  document.getElementById('mobileSearchButton')?.addEventListener('click', openMobileSearch);
  document.getElementById('workspace').innerHTML = '<div class="min-h-full flex items-center justify-center p-8 text-sm text-slate-500">正在读取本机资料…</div>';
  ai.close();
  renderStorageBadge();
  if (trialIsUnlocked()) await renderWorkspace(++routeGeneration);
  else showTrialCodePrompt();

  document.getElementById('aiInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      window.__app.sendAI();
    }
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
