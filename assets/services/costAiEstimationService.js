import { boqRepo, projectRepo, quotaRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=6.15';
import { hasCostPrice } from './costEstimationService.js?v=6.15&build=20260814f';
import { rankHistoryReferences, rankQuotaReferences, rankResourceReferences } from './costSourceReferenceService.js?v=6.15&build=20260814f';

const DEFAULT_QUOTE_FACTOR = 0.85;

export const costAiEstimationService = {
  async suggest(lines = []) {
    const [projects, allLines, quotas, resources, prices] = await Promise.all([
      projectRepo.all(), boqRepo.all(), quotaRepo.all(), resourceRepo.all(), resourcePriceRepo.all(),
    ]);
    return generateCostSuggestions(lines, { projects, allLines, quotas, resources, prices });
  },
};

export function generateCostSuggestions(lines = [], context = {}) {
  const candidates = lines.filter(line => line.costIncluded !== false && !hasCostPrice(line));
  const suggestions = candidates.map(line => suggestLineCost(line, context)).filter(Boolean);
  const counts = suggestions.reduce((result, row) => ({ ...result, [row.confidence]: (result[row.confidence] || 0) + 1 }), { high: 0, medium: 0, low: 0 });
  return {
    source: 'local',
    summary: `已为 ${suggestions.length} 条未覆价清单生成建议。`,
    suggestions,
    counts,
    warnings: counts.low ? ['低置信度项仅按投标价折算，默认不选中，必须结合询价或历史成本复核。'] : [],
  };
}

export function suggestLineCost(line = {}, context = {}) {
  const quotas = rankQuotaReferences(line, context.quotas || []).filter(item => item.canApplyPrice && item.score >= 45);
  const history = rankHistoryReferences(line, context.projects || [], context.allLines || []).filter(item => item.canApplyPrice);
  const resources = rankResourceReferences(line, context.resources || [], context.prices || []).filter(item => item.canApplyPrice);
  const matched = [
    ...quotas.map(item => ({ ...item, costSource: 'enterprise_quota' })),
    ...history.map(item => ({ ...item, costSource: 'history' })),
    ...resources.map(item => ({ ...item, costSource: 'resource' })),
  ].sort((a, b) => b.score - a.score)[0];
  if (matched) {
    const confidence = matched.score >= 80 ? 'high' : matched.score >= 45 ? 'medium' : 'low';
    return {
      lineId: line.id,
      lineName: line.name || '未命名清单',
      unit: line.unit || '',
      bidUnitPrice: Number(line.unitPrice || 0),
      suggestedPrice: roundMoney(matched.unitPrice),
      confidence,
      costSource: matched.costSource,
      sourceLabel: matched.label,
      reason: matched.detail || '匹配到同单位的可追溯成本记录',
      costSourceRef: { ...matched, type: matched.costSource },
      apply: confidence === 'high',
    };
  }
  const bidUnitPrice = Number(line.unitPrice);
  if (!Number.isFinite(bidUnitPrice)) return null;
  const suggestedPrice = roundMoney(bidUnitPrice * DEFAULT_QUOTE_FACTOR);
  return {
    lineId: line.id,
    lineName: line.name || '未命名清单',
    unit: line.unit || '',
    bidUnitPrice,
    suggestedPrice,
    confidence: 'low',
    costSource: 'quote_factor',
    sourceLabel: '投标综合单价折算',
    reason: `缺少同单位企业定额、历史成本或材料设备价格，暂按投标单价的 ${DEFAULT_QUOTE_FACTOR * 100}% 生成起算建议`,
    costSourceRef: {
      id: `quote-factor:${line.id}:${DEFAULT_QUOTE_FACTOR}`,
      type: 'quote_factor',
      sourceId: line.id,
      label: `投标单价 × ${DEFAULT_QUOTE_FACTOR * 100}%`,
      detail: `${bidUnitPrice} × ${DEFAULT_QUOTE_FACTOR * 100}%`,
      unitPrice: suggestedPrice,
      date: new Date().toISOString(),
    },
    apply: false,
  };
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
