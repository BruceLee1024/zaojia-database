// 视图：AI 抽屉
import { tryLocalCommand } from '../ai/localCommands.js?v=3.2';
import { callLLM } from '../ai/remoteLLM.js?v=3.2';

const history = [];

export function open() {
  document.body.classList.add('ai-open');
  document.getElementById('aiInput').focus();
  if (!document.getElementById('aiMsgs').children.length) {
    addMsg('assistant',
`你好，我是水务造价助手。

我会优先读取本地项目、清单、指标和报价版本，帮助你做审查、对标、推荐定额和估算。`);
    addSuggestions();
  }
}
export function close() { document.body.classList.remove('ai-open'); }

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
    const reply = await callLLM(text, history);
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    replaceLast(reply);
  } catch (e) {
    replaceLast('❌ ' + e.message);
  }
}
