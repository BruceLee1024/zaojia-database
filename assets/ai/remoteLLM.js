// 远端 LLM 调用
import { getAIConfig } from '../services/aiService.js?v=3.2';
import { quotaRepo, projectRepo, indicatorRepo, boqRepo, versionRepo } from '../data/repository.js?v=3.2';
import { categoryGuess } from '../utils/stats.js';
import { hasMissingPrice } from '../utils/costing.js?v=3.2';

export async function callLLM(text, history = []) {
  const cfg = getAIConfig();
  if (!cfg.api_key) throw new Error('未配置 API Key');

  const [quota, projects, indicators, boq, versions] = await Promise.all([
    quotaRepo.all(), projectRepo.all(), indicatorRepo.all(), boqRepo.all(), versionRepo.all(),
  ]);
  const currentProjectId = window.__app?.state?.currentProjectId;
  const currentProject = projects.find(p => p.id === currentProjectId) || projects[0] || null;
  const currentLines = currentProject ? boq.filter(b => b.projectId === currentProject.id) : [];
  const categoryCost = {};
  currentLines.forEach(line => {
    const cat = line.majorCategory || line.category || categoryGuess(line.name);
    categoryCost[cat] = (categoryCost[cat] || 0) + Number(line.amount || 0);
  });
  const currentVersions = currentProject ? versions.filter(v => v.projectId === currentProject.id) : [];
  const ctx = {
    projectCount: projects.length,
    archivedCount: projects.filter(p => p.status === 'archived').length,
    quotaCount: quota.length,
    boqLineCount: boq.length,
    missingQuotaCount: quota.filter(q => hasMissingPrice(q.priceTotal)).length,
    missingBoqCount: boq.filter(b => hasMissingPrice(b.unitPrice)).length,
    currentProject: currentProject ? {
      id: currentProject.id,
      name: currentProject.name,
      type: currentProject.type,
      scale: currentProject.scale,
      structure: currentProject.structure,
      process: currentProject.process,
      area: currentProject.area,
      dailyCapacity: currentProject.dailyCapacity,
      status: currentProject.status,
      totalCost: currentProject.totalCost || 0,
      lineCount: currentLines.length,
      missingPriceCount: currentLines.filter(b => hasMissingPrice(b.unitPrice)).length,
      categoryCost: Object.entries(categoryCost).sort((a, b) => b[1] - a[1]).slice(0, 8),
      versions: currentVersions
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, 5)
        .map(v => ({ name: v.name, totalCost: v.totalCost, lineCount: v.lineCount, missingPriceCount: v.missingPriceCount, createdAt: v.createdAt })),
      lines: currentLines.slice(0, 30).map(b => ({ name: b.name, feature: b.feature, unit: b.unit, qty: b.qty, unitPrice: b.unitPrice, factor: b.factor, amount: b.amount, priceMissing: hasMissingPrice(b.unitPrice) })),
    } : null,
    indicators: indicators.slice(0, 30).map(i => ({
      key: i.typeKey, metric: i.metric, n: i.n, median: i.median, p25: i.p25, p75: i.p75, min: i.min, max: i.max, confidence: i.confidence, dispersion: i.dispersion,
    })),
  };
  const matched = quota.filter(q => {
    const blob = `${q.name} ${q.feature} ${(q.tags || []).join(' ')}`.toLowerCase();
    return text.toLowerCase().split(/\s+/).some(w => w.length > 1 && blob.includes(w));
  }).slice(0, 12).map(q => ({ name: q.name, unit: q.unit, price: q.priceTotal, cat: q.category }));

  const systemMsg = `${cfg.system}

工作边界：
- 你是报价辅助，不直接承诺修改数据；涉及新增清单、调价、恢复版本等动作时，必须提示用户使用页面按钮或明确确认。
- 优先指出数据依据、样本数、缺单价、0 工程量和异常系数。
- 指标样本少或 confidence 为“仅参考/低可信”时要明确提醒。
- 回答保持简洁，先给结论，再给依据和建议动作。

当前数据上下文(JSON)：${JSON.stringify(ctx)}
命中的定额条目(JSON)：${JSON.stringify(matched)}`;
  const messages = [
    { role: 'system', content: systemMsg },
    ...history.slice(-6),
    { role: 'user', content: text },
  ];

  const url = cfg.base_url.replace(/\/$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, stream: false }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`请求失败：${resp.status}\n${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '（无回复）';
}

export async function testConnection() {
  const cfg = getAIConfig();
  if (!cfg.api_key) throw new Error('请先填写 API Key');
  const url = cfg.base_url.replace(/\/$/, '') + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: '说"OK"即可' }], max_tokens: 10 }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return true;
}
