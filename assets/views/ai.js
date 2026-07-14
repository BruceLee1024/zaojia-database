// 视图：AI 抽屉
import { tryLocalCommand } from '../ai/localCommands.js?v=3.9';
import { callLLM } from '../ai/remoteLLM.js?v=4.0';

const history = [];
let aiReturnFocus = null;
let remoteConsentGranted = false;

export function open() {
  aiReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.add('ai-open');
  document.getElementById('aiDrawer')?.setAttribute('aria-hidden', 'false');
  document.getElementById('aiOpenButton')?.setAttribute('aria-expanded', 'true');
  document.getElementById('aiInput').focus();
  if (!document.getElementById('aiMsgs').children.length) {
    addMsg('assistant',
`你好，我是工程造价助手。

我会优先处理本地问题；只有需要远端模型时，才会在本次会话首次发送前征得你的确认。`);
    addSuggestions();
  }
}
export function close() {
  document.body.classList.remove('ai-open');
  document.getElementById('aiDrawer')?.setAttribute('aria-hidden', 'true');
  document.getElementById('aiOpenButton')?.setAttribute('aria-expanded', 'false');
  if (aiReturnFocus && document.contains(aiReturnFocus)) aiReturnFocus.focus();
  aiReturnFocus = null;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('ai-open')) close();
});

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `px-3 py-2 rounded-md text-sm leading-6 whitespace-pre-wrap border ${role === 'user' ? 'ai-bubble-user border-teal-700' : 'ai-bubble-assistant border-slate-200'}`;
  div.style.alignSelf = role === 'user' ? 'flex-end' : 'flex-start';
  div.style.maxWidth = role === 'user' ? '88%' : '100%';
  div.textContent = text;
  document.getElementById('aiMsgs').appendChild(div);
  document.getElementById('aiMsgs').scrollTop = document.getElementById('aiMsgs').scrollHeight;
}

function addActionMsg(msg, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'px-3 py-2 rounded-md text-sm bg-white border border-slate-200 space-y-2';
  wrap.style.alignSelf = 'flex-start';
  wrap.style.maxWidth = '100%';
  const txt = document.createElement('div');
  txt.className = 'whitespace-pre-wrap';
  txt.textContent = msg;
  wrap.appendChild(txt);
  if (actions && actions.length) {
    const row = document.createElement('div');
    row.className = 'ai-hint-grid';
    actions.forEach(a => {
      const b = document.createElement('button');
      b.className = 'min-h-8 px-2 py-1 text-xs rounded border border-slate-200 bg-slate-50 text-slate-700 hover:bg-teal-50 hover:text-teal-700 hover:border-teal-200 text-left';
      b.textContent = a.label;
      b.onclick = a.onClick;
      row.appendChild(b);
    });
    wrap.appendChild(row);
  }
  document.getElementById('aiMsgs').appendChild(wrap);
  document.getElementById('aiMsgs').scrollTop = document.getElementById('aiMsgs').scrollHeight;
}

function replaceLast(text) {
  const last = document.getElementById('aiMsgs').lastElementChild;
  if (last) last.textContent = text;
  document.getElementById('aiMsgs').scrollTop = document.getElementById('aiMsgs').scrollHeight;
}

function addSuggestions() {
  addActionMsg('常用问题', [
    { label: '审查报价', onClick: () => send('审查当前报价有没有风险') },
    { label: '复盘项目', onClick: () => send('复盘当前项目') },
    { label: '查经验', onClick: () => send('查防水报价经验') },
    { label: '检查缺单价', onClick: () => send('检查缺单价') },
    { label: '项目对标', onClick: () => send('当前项目对标，贵不贵') },
    { label: '报价版本', onClick: () => send('查看当前项目报价版本列表和差异') },
    { label: '推荐定额', onClick: () => send('推荐 水池 防水 定额') },
  ]);
}

export async function send(text) {
  addMsg('user', text);
  // 先尝试本地
  try {
    const local = await tryLocalCommand(text);
    if (local && local.handled) {
      const last = document.getElementById('aiMsgs').lastElementChild;
      if (last && last.textContent === '…思考中') last.remove();
      if (local.actions) addActionMsg(local.msg, local.actions);
      else addMsg('assistant', local.msg);
      return;
    }
  } catch (e) { console.warn('local cmd err', e); }

  addMsg('assistant', '…思考中');
  try {
    if (!remoteConsentGranted) {
      const approved = confirm('本次远端 AI 请求会发送：当前项目摘要、最多 30 条当前清单、最近 5 个报价版本摘要、最多 30 条指标摘要及最多 8 条相关复盘摘要；不会发送 API Key。是否继续？');
      if (!approved) {
        replaceLast('已取消远端 AI 请求。你仍可使用本地查询、报价审查和资料库筛选。');
        return;
      }
      remoteConsentGranted = true;
    }
    const reply = await callLLM(text, history);
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    replaceLast(reply);
  } catch (e) {
    replaceLast('❌ ' + e.message);
  }
}
