import assert from 'node:assert/strict';
import {
  calculateCostAmount,
  calculateControlPriceDiscount,
  costEstimationService,
  COST_SOURCE_OPTIONS,
  hasCostPrice,
  normalizeCostSettings,
  normalizeCostSourceReference,
  summarizeCostEstimate,
} from '../assets/services/costEstimationService.js?v=test-cost-estimation';
import { rankHistoryReferences, rankIndicatorReferences, rankQuotaReferences, rankResourceReferences } from '../assets/services/costSourceReferenceService.js?v=test-cost-source-reference';
import { generateCostSuggestions } from '../assets/services/costAiEstimationService.js?v=test-cost-ai';

export function testCostEstimationMath() {
  const emptySummary = summarizeCostEstimate([], {});
  assert.equal(emptySummary.decisionReady, false, '空清单不应该显示已达到目标利润');

  const lines = [
    { id: 'priced', qty: 10, factor: 1, unitPrice: 100, amount: 1000, costUnitPrice: 70 },
    { id: 'missing', qty: 5, factor: 1, unitPrice: 100, amount: 500 },
    { id: 'excluded', qty: 2, factor: 1, unitPrice: 100, amount: 200, costUnitPrice: 50, costIncluded: false },
  ];
  const summary = summarizeCostEstimate(lines, {
    taxRate: 9, measureRate: 2, targetProfitRate: 10, provisionalAmount: 100, otherAmount: 50, recoveryAmount: 20,
  });
  assert.equal(summary.fullBidTotal, 1700);
  assert.equal(summary.bidTotal, 1500);
  assert.equal(summary.excludedBidTotal, 200);
  assert.equal(summary.directCost, 700);
  assert.equal(summary.measureCost, 14);
  assert.equal(summary.preTaxCost, 844);
  assert.equal(summary.taxAmount, 75.96);
  assert.equal(summary.totalCost, 919.96);
  assert.equal(summary.expectedProfit, 580.04);
  assert.equal(summary.profitMargin, 580.04 / 1500);
  assert.equal(summary.coverage, 0.5);
  assert.equal(summary.valueCoverage, 2 / 3);
  assert.equal(summary.missingCount, 1);
  assert.equal(summary.missingBidAmount, 500);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.targetCost, 1350);
  assert.equal(summary.costHeadroom, 430.04);
  assert.equal(summary.decisionReady, false);

  assert.equal(hasCostPrice({ costUnitPrice: 0 }), true, '显式零成本不是缺价');
  assert.equal(hasCostPrice({ costUnitPrice: -20 }), true, '回收或冲减允许负成本');
  assert.equal(hasCostPrice({ costUnitPrice: '' }), false);
  assert.equal(calculateCostAmount({ qty: 3, factor: 1.1, costUnitPrice: -20 }), -66);
  assert.equal(COST_SOURCE_OPTIONS.some(option => option.value === 'enterprise_quota'), true);
  assert.equal(COST_SOURCE_OPTIONS.some(option => option.value === 'control_price_discount'), true);
  assert.equal(calculateControlPriceDiscount(100, 10), 90);
  assert.equal(calculateControlPriceDiscount(123.45, 8.5), 112.96);
  assert.throws(() => calculateControlPriceDiscount(100, 100), /下浮率/);
  assert.throws(() => calculateControlPriceDiscount(-1, 10), /控制综合单价/);
  const normalizedReference = normalizeCostSourceReference({ id: 'history:1', type: 'history', label: '历史项目 A', unitPrice: 88 }, 'history');
  assert.equal(normalizedReference.id, 'history:1');
  assert.equal(normalizedReference.unitPrice, 88);
  assert.equal(Number.isNaN(Date.parse(normalizedReference.linkedAt)), false);
  assert.throws(() => normalizeCostSourceReference({ id: 'x', type: 'resource', label: '错误来源' }, 'history'), /不一致/);
  const quotaReference = normalizeCostSourceReference({
    id: 'enterprise-quota:q1', type: 'enterprise_quota', sourceId: 'q1', quotaItemId: 'q1', label: 'TJ-5 · C30混凝土',
    version: '2026-A', breakdown: { 人工: 12, 材料: 55 }, unitPrice: 75,
  }, 'enterprise_quota');
  assert.equal(quotaReference.quotaItemId, 'q1');
  assert.equal(quotaReference.version, '2026-A');
  assert.deepEqual(quotaReference.breakdown, { 人工: 12, 材料: 55 });
  const controlPriceReference = normalizeCostSourceReference({
    id: 'control-price-discount:1', type: 'control_price_discount', label: '控制价下浮 10%',
    baseUnitPrice: 100, rate: 10, priceBasis: '含税控制价', unitPrice: 90,
  }, 'control_price_discount');
  assert.equal(controlPriceReference.baseUnitPrice, 100);
  assert.equal(controlPriceReference.rate, 10);
  assert.equal(controlPriceReference.priceBasis, '含税控制价');
  assert.equal(controlPriceReference.unitPrice, 90);
  assert.deepEqual(normalizeCostSettings({ taxRate: '', measureRate: '', provisionalAmount: '' }), {
    taxRate: 9, measureRate: 2, targetProfitRate: 8, provisionalAmount: 0, otherAmount: 0, recoveryAmount: 0,
  });
  assert.throws(() => normalizeCostSettings({ taxRate: 101 }), /费率/);
  assert.throws(() => normalizeCostSettings({ recoveryAmount: -1 }), /不能为负数/);
  assert.throws(() => normalizeCostSettings({ targetProfitRate: 100 }), /目标利润率/);

  const reviewSummary = summarizeCostEstimate([
    { qty: 1, amount: 100, costUnitPrice: 70, costReviewStatus: 'pending' },
  ], { taxRate: 0, measureRate: 0, targetProfitRate: 20 });
  assert.equal(reviewSummary.pendingCount, 1);
  assert.equal(reviewSummary.pendingBidAmount, 100);
  assert.equal(reviewSummary.riskBidAmount, 100);
  assert.equal(reviewSummary.decisionReady, false);
  assert.equal(reviewSummary.targetCost, 80);
  assert.equal(reviewSummary.costHeadroom, 10);
  assert.equal(reviewSummary.minimumBidForTarget, 87.5);

  const history = rankHistoryReferences(
    { id: 'current', projectId: 'p-current', code: 'TJ-5', name: 'C30混凝土', unit: 'm³' },
    [{ id: 'p-old', name: '方兴大道', status: 'archived', archivedAt: '2025-01-01' }],
    [{ id: 'old-line', projectId: 'p-old', code: 'TJ-5', name: 'C30混凝土', unit: 'm³', costUnitPrice: 86 }],
  );
  assert.equal(history[0].sourceId, 'old-line');
  assert.equal(history[0].unitPrice, 86);
  assert.equal(history[0].canApplyPrice, true);

  const quotas = rankQuotaReferences(
    { code: 'TJ-5', name: 'C30混凝土', unit: 'm³' },
    [{ id: 'q1', code: 'TJ-5', name: 'C30混凝土', unit: 'm³', category: '土建', priceTotal: 75, version: '2026-A', breakdown: { 人工: 12, 材料: 55, 机械: 8 } }],
  );
  assert.equal(quotas[0].source, 'enterprise_quota');
  assert.equal(quotas[0].quotaItemId, 'q1');
  assert.equal(quotas[0].unitPrice, 75);
  assert.equal(quotas[0].canApplyPrice, true);
  assert.equal(quotas[0].detail.includes('人工 12'), true);
  assert.equal(rankQuotaReferences({ name: 'C30混凝土', unit: 'm²' }, [{ id: 'q2', name: 'C30混凝土', unit: 'm³', priceTotal: 75 }])[0].canApplyPrice, false);
  assert.equal(rankQuotaReferences({ name: '临时设施', unit: '项' }, [{ id: 'q3', name: '人工挖土', unit: 'm³', priceTotal: 30 }]).length, 1, '无自动匹配时仍应允许人工选择企业定额');

  const resources = rankResourceReferences(
    { name: 'C30混凝土', unit: 'm³' },
    [{ id: 'r1', name: 'C30商品混凝土', unit: 'm³', preferredPriceId: 'rp1' }],
    [{ id: 'rp1', resourceId: 'r1', unitPrice: 420, sourceType: 'supplier_quote', priceDate: '2026-08-01', status: 'active' }],
  );
  assert.equal(resources[0].sourceId, 'rp1');
  assert.equal(resources[0].canApplyPrice, true);

  const indicators = rankIndicatorReferences(
    { name: '混凝土工程' },
    [{ typeKey: '公共建筑', metric: '分项造价-混凝土(元)', category: '混凝土', median: 1000, n: 6, confidence: '中可信' }],
  );
  assert.equal(indicators[0].canApplyPrice, false, '经验指标只作校核依据，不应直接覆盖清单单价');

  const aiSuggestions = generateCostSuggestions([
    { id: 'ai-history', projectId: 'p-current', code: 'TJ-5', name: 'C30混凝土', unit: 'm³', unitPrice: 100 },
    { id: 'ai-factor', projectId: 'p-current', name: '临时设施', unit: '项', unitPrice: 1000 },
  ], {
    projects: [{ id: 'p-old', name: '历史案例', status: 'archived' }],
    allLines: [{ id: 'history-line', projectId: 'p-old', code: 'TJ-5', name: 'C30混凝土', unit: 'm³', costUnitPrice: 72 }],
    resources: [], prices: [],
  });
  assert.equal(aiSuggestions.suggestions.length, 2);
  assert.equal(aiSuggestions.suggestions[0].suggestedPrice, 72);
  assert.equal(aiSuggestions.suggestions[0].costSource, 'history');
  assert.equal(aiSuggestions.suggestions[0].confidence, 'high');
  assert.equal(aiSuggestions.suggestions[0].apply, true);
  assert.equal(aiSuggestions.suggestions[1].suggestedPrice, 850);
  assert.equal(aiSuggestions.suggestions[1].confidence, 'low');
  assert.equal(aiSuggestions.suggestions[1].apply, false);

  const quotaAiSuggestions = generateCostSuggestions([
    { id: 'ai-quota', projectId: 'p-current', code: 'TJ-5', name: 'C30混凝土', unit: 'm³', unitPrice: 100 },
  ], {
    quotas: [{ id: 'q1', code: 'TJ-5', name: 'C30混凝土', unit: 'm³', priceTotal: 75, version: '2026-A' }],
    projects: [], allLines: [], resources: [], prices: [],
  });
  assert.equal(quotaAiSuggestions.suggestions[0].costSource, 'enterprise_quota');
  assert.equal(quotaAiSuggestions.suggestions[0].suggestedPrice, 75);
  assert.equal(quotaAiSuggestions.suggestions[0].costSourceRef.quotaItemId, 'q1');
}

export async function testCostEstimationPersistence() {
  const memory = new Map();
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: key => memory.get(`local:${key}`) ?? null,
    setItem: (key, value) => memory.set(`local:${key}`, value),
  };
  globalThis.window = {
    idbKeyval: {
      get: async key => memory.get(key),
      set: async (key, value) => memory.set(key, value),
    },
  };
  const repo = await import('../assets/data/repository.js?v=6.15');
  await repo.projectRepo.replaceAll([{ id: 'cost-project', name: '成本测算项目', status: 'doing', totalCost: 1000 }]);
  await repo.boqRepo.replaceAll([
    { id: 'cost-line-1', projectId: 'cost-project', name: '池壁', qty: 10, factor: 1, unitPrice: 100, amount: 1000 },
  ]);

  const updated = await costEstimationService.updateLine('cost-line-1', {
    costUnitPrice: 72, costSource: 'history', costNote: '同地区历史项目', costReviewStatus: 'reviewed',
  });
  assert.equal(updated.costAmount, 720);
  assert.equal(updated.costSource, 'history');
  await costEstimationService.updateSettings('cost-project', { taxRate: 9, measureRate: 2, recoveryAmount: 10 });
  const loaded = await costEstimationService.load('cost-project');
  assert.equal(loaded.summary.directCost, 720);
  assert.equal(loaded.summary.totalCost, 789.6);

  const count = await costEstimationService.applyQuoteFactor('cost-project', 0.8, { onlyMissing: false });
  assert.equal(count, 1);
  const factored = (await repo.boqRepo.byProject('cost-project'))[0];
  assert.equal(factored.costUnitPrice, 80);
  assert.equal(factored.costReviewStatus, 'pending');
  assert.equal(factored.costSource, 'quote_factor');

  const aiCount = await costEstimationService.applyAiSuggestions('cost-project', [{
    lineId: 'cost-line-1', suggestedPrice: 68, costSource: 'history', sourceLabel: '历史项目 · 池壁', reason: '同编码同单位历史内部成本价',
    costSourceRef: { id: 'history:cost-line-old', type: 'history', label: '历史项目 · 池壁', unitPrice: 68 },
  }]);
  assert.equal(aiCount, 1);
  const aiPriced = (await repo.boqRepo.byProject('cost-project'))[0];
  assert.equal(aiPriced.costUnitPrice, 68);
  assert.equal(aiPriced.costReviewStatus, 'pending');
  assert.equal(aiPriced.costSourceRef.id, 'history:cost-line-old');
  assert.equal(aiPriced.costNote.includes('AI建议：'), true);

  await repo.projectRepo.update('cost-project', { status: 'archived' });
  await assert.rejects(() => costEstimationService.updateLine('cost-line-1', { costUnitPrice: 70 }), /只读状态/);
  globalThis.window = previousWindow;
  globalThis.localStorage = previousLocalStorage;
}
