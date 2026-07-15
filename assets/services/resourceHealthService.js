import { quotaResourceUsageRepo, resourceAttachmentRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=4.1';
import { localDateKey } from '../utils/localDate.js?v=4.2';
import { getUsageComparisonReasons } from './quotaResourceService.js?v=6.1';
import { selectCurrentResourcePrice, selectResourcePrice } from './resourcePriceService.js?v=6.1';

export const resourceHealthService = {
  async getHealth({ today = localDateKey() } = {}) {
    const [resources, prices, attachments, usages] = await Promise.all([
      resourceRepo.all(),
      resourcePriceRepo.all(),
      resourceAttachmentRepo.all(),
      quotaResourceUsageRepo.all(),
    ]);
    return buildResourceHealth({ resources, prices, attachments, usages, today });
  },
};

export function buildResourceHealth({ resources = [], prices = [], attachments = [], usages = [], today = localDateKey() } = {}) {
  const activeResources = resources.filter(resource => resource.status !== 'inactive');
  const activeById = new Map(activeResources.map(resource => [resource.id, resource]));
  const currentByResource = new Map(activeResources.map(resource => [
    resource.id,
    selectResourcePriceForHealth(resource, prices, today),
  ]));
  const availableEvidence = new Set(attachments
    .filter(attachment => attachment.status === 'available' && attachment.priceId)
    .map(attachment => attachment.priceId));

  const missingCurrentPrice = summarize(activeResources
    .filter(resource => !currentByResource.get(resource.id))
    .map(resource => ({ resource })));
  const expiredCurrentPrice = summarize(activeResources
    .map(resource => ({ resource, price: currentByResource.get(resource.id) }))
    .filter(({ price }) => price?.validTo && price.validTo < today));
  const missingQuoteEvidence = summarize(prices
    .filter(price => price.sourceType === 'supplier_quote' && activeById.has(price.resourceId) && !availableEvidence.has(price.id))
    .map(price => ({ resource: activeById.get(price.resourceId), price })));
  const pendingQuotaUpdates = summarizeQuotaUpdates(usages
    .map(usage => {
      const resource = activeById.get(usage.resourceId) || resources.find(item => item.id === usage.resourceId) || null;
      const currentPrice = resource ? selectCurrentResourcePrice(resource, prices, today) : null;
      return { resource, price: currentPrice, usage };
    })
    .filter(({ resource, price, usage }) => getUsageComparisonReasons(usage, resource, price).length > 0));

  const issues = { missingCurrentPrice, expiredCurrentPrice, missingQuoteEvidence, pendingQuotaUpdates };
  return {
    ...issues,
    summary: Object.values(issues).reduce((sum, issue) => ({
      total: sum.total + issue.total,
      material: sum.material + issue.material,
      equipment: sum.equipment + issue.equipment,
    }), { total: 0, material: 0, equipment: 0 }),
  };
}

export function selectResourcePriceForHealth(resource, prices = [], today = localDateKey()) {
  return selectCurrentResourcePrice(resource, prices, today)
    || selectResourcePrice(resource, prices, today, { latestRegardlessOfValidity: true });
}

function summarize(items) {
  return {
    total: items.length,
    material: items.filter(item => resourceType(item) === 'material').length,
    equipment: items.filter(item => resourceType(item) === 'equipment').length,
    resourceIds: unique(items.map(item => item.resource?.id || item.usage?.resourceId)),
    materialResourceIds: unique(items.filter(item => resourceType(item) === 'material').map(item => item.resource?.id || item.usage?.resourceId)),
    equipmentResourceIds: unique(items.filter(item => resourceType(item) === 'equipment').map(item => item.resource?.id || item.usage?.resourceId)),
    priceIds: unique(items.map(item => item.price?.id)),
    usageIds: unique(items.map(item => item.usage?.id)),
    quotaItemIds: unique(items.map(item => item.usage?.quotaItemId)),
  };
}

function summarizeQuotaUpdates(items) {
  const summary = summarize(items);
  const quotas = unique(items.map(item => item.usage?.quotaItemId));
  const materialQuotas = unique(items.filter(item => resourceType(item) === 'material').map(item => item.usage?.quotaItemId));
  const equipmentQuotas = unique(items.filter(item => resourceType(item) === 'equipment').map(item => item.usage?.quotaItemId));
  return { ...summary, total: quotas.length, material: materialQuotas.length, equipment: equipmentQuotas.length };
}

function resourceType(item) {
  return item.resource?.resourceType || item.usage?.resourceType || '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
