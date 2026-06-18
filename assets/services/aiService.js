// AI 配置
const AI_DEFAULT = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com/v1',
  api_key: '',
  model: 'deepseek-chat',
  system: '你是工程造价专家和报价审核助手。基于「企业定额库」「项目清单」「报价版本」「指标库」回答用户问题。先给结论，再给数据依据、风险提示和建议动作；样本不足或缺单价时必须说明。',
};

const PROVIDERS = {
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',  label: 'DeepSeek' },
  qwen:     { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', label: '通义千问' },
  doubao:   { base_url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k', label: '豆包' },
  glm:      { base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', label: '智谱 GLM' },
  openai:   { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI 兼容' },
};

export function getAIConfig() {
  return { ...AI_DEFAULT, ...JSON.parse(localStorage.getItem('ai_config') || '{}') };
}
export function setAIConfig(cfg) {
  localStorage.setItem('ai_config', JSON.stringify(cfg));
}
export function listProviders() {
  return Object.entries(PROVIDERS);
}
export function getProviderDefaults(key) {
  return PROVIDERS[key] || {};
}
