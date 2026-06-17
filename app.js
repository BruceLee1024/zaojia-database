// 应用入口：路由 + 启动
import * as dashboard from './assets/views/dashboard.js?v=4.1';
import * as quota     from './assets/views/quota.js?v=3.9';
import * as projects  from './assets/views/projects.js?v=4.2';
import * as boq       from './assets/views/boq.js?v=4.2';
import * as indicators from './assets/views/indicators.js?v=3.9';
import * as experience from './assets/views/experience.js?v=4.3';
import * as settings  from './assets/views/settings.js?v=3.9';
import * as ai        from './assets/views/ai.js?v=3.9';
import { ensureDemoData } from './assets/data/demo.js?v=3.9';

const VIEWS = [
  { id: 'dashboard',  label: '仪表盘',     icon: 'dashboard', group: '工作台', desc: '经营概览' },
  { id: 'quota',      label: '定额库',     icon: 'menu_book', group: '工作台', desc: '价格基础' },
  { id: 'projects',   label: '项目管理',   icon: 'folder_managed', group: '工作台', desc: '项目档案' },
  { id: 'boq',        label: '工程量清单', icon: 'list_alt', group: '工作台', desc: '报价编制' },
  { id: 'indicators', label: '指标分析',   icon: 'analytics', group: '工作台', desc: '样本对标' },
  { id: 'ai',         label: 'AI 助手',    icon: 'smart_toy', group: '智能与配置', desc: '报价辅助' },
  { id: 'experience', label: '经验萃取',   icon: 'psychology_alt', group: '智能与配置', desc: '复盘沉淀' },
  { id: 'settings',   label: '设置',       icon: 'settings', group: '智能与配置', desc: '数据维护' },
];

const state = {
  currentView: 'dashboard',
  currentProjectId: null,
};

const renderers = {
  dashboard, quota, projects, boq, indicators, experience, settings,
};

function renderNav() {
  const groups = [...new Set(VIEWS.map(v => v.group))];
  document.getElementById('nav').innerHTML = groups.map(group => `
    <div class="nav-section-title">${group}</div>
    <div class="space-y-1.5">
      ${VIEWS.filter(v => v.group === group).map(v => {
        const active = state.currentView === v.id;
        return `
          <div class="nav-item px-3 py-2.5 cursor-pointer flex items-center gap-3 text-sm font-medium ${active ? 'active' : ''}" data-go="${v.id}">
            <span class="material-symbols-outlined text-[21px] shrink-0">${v.icon}</span>
            <div class="min-w-0 flex-1">
              <div class="leading-5">${v.label}</div>
              <div class="text-[11px] leading-4 ${active ? 'text-teal-50/80' : 'text-slate-500'}">${v.desc}</div>
            </div>
            ${active ? '<span class="h-1.5 w-1.5 rounded-full bg-teal-100"></span>' : ''}
          </div>
        `;
      }).join('')}
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
  import('./assets/views/settings.js?v=3.9').then(m => m.render());
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

window.addEventListener('DOMContentLoaded', async () => {
  await ensureDemoData();
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
