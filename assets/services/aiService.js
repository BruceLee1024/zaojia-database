// AI 配置
export const DEFAULT_AI_SYSTEM_PROMPT = `你是“个人造价工作台”的工程造价分析助手，服务于单机个人用户。

工作目标
1. 基于已提供的项目、清单、定额、报价版本、指标和复盘资料，帮助用户检查报价、定位风险、比较案例并给出下一步动作。
2. 不虚构价格、定额、规范、市场信息或项目事实；资料不足时明确说明“数据不足”，并说明还需要什么资料。
3. 不直接修改任何本地数据，也不把建议表述为最终审定结论。

回答规则
- 先给结论，再给数据依据、风险提示和建议动作。
- 引用本地数据时说明项目、清单或样本数量，不展示内部 ID。
- 审查报价时优先检查：缺单价、工程量为 0、未匹配或已失效定额、异常系数、疑似重复项和样本可信度。
- 指标样本少于 3 个，或可信度为“仅参考/低可信”时，必须说明其不能单独作为定价依据。
- 涉及法规、清单规范、定额口径、市场价或合同条件时，提示用户以最新正式依据和人工复核为准。
- 使用清晰、简洁的中文；金额和数量保留必要精度。

输出格式
结论：
数据依据：
风险提示：
建议动作：`;

const LEGACY_DEFAULT_AI_SYSTEM_PROMPT = '你是工程造价专家和报价审核助手。基于「企业定额库」「项目清单」「报价版本」「指标库」回答用户问题。先给结论，再给数据依据、风险提示和建议动作；样本不足或缺单价时必须说明。';

export const AI_SYSTEM_PROMPT_PRESETS = {
  general: {
    label: '综合造价助手',
    description: '适合日常问答、案例比较和报价风险排查。',
    prompt: DEFAULT_AI_SYSTEM_PROMPT,
  },
  review: {
    label: '报价审查优先',
    description: '强化缺价、工程量、定额关联和异常项检查。',
    prompt: `${DEFAULT_AI_SYSTEM_PROMPT}\n\n当前侧重点\n- 将报价审查放在首位；按风险等级列出需要人工复核的清单行，并说明触发原因。\n- 不给出未经数据支持的“合理单价”或调价幅度。`,
  },
  knowledge: {
    label: '资料沉淀优先',
    description: '强化清单、定额、指标与经验资料的归纳和复用边界。',
    prompt: `${DEFAULT_AI_SYSTEM_PROMPT}\n\n当前侧重点\n- 优先梳理清单、定额、指标和经验资料之间的可复用关系。\n- 每条经验都要说明适用条件、样本边界和是否需要复核。`,
  },
};

export function getAISystemPromptPreset(key = 'general') {
  return AI_SYSTEM_PROMPT_PRESETS[key]?.prompt || DEFAULT_AI_SYSTEM_PROMPT;
}

const AI_DEFAULT = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com/v1',
  api_key: '',
  model: 'deepseek-chat',
  system: DEFAULT_AI_SYSTEM_PROMPT,
};

const PROVIDERS = {
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',  label: 'DeepSeek' },
  qwen:     { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', label: '通义千问' },
  doubao:   { base_url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k', label: '豆包' },
  glm:      { base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', label: '智谱 GLM' },
  openai:   { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI 兼容' },
};

const BACKUP_SAFE_FIELDS = ['provider', 'base_url', 'model', 'system'];

export function getAIConfig() {
  const saved = JSON.parse(localStorage.getItem('ai_config') || '{}');
  return {
    ...AI_DEFAULT,
    ...saved,
    // 仅迁移可精确识别的旧版默认文案，任何用户自定义内容都保持原样。
    system: saved.system === LEGACY_DEFAULT_AI_SYSTEM_PROMPT ? DEFAULT_AI_SYSTEM_PROMPT : (saved.system || AI_DEFAULT.system),
  };
}
export function setAIConfig(cfg) {
  localStorage.setItem('ai_config', JSON.stringify(cfg));
}

/** 业务备份只能携带非敏感 AI 偏好，绝不包含 API Key。 */
export function toBackupSafeAIConfig(config = getAIConfig()) {
  return BACKUP_SAFE_FIELDS.reduce((safe, field) => {
    if (config[field] != null) safe[field] = config[field];
    return safe;
  }, {});
}

/** 恢复备份时保留当前设备的 API Key，并忽略旧备份中的任何密钥字段。 */
export function restoreBackupSafeAIConfig(backupConfig = {}, currentConfig = getAIConfig()) {
  const safe = toBackupSafeAIConfig(backupConfig || {});
  return { ...currentConfig, ...safe, api_key: currentConfig.api_key || '' };
}
export function listProviders() {
  return Object.entries(PROVIDERS);
}
export function getProviderDefaults(key) {
  return PROVIDERS[key] || {};
}
