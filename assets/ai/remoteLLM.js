// 远端 LLM 调用
import { getAIConfig } from '../services/aiService.js?v=6.3';
import { quotaRepo, projectRepo, indicatorRepo, boqRepo, versionRepo, experienceCardRepo } from '../data/repository.js?v=6.3';
import { categoryGuess } from '../utils/stats.js?v=6.3';
import { hasMissingPrice } from '../utils/costing.js?v=6.3';
import { sanitizeRemoteContext } from '../services/aiTaskService.js?v=6.3';

export async function callLLM(text, history = [], options = {}) {
  const cfg = getAIConfig();
  if (!cfg.api_key) throw new Error('未配置 API Key');

  const [quota, projects, indicators, boq, versions, experienceCards] = await Promise.all([
    quotaRepo.all(), projectRepo.all(), indicatorRepo.all(), boqRepo.all(), versionRepo.all(), experienceCardRepo.all(),
  ]);
  const currentProjectId = window.__app?.state?.currentProjectId;
  const currentProject = projects.find(p => p.id === currentProjectId) || null;
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
    experienceCards: experienceCards
      .filter(c => (c.reviewStatus || c.status || 'confirmed') === 'confirmed')
      .filter(c => {
        if (!currentProject) return true;
        if (c.projectId === currentProject.id) return true;
        const blob = [c.projectNameSnapshot, ...(c.tags || []), ...(c.keywords || []), c.category, c.domainCategory, c.projectType, c.processType, c.costCategory, c.lesson, c.applicability].join(' ');
        return Boolean((currentProject.type && blob.includes(currentProject.type)) || (currentProject.process && blob.includes(currentProject.process)));
      })
      .slice(0, 8)
      .map(c => ({
        title: c.title,
        category: c.domainCategory || c.category,
        projectType: c.projectType,
        processType: c.processType,
        costCategory: c.costCategory,
        keywords: c.keywords,
        projectName: c.projectNameSnapshot,
        tags: c.tags,
        trigger: c.trigger,
        lesson: c.lesson,
        applicability: c.applicability,
        risks: c.risks,
        confidence: c.confidence,
        expiresAt: c.expiresAt,
        reuseCount: c.reuseCount || 0,
      })),
  };
  const matched = quota.filter(q => {
    const blob = `${q.name} ${q.feature} ${(q.tags || []).join(' ')}`.toLowerCase();
    return text.toLowerCase().split(/\s+/).some(w => w.length > 1 && blob.includes(w));
  }).slice(0, 12).map(q => ({ name: q.name, unit: q.unit, price: q.priceTotal, cat: q.category }));

  const remoteContext = sanitizeRemoteContext({ ...ctx, currentLines }, options.shareScope || {});
  const responseContract = `
返回 JSON 对象，不要使用 Markdown 代码块：
{"summary":"一句结论","sections":[{"title":"依据","content":"..."}],"evidence":[{"label":"数据依据","detail":"..."}],"risks":["..."],"nextQuestions":["..."],"confidence":"high|medium|low"}`;
  const systemMsg = `${cfg.system}

工作边界：
- 你是报价辅助，不直接承诺修改数据；涉及新增清单、调价、恢复版本等动作时，必须提示用户使用页面按钮或明确确认。
- 优先指出数据依据、样本数、缺单价、0 工程量和异常系数。
- 指标样本少或 confidence 为“仅参考/低可信”时要明确提醒。
- 引用经验卡时必须说明适用边界、可信度和过期风险；不要把经验卡当成硬性指标。
- 回答保持简洁，先给结论，再给依据和建议动作。${responseContract}

当前数据上下文(JSON)：${JSON.stringify(remoteContext)}
命中的定额条目(JSON)：${JSON.stringify(matched)}`;
  const messages = [
    { role: 'system', content: systemMsg },
    ...history.slice(-6),
    { role: 'user', content: text },
  ];

  const url = cfg.base_url.replace(/\/$/, '') + '/chat/completions';
  const stream = typeof options.onDelta === 'function';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, stream }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`请求失败：${resp.status}\n${err.slice(0, 300)}`);
  }
  if (!stream || !resp.body) {
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '（无回复）';
  }
  return await readSseResponse(resp.body, options.onDelta);
}

async function readSseResponse(stream, onDelta) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const rows = buffer.split('\n');
    buffer = rows.pop() || '';
    for (const row of rows) {
      const payload = row.trim().replace(/^data:\s*/, '');
      if (!payload || payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload).choices?.[0]?.delta?.content || '';
        if (chunk) {
          text += chunk;
          onDelta(text);
        }
      } catch { /* Ignore provider keep-alive and non-standard SSE rows. */ }
    }
  }
  return text || '（无回复）';
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
