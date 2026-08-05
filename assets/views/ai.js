// 视图：AI 造价工作副驾。本地规则优先；远端调用按会话授权。
import { tryLocalCommand } from '../ai/localCommands.js?v=6.7';
import { callLLM } from '../ai/remoteLLM.js?v=6.7';
import { buildAiSharePreview, createAiResponse, parseRemoteResponse } from '../services/aiTaskService.js?v=6.7';
import { createAiSession, listAiSessions, saveAiSessionMessage } from '../services/aiSessionService.js?v=6.7';

let aiReturnFocus = null;
let remoteConsentGranted = null;
let activeSessionId = '';
let activeProjectId = '';
let restoring = false;

const QUICK_TASKS = [
  ['审查报价', '审查当前报价有没有风险'], ['查缺单价', '检查缺单价'], ['项目对标', '当前项目对标，贵不贵'],
  ['成本结构', '查看当前项目成本结构'], ['报价版本', '查看当前项目报价版本列表和差异'], ['推荐定额', '推荐 水池 防水 定额'],
  ['查经验', '查防水报价经验'], ['快速估算', '估算 5万m³/d 污水厂造价区间'],
];

export async function open() {
  aiReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.add('ai-open');
  document.getElementById('aiDrawer')?.setAttribute('aria-hidden', 'false');
  document.getElementById('aiOpenButton')?.setAttribute('aria-expanded', 'true');
  await ensureSession();
  document.getElementById('aiInput')?.focus();
}

export function close() {
  document.body.classList.remove('ai-open');
  document.getElementById('aiDrawer')?.setAttribute('aria-hidden', 'true');
  document.getElementById('aiOpenButton')?.setAttribute('aria-expanded', 'false');
  if (aiReturnFocus && document.contains(aiReturnFocus)) aiReturnFocus.focus();
  aiReturnFocus = null;
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('ai-open')) close();
});

export async function newSession() {
  const projectId = window.__app?.state?.currentProjectId || '';
  const session = await createAiSession({ projectId });
  activeSessionId = session.id;
  activeProjectId = projectId;
  remoteConsentGranted = false;
  clearMessages();
  await addWelcome();
  await renderSessions();
  document.getElementById('aiInput')?.focus();
}

async function ensureSession() {
  const projectId = window.__app?.state?.currentProjectId || '';
  if (activeSessionId && activeProjectId === projectId) return;
  const sessions = await listAiSessions(projectId);
  if (sessions[0]) await selectSession(sessions[0].id);
  else await newSession();
}

async function selectSession(sessionId) {
  const sessions = await listAiSessions(window.__app?.state?.currentProjectId || '');
  const session = sessions.find(item => item.id === sessionId);
  if (!session) return;
  activeSessionId = sessionId;
  activeProjectId = session.projectId || '';
  remoteConsentGranted = false;
  restoring = true;
  clearMessages();
  for (const message of session.messages || []) {
    if (message.role === 'assistant' && message.response) addResponse(message.response, false);
    else addMsg(message.role, message.text, false);
  }
  if (!session.messages?.length) await addWelcome();
  restoring = false;
  await renderSessions();
}

async function addWelcome() {
  addResponse(createAiResponse({
    summary: '我是你的工程造价工作副驾。可以先做本地审查、对标、定额检索和资料诊断；需要远端模型时，本次会话首次外发前会征得确认。',
    source: 'local', confidence: 'high',
    nextQuestions: ['你可以从下面的任务开始，或直接描述项目和目标。'],
  }));
  addQuickTasks();
}

function clearMessages() {
  const container = document.getElementById('aiMsgs');
  if (container) container.replaceChildren();
}

function addMsg(role, text, persist = true) {
  const div = document.createElement('div');
  div.className = `ai-message px-3 py-2 rounded-md text-sm leading-6 whitespace-pre-wrap border ${role === 'user' ? 'ai-bubble-user border-teal-700' : 'ai-bubble-assistant border-slate-200'}`;
  div.style.alignSelf = role === 'user' ? 'flex-end' : 'flex-start';
  div.style.maxWidth = role === 'user' ? '88%' : '100%';
  div.textContent = text;
  appendMessage(div);
  if (persist) persistMessage({ role, text });
  return div;
}

function addResponse(response, persist = true) {
  const result = createAiResponse(response);
  const wrap = document.createElement('article');
  wrap.className = 'ai-response bg-white border border-slate-200 rounded-md p-3 space-y-2 text-sm';
  wrap.dataset.source = result.source;
  const meta = document.createElement('div');
  meta.className = 'flex items-center gap-2 text-[11px] text-slate-500';
  meta.innerHTML = `<span class="rounded px-1.5 py-0.5 ${result.source === 'local' ? 'bg-teal-50 text-teal-700' : 'bg-violet-50 text-violet-700'}">${result.source === 'local' ? '本地资料' : '远端模型'}</span><span>可信度：${confidenceLabel(result.confidence)}</span>`;
  const summary = document.createElement('div');
  summary.className = 'whitespace-pre-wrap leading-6 text-slate-800';
  summary.textContent = result.summary;
  wrap.append(meta, summary);
  result.sections.forEach(section => appendSection(wrap, section.title, section.content));
  if (result.evidence.length) appendSection(wrap, '依据', result.evidence.map(item => `• ${item.label || '资料'}：${item.detail || item.text || ''}`).join('\n'));
  if (result.risks.length) appendSection(wrap, '风险提示', result.risks.map(item => `• ${item}`).join('\n'), 'text-amber-700');
  if (result.nextQuestions.length) appendSection(wrap, '下一步', result.nextQuestions.map(item => `• ${item}`).join('\n'), 'text-slate-600');
  if (result.proposedActions.length) {
    const row = document.createElement('div');
    row.className = 'ai-hint-grid pt-1';
    result.proposedActions.forEach(action => {
      const button = document.createElement('button');
      button.className = `min-h-8 px-2 py-1 text-xs rounded border text-left ${action.requiresConfirmation ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-teal-50 hover:text-teal-700 hover:border-teal-200'}`;
      button.textContent = `${action.requiresConfirmation ? '需确认 · ' : ''}${action.label}`;
      button.onclick = action.onClick;
      row.appendChild(button);
    });
    wrap.appendChild(row);
  }
  appendMessage(wrap);
  if (persist) persistMessage({ role: 'assistant', text: result.summary, response: serializableResponse(result) });
  return wrap;
}

function appendSection(parent, title, content, tone = '') {
  const section = document.createElement('div');
  section.className = `border-l-2 border-slate-200 pl-2 whitespace-pre-wrap text-xs leading-5 ${tone}`;
  section.textContent = `${title}\n${content}`;
  parent.appendChild(section);
}

function addQuickTasks() {
  const wrap = document.createElement('div');
  wrap.className = 'ai-quick-tasks';
  QUICK_TASKS.forEach(([label, prompt]) => {
    const button = document.createElement('button');
    button.className = 'text-left text-xs px-2 py-1.5 border border-slate-200 rounded bg-white hover:bg-teal-50 hover:text-teal-700';
    button.textContent = label;
    button.onclick = () => send(prompt);
    wrap.appendChild(button);
  });
  appendMessage(wrap);
}

function appendMessage(element) {
  const container = document.getElementById('aiMsgs');
  if (!container) return;
  container.appendChild(element);
  container.scrollTop = container.scrollHeight;
}

async function persistMessage(message) {
  if (restoring || !activeSessionId) return;
  try {
    await saveAiSessionMessage(activeSessionId, message);
    renderSessions();
  } catch (error) { console.warn('AI session persistence failed', error); }
}

function serializableResponse(response) {
  const { proposedActions, ...safe } = response;
  return { ...safe, proposedActions: proposedActions.map(({ onClick, ...action }) => action) };
}

async function renderSessions() {
  const container = document.getElementById('aiSessionList');
  if (!container) return;
  const sessions = await listAiSessions(window.__app?.state?.currentProjectId || '');
  container.replaceChildren();
  sessions.slice(0, 8).forEach(session => {
    const button = document.createElement('button');
    button.className = `w-full px-2 py-1.5 rounded text-left text-xs truncate ${session.id === activeSessionId ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-100'}`;
    button.textContent = session.title || '新对话';
    button.title = session.title || '新对话';
    button.onclick = () => selectSession(session.id);
    container.appendChild(button);
  });
}

export async function send(text) {
  const value = String(text || '').trim();
  if (!value) return;
  await ensureSession();
  addMsg('user', value);
  const thinking = addMsg('assistant', '正在基于本地资料分析…', false);
  try {
    const local = await tryLocalCommand(value);
    if (local?.handled) {
      thinking.remove();
      addResponse(createAiResponse({ ...local, source: 'local' }));
      return;
    }
  } catch (error) { console.warn('local AI command failed', error); }

  thinking.textContent = '正在准备远端请求，等待你的确认…';
  try {
    if (!remoteConsentGranted) {
      const preview = buildAiSharePreview({ currentProject: window.__app?.state?.currentProjectId ? { id: window.__app.state.currentProjectId } : null }, {});
      const approved = confirm(`本次仅向已配置模型发送匿名汇总：${preview.projectIncluded ? '当前项目汇总' : '不发送项目资料'}、指标统计；不会发送项目名称、客户、地址、编号、供应商、附件或经验正文。是否继续？`);
      if (!approved) {
        thinking.textContent = '已取消远端请求。你仍可使用本地审查、对标和资料检索。';
        return;
      }
      remoteConsentGranted = { boqSummary: approved && confirm('是否额外发送最多 30 条去名称化清单的数量、单价和合价摘要？取消则只发送汇总。') };
    }
    thinking.textContent = '远端模型正在生成…';
    const reply = await callLLM(value, await getRemoteHistory(), {
      shareScope: remoteConsentGranted || {},
      onDelta: partial => { thinking.textContent = partial; },
    });
    const response = parseRemoteResponse(reply);
    thinking.remove();
    addResponse(response);
  } catch (error) {
    thinking.textContent = `❌ ${error.message}`;
  }
}

async function getRemoteHistory() {
  const sessions = await listAiSessions(window.__app?.state?.currentProjectId || '');
  const session = sessions.find(item => item.id === activeSessionId);
  return (session?.messages || []).slice(-6).map(item => ({ role: item.role, content: item.text })).filter(item => ['user', 'assistant'].includes(item.role));
}

function confidenceLabel(value) {
  return ({ high: '较高', medium: '中等', low: '较低' })[value] || '中等';
}
