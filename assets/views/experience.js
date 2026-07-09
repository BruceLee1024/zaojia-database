// 经验萃取与知识库工作台
import { projectRepo } from '../data/repository.js?v=3.9';
import { experienceService } from '../services/experienceService.js?v=4.4';
import { esc, fmt, openModal, closeModal, toast } from '../utils/dom.js';

const experienceState = {
  keyword: '',
  projectId: '',
  status: '',
  projectType: '',
  processType: '',
  costCategory: '',
  expired: '',
  selectedId: '',
};

export async function render() {
  const params = window.__app?.state?.routeParams || {};
  if (params.keyword != null) experienceState.keyword = params.keyword;
  if (params.selectedId) experienceState.selectedId = params.selectedId;
  if (params.projectId) experienceState.projectId = params.projectId;
  const [projects, dashboard, kb] = await Promise.all([
    projectRepo.all(),
    experienceService.dashboard(),
    experienceService.listKnowledgeBase(currentFilters()),
  ]);
  const currentProject = projects.find(p => p.id === (experienceState.projectId || window.__app?.state?.currentProjectId)) || projects[0] || null;
  if (currentProject && !experienceState.projectId) experienceState.projectId = currentProject.id;
  const selected = kb.items.find(card => card.id === experienceState.selectedId) || kb.items[0] || null;
  if (selected) experienceState.selectedId = selected.id;
  const health = knowledgeHealth(projects, dashboard, kb);

  document.getElementById('workspace').innerHTML = `
    <div class="h-full min-h-0 flex flex-col gap-3">
      <section class="card p-4 shrink-0">
        <div class="flex items-start gap-4">
          <div class="h-11 w-11 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[24px]">psychology_alt</span>
          </div>
          <div class="min-w-0">
            <div class="text-base font-semibold text-slate-900">AI 经验萃取知识库</div>
            <div class="mt-1 text-sm leading-6 text-slate-600">把报价复盘沉淀成可审核、可检索、可复用并带证据链的知识资产。</div>
          </div>
          <div class="flex-1"></div>
          <button id="expStartPrimary" class="px-3 py-1.5 text-sm brand-bg text-white rounded ${currentProject ? '' : 'opacity-50'}">开始复盘</button>
          <button onclick="window.__app.openAI()" class="px-3 py-1.5 text-sm border border-slate-300 bg-white rounded hover:bg-slate-50">问 AI</button>
        </div>
        <div class="mt-4 grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3">
          ${statTile('正式经验', kb.stats.confirmed, '张', '可进入 AI 查询')}
          ${statTile('需复核', kb.stats.needsReview, '张', '价格或边界需确认', kb.stats.needsReview ? 'amber' : 'teal')}
          ${statTile('过期经验', kb.stats.expired, '张', '有效期已过', kb.stats.expired ? 'amber' : 'teal')}
          ${statTile('高复用', kb.stats.highReuse, '张', '引用 3 次以上')}
          ${statTile('待确认复盘', dashboard.pendingSessions.length, '个', '草稿确认后入库', dashboard.pendingSessions.length ? 'amber' : 'teal')}
          ${statTile('知识总量', kb.stats.total, '张', '含归档与复核中')}
        </div>
        <div class="mt-3 grid grid-cols-2 2xl:grid-cols-4 gap-3">
          ${healthTile('覆盖率', `${health.coverage}%`, `${health.coveredProjects}/${health.expectedProjects} 个关键项目已有经验`, health.coverage >= 60 ? 'teal' : 'amber')}
          ${healthTile('知识活性', `${health.activity}%`, `${health.activeCards} 张经验被引用或更新`, health.activity >= 30 || !kb.stats.confirmed ? 'teal' : 'amber')}
          ${healthTile('萃取质量', `${health.extractionQuality}%`, `${health.lowQualityCards} 张需补齐证据或边界`, health.extractionQuality >= 70 ? 'teal' : 'amber')}
          ${healthTile('复核压力', `${health.reviewPressure}%`, `${kb.stats.needsReview + kb.stats.expired} 张需复核或过期`, health.reviewPressure ? 'amber' : 'teal')}
        </div>
      </section>

      <section class="grid grid-cols-[260px_minmax(0,1fr)_390px] gap-3 flex-1 min-h-0">
        <aside class="card p-0 overflow-hidden min-h-0 flex flex-col">
          <div class="px-4 py-3 border-b border-slate-200">
            <div class="font-semibold text-slate-800">知识筛选</div>
            <div class="mt-1 text-xs text-slate-500">按业务场景和生命周期筛选经验。</div>
          </div>
          <div class="p-3 space-y-3 overflow-auto scroll-thin">
            ${filterInput('关键词', 'expKw', experienceState.keyword, '防水 / 暂估 / AAO')}
            ${filterSelect('状态', 'expStatus', experienceState.status, [
              ['', '默认：不含归档'],
              ['confirmed', '正式经验'],
              ['needs_review', '需复核'],
              ['archived', '已归档'],
            ])}
            ${filterSelect('项目类型', 'expProjectType', experienceState.projectType, [['', '全部类型'], ...kb.facets.projectTypes.map(v => [v, v])])}
            ${filterSelect('工艺类型', 'expProcessType', experienceState.processType, [['', '全部工艺'], ...kb.facets.processTypes.map(v => [v, v])])}
            ${filterSelect('成本分类', 'expCostCategory', experienceState.costCategory, [['', '全部分类'], ...kb.facets.costCategories.map(v => [v, v])])}
            ${filterSelect('有效期', 'expExpired', experienceState.expired, [['', '全部有效期'], ['active', '未过期'], ['expired', '已过期']])}
            <div class="pt-2 border-t border-slate-200">
              <div class="mb-2 text-xs font-medium text-slate-500">发起复盘项目</div>
              <select id="expStartProject" class="h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm">
                ${projects.map(p => `<option value="${p.id}" ${p.id === (currentProject?.id || '') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
              </select>
              <button id="expStartSide" class="mt-2 w-full px-3 py-2 text-sm brand-bg text-white rounded ${projects.length ? '' : 'opacity-50'}">生成追问卡</button>
            </div>
          </div>
        </aside>

        <main class="card p-0 overflow-hidden min-h-0 flex flex-col">
          <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div>
              <div class="font-semibold text-slate-800">经验知识库</div>
              <div class="mt-1 text-xs text-slate-500">按条目逐条沉淀、复核和复用经验。显示 ${kb.items.length} / ${kb.stats.total} 张知识卡。</div>
            </div>
            <button id="expResetFilters" class="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50">清除筛选</button>
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_92px_82px_96px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-medium text-slate-500">
            <div>经验条目</div>
            <div class="text-center">状态</div>
            <div class="text-right">复用</div>
            <div class="text-right">有效期</div>
          </div>
          <div class="overflow-auto scroll-thin flex-1 min-h-0">
            ${kb.items.length ? `<div class="divide-y divide-slate-100">${kb.items.map(card => cardItem(card, selected?.id === card.id)).join('')}</div>` : emptyKnowledgeList()}
          </div>
        </main>

        <aside class="card p-0 overflow-hidden min-h-0 flex flex-col">
          ${selected ? detailPanel(selected) : emptyDetail()}
        </aside>
      </section>
    </div>
  `;
  bindExperiencePage(projects);
}

export async function openReview({ projectId, versionId = '', sourceType = 'manual_review' } = {}) {
  try {
    const session = await experienceService.startReview({ projectId, versionId, sourceType });
    renderReview(session);
  } catch (e) {
    toast(e.message || '复盘初始化失败', 'error');
  }
}

export async function openSession(sessionId) {
  const dashboard = await experienceService.dashboard();
  const session = dashboard.sessions.find(s => s.id === sessionId);
  if (!session) {
    toast('复盘会话不存在', 'error');
    return;
  }
  renderReview(session, session.draft || null);
}

function renderReview(session, draft = null) {
  const extraction = draft?.extraction || session.extraction || null;
  openModal('报价复盘经验萃取', `
    <div class="space-y-4 text-sm text-slate-700">
      <section class="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div class="px-4 py-3 flex items-start justify-between gap-4">
          <div class="flex items-start gap-3 min-w-0">
            <div class="h-10 w-10 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
              <span class="material-symbols-outlined text-[22px]">psychology_alt</span>
            </div>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <div class="font-semibold text-slate-900 truncate">${esc(session.projectNameSnapshot || '当前项目')}</div>
                <span class="badge badge-blue">${esc(sourceLabel(session.sourceType))}</span>
              </div>
              <div class="mt-1 text-xs leading-5 text-slate-500">${esc(session.versionNameSnapshot || '当前工作稿')} · 追问只生成草稿，确认后才进入知识库</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="badge ${session.questionSource === 'ai' ? 'badge-green' : 'badge-gray'}">${session.questionSource === 'ai' ? 'AI 追问' : '本地兜底'}</span>
            ${(session.questions || []).some(q => q.level === 'L2') ? `<span class="badge ${session.followUpSource === 'ai' ? 'badge-green' : 'badge-gray'}">L2 补问</span>` : ''}
          </div>
        </div>
        <div class="border-t border-slate-200 bg-slate-50 px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-2">
          ${reviewMetric('清单', session.context?.lineCount || 0, '条', 'list_alt')}
          ${reviewMetric('缺单价', session.context?.missingPriceCount || 0, '条', 'priority_high', session.context?.missingPriceCount ? 'amber' : 'teal')}
          ${reviewMetric('0 工程量', session.context?.zeroQtyCount || 0, '条', 'exposure_zero', session.context?.zeroQtyCount ? 'amber' : 'teal')}
          ${reviewMetric('系数异常', session.context?.factorRiskCount || 0, '条', 'tune', session.context?.factorRiskCount ? 'amber' : 'teal')}
        </div>
      </section>

      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(340px,.95fr)] gap-4 items-start">
        <section class="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-semibold text-slate-800">AI 追问卡片</div>
              <div class="mt-1 text-xs leading-5 text-slate-500">${questionSourceText(session)}</div>
            </div>
            <span class="badge badge-gray shrink-0">${(session.questions || []).length} 问</span>
          </div>
          <div class="px-4 py-3 border-b border-slate-100 grid grid-cols-3 gap-2 bg-slate-50/70">
            ${reviewStep('L0', '事实背景', '项目/清单/版本', 'done')}
            ${reviewStep('L1', '首轮追问', session.questionSource === 'ai' ? 'AI 生成' : '本地模板', 'done')}
            ${reviewStep('L2', '递进补问', (session.questions || []).some(q => q.level === 'L2') ? (session.followUpSource === 'ai' ? 'AI 已补问' : '本地已补问') : '回答后生成', (session.questions || []).some(q => q.level === 'L2') ? 'done' : 'pending')}
          </div>
          ${reviewQualityPanel(extraction)}
          <div class="p-3 space-y-3 max-h-[430px] overflow-auto scroll-thin">
            ${(session.questions || []).map((q, idx) => questionCard(q, idx, (session.answers || {})[q.id] || '')).join('')}
          </div>
        </section>

        <section class="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-semibold text-slate-800">经验卡草稿</div>
              <div class="mt-1 text-xs leading-5 text-slate-500">确认后写入知识库，并可被 AI 查询引用。</div>
            </div>
            <span class="badge ${draft ? 'badge-green' : 'badge-gray'} shrink-0">${draft ? `萃取 ${extraction?.score ?? '-'} 分` : '待生成'}</span>
          </div>
          <div class="p-3 max-h-[520px] overflow-auto scroll-thin bg-slate-50/70">
            ${draft ? draftForm(draft) : draftEmptyState(extraction)}
          </div>
        </section>
      </div>
    </div>
  `, `
    <div class="w-full flex items-center justify-between gap-3">
      <div class="text-xs text-slate-500">${extractionFooterHint(extraction)}</div>
      <div class="flex items-center gap-2">
        <button id="expRefine" class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded text-slate-700 border-slate-300 bg-white hover:bg-slate-50">
          <span class="material-symbols-outlined text-[16px]">auto_awesome</span>AI 补问
        </button>
        <button id="expDraft" class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded text-teal-700 border-teal-300 bg-teal-50 hover:bg-teal-100">
          <span class="material-symbols-outlined text-[16px]">edit_note</span>AI 生成草稿
        </button>
        <button id="expConfirm" class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm brand-bg text-white rounded ${draft ? '' : 'opacity-50'}">
          <span class="material-symbols-outlined text-[16px]">inventory_2</span>确认入库
        </button>
        <button onclick="window.__modalClose ? window.__modalClose() : document.getElementById('modal').classList.add('hidden')" class="px-3 py-1.5 text-sm border border-slate-300 bg-white rounded">关闭</button>
      </div>
    </div>
  `);
  document.getElementById('expRefine').onclick = async () => {
    const answers = collectAnswers();
    const refined = await experienceService.refineQuestions(session.id, answers);
    renderReview(refined, draft);
    toast(refined.followUpSource === 'ai' ? 'AI 已补充递进追问' : '已补充本地追问', 'success');
  };
  document.getElementById('expDraft').onclick = async () => {
    const answers = collectAnswers();
    const nextDraft = await experienceService.draftCard(session.id, answers);
    const fresh = { ...session, answers, draft: nextDraft, extraction: nextDraft.extraction, status: 'draft_ready' };
    renderReview(fresh, nextDraft);
    toast('已生成经验卡草稿，请确认后入库', 'success');
  };
  document.getElementById('expConfirm').onclick = async () => {
    if (!draft) {
      toast('请先生成草稿', 'error');
      return;
    }
    const card = await experienceService.confirmCard(session.id, collectDraftPatch());
    experienceState.selectedId = card.id;
    closeModal();
    toast(`经验卡已入库：${card.title}`, 'success');
    if (window.__app?.state?.currentView === 'experience') render();
  };
}

function bindExperiencePage(projects) {
  bindInput('expKw', value => { experienceState.keyword = value; renderDebounced(); });
  bindSelect('expStatus', value => { experienceState.status = value; render(); });
  bindSelect('expProjectType', value => { experienceState.projectType = value; render(); });
  bindSelect('expProcessType', value => { experienceState.processType = value; render(); });
  bindSelect('expCostCategory', value => { experienceState.costCategory = value; render(); });
  bindSelect('expExpired', value => { experienceState.expired = value; render(); });
  document.getElementById('expResetFilters')?.addEventListener('click', () => {
    Object.assign(experienceState, { keyword: '', status: '', projectType: '', processType: '', costCategory: '', expired: '' });
    render();
  });
  document.getElementById('expStartProject')?.addEventListener('change', e => {
    experienceState.projectId = e.target.value;
    window.__app.state.currentProjectId = e.target.value;
  });
  const start = () => {
    const projectId = document.getElementById('expStartProject')?.value || experienceState.projectId || projects[0]?.id;
    if (!projectId) {
      toast('请先新建项目', 'error');
      return;
    }
    openReview({ projectId, sourceType: 'manual_review' });
  };
  document.getElementById('expStartPrimary')?.addEventListener('click', start);
  document.getElementById('expStartSide')?.addEventListener('click', start);
  document.querySelectorAll('[data-exp-card]').forEach(btn => btn.onclick = () => {
    experienceState.selectedId = btn.dataset.expCard;
    render();
  });
  document.getElementById('expSaveMeta')?.addEventListener('click', saveSelectedMeta);
  document.getElementById('expNeedsReview')?.addEventListener('click', markSelectedReview);
  document.getElementById('expArchive')?.addEventListener('click', archiveSelected);
  document.getElementById('expRecordReuse')?.addEventListener('click', recordSelectedReuse);
}

async function saveSelectedMeta() {
  if (!experienceState.selectedId) return;
  const patch = {
    domainCategory: val('expDomainCategory'),
    knowledgeType: val('expKnowledgeType'),
    projectType: val('expDetailProjectType'),
    processType: val('expDetailProcessType'),
    costCategory: val('expDetailCostCategory'),
    keywords: splitWords(val('expKeywords')),
    reviewStatus: val('expReviewStatus'),
    expiresAt: val('expDetailExpiresAt'),
    reviewNote: val('expReviewNote'),
  };
  await experienceService.updateCard(experienceState.selectedId, patch);
  toast('知识卡已更新', 'success');
  render();
}

async function markSelectedReview() {
  if (!experienceState.selectedId) return;
  const note = val('expReviewNote') || '需要复核适用边界或价格口径';
  await experienceService.markNeedsReview(experienceState.selectedId, note);
  toast('已标记为需复核', 'success');
  render();
}

async function archiveSelected() {
  if (!experienceState.selectedId || !confirm('归档后默认不会进入 AI 经验检索，确定归档？')) return;
  await experienceService.archiveCard(experienceState.selectedId);
  toast('已归档经验卡', 'success');
  render();
}

async function recordSelectedReuse() {
  if (!experienceState.selectedId) return;
  await experienceService.recordReuse(experienceState.selectedId);
  toast('已记录一次引用', 'success');
  render();
}

function currentFilters() {
  return {
    keyword: experienceState.keyword,
    status: experienceState.status,
    projectType: experienceState.projectType,
    processType: experienceState.processType,
    costCategory: experienceState.costCategory,
    expired: experienceState.expired,
  };
}

function cardItem(card, active) {
  const tags = (card.keywords || card.tags || []).slice(0, 4);
  const expired = isExpiredDate(card.expiresAt);
  return `<button data-exp-card="${card.id}" class="w-full grid grid-cols-[minmax(0,1fr)_92px_82px_96px] gap-3 px-4 py-3 text-left border-l-2 ${active ? 'border-l-teal-600 bg-teal-50/70' : 'border-l-transparent bg-white hover:bg-slate-50'} transition-colors">
    <div class="min-w-0">
      <div class="flex items-center gap-2 min-w-0">
        <span class="material-symbols-outlined text-[17px] ${active ? 'text-teal-700' : 'text-slate-400'} shrink-0">article</span>
        <span class="font-semibold text-slate-900 truncate">${esc(card.title || '未命名经验')}</span>
      </div>
      <div class="mt-1 text-xs text-slate-500 truncate">
        ${esc(card.projectNameSnapshot || '未知项目')} · ${esc(card.costCategory || card.domainCategory || '未分类')} · ${esc(card.processType || card.projectType || '未标注')}
      </div>
      <div class="mt-1.5 text-sm leading-5 text-slate-700 line-clamp-2">${esc(card.lesson || '暂无经验结论')}</div>
      <div class="mt-2 flex flex-wrap gap-1">
        ${tags.length ? tags.map(tag => `<span class="badge badge-blue">${esc(tag)}</span>`).join('') : '<span class="badge badge-gray">未标记</span>'}
      </div>
    </div>
    <div class="flex flex-col items-center justify-start gap-1 pt-0.5">
      <span class="badge ${statusBadgeClass(card.reviewStatus)} shrink-0">${statusLabel(card.reviewStatus)}</span>
      <span class="text-[11px] ${Number(card.extractionScore || 0) >= 70 ? 'text-slate-500' : 'text-amber-700'}">萃取 ${fmt(card.extractionScore || 0)}分</span>
    </div>
    <div class="pt-0.5 text-right">
      <div class="font-semibold tabular-nums text-slate-800">${fmt(card.reuseCount || 0)}</div>
      <div class="mt-1 text-[11px] text-slate-500">次引用</div>
    </div>
    <div class="pt-0.5 text-right">
      <div class="font-medium tabular-nums ${expired ? 'text-amber-700' : 'text-slate-800'}">${esc(card.expiresAt || '-')}</div>
      <div class="mt-1 text-[11px] ${expired ? 'text-amber-700' : 'text-slate-500'}">${expired ? '已过期' : '有效'}</div>
    </div>
  </button>`;
}

function emptyKnowledgeList() {
  return `<div class="p-4 space-y-2">
    <div class="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-5">
      <div class="flex items-start gap-3">
        <div class="h-9 w-9 rounded border border-slate-200 bg-white text-slate-400 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[20px]">view_list</span>
        </div>
        <div class="min-w-0">
          <div class="font-medium text-slate-800">暂无经验条目</div>
          <div class="mt-1 text-xs leading-5 text-slate-500">经验卡来自报价审查、保存版本或项目归档复盘；确认后可被 AI 检索复用，但不参与指标计算。</div>
          <div class="mt-3 flex flex-wrap gap-2">
            <button onclick="window.__app.go('boq')" class="rounded border border-teal-300 bg-white px-2.5 py-1 text-xs text-teal-700">去报价审查</button>
            <button onclick="window.__app.go('boq')" class="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700">去保存版本</button>
            <button onclick="window.__app.go('projects')" class="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700">去项目归档</button>
          </div>
        </div>
      </div>
    </div>
    ${emptyKnowledgeRow('待沉淀经验', '项目 / 分类 / 结论摘要', '正式', '0', '-')}
    ${emptyKnowledgeRow('防水报价口径示例', '项目归档后自动形成条目', '需复核', '0', '-')}
  </div>`;
}

function emptyKnowledgeRow(title, meta, status, reuse, expiresAt) {
  return `<div class="grid grid-cols-[minmax(0,1fr)_92px_82px_96px] gap-3 rounded border border-slate-200 bg-white px-4 py-3 opacity-60">
    <div class="min-w-0">
      <div class="font-medium text-slate-700 truncate">${esc(title)}</div>
      <div class="mt-1 text-xs text-slate-500 truncate">${esc(meta)}</div>
    </div>
    <div class="text-center"><span class="badge badge-gray">${esc(status)}</span></div>
    <div class="text-right tabular-nums text-slate-500">${esc(reuse)}</div>
    <div class="text-right tabular-nums text-slate-500">${esc(expiresAt)}</div>
  </div>`;
}

function detailPanel(card) {
  return `
    <div class="px-4 py-3 border-b border-slate-200">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="font-semibold text-slate-900 leading-5">${esc(card.title || '未命名经验')}</div>
          <div class="mt-1 text-xs text-slate-500">${esc(card.projectNameSnapshot || '未知项目')} · ${esc(card.versionNameSnapshot || sourceLabel(card.sourceType))}</div>
        </div>
        <span class="badge ${statusBadgeClass(card.reviewStatus)} shrink-0">${statusLabel(card.reviewStatus)}</span>
      </div>
    </div>
    <div class="p-4 space-y-4 overflow-auto scroll-thin flex-1 min-h-0">
      <div class="grid grid-cols-4 gap-2">
        ${metric('复用', fmt(card.reuseCount || 0), '次')}
        ${metric('可信度', esc(card.confidence || '-'), '')}
        ${metric('萃取', fmt(card.extractionScore || 0), '分')}
        ${metric('有效期', esc(card.expiresAt || '-'), '')}
      </div>
      ${extractionDetail(card)}
      ${detailBlock('经验结论', card.lesson)}
      ${detailBlock('适用边界', card.applicability)}
      ${detailBlock('风险提示', card.risks)}
      ${detailBlock('证据来源', card.evidence)}
      ${evidenceRefs(card.evidenceRefs)}

      <div class="rounded border border-slate-200 bg-white p-3 space-y-2">
        <div class="font-medium text-slate-800">知识维护</div>
        <div class="grid grid-cols-2 gap-2">
          ${textInput('知识类型', 'expKnowledgeType', card.knowledgeType || '经验卡')}
          ${textInput('领域分类', 'expDomainCategory', card.domainCategory || '')}
          ${textInput('项目类型', 'expDetailProjectType', card.projectType || '')}
          ${textInput('工艺类型', 'expDetailProcessType', card.processType || '')}
          ${textInput('成本分类', 'expDetailCostCategory', card.costCategory || '')}
          ${selectInput('审核状态', 'expReviewStatus', card.reviewStatus || 'confirmed', [
            ['confirmed', '正式经验'],
            ['needs_review', '需复核'],
            ['archived', '已归档'],
          ])}
        </div>
        ${textInput('关键词', 'expKeywords', (card.keywords || []).join('，'))}
        <label class="block text-xs font-medium text-slate-500">有效期
          <input id="expDetailExpiresAt" type="date" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(card.expiresAt || '')}" />
        </label>
        <label class="block text-xs font-medium text-slate-500">复核备注
          <textarea id="expReviewNote" rows="2" class="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm">${esc(card.reviewNote || '')}</textarea>
        </label>
      </div>
    </div>
    <div class="px-4 py-3 border-t border-slate-200 bg-white flex flex-wrap gap-2">
      <button id="expSaveMeta" class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存维护</button>
      <button id="expRecordReuse" class="px-3 py-1.5 text-sm border border-teal-300 text-teal-700 rounded">记录引用</button>
      <button id="expNeedsReview" class="px-3 py-1.5 text-sm border border-amber-300 text-amber-700 rounded">标记复核</button>
      <button id="expArchive" class="px-3 py-1.5 text-sm border border-slate-300 text-slate-600 rounded">归档</button>
    </div>
  `;
}

function emptyDetail() {
  return `<div class="flex h-full min-h-[360px] items-center justify-center px-6 text-center text-sm text-slate-400">选择一张经验卡查看证据、边界和维护动作。</div>`;
}

function statTile(label, value, unit, note, tone = 'slate') {
  const toneCls = tone === 'amber' ? 'text-amber-700' : tone === 'teal' ? 'text-teal-700' : 'text-slate-900';
  return `<div class="rounded border border-slate-200 bg-slate-50 px-3 py-2">
    <div class="text-xs text-slate-500">${label}</div>
    <div class="mt-1 text-lg font-semibold tabular-nums ${toneCls} truncate">${fmt(value)}<span class="ml-1 text-xs font-normal text-slate-500">${unit}</span></div>
    <div class="mt-1 text-xs text-slate-500 truncate">${note}</div>
  </div>`;
}

function healthTile(label, value, note, tone = 'slate') {
  const toneCls = tone === 'amber' ? 'text-amber-700' : tone === 'teal' ? 'text-teal-700' : 'text-slate-900';
  const barCls = tone === 'amber' ? 'bg-amber-500' : 'bg-teal-600';
  const width = Math.max(4, Math.min(100, Number.parseInt(value, 10) || 0));
  return `<div class="rounded border border-slate-200 bg-white px-3 py-2">
    <div class="flex items-center justify-between gap-2">
      <div class="text-xs text-slate-500 truncate">${label}</div>
      <div class="text-sm font-semibold tabular-nums ${toneCls}">${esc(value)}</div>
    </div>
    <div class="mt-2 h-1.5 rounded bg-slate-100 overflow-hidden"><div class="h-1.5 rounded ${barCls}" style="width:${width}%"></div></div>
    <div class="mt-1 text-xs text-slate-500 truncate">${esc(note)}</div>
  </div>`;
}

function knowledgeHealth(projects, dashboard, kb) {
  const expectedProjects = Math.max(1, projects.filter(p => p.status === 'archived').length || projects.length);
  const confirmedCards = dashboard.confirmedCards || [];
  const coveredProjects = new Set(confirmedCards.map(card => card.projectId).filter(Boolean)).size;
  const activeCards = confirmedCards.filter(card => Number(card.reuseCount || 0) > 0 || isRecent(card.updatedAt || card.createdAt)).length;
  const riskCards = (kb.stats.needsReview || 0) + (kb.stats.expired || 0);
  const extractionQuality = confirmedCards.length
    ? Math.round(confirmedCards.reduce((sum, card) => sum + Number(card.extractionScore || 0), 0) / confirmedCards.length)
    : 100;
  return {
    expectedProjects,
    coveredProjects,
    activeCards,
    lowQualityCards: dashboard.lowQualityCards?.length || kb.stats.lowQuality || 0,
    coverage: Math.round(Math.min(1, coveredProjects / expectedProjects) * 100),
    activity: confirmedCards.length ? Math.round(activeCards / confirmedCards.length * 100) : 100,
    efficiency: dashboard.sessions.length ? Math.round((kb.stats.confirmed || 0) / dashboard.sessions.length * 100) : 100,
    extractionQuality,
    reviewPressure: kb.stats.total ? Math.round(riskCards / kb.stats.total * 100) : 0,
  };
}

function filterInput(label, id, value, placeholder) {
  return `<label class="block text-xs font-medium text-slate-500">${label}
    <input id="${id}" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}" />
  </label>`;
}

function filterSelect(label, id, value, options) {
  return `<label class="block text-xs font-medium text-slate-500">${label}
    <select id="${id}" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm">
      ${options.map(([v, text]) => `<option value="${esc(v)}" ${value === v ? 'selected' : ''}>${esc(text)}</option>`).join('')}
    </select>
  </label>`;
}

function textInput(label, id, value) {
  return `<label class="block text-xs font-medium text-slate-500">${label}
    <input id="${id}" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm" value="${esc(value || '')}" />
  </label>`;
}

function selectInput(label, id, value, options) {
  return `<label class="block text-xs font-medium text-slate-500">${label}
    <select id="${id}" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm">
      ${options.map(([v, text]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${text}</option>`).join('')}
    </select>
  </label>`;
}

function evidenceRefs(refs = []) {
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="text-xs font-medium text-slate-500">证据链</div>
    <div class="mt-2 space-y-1 text-sm text-slate-700">
      ${refs.length ? refs.map(ref => `<div>• ${esc(ref.type || 'source')}：${esc(ref.label || ref.id || '-')}</div>`).join('') : '<div class="text-slate-400">暂无结构化证据链</div>'}
    </div>
  </div>`;
}

function extractionDetail(card) {
  const extraction = card.extraction || {};
  const score = Number(card.extractionScore ?? extraction.score ?? 0);
  const gaps = card.extractionGaps || extraction.gaps || [];
  const checks = card.extractionChecks || extraction.checks || [];
  const tone = qualityTone(score);
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="text-xs font-medium text-slate-500">萃取质量</div>
        <div class="mt-1 text-sm font-semibold ${tone.text}">${esc(card.extractionLevel || extraction.level || '待评估')}</div>
      </div>
      <div class="text-right">
        <div class="text-lg font-semibold tabular-nums ${tone.text}">${fmt(score)}<span class="ml-1 text-xs font-normal text-slate-500">分</span></div>
        <div class="text-[11px] text-slate-500">证据 / 边界 / 风险</div>
      </div>
    </div>
    <div class="mt-3 h-1.5 rounded bg-slate-100 overflow-hidden"><div class="h-1.5 rounded ${tone.bar}" style="width:${Math.max(4, Math.min(100, score))}%"></div></div>
    <div class="mt-2 text-xs leading-5 text-slate-600">${esc(card.extractionSummary || extraction.summary || '暂无萃取评估')}</div>
    ${checks.length ? `<div class="mt-3 grid grid-cols-2 gap-2">${checks.slice(0, 4).map(qualityCheckPill).join('')}</div>` : ''}
    ${gaps.length ? `<div class="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">需补齐：${gaps.map(g => esc(g.label || g.key)).join('、')}</div>` : ''}
  </div>`;
}

function detailBlock(title, text) {
  return `<div class="rounded border border-slate-200 bg-white p-3">
    <div class="text-xs font-medium text-slate-500">${title}</div>
    <div class="mt-1 whitespace-pre-wrap leading-6 text-sm text-slate-700">${esc(text || '-')}</div>
  </div>`;
}

function emptyState(text) {
  return `<div class="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">${text}</div>`;
}

function bindInput(id, fn) {
  document.getElementById(id)?.addEventListener('input', e => fn(e.target.value));
}

function bindSelect(id, fn) {
  document.getElementById(id)?.addEventListener('change', e => fn(e.target.value));
}

function renderDebounced() {
  clearTimeout(renderDebounced.timer);
  renderDebounced.timer = setTimeout(() => render(), 160);
}

function val(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function splitWords(text) {
  return String(text || '').split(/[，,\s]+/).map(v => v.trim()).filter(Boolean);
}

function collectAnswers() {
  const answers = {};
  document.querySelectorAll('[data-exp-answer]').forEach(el => {
    answers[el.dataset.expAnswer] = el.value.trim();
  });
  return answers;
}

function collectDraftPatch() {
  const tags = document.getElementById('expTags')?.value || '';
  return {
    title: document.getElementById('expTitle')?.value || '',
    category: document.getElementById('expCategory')?.value || '',
    tags: tags.split(/[，,\s]+/).filter(Boolean),
    trigger: document.getElementById('expTrigger')?.value || '',
    evidence: document.getElementById('expEvidence')?.value || '',
    lesson: document.getElementById('expLesson')?.value || '',
    applicability: document.getElementById('expApplicability')?.value || '',
    risks: document.getElementById('expRisks')?.value || '',
    expiresAt: document.getElementById('expExpiresAt')?.value || '',
    confidence: document.getElementById('expConfidence')?.value || '',
  };
}

function draftForm(draft) {
  return `
    <div class="space-y-2">
      ${draftQualityStrip(draft.extraction)}
      ${input('标题', 'expTitle', draft.title)}
      <div class="grid grid-cols-2 gap-2">
        ${input('分类', 'expCategory', draft.category)}
        ${input('可信度', 'expConfidence', draft.confidence)}
      </div>
      ${input('标签', 'expTags', (draft.tags || []).join('，'))}
      ${input('触发场景', 'expTrigger', draft.trigger)}
      ${area('证据来源', 'expEvidence', draft.evidence, 3)}
      ${area('经验结论', 'expLesson', draft.lesson, 3)}
      ${area('适用边界', 'expApplicability', draft.applicability, 2)}
      ${area('风险提示', 'expRisks', draft.risks, 2)}
      <label class="block text-xs font-medium text-slate-500">有效期
        <input id="expExpiresAt" type="date" class="mt-1 h-9 w-full rounded border border-slate-300 px-2 text-sm" value="${esc(draft.expiresAt || '')}" />
      </label>
    </div>
  `;
}

function input(label, id, value) {
  return `<label class="block text-xs font-medium text-slate-500">${label}
    <input id="${id}" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm" value="${esc(value || '')}" />
  </label>`;
}

function area(label, id, value, rows) {
  return `<label class="block text-xs font-medium text-slate-500">${label}
    <textarea id="${id}" rows="${rows}" class="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm">${esc(value || '')}</textarea>
  </label>`;
}

function reviewMetric(label, value, unit, icon, tone = 'teal') {
  return `<div class="rounded border border-slate-200 bg-white px-3 py-2">
    <div class="flex items-center justify-between gap-2">
      <div class="text-[11px] text-slate-500">${label}</div>
      <span class="material-symbols-outlined text-[16px] ${toneText(tone)}">${icon}</span>
    </div>
    <div class="mt-1 font-semibold tabular-nums text-slate-900">${fmt(value)}<span class="ml-1 text-[11px] font-normal text-slate-500">${unit}</span></div>
  </div>`;
}

function reviewStep(level, title, desc, status = 'pending') {
  const done = status === 'done';
  return `<div class="rounded border ${done ? 'border-teal-200 bg-white' : 'border-slate-200 bg-white'} px-2.5 py-2">
    <div class="flex items-center gap-1.5">
      <span class="inline-flex h-5 w-5 items-center justify-center rounded-full ${done ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500'} text-[10px] font-semibold">${level}</span>
      <span class="text-xs font-medium text-slate-700">${title}</span>
    </div>
    <div class="mt-1 truncate text-[11px] text-slate-500">${esc(desc)}</div>
  </div>`;
}

function reviewQualityPanel(extraction) {
  const score = Number(extraction?.score || 0);
  const gaps = extraction?.gaps || [];
  const checks = extraction?.checks || [];
  const tone = qualityTone(score);
  return `<div class="px-4 py-3 border-b border-slate-100 bg-white">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-slate-800">萃取完整度</div>
        <div class="mt-1 text-xs leading-5 text-slate-500">${esc(extraction?.summary || '回答后会自动判断证据、边界和风险是否足够沉淀。')}</div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-lg font-semibold tabular-nums ${tone.text}">${fmt(score)}<span class="ml-1 text-xs font-normal text-slate-500">分</span></div>
        <div class="text-[11px] text-slate-500">${esc(extraction?.level || '待评估')}</div>
      </div>
    </div>
    <div class="mt-3 h-1.5 rounded bg-slate-100 overflow-hidden"><div class="h-1.5 rounded ${tone.bar}" style="width:${Math.max(4, Math.min(100, score))}%"></div></div>
    ${checks.length ? `<div class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">${checks.slice(0, 4).map(qualityCheckPill).join('')}</div>` : ''}
    ${gaps.length ? `<div class="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">建议继续追问：${gaps.slice(0, 2).map(g => esc(g.label)).join('、')}</div>` : ''}
  </div>`;
}

function qualityCheckPill(check) {
  const ok = check.status === 'ok';
  const partial = check.status === 'partial';
  const cls = ok ? 'border-teal-200 bg-teal-50 text-teal-800' : partial ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-600';
  const icon = ok ? 'check_circle' : partial ? 'radio_button_partial' : 'error';
  return `<div class="rounded border ${cls} px-2.5 py-2">
    <div class="flex items-center gap-1.5">
      <span class="material-symbols-outlined text-[15px]">${icon}</span>
      <span class="text-xs font-medium">${esc(check.label)}</span>
    </div>
    <div class="mt-1 truncate text-[11px] opacity-80">${esc(check.message || '')}</div>
  </div>`;
}

function questionCard(q, index, answer) {
  const isFollowUp = q.level === 'L2';
  return `<label class="block rounded-lg border ${isFollowUp ? 'border-blue-200 bg-blue-50/40' : 'border-slate-200 bg-white'} p-3">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="inline-flex h-6 w-6 items-center justify-center rounded border ${isFollowUp ? 'border-blue-200 bg-white text-blue-700' : 'border-teal-200 bg-teal-50 text-teal-700'} text-[11px] font-semibold">${isFollowUp ? 'L2' : `Q${index + 1}`}</span>
        <span class="font-semibold text-slate-800 truncate">${esc(q.label)}</span>
      </div>
      ${isFollowUp ? '<span class="badge badge-blue shrink-0">递进</span>' : ''}
    </div>
    <div class="mt-2 text-xs leading-5 text-slate-600">${esc(q.prompt)}</div>
    <textarea data-exp-answer="${esc(q.id)}" rows="3" class="mt-2 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm leading-5" placeholder="写下这次判断、依据或适用边界...">${esc(answer || '')}</textarea>
  </label>`;
}

function draftEmptyState(extraction = null) {
  return `<div class="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 text-center">
    <div class="h-11 w-11 rounded-lg border border-slate-200 bg-slate-50 text-slate-500 flex items-center justify-center">
      <span class="material-symbols-outlined text-[22px]">edit_document</span>
    </div>
    <div class="mt-3 font-medium text-slate-800">等待生成经验卡草稿</div>
    <div class="mt-1 max-w-[280px] text-xs leading-5 text-slate-500">先回答左侧关键追问，再点击“生成草稿”。AI 内容会保持草稿状态，确认后才会进入知识库。</div>
    ${extraction ? `<div class="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">当前萃取完整度 ${fmt(extraction.score || 0)} 分，${esc(extraction.gaps?.length ? '建议先补齐追问缺口' : '已具备生成草稿条件')}</div>` : ''}
    <div class="mt-4 grid grid-cols-3 gap-2 w-full max-w-[320px]">
      ${miniProcessPill('结论', 'lesson')}
      ${miniProcessPill('边界', 'rule')}
      ${miniProcessPill('证据', 'fact_check')}
    </div>
  </div>`;
}

function draftQualityStrip(extraction) {
  const score = Number(extraction?.score || 0);
  const tone = qualityTone(score);
  return `<div class="rounded border ${score >= 70 ? 'border-teal-200 bg-teal-50' : 'border-amber-200 bg-amber-50'} px-3 py-2">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="text-xs font-medium ${tone.text}">萃取质量：${esc(extraction?.level || '待评估')}</div>
        <div class="mt-1 text-[11px] leading-4 text-slate-600">${esc(extraction?.summary || '')}</div>
      </div>
      <div class="shrink-0 text-sm font-semibold tabular-nums ${tone.text}">${fmt(score)}分</div>
    </div>
  </div>`;
}

function miniProcessPill(label, icon) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-2 py-2">
    <span class="material-symbols-outlined text-[16px] text-slate-500">${icon}</span>
    <div class="mt-1 text-[11px] text-slate-600">${label}</div>
  </div>`;
}

function extractionFooterHint(extraction) {
  if (!extraction) return '流程：回答追问 → 生成草稿 → 用户确认入库';
  const score = Number(extraction.score || 0);
  if (score >= 85) return '萃取质量较完整，可生成草稿并确认入库';
  if (score >= 70) return '已达到入库门槛，建议补齐高亮缺口后再确认';
  return '当前萃取仍偏薄，建议先点“AI 补问”补证据、边界或风险';
}

function qualityTone(score) {
  return Number(score || 0) >= 70
    ? { text: 'text-teal-700', bar: 'bg-teal-600' }
    : { text: 'text-amber-700', bar: 'bg-amber-500' };
}

function metric(label, value, unit) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
    <div class="text-[11px] text-slate-500">${label}</div>
    <div class="mt-0.5 font-semibold tabular-nums text-slate-900">${value}<span class="ml-1 text-[11px] font-normal text-slate-500">${unit}</span></div>
  </div>`;
}

function stepPill(level, title, desc) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
    <div class="flex items-center gap-1">
      <span class="text-[11px] font-semibold text-teal-700">${level}</span>
      <span class="text-[11px] text-slate-700">${title}</span>
    </div>
    <div class="mt-0.5 truncate text-[11px] text-slate-500">${esc(desc)}</div>
  </div>`;
}

function toneText(tone) {
  return tone === 'amber' ? 'text-amber-700'
    : tone === 'teal' ? 'text-teal-700'
    : 'text-slate-700';
}

function questionSourceText(session) {
  const hasL2 = (session.questions || []).some(q => q.level === 'L2');
  const l1 = session.questionSource === 'ai' ? 'L1 由 AI 根据当前项目动态生成' : 'L1 使用本地模板';
  if (!hasL2) return `${l1}，可继续生成 L2 补问`;
  return `${l1}，L2 ${session.followUpSource === 'ai' ? '由 AI 递进补问' : '由本地规则补问'}`;
}

function isRecent(value) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time < 1000 * 60 * 60 * 24 * 30;
}

function statusLabel(status) {
  return status === 'needs_review' ? '需复核' : status === 'archived' ? '已归档' : '正式';
}

function statusBadgeClass(status) {
  return status === 'needs_review' ? 'badge-yellow' : status === 'archived' ? 'badge-gray' : 'badge-green';
}

function isExpiredDate(value) {
  if (!value) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getTime() < new Date().setHours(0, 0, 0, 0);
}

function sourceLabel(sourceType = '') {
  return {
    version_saved: '保存版本复盘',
    quote_audit: '报价审查复盘',
    project_archive: '项目归档复盘',
    ai_review: 'AI 发起复盘',
  }[sourceType] || '手动复盘';
}

function formatTime(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}
