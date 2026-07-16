// 复盘笔记与个人经验库
import { projectRepo, boqRepo, versionRepo, experienceSessionRepo } from '../data/repository.js?v=6.3';
import { hasMissingPrice } from '../utils/costing.js?v=6.3';
import { experienceService } from '../services/experienceService.js?v=6.3';
import { indicatorService } from '../services/indicatorService.js?v=6.3';
import { esc, fmt, openModal, closeModal, toast, scopedDom } from '../utils/dom.js?v=6.3';

const experienceState = {
  keyword: '',
  projectId: '',
  status: '',
  projectType: '',
  processType: '',
  costCategory: '',
  expired: '',
  selectedId: '',
  selectedProjectId: '',
  selectedSessionId: '',
  activeQuestionIndex: 0,
  activePanel: 'review',
  projectKeyword: '',
  projectStatus: '',
  showEvidence: true,
  showProjectSummary: true,
  showRelatedCases: true,
  pageMode: 'queue',
  answerDrafts: {},
  selectedEvidenceIds: [],
  caseKeyword: '',
  caseFilter: '',
  caseSort: 'similarity',
};

export async function render(workspace = document.getElementById('workspace')) {
  const params = window.__app?.state?.routeParams || {};
  if (params.keyword != null) experienceState.keyword = params.keyword;
  if (params.selectedId) experienceState.selectedId = params.selectedId;
  if (params.projectId) experienceState.selectedProjectId = params.projectId;
  if (params.sessionId) experienceState.selectedSessionId = params.sessionId;
  if (params.sessionId) experienceState.pageMode = 'review';
  const projects = await projectRepo.all();
  const currentProject = projects.find(p => p.id === (experienceState.selectedProjectId || window.__app?.state?.currentProjectId)) || projects[0] || null;
  const [boq, versions, dashboard, kb, benchmark] = await Promise.all([
    boqRepo.all(),
    versionRepo.all(),
    experienceService.dashboard(),
    experienceService.listKnowledgeBase(currentFilters()),
    currentProject ? indicatorService.benchmarkProject(currentProject.id) : Promise.resolve(null),
  ]);
  if (currentProject && !experienceState.selectedProjectId) experienceState.selectedProjectId = currentProject.id;
  const sessions = dashboard.sessions || [];
  const currentSession = sessions.find(s => s.id === experienceState.selectedSessionId && s.projectId === currentProject?.id && (experienceState.pageMode === 'review' || s.status !== 'confirmed'))
    || sessions.filter(s => s.projectId === currentProject?.id && s.status !== 'confirmed').sort(byUpdatedDesc)[0]
    || null;
  if (currentSession) experienceState.selectedSessionId = currentSession.id;
  if (currentSession && !Object.keys(experienceState.answerDrafts).length) experienceState.answerDrafts = { ...(currentSession.answers || {}) };
  if (!currentSession && experienceState.pageMode === 'review') experienceState.pageMode = 'queue';
  const selected = kb.items.find(card => card.id === experienceState.selectedId) || kb.items[0] || null;
  if (selected) experienceState.selectedId = selected.id;
  const projectRows = buildReviewProjectRows(projects, boq, versions, sessions, kb.items);
  const visibleProjects = filterReviewProjects(projectRows);

  workspace.innerHTML = `
    <div class="page-frame min-h-full flex flex-col gap-3">
      <section class="card p-4 shrink-0">
        <div class="flex flex-col lg:flex-row lg:items-center gap-4">
          <div class="h-11 w-11 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[24px]">psychology_alt</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <div class="text-base font-semibold text-slate-900">复盘笔记</div>
              ${currentProject ? `<span class="badge badge-blue">当前：${esc(currentProject.name)}</span>` : ''}
            </div>
            <div class="mt-1 text-sm leading-6 text-slate-600">选择项目，回答几个关键问题，把这次报价的判断和依据留给未来的自己。</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs text-slate-500">数据保存在本机</span>
            <button id="expStartPrimary" class="px-3 py-1.5 text-sm brand-bg text-white rounded ${currentProject ? '' : 'opacity-50'}">${currentSession ? '继续复盘' : '开始复盘'}</button>
          <button onclick="window.__app.openAI()" class="px-3 py-1.5 text-sm border border-slate-300 bg-white rounded hover:bg-slate-50">问 AI</button>
          </div>
        </div>
        ${renderReviewFlowSteps(experienceState.pageMode, currentSession, projectRows, sessions, kb)}
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_360px] gap-3 flex-1 min-h-0">
        <aside class="card p-0 overflow-hidden min-h-[560px] flex flex-col">
          <div class="px-4 py-3 border-b border-slate-200">
            <div class="font-semibold text-slate-800">待复盘项目</div>
            <div class="mt-1 text-xs text-slate-500">优先处理有报价版本或待确认复盘的项目。</div>
          </div>
          <div class="p-3 border-b border-slate-200 space-y-2">
            <label class="block text-xs font-medium text-slate-500">搜索项目
              <input id="expProjectKeyword" class="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm" placeholder="项目名称 / 工艺" value="${esc(experienceState.projectKeyword)}" />
            </label>
            <select id="expProjectStatus" class="h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm">
              <option value="">全部项目</option>
              <option value="pending" ${experienceState.projectStatus === 'pending' ? 'selected' : ''}>待复盘</option>
              <option value="in_progress" ${experienceState.projectStatus === 'in_progress' ? 'selected' : ''}>进行中</option>
              <option value="completed" ${experienceState.projectStatus === 'completed' ? 'selected' : ''}>已完成</option>
            </select>
          </div>
          <div class="p-3 space-y-2 overflow-auto scroll-thin flex-1">
            ${visibleProjects.length ? visibleProjects.map(row => reviewProjectCard(row, row.project.id === currentProject?.id)).join('') : `<div class="rounded border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm text-slate-500">还没有可复盘的项目。<button class="mt-2 block mx-auto text-teal-700 underline" onclick="window.__app.go('projects',{action:'new'})">去新建项目</button></div>`}
          </div>
        </aside>

        <main class="card p-0 overflow-hidden min-h-[560px] flex flex-col">
          ${experienceState.pageMode === 'review' && currentSession
            ? renderReviewWorkspace(currentSession, currentProject, projectRows.find(row => row.project.id === currentProject?.id), kb.items)
            : activeReviewPanel(currentProject, currentSession, kb.items, selected)}
        </main>

        <aside class="card p-0 overflow-hidden min-h-[560px] flex flex-col">
          ${renderSavedNotesPanel(kb.items, selected?.id, currentSession)}
          ${renderProjectSummary(currentProject, currentSession, projectRows.find(row => row.project.id === currentProject?.id))}
          ${renderCostReference(currentProject, benchmark)}
          ${renderRelatedCases(currentProject, projectRows)}
        </aside>
      </section>
    </div>
  `;
  const document = scopedDom(workspace);
  bindExperiencePage(projects, document);
  bindReviewWorkspace(projects, sessions, kb.items, projectRows, currentProject, benchmark, document);
}

function byUpdatedDesc(a, b) {
  return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
}

function buildReviewProjectRows(projects, boq, versions, sessions, cards) {
  return projects.map(project => {
    const lines = boq.filter(line => line.projectId === project.id);
    const projectVersions = versions.filter(version => version.projectId === project.id);
    const projectSessions = sessions.filter(session => session.projectId === project.id);
    const pending = projectSessions.some(session => session.status !== 'confirmed');
    const confirmed = cards.some(card => card.projectId === project.id && card.reviewStatus === 'confirmed');
    const missing = lines.filter(line => hasMissingPrice(line.unitPrice)).length;
    const latestSession = projectSessions.slice().sort(byUpdatedDesc)[0];
    return {
      project,
      lines,
      versions: projectVersions,
      sessions: projectSessions,
      missing,
      zeroQty: lines.filter(line => !(Number(line.qty) > 0)).length,
      pending,
      confirmed,
      reviewStatus: pending ? 'in_progress' : confirmed ? 'completed' : 'pending',
      latestAt: latestSession?.updatedAt || project.updatedAt || project.createdAt || '',
    };
  }).sort((a, b) => {
    const rank = row => row.pending ? 0 : row.versions.length ? 1 : row.missing ? 2 : row.confirmed ? 4 : 3;
    return rank(a) - rank(b) || b.latestAt.localeCompare(a.latestAt);
  });
}

function filterReviewProjects(rows) {
  const keyword = experienceState.projectKeyword.trim().toLowerCase();
  return rows.filter(row => {
    const blob = `${row.project.name || ''} ${row.project.type || ''} ${row.project.process || ''}`.toLowerCase();
    if (keyword && !blob.includes(keyword)) return false;
    return !experienceState.projectStatus || row.reviewStatus === experienceState.projectStatus;
  });
}

function reviewProjectCard(row, active) {
  const statusText = row.reviewStatus === 'in_progress' ? '进行中' : row.reviewStatus === 'completed' ? '已完成' : '待复盘';
  const statusClass = row.reviewStatus === 'in_progress' ? 'badge-yellow' : row.reviewStatus === 'completed' ? 'badge-green' : 'badge-gray';
  const action = row.reviewStatus === 'in_progress' ? '继续复盘' : row.reviewStatus === 'completed' ? '查看笔记' : '开始复盘';
  return `<article data-review-project="${esc(row.project.id)}" role="button" aria-current="${active ? 'true' : 'false'}" tabindex="0" class="w-full rounded-lg border ${active ? 'border-teal-500 bg-teal-50/60' : 'border-slate-200 bg-white'} p-3 text-left transition-colors hover:border-teal-300">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="font-semibold text-slate-900 truncate">${esc(row.project.name || '未命名项目')}</div>
        <div class="mt-1 text-xs text-slate-500 truncate">${esc(row.project.type || '未分类')} · ${esc(row.project.process || '未填写工艺')}</div>
      </div>
      <span class="badge ${statusClass} shrink-0">${statusText}</span>
    </div>
    <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
      ${optionalMetric('最终造价', row.project.totalCost)}
      ${optionalMetric('合同金额', row.project.contractAmount)}
      ${optionalMetric('结算金额', row.project.settlementAmount)}
      <div><div class="text-slate-400">报价版本</div><div class="mt-0.5 font-semibold tabular-nums text-slate-800">${row.versions.length} 个</div></div>
    </div>
    <div class="mt-2 text-[11px] text-slate-500">${esc(row.project.capacity || row.project.scale || '规模未填写')} · ${esc(row.project.process || '工艺未填写')} · 更新于 ${esc((row.latestAt || '').slice(0, 10) || '-')}</div>
    <div class="mt-3 flex items-center justify-between text-[11px]">
      <span class="${row.missing ? 'text-amber-700' : 'text-slate-500'}">${row.missing ? `${row.missing} 条缺单价` : '价格完整'}</span>
      <button type="button" data-review-action="${esc(row.project.id)}" class="rounded border border-teal-300 bg-white px-2.5 py-1 text-xs font-medium text-teal-700 hover:bg-teal-50">${action}</button>
    </div>
  </article>`;
}

function optionalMetric(label, value) {
  if (value == null || value === '') return '';
  return `<div><div class="text-slate-400">${label}</div><div class="mt-0.5 font-semibold tabular-nums text-slate-800">${fmt(value)}</div></div>`;
}

function renderReviewFlowSteps(mode, session, rows, sessions, kb) {
  const unanswered = session ? (session.questions || []).filter(q => !(session.answers || {})[q.id] && !experienceState.answerDrafts[q.id]).length : 0;
  const steps = [
    ['选择项目', mode === 'review' ? '已选择当前项目' : `${rows.length} 个项目可选`, mode === 'review' ? 'done' : 'active'],
    ['回答问题', mode === 'review' ? `第 ${Math.min((experienceState.activeQuestionIndex || 0) + 1, session?.questions?.length || 1)} / ${session?.questions?.length || 0} 问` : '基于依据回答关键问题', mode === 'review' ? 'active' : 'pending'],
    ['保存笔记', mode === 'review' ? (session?.status === 'confirmed' ? '已保存当前笔记' : `${unanswered} 个问题待补充`) : `${kb?.stats?.confirmed || 0} 条已保存`, mode === 'review' && session?.status === 'confirmed' ? 'done' : 'pending'],
  ];
  return `<div class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">${steps.map(([title, note, state], i) => `<div class="flex items-center gap-3 rounded-lg border ${state === 'active' ? 'border-teal-300 bg-teal-50/70' : 'border-slate-200 bg-slate-50'} px-3 py-2.5"><span class="h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ${state === 'done' ? 'bg-teal-700 text-white' : state === 'active' ? 'border-2 border-teal-600 text-teal-700 bg-white' : 'border border-slate-300 text-slate-400 bg-white'}">${state === 'done' ? '✓' : i + 1}</span><div class="min-w-0"><div class="text-sm font-semibold ${state === 'active' ? 'text-teal-900' : 'text-slate-700'}">${title}</div><div class="text-xs text-slate-500 truncate">${note}</div></div></div>`).join('')}</div>`;
}

function renderReviewWorkspace(session, project, row, cards) {
  const questions = session.questions || [];
  const index = Math.max(0, Math.min(experienceState.activeQuestionIndex || 0, Math.max(questions.length - 1, 0)));
  experienceState.activeQuestionIndex = index;
  const question = questions[index];
  const answer = question ? (experienceState.answerDrafts[question.id] ?? session.answers?.[question.id] ?? '') : '';
  const evidence = buildReviewEvidence(session, project, row?.lines || [], row?.versions || [], question?.id);
  if (!question) return `<div class="flex-1 p-6"><div class="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center"><div class="font-semibold text-slate-800">当前没有待回答问题</div><div class="mt-2 text-sm text-slate-500">可以退出复盘，或使用 AI 补问生成新的问题。</div><button data-review-ai-refine class="mt-4 px-3 py-2 text-sm brand-bg text-white rounded">AI 补问</button></div></div>`;
  const progress = questions.length ? Math.round(Object.keys(experienceState.answerDrafts).filter(id => experienceState.answerDrafts[id]).length / questions.length * 100) : 0;
  return `<div class="review-workspace flex flex-col h-full min-h-[560px]">
    <div class="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3"><div class="min-w-0"><div class="flex items-center gap-2"><button data-review-exit class="text-slate-500 hover:text-teal-700" aria-label="退出复盘"><span class="material-symbols-outlined">arrow_back</span></button><div class="font-semibold text-slate-900 truncate">当前复盘：${esc(project.name)}</div></div><div class="mt-1 ml-8 text-xs text-slate-500">${esc(project.type || '未分类')} · ${esc(project.capacity || project.scale || '规模未填写')} · ${esc(project.process || '工艺未填写')}</div></div><div class="text-right text-xs text-slate-500">问题进度（共 ${questions.length} 题）<div class="mt-1 font-semibold text-teal-700">${index + 1} / ${questions.length}</div></div></div>
    <div class="px-4 pt-4 overflow-auto scroll-thin flex-1 space-y-4">
      <div><div class="flex items-center justify-between text-xs text-slate-500"><span>已回答 ${Object.keys(experienceState.answerDrafts).filter(id => experienceState.answerDrafts[id]).length} 题</span><span>${progress}%</span></div><div class="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="h-2 rounded-full bg-teal-600" style="width:${progress}%"></div></div></div>
      <section class="rounded-xl border border-teal-200 bg-white p-4 shadow-sm"><div class="flex items-center gap-2 text-xs text-teal-700"><span class="badge badge-blue">问题 ${index + 1}</span><span>${esc(question.tag || question.level || '报价判断')}</span></div><h2 class="mt-3 text-lg font-semibold text-slate-900">${esc(question.prompt || question.title || '请补充这次报价的关键判断')}</h2><p class="mt-2 text-sm leading-6 text-slate-500">${esc(question.guidance || question.description || '结合下方依据，记录影响报价结果的原因、判断和适用边界。')}</p><label for="reviewAnswerInput" class="mt-4 block text-xs font-medium text-slate-600">你的回答</label><textarea id="reviewAnswerInput" rows="6" maxlength="1000" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm leading-6 focus:border-teal-500 focus:ring-2 focus:ring-teal-100" placeholder="写下这次报价中最值得留给未来自己的判断…">${esc(answer)}</textarea><div class="mt-1 text-right text-xs text-slate-400"><span id="reviewAnswerCount">${String(answer).length}</span> / 1000</div></section>
      <section><div class="flex items-center justify-between"><div><div class="font-semibold text-slate-800">关联依据</div><div class="mt-1 text-xs text-slate-500">点击依据可加入回答，保留可追溯来源。</div></div><span class="text-xs text-slate-400">${evidence.length} 条</span></div><div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">${evidence.length ? evidence.map(renderEvidenceCard).join('') : '<div class="md:col-span-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">暂无可直接引用的依据，可以先回答问题，之后再补充资料。</div>'}</div></section>
      <section><div class="text-xs font-medium text-slate-500">快速选择</div><div class="mt-2 flex flex-wrap gap-2">${['材料价格上涨','设计变更增加工程量','签证变更多','施工组织影响','设备选型变更','不可抗力因素','管理费用超支','其他原因'].map(chip => `<button data-review-chip="${esc(chip)}" class="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-600 hover:border-teal-400 hover:text-teal-700">${esc(chip)}</button>`).join('')}</div></section>
    </div>
    <div class="px-4 py-3 border-t border-slate-200 bg-white flex flex-wrap items-center justify-between gap-2"><div class="flex flex-wrap gap-2"><button data-review-prev class="px-3 py-1.5 text-sm border border-slate-300 rounded ${index === 0 ? 'opacity-50' : ''}">上一题</button><button data-review-next class="px-3 py-1.5 text-sm border border-slate-300 rounded">下一题</button><button data-review-skip class="px-3 py-1.5 text-sm text-slate-600">跳过此题</button></div><div class="flex flex-wrap gap-2"><button data-review-save-draft class="px-3 py-1.5 text-sm border border-teal-300 text-teal-700 rounded">暂存草稿</button><button data-review-ai-refine class="px-3 py-1.5 text-sm border border-slate-300 rounded">AI 补问</button><button data-review-generate-draft class="px-3 py-1.5 text-sm border border-teal-300 bg-teal-50 text-teal-700 rounded">AI 生成草稿</button>${session.draft ? '<button data-review-confirm class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存笔记</button>' : ''}<button data-review-save-next class="px-3 py-1.5 text-sm brand-bg text-white rounded">保存并下一题</button></div></div>
  </div>`;
}

function friendlyEvidenceText(text) {
  return String(text || '').replaceAll('进入正式样本池', '可作为后续参考案例').replaceAll('正式样本池', '后续参考案例').replaceAll('候选样本', '待检查记录').replaceAll('数据引擎', '系统检查').replaceAll('质量报告', '资料质量检查');
}

function buildReviewEvidence(session, project, lines, versions, questionId = 'question') {
  const list = [];
  const prefix = `${session.id}-${questionId}`;
  versions.slice(0, 3).forEach(v => list.push({ id: `${prefix}-version-${v.id}`, title: v.name || v.versionName || '报价版本', source: '报价版本', value: fmt(v.totalCost || v.amount || project?.totalCost || 0), date: v.createdAt || v.updatedAt }));
  const missing = lines.filter(line => hasMissingPrice(line.unitPrice));
  if (missing.length) list.push({ id: `${prefix}-risk-missing-price`, title: `${missing.length} 条清单缺少单价`, source: '工程量风险', value: '待补充', risk: true });
  const zero = lines.filter(line => !(Number(line.qty) > 0));
  if (zero.length) list.push({ id: `${prefix}-risk-zero-qty`, title: `${zero.length} 条工程量需要检查`, source: '工程量风险', value: '需检查', risk: true });
  (session.context?.evidence?.recommendations || []).slice(0, 3).forEach((item, i) => list.push({ id: `${prefix}-recommendation-${i}`, title: friendlyEvidenceText(item?.title || item?.message || item), source: '系统检查建议', value: '可引用' }));
  return list.slice(0, 6);
}

function renderEvidenceCard(evidence) {
  const selected = experienceState.selectedEvidenceIds.includes(evidence.id);
  return `<button type="button" data-review-evidence="${esc(evidence.id)}" data-evidence-title="${esc(evidence.title)}" aria-pressed="${selected ? 'true' : 'false'}" class="text-left rounded-lg border ${selected ? 'border-teal-500 bg-teal-50/70' : 'border-slate-200 bg-white'} p-3 hover:border-teal-400"><div class="flex items-start justify-between gap-2"><span class="material-symbols-outlined text-[18px] ${evidence.risk ? 'text-amber-600' : 'text-teal-700'}">${evidence.risk ? 'warning' : 'description'}</span><span class="text-[11px] ${selected ? 'text-teal-700' : 'text-slate-400'}">${selected ? '已引用' : '引用'}</span></div><div class="mt-2 text-sm font-medium text-slate-800 line-clamp-2">${esc(evidence.title)}</div><div class="mt-1 text-xs text-slate-500">${esc(evidence.source)} · ${esc(evidence.date || '当前资料')}</div><div class="mt-1 text-xs ${evidence.risk ? 'text-amber-700' : 'text-slate-600'}">${esc(evidence.value || '')}</div></button>`;
}

function activeReviewPanel(project, session, cards, selected) {
  if (!project) return `<div class="flex h-full min-h-[560px] items-center justify-center p-8 text-center"><div><div class="font-semibold text-slate-800">还没有项目</div><div class="mt-2 text-sm text-slate-500">先建立一个项目，再开始复盘报价判断。</div><button onclick="window.__app.go('projects',{action:'new'})" class="mt-4 px-3 py-2 text-sm brand-bg text-white rounded">新建项目</button></div></div>`;
  if (!session) return `<div class="flex h-full min-h-[560px] items-center justify-center p-8 text-center"><div class="max-w-md"><div class="mx-auto h-12 w-12 rounded-lg border border-teal-200 bg-teal-50 text-teal-700 flex items-center justify-center"><span class="material-symbols-outlined text-[26px]">psychology_alt</span></div><div class="mt-4 text-lg font-semibold text-slate-900">准备复盘「${esc(project.name)}」</div><div class="mt-2 text-sm leading-6 text-slate-500">系统会根据项目清单、报价版本和风险项生成几个问题，回答后保存为复盘笔记。</div><button data-inline-start="${esc(project.id)}" class="mt-5 px-4 py-2 text-sm brand-bg text-white rounded">开始复盘</button></div></div>`;
  const questions = session.questions || [];
  const answered = Object.keys(session.answers || {}).length;
  const draft = session.draft;
  return `<div class="flex flex-col h-full">
    <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
      <div class="min-w-0"><div class="font-semibold text-slate-900">当前复盘：${esc(session.projectNameSnapshot || project.name)}</div><div class="mt-1 text-xs text-slate-500">${esc(session.versionNameSnapshot || '当前工作稿')} · ${answered} / ${questions.length || 0} 个问题已有回答</div></div>
      <button data-inline-session="${esc(session.id)}" class="px-3 py-1.5 text-sm brand-bg text-white rounded">继续复盘</button>
    </div>
    <div class="p-4 space-y-4 overflow-auto scroll-thin flex-1">
      <div class="rounded-lg border border-teal-200 bg-teal-50/60 p-4"><div class="flex items-center justify-between text-sm"><span class="font-semibold text-teal-900">复盘进度</span><span class="font-data text-teal-800">${questions.length ? Math.round(answered / questions.length * 100) : 0}%</span></div><div class="mt-2 h-2 rounded-full bg-white overflow-hidden"><div class="h-2 rounded-full bg-teal-600" style="width:${questions.length ? Math.min(100, answered / questions.length * 100) : 0}%"></div></div><div class="mt-2 text-xs text-teal-800">打开复盘后可以逐题回答、引用依据并保存笔记。</div></div>
      <section class="rounded-lg border border-slate-200 bg-white p-4"><div class="flex items-center gap-2"><span class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-teal-700 text-white text-xs">1</span><span class="font-semibold text-slate-800">事实背景</span><span class="text-xs text-teal-700">已完成</span></div><div class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">${reviewContextMetric('清单', session.context?.lineCount || 0, '条')}${reviewContextMetric('缺单价', session.context?.missingPriceCount || 0, '条')}${reviewContextMetric('0 工程量', session.context?.zeroQtyCount || 0, '条')}${reviewContextMetric('系数异常', session.context?.factorRiskCount || 0, '条')}</div></section>
      <section class="rounded-lg border border-slate-200 bg-slate-50/70 p-4"><div class="font-semibold text-slate-800">当前待处理问题</div><div class="mt-2 text-sm text-slate-700">${esc(questions.find(q => !(session.answers || {})[q.id])?.prompt || questions[0]?.prompt || '暂无问题')}</div><div class="mt-3 text-xs text-slate-500">${draft ? '已有复盘笔记草稿，可以继续编辑或保存。' : '继续复盘后会进入逐题回答。'}</div></section>
      <section class="rounded-lg border border-slate-200 bg-white p-4"><div class="flex items-center justify-between"><div class="font-semibold text-slate-800">关联依据</div><span class="text-xs text-slate-500">${session.context?.evidence?.recommendations?.length || 0} 条建议</span></div>${session.context?.evidence?.recommendations?.length ? `<div class="mt-3 space-y-2">${session.context.evidence.recommendations.slice(0, 3).map(item => evidenceCard(item)).join('')}</div>` : '<div class="mt-3 text-sm text-slate-400">暂无关联依据，进入复盘后可继续补充。</div>'}</section>
    </div>
  </div>`;
}

function reviewContextMetric(label, value, unit) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-2.5 py-2"><div class="text-[11px] text-slate-500">${label}</div><div class="mt-1 font-semibold tabular-nums text-slate-800">${fmt(value)}<span class="ml-1 text-[11px] font-normal text-slate-500">${unit}</span></div></div>`;
}

function evidenceCard(text) {
  return `<div class="rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"><span class="material-symbols-outlined mr-1 align-middle text-[16px] text-teal-700">description</span>${esc(typeof text === 'string' ? text : text?.message || text?.title || '复核建议')}</div>`;
}

function renderSavedNotesPanel(cards, selectedId, session) {
  const notes = cards.filter(card => card.reviewStatus !== 'archived').sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')).slice(0, 5);
  return `<section class="border-b border-slate-200"><div class="px-4 py-3 flex items-center justify-between"><div><div class="font-semibold text-slate-800">已保存笔记</div><div class="mt-1 text-xs text-slate-500">${cards.length} 条，可继续补充自己的判断</div></div><button data-show-all-notes class="text-xs text-teal-700 hover:underline">查看全部</button></div><div class="px-4 pb-4 relative"><div class="absolute left-7 top-1 bottom-2 w-px bg-slate-200"></div><div class="space-y-3">${notes.length ? notes.map(card => `<div class="relative pl-7"><span class="absolute left-0 top-2 h-3 w-3 rounded-full ${card.id === selectedId ? 'bg-teal-600 ring-4 ring-teal-100' : 'bg-white border-2 border-teal-500'}"></span><div class="rounded-lg border ${card.id === selectedId ? 'border-teal-400 bg-teal-50/50' : 'border-slate-200 bg-white'} p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><div class="text-[11px] text-teal-700">${esc(card.questionLabel || card.sourceType || '复盘问题')}</div><div class="mt-1 font-medium text-slate-800 line-clamp-2">${esc(card.title || '未命名复盘')}</div></div><span class="badge ${statusBadgeClass(card.reviewStatus)}">${statusLabel(card.reviewStatus)}</span></div><div class="mt-2 text-xs leading-5 text-slate-600 line-clamp-3">${esc(card.lesson || '暂无经验结论')}</div><div class="mt-2 text-[11px] text-slate-400">${esc((card.updatedAt || card.createdAt || '').slice(0, 16) || '刚刚')} · 引用 ${fmt(card.reuseCount || 0)} 次</div><div class="mt-2 flex gap-3"><button data-note-view="${esc(card.id)}" class="text-xs text-teal-700">查看</button>${card.sessionId ? `<button data-inline-session="${esc(card.sessionId)}" class="text-xs text-slate-600">继续编辑</button>` : ''}</div></div></div>`).join('') : '<div class="rounded border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs text-slate-500">完成当前问题后，复盘笔记会显示在这里。</div>'}</div></div></section>`;
}

function renderProjectSummary(project, session, row) {
  if (!project) return '';
  const total = Number(project.totalCost || session?.context?.project?.totalCost || 0);
  const missing = row?.missing || session?.context?.missingPriceCount || 0;
  const zeroQty = row?.zeroQty || session?.context?.zeroQtyCount || 0;
  const progress = session ? Math.round(Object.keys(session.answers || {}).length / Math.max(1, (session.questions || []).length) * 100) : 0;
  return `<details class="border-b border-slate-200"><summary class="cursor-pointer list-none px-4 py-3 font-semibold text-slate-800">项目摘要 <span class="float-right text-xs font-normal text-slate-400">展开</span></summary><div class="px-3 pb-3 grid grid-cols-2 gap-2">${summaryMetric('总造价', fmt(total))}${summaryMetric('缺单价', fmt(missing))}${summaryMetric('0 工程量', fmt(zeroQty))}${summaryMetric('复盘进度', `${progress}%`)}</div></details>`;
}

function renderCostReference(project, benchmark) {
  if (!project) return '';
  const total = benchmark?.metrics?.find(metric => metric.key === 'totalCost');
  const area = benchmark?.metrics?.find(metric => metric.key === 'areaCost');
  const water = benchmark?.metrics?.find(metric => metric.key === 'waterCost');
  const status = total?.status?.label || '样本不足';
  const statusTone = status === '合理区间' ? 'text-emerald-700' : status === '偏高' ? 'text-rose-700' : status === '偏低' ? 'text-blue-700' : 'text-amber-700';
  return `<details class="border-b border-slate-200"><summary class="cursor-pointer list-none px-4 py-3 font-semibold text-slate-800">造价参考 <span class="float-right text-xs font-normal ${statusTone}">${esc(status)}</span></summary><div class="px-3 pb-3 space-y-3"><div class="grid grid-cols-2 gap-2">${summaryMetric('同类案例', benchmark?.sampleCount ? `${fmt(benchmark.sampleCount)} 个` : '样本不足')}${summaryMetric('可信度', benchmark?.confidence || '暂无资料')}${summaryMetric('单方造价', area?.value ? fmt(area.value) : '暂无资料')}${summaryMetric('单水造价', water?.value ? fmt(water.value) : '暂无资料')}</div><div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">${esc(benchmark?.conclusion || '当前可用案例不足，仅供参考，建议先补充或收录更多项目。')}</div><button type="button" data-benchmark-detail class="w-full rounded border border-teal-300 bg-white px-3 py-2 text-xs text-teal-700 hover:bg-teal-50">查看参考依据</button></div></details>`;
}

function summaryMetric(label, value) {
  return `<div class="rounded border border-slate-200 bg-slate-50 px-2.5 py-2"><div class="text-[11px] text-slate-500">${label}</div><div class="mt-1 font-semibold tabular-nums text-slate-800 truncate">${value}</div></div>`;
}

function renderRelatedCases(project, rows) {
  const candidates = rows.filter(row => row.project.id !== project?.id && row.project.status === 'archived');
  const scored = candidates.map(row => {
    let score = 0;
    const reasons = [];
    if (row.project.type && row.project.type === project?.type) { score += 5; reasons.push('同项目类型'); }
    if (row.project.process && row.project.process === project?.process) { score += 4; reasons.push('同工艺'); }
    if (row.project.scale && row.project.scale === project?.scale) { score += 2; reasons.push('同规模'); }
    if (row.project.structure && row.project.structure === project?.structure) { score += 1; reasons.push('同结构'); }
    if (row.versions.length) score += 1;
    if (!row.missing) score += 2;
    const area = Number(project?.area || 0);
    const rowArea = Number(row.project.area || 0);
    const distance = area && rowArea ? Math.abs(area - rowArea) / Math.max(area, rowArea) : 1;
    if (distance < 0.3) score += 2;
    const unitCost = row.project.area ? Number(row.project.totalCost || 0) / Number(row.project.area) : 0;
    return { ...row, similarity: score, reason: reasons.slice(0, 2).join('、') || '可作为补充参考', unitCost };
  });
  const filtered = scored.filter(row => {
    const keyword = experienceState.caseKeyword.trim().toLowerCase();
    const blob = `${row.project.name || ''} ${row.project.type || ''} ${row.project.process || ''} ${row.project.structure || ''}`.toLowerCase();
    if (keyword && !blob.includes(keyword)) return false;
    if (experienceState.caseFilter === 'type' && row.project.type !== project?.type) return false;
    if (experienceState.caseFilter === 'process' && row.project.process !== project?.process) return false;
    if (experienceState.caseFilter === 'version' && !row.versions.length) return false;
    if (experienceState.caseFilter === 'complete' && row.missing) return false;
    return true;
  }).sort((a, b) => experienceState.caseSort === 'recent' ? b.latestAt.localeCompare(a.latestAt) : experienceState.caseSort === 'unit' ? Math.abs(a.unitCost - Number(project?.totalCost || 0) / Math.max(1, Number(project?.area || 0))) - Math.abs(b.unitCost - Number(project?.totalCost || 0) / Math.max(1, Number(project?.area || 0))) : experienceState.caseSort === 'total' ? Number(b.project.totalCost || 0) - Number(a.project.totalCost || 0) : b.similarity - a.similarity).slice(0, 3);
  return `<details class="border-b border-slate-200"><summary class="cursor-pointer list-none px-4 py-3 font-semibold text-slate-800">相关案例 <span class="float-right text-xs font-normal text-slate-400">${filtered.length} 条</span></summary><div class="px-3 pb-3 space-y-2"><input id="reviewCaseKeyword" class="h-8 w-full rounded border border-slate-300 px-2 text-xs" placeholder="搜索项目、类型、工艺或结构" value="${esc(experienceState.caseKeyword)}" /><div class="grid grid-cols-2 gap-2"><select id="reviewCaseFilter" class="h-8 rounded border border-slate-300 px-2 text-xs"><option value="">全部案例</option><option value="type" ${experienceState.caseFilter === 'type' ? 'selected' : ''}>同项目类型</option><option value="process" ${experienceState.caseFilter === 'process' ? 'selected' : ''}>同工艺</option><option value="version" ${experienceState.caseFilter === 'version' ? 'selected' : ''}>有报价版本</option><option value="complete" ${experienceState.caseFilter === 'complete' ? 'selected' : ''}>价格完整</option></select><select id="reviewCaseSort" class="h-8 rounded border border-slate-300 px-2 text-xs"><option value="similarity" ${experienceState.caseSort === 'similarity' ? 'selected' : ''}>相似度最高</option><option value="recent" ${experienceState.caseSort === 'recent' ? 'selected' : ''}>最近收录</option><option value="unit" ${experienceState.caseSort === 'unit' ? 'selected' : ''}>单位造价接近</option><option value="total" ${experienceState.caseSort === 'total' ? 'selected' : ''}>总造价从高到低</option></select></div>${filtered.length ? filtered.map(caseRow => `<div class="rounded-lg border border-slate-200 bg-white p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><div class="font-medium text-slate-800 truncate">${esc(caseRow.project.name)}</div><div class="mt-1 text-[11px] text-slate-500">${esc(caseRow.project.type || '未分类')} · ${esc(caseRow.project.process || caseRow.project.structure || '资料未填写')}</div></div><span class="badge badge-blue">${esc(caseRow.reason)}</span></div><div class="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-500"><span>总造价 <b class="text-slate-800">${fmt(caseRow.project.totalCost || 0)}</b></span><span>单位造价 <b class="text-slate-800">${caseRow.unitCost ? fmt(caseRow.unitCost) : '暂无资料'}</b></span><span>报价版本 <b class="text-slate-800">${caseRow.versions.length} 个</b></span><span>收录时间 <b class="text-slate-800">${esc((caseRow.latestAt || '').slice(0, 10) || '-')}</b></span></div><button type="button" data-case-detail="${esc(caseRow.project.id)}" class="mt-2 text-xs text-teal-700 hover:underline">查看案例</button></div>`).join('') : '<div class="rounded border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs text-slate-500">当前没有匹配的可用案例。</div>'}<button type="button" data-show-more-cases class="w-full rounded border border-slate-300 bg-white px-3 py-2 text-xs text-slate-600">查看更多案例</button></div></details>`;
}

function caseDetailPanel(row, cards, currentProject) {
  const project = row.project;
  const unitCost = project.area ? Number(project.totalCost || 0) / Number(project.area) : 0;
  const note = cards.find(card => card.projectId === project.id && card.reviewStatus === 'confirmed');
  return `<div class="space-y-4 text-sm"><div class="grid grid-cols-2 gap-2">${summaryMetric('项目类型', project.type || '未分类')}${summaryMetric('工艺类型', project.process || '暂无资料')}${summaryMetric('总造价', fmt(project.totalCost || 0))}${summaryMetric('单位造价', unitCost ? fmt(unitCost) : '暂无资料')}${summaryMetric('清单条数', fmt(row.lines.length))}${summaryMetric('缺单价', fmt(row.missing))}${summaryMetric('报价版本', `${row.versions.length} 个`)}${summaryMetric('收录时间', (row.latestAt || '').slice(0, 10) || '暂无资料')}</div>${note ? `<div class="rounded border border-slate-200 bg-slate-50 p-3"><div class="font-medium text-slate-800">可复用复盘笔记</div><div class="mt-1 text-xs leading-5 text-slate-600">${esc(note.lesson || note.title || '暂无结论')}</div></div>` : '<div class="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">该案例暂无已确认的复盘笔记。</div>'}<div class="flex flex-wrap gap-2"><button type="button" onclick="window.__app.go('boq',{projectId:'${esc(project.id)}'})" class="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700">打开项目清单</button><button type="button" data-case-add-evidence="${esc(project.id)}" data-case-title="${esc(project.name)}" class="rounded border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs text-teal-700">加入当前回答依据</button></div></div>`;
}

function benchmarkDetailPanel(benchmark) {
  if (!benchmark) return '<div class="p-4 text-sm text-slate-500">当前没有可用的造价参考数据。</div>';
  const total = benchmark.metrics?.find(metric => metric.key === 'totalCost');
  return `<div class="space-y-4 text-sm"><div class="grid grid-cols-2 gap-2">${summaryMetric('同类案例', benchmark.sampleCount ? `${fmt(benchmark.sampleCount)} 个` : '样本不足')}${summaryMetric('可信度', benchmark.confidence || '暂无资料')}${summaryMetric('参考指标', total?.label || '总造价')}${summaryMetric('当前值', total?.value ? fmt(total.value) : '暂无资料')}</div><div class="rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">${esc(benchmark.conclusion || '当前可用案例不足，仅供参考。')}</div>${benchmark.deviations?.length ? `<div><div class="font-medium text-slate-800">成本构成偏差</div><div class="mt-2 space-y-2">${benchmark.deviations.slice(0, 5).map(item => `<div class="flex justify-between gap-3 rounded border border-slate-200 bg-white px-3 py-2 text-xs"><span>${esc(item.category)}</span><span class="tabular-nums ${item.delta >= 0 ? 'text-rose-700' : 'text-teal-700'}">${item.delta >= 0 ? '+' : ''}${fmt(item.delta)}</span></div>`).join('')}</div></div>` : ''}</div>`;
}

function bindReviewWorkspace(projects, sessions, cards = [], projectRows = [], currentProject = null, benchmark = null, document = globalThis.document) {
  document.querySelectorAll('details').forEach(details => {
    details.setAttribute('aria-expanded', String(details.open));
    details.addEventListener('toggle', () => details.setAttribute('aria-expanded', String(details.open)));
  });
  document.getElementById('expProjectKeyword')?.addEventListener('input', event => { experienceState.projectKeyword = event.target.value; renderDebounced(); });
  document.getElementById('expProjectStatus')?.addEventListener('change', event => { experienceState.projectStatus = event.target.value; render(); });
  document.querySelectorAll('[data-review-project]').forEach(card => card.addEventListener('click', event => {
    if (event.target.closest('[data-review-action]')) return;
    experienceState.selectedProjectId = card.dataset.reviewProject;
    experienceState.selectedSessionId = '';
    experienceState.activeQuestionIndex = 0;
    experienceState.answerDrafts = {};
    experienceState.selectedEvidenceIds = [];
    experienceState.pageMode = 'queue';
    window.__app.state.currentProjectId = card.dataset.reviewProject;
    render();
  }));
  document.querySelectorAll('[data-review-project]').forEach(card => card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
  }));
  document.querySelectorAll('[data-review-action]').forEach(button => button.addEventListener('click', () => {
    const row = projects.find(project => project.id === button.dataset.reviewAction);
    const existing = sessions.filter(session => session.projectId === button.dataset.reviewAction && session.status !== 'confirmed').sort(byUpdatedDesc)[0];
    if (existing) openSession(existing.id);
    else {
      const saved = cards.filter(card => card.projectId === button.dataset.reviewAction && card.reviewStatus !== 'archived').sort(byUpdatedDesc)[0];
      if (saved) openModal('复盘笔记详情', detailPanel(saved));
      else if (row) openReview({ projectId: row.id, sourceType: 'manual_review' });
    }
  }));
  document.querySelectorAll('[data-inline-start]').forEach(button => button.addEventListener('click', () => openReview({ projectId: button.dataset.inlineStart, sourceType: 'manual_review' })));
  document.querySelectorAll('[data-inline-session]').forEach(button => button.addEventListener('click', () => openSession(button.dataset.inlineSession)));
  document.querySelectorAll('[data-note-view]').forEach(button => button.addEventListener('click', () => {
    const card = cards.find(item => item.id === button.dataset.noteView);
    if (card) openModal('复盘笔记详情', detailPanel(card));
  }));
  const caseRefresh = () => { experienceState.caseKeyword = document.getElementById('reviewCaseKeyword')?.value || ''; experienceState.caseFilter = document.getElementById('reviewCaseFilter')?.value || ''; experienceState.caseSort = document.getElementById('reviewCaseSort')?.value || 'similarity'; render(); };
  document.getElementById('reviewCaseKeyword')?.addEventListener('input', () => { clearTimeout(window.__reviewCaseTimer); window.__reviewCaseTimer = setTimeout(caseRefresh, 180); });
  document.getElementById('reviewCaseFilter')?.addEventListener('change', caseRefresh);
  document.getElementById('reviewCaseSort')?.addEventListener('change', caseRefresh);
  document.querySelectorAll('[data-case-detail]').forEach(button => button.addEventListener('click', () => {
    const row = projectRows.find(item => item.project.id === button.dataset.caseDetail);
    if (row) {
      openModal('相关案例详情', caseDetailPanel(row, cards, currentProject));
      document.querySelector('[data-case-add-evidence]')?.addEventListener('click', () => {
        const session = sessions.find(item => item.id === experienceState.selectedSessionId);
        const question = session?.questions?.[experienceState.activeQuestionIndex];
        const title = document.querySelector('[data-case-add-evidence]')?.dataset.caseTitle || row.project.name;
        if (question) {
          const current = experienceState.answerDrafts[question.id] || '';
          const marker = `案例依据：${title}`;
          if (!current.includes(marker)) experienceState.answerDrafts[question.id] = `${current}${current ? '；' : ''}${marker}`;
        }
        closeModal();
        toast('已加入当前回答依据', 'success');
      });
    }
  }));
  document.querySelector('[data-show-more-cases]')?.addEventListener('click', () => openModal('相关案例', projectRows.filter(row => row.project.status === 'archived' && row.project.id !== currentProject?.id).slice(0, 20).map(row => caseDetailPanel(row, cards, currentProject)).join('<div class="my-3 border-t border-slate-200"></div>') || '<div class="p-4 text-sm text-slate-500">暂无可用案例。</div>'));
  document.querySelector('[data-benchmark-detail]')?.addEventListener('click', () => openModal('造价参考依据', benchmarkDetailPanel(benchmark)));
  document.querySelector('[data-review-exit]')?.addEventListener('click', async () => { await persistActiveAnswer(active); experienceState.pageMode = 'queue'; experienceState.selectedSessionId = ''; experienceState.activeQuestionIndex = 0; experienceState.selectedEvidenceIds = []; render(); });
  const active = sessions.find(s => s.id === experienceState.selectedSessionId);
  const question = active?.questions?.[experienceState.activeQuestionIndex];
  const answerInput = document.getElementById('reviewAnswerInput');
  answerInput?.addEventListener('input', event => { if (question) { experienceState.answerDrafts[question.id] = event.target.value; const count = document.getElementById('reviewAnswerCount'); if (count) count.textContent = String(event.target.value.length); } });
  document.querySelector('[data-review-prev]')?.addEventListener('click', async () => { await persistActiveAnswer(active, false); if (experienceState.activeQuestionIndex > 0) { experienceState.activeQuestionIndex -= 1; experienceState.selectedEvidenceIds = []; render(); } });
  document.querySelector('[data-review-next]')?.addEventListener('click', () => navigateQuestion(active, 1));
  document.querySelector('[data-review-skip]')?.addEventListener('click', () => navigateQuestion(active, 1, true));
  document.querySelector('[data-review-save-draft]')?.addEventListener('click', () => persistCurrentAnswer(active));
  document.querySelector('[data-review-save-next]')?.addEventListener('click', async () => { await persistActiveAnswer(active, false); if ((active?.questions || []).length && experienceState.activeQuestionIndex < active.questions.length - 1) { experienceState.activeQuestionIndex += 1; experienceState.selectedEvidenceIds = []; render(); } else if (!active?.draft) toast('这是最后一题，请先生成草稿后再保存笔记', 'error'); else toast('已完成全部问题，可以保存笔记', 'success'); });
  document.querySelector('[data-review-ai-refine]')?.addEventListener('click', async () => { if (!active) return; try { const refined = await experienceService.refineQuestions(active.id, experienceState.answerDrafts); experienceState.selectedSessionId = refined.id; render(); toast(refined.followUpSource === 'ai' ? 'AI 已补充递进追问' : '已补充本地追问', 'success'); } catch (e) { toast(e.message || '补问失败', 'error'); } });
  document.querySelector('[data-review-generate-draft]')?.addEventListener('click', async () => { if (!active) return; try { await persistCurrentAnswer(active, false); await experienceService.draftCard(active.id, experienceState.answerDrafts); toast('已生成复盘笔记草稿，请继续检查', 'success'); render(); } catch (e) { toast(e.message || '草稿生成失败', 'error'); } });
  document.querySelector('[data-review-confirm]')?.addEventListener('click', async () => { if (!active?.draft) { toast('请先生成草稿', 'error'); return; } try { const card = await experienceService.confirmCard(active.id, {}); experienceState.selectedId = card.id; toast(`复盘笔记已保存：${card.title}`, 'success'); await render(); } catch (e) { toast(e.message || '保存笔记失败', 'error'); } });
  document.querySelectorAll('[data-review-chip]').forEach(button => button.addEventListener('click', () => { if (!question) return; const text = button.dataset.reviewChip; const current = getActiveAnswer(active); const has = current.includes(text); experienceState.answerDrafts[question.id] = has ? current.replace(`；${text}`, '').replace(text, '').trim() : `${current}${current ? '；' : ''}${text}`; button.setAttribute('aria-pressed', String(!has)); const input = document.getElementById('reviewAnswerInput'); if (input) { input.value = experienceState.answerDrafts[question.id]; input.dispatchEvent(new Event('input')); } }));
  document.querySelectorAll('[data-review-evidence]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.reviewEvidence;
    const title = button.dataset.evidenceTitle || '';
    const idx = experienceState.selectedEvidenceIds.indexOf(id);
    const input = document.getElementById('reviewAnswerInput');
    const marker = `依据：${title}`;
    if (idx >= 0) {
      experienceState.selectedEvidenceIds.splice(idx, 1);
      if (input) input.value = input.value.split('；').filter(part => part.trim() !== marker).join('；');
    } else {
      experienceState.selectedEvidenceIds.push(id);
      if (input && title && !input.value.includes(marker)) input.value = `${input.value}${input.value ? '；' : ''}${marker}`;
    }
    input?.dispatchEvent(new Event('input'));
    button.setAttribute('aria-pressed', String(idx < 0));
    button.classList.toggle('border-teal-500', idx < 0);
    button.classList.toggle('bg-teal-50/70', idx < 0);
  }));
  document.querySelectorAll('[data-show-all-notes]').forEach(button => button.addEventListener('click', () => {
    openModal('全部复盘笔记', `<div class="space-y-2">${cards.length ? cards.map(card => cardItem(card, false)).join('') : '<div class="rounded border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">还没有保存复盘笔记。</div>'}</div>`);
  }));
}

function getActiveAnswer(session) {
  const question = session?.questions?.[experienceState.activeQuestionIndex];
  return question ? (experienceState.answerDrafts[question.id] ?? session.answers?.[question.id] ?? '') : '';
}

async function persistActiveAnswer(session, notify = true) {
  if (!session) return;
  const question = session.questions?.[experienceState.activeQuestionIndex];
  const answers = { ...(session.answers || {}) };
  if (question) answers[question.id] = getActiveAnswer(session);
  await experienceSessionRepo.update(session.id, { answers, updatedAt: new Date().toISOString() });
  if (notify) toast('草稿已暂存', 'success');
}

async function persistCurrentAnswer(session, notify = true) {
  if (!session) return;
  const answers = { ...(session.answers || {}), ...experienceState.answerDrafts };
  await experienceSessionRepo.update(session.id, { answers, updatedAt: new Date().toISOString() });
  if (notify) toast('草稿已暂存', 'success');
}

async function navigateQuestion(session, delta, skip = false) {
  if (!session) return;
  if (skip && session.questions?.[experienceState.activeQuestionIndex]) experienceState.answerDrafts[session.questions[experienceState.activeQuestionIndex].id] = '';
  await persistCurrentAnswer(session, false);
  experienceState.activeQuestionIndex = Math.max(0, Math.min((session.questions || []).length - 1, experienceState.activeQuestionIndex + delta));
  render();
}

export async function openReview({ projectId, versionId = '', sourceType = 'manual_review' } = {}) {
  try {
    const session = await experienceService.startReview({ projectId, versionId, sourceType });
    experienceState.selectedProjectId = projectId;
    experienceState.selectedSessionId = session.id;
    experienceState.activeQuestionIndex = 0;
    experienceState.answerDrafts = { ...(session.answers || {}) };
    if (window.__app?.state?.currentView === 'experience') { experienceState.pageMode = 'review'; await render(); }
    else renderReview(session);
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
  experienceState.selectedProjectId = session.projectId;
  experienceState.selectedSessionId = session.id;
  experienceState.answerDrafts = { ...(session.answers || {}) };
  if (window.__app?.state?.currentView === 'experience') { experienceState.pageMode = 'review'; await render(); }
  else renderReview(session, session.draft || null);
}

function renderReview(session, draft = null) {
  const extraction = draft?.extraction || session.extraction || null;
  openModal('生成报价复盘笔记', `
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
              <div class="mt-1 text-xs leading-5 text-slate-500">${esc(session.versionNameSnapshot || '当前工作稿')} · 追问只生成草稿，确认后才保存到复盘笔记</div>
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
              <div class="font-semibold text-slate-800">复盘笔记草稿</div>
              <div class="mt-1 text-xs leading-5 text-slate-500">确认后保存，并可被 AI 查询引用。</div>
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
          <span class="material-symbols-outlined text-[16px]">inventory_2</span>保存笔记
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
    toast('已生成复盘笔记草稿，请确认后保存', 'success');
  };
  document.getElementById('expConfirm').onclick = async () => {
    if (!draft) {
      toast('请先生成草稿', 'error');
      return;
    }
    const card = await experienceService.confirmCard(session.id, collectDraftPatch());
    experienceState.selectedId = card.id;
    closeModal();
    toast(`复盘笔记已保存：${card.title}`, 'success');
    if (window.__app?.state?.currentView === 'experience') render();
  };
}

function bindExperiencePage(projects, document = globalThis.document) {
  bindInput('expKw', value => { experienceState.keyword = value; renderDebounced(); }, document);
  bindSelect('expStatus', value => { experienceState.status = value; render(); }, document);
  bindSelect('expProjectType', value => { experienceState.projectType = value; render(); }, document);
  bindSelect('expProcessType', value => { experienceState.processType = value; render(); }, document);
  bindSelect('expCostCategory', value => { experienceState.costCategory = value; render(); }, document);
  bindSelect('expExpired', value => { experienceState.expired = value; render(); }, document);
  document.getElementById('expResetFilters')?.addEventListener('click', () => {
    Object.assign(experienceState, { keyword: '', status: '', projectType: '', processType: '', costCategory: '', expired: '' });
    render();
  });
  document.getElementById('expStartProject')?.addEventListener('change', e => {
    experienceState.projectId = e.target.value;
    window.__app.state.currentProjectId = e.target.value;
  });
  const start = () => {
    const projectId = experienceState.selectedProjectId || document.getElementById('expStartProject')?.value || experienceState.projectId || projects[0]?.id;
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
  toast('复盘笔记已更新', 'success');
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
  if (!experienceState.selectedId || !confirm('收起后默认不会进入 AI 复盘检索，确定收起？')) return;
  await experienceService.archiveCard(experienceState.selectedId);
  toast('已收起复盘笔记', 'success');
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
          <div class="mt-1 text-xs leading-5 text-slate-500">复盘笔记来自报价审查、保存版本或案例收录；确认后可被 AI 查阅，但不参与指标计算。</div>
          <div class="mt-3 flex flex-wrap gap-2">
            <button onclick="window.__app.go('boq')" class="rounded border border-teal-300 bg-white px-2.5 py-1 text-xs text-teal-700">去报价审查</button>
            <button onclick="window.__app.go('boq')" class="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700">去保存版本</button>
            <button onclick="window.__app.go('projects')" class="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700">去我的项目收录案例</button>
          </div>
        </div>
      </div>
    </div>
    ${emptyKnowledgeRow('待沉淀经验', '项目 / 分类 / 结论摘要', '正式', '0', '-')}
    ${emptyKnowledgeRow('防水报价口径示例', '案例收录后可以形成笔记', '需复核', '0', '-')}
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
        <div class="font-medium text-slate-800">笔记维护</div>
        <div class="grid grid-cols-2 gap-2">
          ${textInput('笔记类型', 'expKnowledgeType', card.knowledgeType || '报价复盘')}
          ${textInput('领域分类', 'expDomainCategory', card.domainCategory || '')}
          ${textInput('项目类型', 'expDetailProjectType', card.projectType || '')}
          ${textInput('工艺类型', 'expDetailProcessType', card.processType || '')}
          ${textInput('成本分类', 'expDetailCostCategory', card.costCategory || '')}
          ${selectInput('审核状态', 'expReviewStatus', card.reviewStatus || 'confirmed', [
            ['confirmed', '正式经验'],
            ['needs_review', '需复核'],
            ['archived', '已收起'],
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
      <button id="expArchive" class="px-3 py-1.5 text-sm border border-slate-300 text-slate-600 rounded">收起</button>
    </div>
  `;
}

function emptyDetail() {
  return `<div class="flex h-full min-h-[360px] items-center justify-center px-6 text-center text-sm text-slate-400">选择一条复盘笔记查看依据、边界和维护动作。</div>`;
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

function bindInput(id, fn, document = globalThis.document) {
  document.getElementById(id)?.addEventListener('input', e => fn(e.target.value));
}

function bindSelect(id, fn, document = globalThis.document) {
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
    <div class="mt-3 font-medium text-slate-800">等待生成复盘笔记草稿</div>
    <div class="mt-1 max-w-[280px] text-xs leading-5 text-slate-500">先回答关键追问，再点击“AI 生成草稿”。AI 内容会保持草稿状态，确认后才会保存到复盘笔记。</div>
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
  if (!extraction) return '流程：回答追问 → 生成草稿 → 用户确认保存';
  const score = Number(extraction.score || 0);
  if (score >= 85) return '复盘内容较完整，可生成草稿并确认保存';
  if (score >= 70) return '已达到保存条件，建议补齐高亮缺口后再确认';
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
  return status === 'needs_review' ? '需复核' : status === 'archived' ? '已收起' : '可用';
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
    project_archive: '案例收录复盘',
    ai_review: 'AI 发起复盘',
  }[sourceType] || '手动复盘';
}

function formatTime(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}
