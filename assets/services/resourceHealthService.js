import { boqRepo, quotaResourceUsageRepo, resourceAttachmentRepo, resourcePriceRepo, resourceRepo } from '../data/repository.js?v=6.10';
import { localDateKey } from '../utils/localDate.js?v=6.10';
import { getUsageComparisonReasons } from './quotaResourceService.js?v=6.10';
import { selectCurrentResourcePrice, selectResourcePrice } from './resourcePriceService.js?v=6.10';
import { resourceCodeIdentity, resourceCompositeIdentity } from './resourceService.js?v=6.10';

export const resourceHealthService = {
  async getHealth({ today = localDateKey() } = {}) {
    const [resources, prices, attachments, usages, projectLines] = await Promise.all([
      resourceRepo.all(),
      resourcePriceRepo.all(),
      resourceAttachmentRepo.all(),
      quotaResourceUsageRepo.all(),
      boqRepo.all(),
    ]);
    return buildResourceHealth({ resources, prices, attachments, usages, projectLines, today });
  },
};

export function buildResourceHealth({ resources = [], prices = [], attachments = [], usages = [], projectLines = [], today = localDateKey() } = {}) {
  const activeResources = resources.filter(resource => resource.status !== 'inactive');
  const activeById = new Map(activeResources.map(resource => [resource.id, resource]));
  const currentByResource = new Map(activeResources.map(resource => [
    resource.id,
    selectCurrentResourcePrice(resource, prices, today),
  ]));
  const latestByResource = new Map(activeResources.map(resource => [
    resource.id, selectResourcePriceForHealth(resource, prices, today),
  ]));
  const availableEvidence = new Set(attachments
    .filter(attachment => attachment.status === 'available' && attachment.priceId)
    .map(attachment => attachment.priceId));

  const missingCurrentPrice = summarize(activeResources
    .filter(resource => !currentByResource.get(resource.id))
    .map(resource => ({ resource })));
  const expiredCurrentPrice = summarize(activeResources
    .map(resource => ({ resource, price: latestByResource.get(resource.id) }))
    .filter(({ price }) => price?.validTo && price.validTo < today));
  const missingQuoteEvidence = summarize(prices
    .filter(price => price.status !== 'withdrawn' && price.sourceType === 'supplier_quote' && activeById.has(price.resourceId) && !availableEvidence.has(price.id))
    .map(price => ({ resource: activeById.get(price.resourceId), price })));
  const pendingQuotaUpdates = summarizeQuotaUpdates(usages
    .map(usage => {
      const resource = activeById.get(usage.resourceId) || resources.find(item => item.id === usage.resourceId) || null;
      const currentPrice = resource ? selectCurrentResourcePrice(resource, prices, today) : null;
      return { resource, price: currentPrice, usage };
    })
    .filter(({ resource, price, usage }) => getUsageComparisonReasons(usage, resource, price).length > 0));

  const references = [...usages, ...projectLineResourceReferences(projectLines, resources)];
  const inactiveResourceInUse = summarize(references
    .map(usage => ({ resource: resources.find(item => item.id === usage.resourceId), usage }))
    .filter(({ resource }) => resource?.status === 'inactive'));
  const unsupportedCostingPrice = summarize(references
    .map(usage => ({ resource: resources.find(item => item.id === usage.resourceId), usage }))
    .filter(({ resource, usage }) => resource && usage.priceSnapshot?.priceBasis && (
      (usage.id?.startsWith('project:')
        ? !['delivered', 'installed_composite'].includes(usage.priceSnapshot.priceBasis)
        : usage.priceSnapshot.priceBasis !== 'delivered')
    )));
  const duplicateCode = summarizeDuplicateGroups(resources, resourceCodeIdentity, true);
  const duplicateComposite = summarizeDuplicateGroups(resources, resourceCompositeIdentity);

  const issues = { missingCurrentPrice, expiredCurrentPrice, missingQuoteEvidence, pendingQuotaUpdates, inactiveResourceInUse, unsupportedCostingPrice, duplicateCode, duplicateComposite };
  return {
    ...issues,
    summary: Object.values(issues).reduce((sum, issue) => ({
      total: sum.total + issue.total,
      material: sum.material + issue.material,
      equipment: sum.equipment + issue.equipment,
    }), { total: 0, material: 0, equipment: 0 }),
  };
}

function projectLineResourceReferences(lines, resources) {
  return lines.flatMap(line => ['resourceItemId', 'linkedResourceItemId', 'installationResourceItemId', 'manualInstallationResourceId']
    .filter(field => line[field])
    .map(field => ({
      id: `project:${line.id || ''}:${field}`,
      resourceId: line[field],
      resourceType: resources.find(resource => resource.id === line[field])?.resourceType || '',
      priceSnapshot: field === 'resourceItemId' ? line.resourcePriceSnapshot || {} : {},
      projectId: line.projectId || '',
    })));
}

function summarizeDuplicateGroups(resources, identity, skipBlank = false) {
  const groups = new Map();
  resources.forEach(resource => {
    const key = identity(resource);
    if (skipBlank && !key) return;
    groups.set(key, [...(groups.get(key) || []), resource]);
  });
  return summarize([...groups.values()]
    .filter(group => group.length > 1)
    .flatMap(group => group.map(resource => ({ resource }))));
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
