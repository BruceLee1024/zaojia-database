import { quotaRepo, quotaResourceUsageRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=4.1';
import { uid } from '../utils/dom.js';
import { resourcePriceService } from './resourcePriceService.js?v=4.1';

export const quotaResourceService = {
  async list(quotaItemId) {
    return await quotaResourceUsageRepo.byQuota(quotaItemId);
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
    const priceSnapshot = {
      unitPrice: Number(price.unitPrice),
      priceBasis: price.priceBasis,
      taxIncluded: Boolean(price.taxIncluded),
      taxRate: Number(price.taxRate || 0),
      region: { ...(price.region || {}) },
      priceDate: price.priceDate,
      sourceName: price.supplier || price.sourceType || '',
    };
    const usage = {
      id: payload.id || uid(),
      quotaItemId: payload.quotaItemId,
      resourceId: payload.resourceId,
      resourceType: resource.resourceType,
      quantityPerUnit,
      lossRate,
      selectedPriceId: price.id,
      priceSnapshot,
      calculatedCost: roundCost(quantityPerUnit * (1 + lossRate / 100) * priceSnapshot.unitPrice),
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
      人工: 0,
      材料: 0,
      机械: 0,
      设备: 0,
      管理费: 0,
      利润: 0,
      风险: 0,
      ...(quota.breakdown || {}),
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
