// AI 系统提示词草案：仅发送用户在本页填写的配置意图，不携带业务资料。
import { getAIConfig } from './aiService.js?v=6.15';

const STYLE_LABELS = {
  concise: '简洁、结论优先，使用短列表',
  detailed: '分析充分，按结论、依据、风险、行动分节',
  table: '适合对比时使用 Markdown 表格，其余内容保持简洁',
};

export function buildSystemPromptGenerationMessages({ scenario, focus = '', responseStyle = 'detailed', basePrompt = '' } = {}) {
  const cleanedScenario = String(scenario || '').trim();
  if (!cleanedScenario) throw new Error('请先填写希望 AI 协助的工作场景');
  if (!STYLE_LABELS[responseStyle]) throw new Error('回答风格无效，请重新选择');
  const request = {
    使用场景: cleanedScenario,
    重点关注: String(focus || '').trim() || '未指定',
    回答风格: STYLE_LABELS[responseStyle],
  };
  if (String(basePrompt || '').trim()) request.当前提示词 = String(basePrompt).trim();
  return [
    { role: 'system', content: '你是 AI 系统提示词设计助手。根据用户提供的工作场景，生成一份可直接粘贴到系统提示词编辑器的中文提示词。提示词应明确角色、工作目标、数据边界、回答规则和输出格式；不得虚构业务数据或承诺自动修改数据。只返回严格 JSON，不要 Markdown 代码块，格式为 {"prompt":"..."}。' },
    { role: 'user', content: JSON.stringify(request) },
  ];
}

export function parseSystemPromptDraft(content) {
  const cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('AI 返回的提示词草案格式不正确，请重试'); }
  const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim() : '';
  if (!prompt) throw new Error('AI 未返回可用的提示词草案，请重试');
  if (prompt.length > 12000) throw new Error('生成的提示词过长，请缩短需求后重试');
  return prompt;
}

export async function generateSystemPromptDraft(options) {
  const cfg = getAIConfig();
  if (!cfg.api_key) throw new Error('请先填写并保存 API Key，再使用 AI 生成提示词');
  const response = await fetch(`${String(cfg.base_url || '').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model: cfg.model, messages: buildSystemPromptGenerationMessages(options), temperature: 0.35, max_tokens: 1800, stream: false }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`生成失败：HTTP ${response.status}${detail ? `，${detail.slice(0, 160)}` : ''}`);
  }
  const data = await response.json();
  return parseSystemPromptDraft(data.choices?.[0]?.message?.content);
}
