import { boqRepo, projectRepo } from '../data/repository.js?v=6.15';
import { calculateAmount, roundMoney } from '../utils/costing.js?v=6.15';
import { assertProjectEditableById } from './projectLockService.js?v=6.15';

export const COST_SOURCE_OPTIONS = Object.freeze([
  { value: 'manual', label: '手工测算' },
  { value: 'enterprise_quota', label: '企业定额' },
  { value: 'history', label: '历史项目' },
  { value: 'resource', label: '材料设备价' },
  { value: 'subcontract', label: '分包报价' },
  { value: 'experience', label: '经验指标' },
  { value: 'control_price_discount', label: '控制价下浮' },
  { value: 'quote_factor', label: '投标价折算' },
]);

export const DEFAULT_COST_SETTINGS = Object.freeze({
  taxRate: 9,
  measureRate: 2,
  targetProfitRate: 8,
  provisionalAmount: 0,
  otherAmount: 0,
  recoveryAmount: 0,
});

export function normalizeCostSettings(settings = {}) {
  return {
    taxRate: normalizeRate(settings.taxRate, DEFAULT_COST_SETTINGS.taxRate),
    measureRate: normalizeRate(settings.measureRate, DEFAULT_COST_SETTINGS.measureRate),
    targetProfitRate: normalizeTargetProfitRate(settings.targetProfitRate),
    provisionalAmount: normalizeMoney(settings.provisionalAmount),
    otherAmount: normalizeMoney(settings.otherAmount),
    recoveryAmount: normalizeMoney(settings.recoveryAmount),
  };
}

export function hasCostPrice(line = {}) {
  return line.costUnitPrice !== ''
    && line.costUnitPrice !== null
    && line.costUnitPrice !== undefined
    && Number.isFinite(Number(line.costUnitPrice));
}

export function calculateCostAmount(line = {}) {
  if (!hasCostPrice(line)) return 0;
  return roundMoney(calculateAmount(line.qty, line.costUnitPrice, line.factor));
}

export function calculateControlPriceDiscount(controlUnitPrice, discountRate) {
  const price = Number(controlUnitPrice);
  const rate = Number(discountRate);
  if (!Number.isFinite(price) || price < 0) throw new Error('控制综合单价必须是不小于 0 的有效数字');
  if (!Number.isFinite(rate) || rate < 0 || rate >= 100) throw new Error('下浮率必须在 0% 到 100% 之间');
  return roundMoney(price * (1 - rate / 100));
}

export function summarizeCostEstimate(lines = [], settings = {}) {
  const normalizedSettings = normalizeCostSettings(settings);
  const includedLines = lines.filter(line => line.costIncluded !== false);
  const pricedLines = includedLines.filter(hasCostPrice);
  const missingLines = includedLines.filter(line => !hasCostPrice(line));
  const pendingLines = pricedLines.filter(line => line.costReviewStatus === 'pending');
  const excludedLines = lines.filter(line => line.costIncluded === false);
  const fullBidTotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const bidTotal = roundMoney(includedLines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const pricedBidTotal = roundMoney(pricedLines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const directCost = roundMoney(pricedLines.reduce((sum, line) => sum + calculateCostAmount(line), 0));
  const measureCost = roundMoney(directCost * normalizedSettings.measureRate / 100);
  const preTaxCost = roundMoney(
    directCost
    + measureCost
    + normalizedSettings.provisionalAmount
    + normalizedSettings.otherAmount
    - normalizedSettings.recoveryAmount,
  );
  const taxAmount = roundMoney(preTaxCost * normalizedSettings.taxRate / 100);
  const totalCost = roundMoney(preTaxCost + taxAmount);
  const expectedProfit = roundMoney(bidTotal - totalCost);
  const profitMargin = bidTotal ? expectedProfit / bidTotal : 0;
  const missingBidAmount = roundMoney(missingLines.reduce((sum, line) => sum + Math.abs(Number(line.amount || 0)), 0));
  const pendingBidAmount = roundMoney(pendingLines.reduce((sum, line) => sum + Math.abs(Number(line.amount || 0)), 0));
  const coverage = includedLines.length ? pricedLines.length / includedLines.length : 0;
  const valueCoverage = Math.abs(bidTotal) ? Math.min(1, Math.abs(pricedBidTotal) / Math.abs(bidTotal)) : coverage;
  const targetCost = roundMoney(bidTotal * (1 - normalizedSettings.targetProfitRate / 100));
  const costHeadroom = roundMoney(targetCost - totalCost);
  const targetProfitRatio = normalizedSettings.targetProfitRate / 100;
  const minimumBidForTarget = targetProfitRatio < 1 ? roundMoney(totalCost / (1 - targetProfitRatio)) : 0;

  return {
    settings: normalizedSettings,
    fullBidTotal,
    bidTotal,
    excludedBidTotal: roundMoney(fullBidTotal - bidTotal),
    directCost,
    measureCost,
    preTaxCost,
    taxAmount,
    totalCost,
    expectedProfit,
    profitMargin,
    targetCost,
    costHeadroom,
    minimumBidForTarget,
    coverage,
    valueCoverage,
    includedCount: includedLines.length,
    pricedCount: pricedLines.length,
    missingCount: missingLines.length,
    pendingCount: pendingLines.length,
    excludedCount: excludedLines.length,
    missingBidAmount,
    pendingBidAmount,
    riskBidAmount: roundMoney(missingBidAmount + pendingBidAmount),
    decisionReady: includedLines.length > 0 && missingLines.length === 0 && pendingLines.length === 0,
  };
}

export const costEstimationService = {
  async load(projectId) {
    const [project, lines] = await Promise.all([
      projectRepo.findById(projectId),
      boqRepo.byProject(projectId),
    ]);
    if (!project) throw new Error('项目不存在');
    const settings = normalizeCostSettings(project.costSettings);
    return { project, lines, settings, summary: summarizeCostEstimate(lines, settings) };
  },

  async updateLine(lineId, patch = {}) {
    const line = await boqRepo.findById?.(lineId) || (await boqRepo.all()).find(item => item.id === lineId);
    if (!line) throw new Error('清单项不存在');
    await assertProjectEditableById(line.projectId);
    const updated = { ...line };
    if ('costUnitPrice' in patch) {
      updated.costUnitPrice = normalizeOptionalCostPrice(patch.costUnitPrice);
      updated.costAmount = calculateCostAmount(updated);
    }
    if ('costSource' in patch) {
      const source = String(patch.costSource || '').trim();
      if (source && !COST_SOURCE_OPTIONS.some(option => option.value === source)) throw new Error('成本来源无效');
      updated.costSource = source;
    }
    if ('costSourceRef' in patch) {
      updated.costSourceRef = normalizeCostSourceReference(patch.costSourceRef, updated.costSource);
    }
    if ('costNote' in patch) updated.costNote = String(patch.costNote || '').trim();
    if ('costIncluded' in patch) updated.costIncluded = patch.costIncluded !== false;
    if ('costReviewStatus' in patch) updated.costReviewStatus = String(patch.costReviewStatus || '').trim();
    updated.costUpdatedAt = new Date().toISOString();
    await boqRepo.update(lineId, updated);
    return updated;
  },

  async updateSettings(projectId, patch = {}) {
    await assertProjectEditableById(projectId);
    const project = await projectRepo.findById(projectId);
    const costSettings = normalizeCostSettings({ ...(project?.costSettings || {}), ...patch });
    await projectRepo.update(projectId, { costSettings, costUpdatedAt: new Date().toISOString() });
    return costSettings;
  },

  async applyQuoteFactor(projectId, factor, { onlyMissing = true } = {}) {
    await assertProjectEditableById(projectId);
    const ratio = Number(factor);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 2) throw new Error('折算比例必须大于 0 且不超过 200%');
    const all = await boqRepo.all();
    let updatedCount = 0;
    const now = new Date().toISOString();
    const next = all.map(line => {
      if (line.projectId !== projectId || line.costIncluded === false) return line;
      if (onlyMissing && hasCostPrice(line)) return line;
      if (!Number.isFinite(Number(line.unitPrice))) return line;
      const costUnitPrice = roundMoney(Number(line.unitPrice) * ratio);
      updatedCount += 1;
      return {
        ...line,
        costUnitPrice,
        costAmount: roundMoney(calculateAmount(line.qty, costUnitPrice, line.factor)),
        costSource: 'quote_factor',
        costReviewStatus: 'pending',
        costNote: `按投标综合单价的 ${roundMoney(ratio * 100, 2)}% 折算，待复核`,
        costUpdatedAt: now,
      };
    });
    await boqRepo.replaceAll(next);
    return updatedCount;
  },

  async applyAiSuggestions(projectId, suggestions = []) {
    await assertProjectEditableById(projectId);
    const suggestionMap = new Map(suggestions.map(item => [item.lineId, item]));
    const all = await boqRepo.all();
    let updatedCount = 0;
    const now = new Date().toISOString();
    const next = all.map(line => {
      const suggestion = suggestionMap.get(line.id);
      if (!suggestion || line.projectId !== projectId || line.costIncluded === false) return line;
      const costUnitPrice = normalizeOptionalCostPrice(suggestion.suggestedPrice);
      const costSource = String(suggestion.costSource || '').trim();
      if (!COST_SOURCE_OPTIONS.some(option => option.value === costSource)) throw new Error('AI 建议的成本来源无效');
      const costSourceRef = normalizeCostSourceReference(suggestion.costSourceRef, costSource);
      updatedCount += 1;
      return {
        ...line,
        costUnitPrice,
        costAmount: roundMoney(calculateAmount(line.qty, costUnitPrice, line.factor)),
        costSource,
        costSourceRef,
        costReviewStatus: 'pending',
        costNote: mergeAiSuggestionNote(line.costNote, suggestion),
        costUpdatedAt: now,
      };
    });
    await boqRepo.replaceAll(next);
    return updatedCount;
  },
};

function mergeAiSuggestionNote(note, suggestion) {
  const current = String(note || '').replace(/(?:^|\n)AI建议：[^\n]*/g, '').trim();
  const aiNote = `AI建议：${suggestion.sourceLabel || '成本数据匹配'}；${suggestion.reason || '待人工复核'}`;
  return [aiNote, current].filter(Boolean).join('\n');
}

function normalizeOptionalCostPrice(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('成本单价必须是有效数字');
  return roundMoney(number);
}

export function normalizeCostSourceReference(reference, source = '') {
  if (!reference) return null;
  if (!reference.id || !reference.label) throw new Error('成本来源引用不完整');
  const type = String(reference.type || source || '').trim();
  if (!COST_SOURCE_OPTIONS.some(option => option.value === type)) throw new Error('成本来源引用类型无效');
  if (source && type !== source) throw new Error('成本来源与引用类型不一致');
  return {
    id: String(reference.id),
    type,
    label: String(reference.label).trim(),
    detail: String(reference.detail || '').trim(),
    sourceId: String(reference.sourceId || '').trim(),
    quotaItemId: String(reference.quotaItemId || '').trim(),
    projectId: String(reference.projectId || '').trim(),
    resourceId: String(reference.resourceId || '').trim(),
    version: String(reference.version || '').trim(),
    baseUnitPrice: reference.baseUnitPrice === null || reference.baseUnitPrice === undefined ? null : normalizeOptionalCostPrice(reference.baseUnitPrice),
    rate: reference.rate === null || reference.rate === undefined ? null : normalizeRate(reference.rate, 0),
    priceBasis: String(reference.priceBasis || '').trim(),
    breakdown: reference.breakdown && typeof reference.breakdown === 'object'
      ? Object.fromEntries(Object.entries(reference.breakdown).map(([key, value]) => [String(key), Number(value) || 0]))
      : null,
    date: String(reference.date || '').trim(),
    unitPrice: reference.unitPrice === null || reference.unitPrice === undefined ? null : normalizeOptionalCostPrice(reference.unitPrice),
    linkedAt: String(reference.linkedAt || new Date().toISOString()),
  };
}

function normalizeRate(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error('费率必须在 0 到 100 之间');
  return roundMoney(number, 4);
}

function normalizeTargetProfitRate(value) {
  if (value === '' || value === null || value === undefined) return DEFAULT_COST_SETTINGS.targetProfitRate;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number >= 100) throw new Error('目标利润率必须在 0 到 100 之间');
  return roundMoney(number, 4);
}

function normalizeMoney(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('调整金额不能为负数');
  return roundMoney(number);
}
