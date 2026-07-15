import { quotaRepo, quotaResourceUsageRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=4.1';
import { uid } from '../utils/dom.js';
import { resourcePriceService } from './resourcePriceService.js?v=4.1';
import { normalizeQuotaBreakdown } from '../utils/quotaBreakdown.js?v=4.2';

export const quotaResourceService = {
  async list(quotaItemId) {
    return await quotaResourceUsageRepo.byQuota(quotaItemId);
  },

  async removeUsage(usageId) {
    const usage = await quotaResourceUsageRepo.findById(usageId);
    if (!usage) return null;
    await quotaResourceUsageRepo.remove(usageId);
    return usage;
  },

  async compareUsage(usageId) {
    const usage = await quotaResourceUsageRepo.findById(usageId);
    if (!usage) throw new Error('定额资源用量不存在');
    const [resource, currentPrice] = await Promise.all([
      resourceRepo.findById(usage.resourceId),
      resourcePriceService.getCurrentPrice(usage.resourceId),
    ]);
    const staleReasons = comparisonReasons(usage, resource, currentPrice);
    const currentCost = currentPrice
      ? calculateUsageCost(usage.quantityPerUnit, usage.lossRate, currentPrice.unitPrice)
      : 0;
    return {
      usage,
      resource,
      currentPrice,
      stale: staleReasons.length > 0,
      staleReasons,
      priceDelta: roundCost(Number(currentPrice?.unitPrice || 0) - Number(usage.priceSnapshot?.unitPrice || 0)),
      currentCost,
      costDelta: roundCost(currentCost - Number(usage.calculatedCost || 0)),
    };
  },

  async compareUsages(quotaItemId) {
    const usages = await quotaResourceUsageRepo.byQuota(quotaItemId);
    return await Promise.all(usages.map(usage => this.compareUsage(usage.id)));
  },

  async refreshUsageSnapshot(usageId) {
    const usage = await quotaResourceUsageRepo.findById(usageId);
    if (!usage) throw new Error('定额资源用量不存在');
    const [resource, currentPrice] = await Promise.all([
      resourceRepo.findById(usage.resourceId),
      resourcePriceService.getCurrentPrice(usage.resourceId),
    ]);
    if (!resource) throw new Error('材料或设备已失效，无法刷新快照');
    if (!currentPrice) throw new Error('当前材料或设备没有可用价格');
    return await quotaResourceUsageRepo.update(usageId, {
      resourceType: resource.resourceType,
      selectedPriceId: currentPrice.id,
      priceSnapshot: snapshotPrice(currentPrice),
      calculatedCost: calculateUsageCost(usage.quantityPerUnit, usage.lossRate, currentPrice.unitPrice),
      updatedAt: new Date().toISOString(),
    });
  },

  async saveUsage(payload = {}) {
    const quota = await quotaRepo.findById(payload.quotaItemId);
    if (!quota) throw new Error('定额不存在');
    const resource = await resourceRepo.findById(payload.resourceId);
    if (!resource) throw new Error('材料或设备不存在');
    const quantityPerUnit = Number(payload.quantityPerUnit);
    const lossRate = Number(payload.lossRate || 0);
    if (!Number.isFinite(quantityPerUnit) || quantityPerUnit < 0) throw new Error('单位用量不能为负数');
    if (!Number.isFinite(lossRate) || lossRate < 0) throw new Error('损耗率不能为负数');
    const price = payload.selectedPriceId
      ? await resourcePriceRepo.findById(payload.selectedPriceId)
      : await resourcePriceService.getCurrentPrice(payload.resourceId);
    if (!price || price.resourceId !== payload.resourceId) throw new Error('所选价格不存在或不属于当前材料/设备');
    const priceSnapshot = snapshotPrice(price);
    const usage = {
      id: payload.id || uid(),
      quotaItemId: payload.quotaItemId,
      resourceId: payload.resourceId,
      resourceType: resource.resourceType,
      quantityPerUnit,
      lossRate,
      selectedPriceId: price.id,
      priceSnapshot,
      calculatedCost: calculateUsageCost(quantityPerUnit, lossRate, priceSnapshot.unitPrice),
      updatedAt: new Date().toISOString(),
    };
    return await quotaResourceUsageRepo.upsert(usage);
  },

  async calculateComposition(quotaItemId) {
    const quota = await quotaRepo.findById(quotaItemId);
    if (!quota) throw new Error('定额不存在');
    const usages = await quotaResourceUsageRepo.byQuota(quotaItemId);
    const material = roundCost(usages.filter(item => item.resourceType === 'material').reduce((sum, item) => sum + Number(item.calculatedCost || 0), 0));
    const equipment = roundCost(usages.filter(item => item.resourceType === 'equipment').reduce((sum, item) => sum + Number(item.calculatedCost || 0), 0));
    return { material, equipment, total: roundCost(material + equipment) };
  },

  async applyComposition(quotaItemId) {
    const quota = await quotaRepo.findById(quotaItemId);
    if (!quota) throw new Error('定额不存在');
    const composition = await this.calculateComposition(quotaItemId);
    const breakdown = {
      ...normalizeQuotaBreakdown(quota.breakdown),
      材料: composition.material,
      设备: composition.equipment,
    };
    return await quotaRepo.update(quotaItemId, {
      breakdown,
      useBreakdown: true,
      priceTotal: roundCost(Object.values(breakdown).reduce((sum, value) => sum + Number(value || 0), 0)),
      updatedAt: new Date().toISOString(),
    });
  },
};

function roundCost(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calculateUsageCost(quantityPerUnit, lossRate, unitPrice) {
  return roundCost(Number(quantityPerUnit || 0) * (1 + Number(lossRate || 0) / 100) * Number(unitPrice || 0));
}

function snapshotPrice(price = {}) {
  return {
    unitPrice: Number(price.unitPrice),
    priceBasis: price.priceBasis || '',
    sourceType: price.sourceType || '',
    taxIncluded: Boolean(price.taxIncluded),
    taxRate: Number(price.taxRate || 0),
    region: { ...(price.region || {}) },
    priceDate: price.priceDate || '',
    validFrom: price.validFrom || '',
    validTo: price.validTo || '',
    supplier: price.supplier || '',
    installationScope: price.installationScope || '',
    sourceName: price.supplier || price.sourceType || '',
  };
}

function comparisonReasons(usage, resource, currentPrice) {
  if (!resource) return ['resourceMissing'];
  if (!currentPrice) return ['currentPriceMissing'];
  const reasons = [];
  if (usage.selectedPriceId !== currentPrice.id) reasons.push('selectedPriceId');
  const fields = ['unitPrice', 'priceBasis', 'sourceType', 'priceDate', 'validFrom', 'validTo'];
  fields.forEach(field => {
    if (String(usage.priceSnapshot?.[field] ?? '') !== String(currentPrice[field] ?? '')) reasons.push(field);
  });
  return reasons;
}
