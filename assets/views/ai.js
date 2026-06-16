// 视图：AI 抽屉
import { tryLocalCommand } from '../ai/localCommands.js?v=2.8';
import { callLLM } from '../ai/remoteLLM.js?v=2.8';

const history = [];

export function open() {
  document.getElementById('aiDrawer').classList.remove('hidden');
  document.getElementById('aiInput').focus();
  if (!document.getElementById('aiMsgs').children.length) {
    addMsg('assistant',
`你好！我是水务造价助手。我能：

• 报价审查：检查缺单价、0 工程量、异常系数、重复清单
• 项目对标：判断当前项目偏高/偏低，并解释偏差来源
• 推荐定额：按项目特征从定额库找候选项
• 版本辅助：查看报价版本，解释最近两版差异
• 快速估算：用历史指标给出造价参考区间

直接说就行，我会优先用本地数据回答；需要联网模型时会读取必要上下文，但不会自动修改清单。`);
    addSuggestions();
  }
}
export function close() { document.getElementById('aiDrawer').classList.add('hidden'); }

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `p-2 rounded-md text-sm whitespace-pre-wrap ${role === 'user' ? 'ai-bubble-user' : 'ai-bubble-assistant'}`;
  div.style.alignSelf = role === 'user' ? 'flex-end' : 'flex-start';
  div.style.maxWidth = role === 'user' ? '85%' : '95%';
  div.textContent = text;
  document.getElementById('aiMsgs').appendChild(div);
  document.getElementById('aiMsgs').scrollTop = document.getElementById('aiMsgs').scrollHeight;
}

function addActionMsg(msg, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'p-2 rounded-md text-sm bg-slate-100 space-y-2';
  wrap.style.alignSelf = 'flex-start';
  wrap.style.maxWidth = '95%';
  const txt = document.createElement('div');
  txt.className = 'whitespace-pre-wrap';
  txt.textContent = msg;
  wrap.appendChild(txt);
  if (actions && actions.length) {
    const row = document.createElement('div');
    row.className = 'flex gap-2 flex-wrap';
    actions.forEach(a => {
      const b = document.createElement('button');
      b.className = 'px-2 py-1 text-xs rounded border border-teal-600 text-teal-700 hover:bg-teal-50';
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
    { label: '审查当前报价', onClick: () => send('审查当前报价有没有风险') },
    { label: '检查缺单价', onClick: () => send('检查缺单价') },
    { label: '项目对标', onClick: () => send('当前项目对标，贵不贵') },
    { label: '查看报价版本', onClick: () => send('查看当前项目报价版本列表和差异') },
    { label: '推荐防水定额', onClick: () => send('推荐 水池 防水 定额') },
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
