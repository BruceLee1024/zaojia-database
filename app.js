// 应用入口：路由 + 启动
import * as dashboard from './assets/views/dashboard.js?v=3.2';
import * as quota     from './assets/views/quota.js?v=3.2';
import * as projects  from './assets/views/projects.js?v=3.2';
import * as boq       from './assets/views/boq.js?v=3.2';
import * as indicators from './assets/views/indicators.js?v=3.2';
import * as settings  from './assets/views/settings.js?v=3.2';
import * as ai        from './assets/views/ai.js?v=3.2';

const VIEWS = [
  { id: 'dashboard',  label: '仪表盘',     icon: 'dashboard' },
  { id: 'quota',      label: '定额库',     icon: 'menu_book' },
  { id: 'projects',   label: '项目管理',   icon: 'folder_managed' },
  { id: 'boq',        label: '工程量清单', icon: 'list_alt' },
  { id: 'indicators', label: '指标分析',   icon: 'analytics' },
  { id: 'ai',         label: 'AI 助手',    icon: 'smart_toy' },
  { id: 'settings',   label: '设置',       icon: 'settings' },
];

const state = {
  currentView: 'dashboard',
  currentProjectId: null,
};

const renderers = {
  dashboard, quota, projects, boq, indicators, settings,
};

function renderNav() {
  document.getElementById('nav').innerHTML = VIEWS.map(v => `
    <div class="nav-item px-4 py-3 cursor-pointer flex items-center gap-3 text-sm font-medium
                ${state.currentView === v.id ? 'active' : ''}"
         data-go="${v.id}">
      <span class="material-symbols-outlined text-[22px]">${v.icon}</span><span>${v.label}</span>
    </div>
  `).join('');
  document.querySelectorAll('[data-go]').forEach(el => el.onclick = () => go(el.dataset.go));
}

function go(view, params = {}) {
  state.currentView = view;
  if (view === 'boq' && params.projectId) state.currentProjectId = params.projectId;
  renderNav();
  renderWorkspace();
}

async function renderWorkspace() {
  document.getElementById('crumb').textContent = (VIEWS.find(x => x.id === state.currentView) || {}).label || '';
  const v = state.currentView;
  if (v === 'ai') return ai.open();
  const r = renderers[v];
  if (r && r.render) await r.render();
}

function exportAll() {
  // 复用 settings 的导出逻辑
  import('./assets/views/settings.js?v=3.2').then(m => m.render());
  // 简化：直接跳到设置页
  setTimeout(() => document.querySelector('#btnExport')?.click(), 100);
  go('settings');
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
};

window.addEventListener('DOMContentLoaded', () => {
  renderNav();
  renderWorkspace();

  document.getElementById('aiInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') window.__app.sendAI();
  });

  document.getElementById('globalSearch').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const kw = e.target.value.trim();
    if (!kw) return;
    state.currentView = 'quota';
    renderNav();
    await quota.render();
    // 设置搜索词
    const inp = document.getElementById('qKw');
    if (inp) { inp.value = kw; inp.dispatchEvent(new Event('input')); }
  });
});
